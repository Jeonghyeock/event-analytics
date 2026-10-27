import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { RETENTION_DAYS } from "./db/partitions.js";

// 집계 작업(DESIGN 6.4, 10장 38~41). 시간 집계 표를 워터마크까지 채우고, 늦은 이벤트가 든 시간을 다시 센다.
// 조각(기본 하루) 하나가 트랜잭션 하나다. 조각마다:
//   1. rollup_state 행을 for update skip locked로 잡는다(못 잡으면 다른 실행이 돈다 → 이번은 건너뜀).
//   2. 그 조각의 끝 앞의 더러운 시간을 지우며 가져온다. 커밋 전인 수집의 행은 보이지 않아 남고, 다음 실행이 센다.
//   3. [워터마크, 조각 끝) ∪ 가져온 시간(워터마크 앞)을 중복 없는 한 집합으로 지우고 원본에서 INSERT 하나로 다시 센다.
//   4. 워터마크를 조각 끝으로 옮긴다.

const HOUR_MS = 3_600_000;

export type RollupOptions = {
  // "지금"(ISO). 테스트가 넘긴다. 없으면 DB의 now()다.
  now?: string;
  chunkHours?: number;
  statementTimeout?: string;
};

export type RollupResult = { skipped: true } | { skipped: false; chunks: number; hours: number; watermark: string };

type State = { watermark: Date; target: Date; retained: Date };

export async function runRollup(pool: pg.Pool, { now, chunkHours = 24, statementTimeout = "60s" }: RollupOptions = {}): Promise<RollupResult> {
  let chunks = 0;
  let hours = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', '3s', true)", [statementTimeout]);
      // 시작은 보관 기간의 시작보다 앞서지 않는다(지운 날을 다시 세지 않게). 목표는 끝난 시간까지(지금의 UTC 정시).
      const { rows } = await client.query<State>(
        `select greatest(watermark, r.retained) as watermark,
                date_trunc('hour', coalesce($1::timestamptz, now()), 'UTC') as target,
                r.retained
           from rollup_state,
                lateral (select ((coalesce($1::timestamptz, now()) at time zone 'UTC')::date - $2::int)::timestamp at time zone 'UTC' as retained) r
            for update of rollup_state skip locked`,
        [now ?? null, RETENTION_DAYS],
      );
      if (rows.length === 0) {
        await client.query("rollback");
        // 행이 없는 것과 다른 실행이 잡은 것을 가린다. 행이 없으면 늘 건너뛰게 되므로 오류로 알린다.
        const exists = await client.query("select 1 from rollup_state");
        if (exists.rowCount === 0) throw new Error("rollup_state 행이 없습니다(마이그레이션 0002)");
        return chunks === 0 ? { skipped: true } : finished();
      }
      const { watermark, target, retained } = rows[0]!;
      // 워터마크는 뒤로 가지 않는다(시계가 어긋나 목표가 워터마크보다 앞서도).
      const chunkEnd = new Date(Math.max(watermark.getTime(), Math.min(target.getTime(), watermark.getTime() + chunkHours * HOUR_MS)));
      const claimed = await client.query<{ hour: Date }>("delete from dirty_hours where hour < $1 returning hour", [chunkEnd]);
      // 범위 안의 시간은 범위가 센다. 범위 앞(워터마크 앞)이고 보관 기간 안인 것만 따로 센다.
      const late = [...new Set(claimed.rows.map((r) => r.hour.getTime()))]
        .filter((t) => t < watermark.getTime() && t >= retained.getTime())
        .sort((a, b) => a - b)
        .map((t) => new Date(t));
      const rangeHours = Math.max(0, (chunkEnd.getTime() - watermark.getTime()) / HOUR_MS);
      if (rangeHours > 0 || late.length > 0) {
        await recompute(client, watermark, chunkEnd, late);
      }
      await client.query("update rollup_state set watermark = $1", [chunkEnd]);
      // 보관 기간이 지난 집계 행을 지운다(파티션은 관리 작업이 뗀다).
      await client.query("delete from hourly_rollup where hour < $1", [retained]);
      await client.query("commit");
      chunks++;
      hours += rangeHours + late.length;
      if (chunkEnd.getTime() >= target.getTime()) return finished(chunkEnd);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  function finished(watermark?: Date): RollupResult {
    return { skipped: false, chunks, hours, watermark: watermark?.toISOString() ?? "" };
  }
}

// [from, to) ∪ late를 지우고 원본에서 INSERT 하나로 다시 센다. 따로 넣으면 같은 시간이 두 번 들어간다(설계 리뷰).
// late는 흩어져 있어 date_trunc = any만으로는 가지를 치지 못한다. 최소·최대로 occurred_at 범위도 건다.
async function recompute(client: pg.PoolClient, from: Date, to: Date, late: Date[]) {
  await client.query("delete from hourly_rollup where (hour >= $1 and hour < $2) or hour = any($3::timestamptz[])", [from, to, late]);
  const lateWhere =
    late.length > 0
      ? ` or (occurred_at >= $3 and occurred_at < $4 and date_trunc('hour', occurred_at, 'UTC') = any($5::timestamptz[]))`
      : "";
  const values: unknown[] = [from, to];
  if (late.length > 0) values.push(late[0], new Date(late.at(-1)!.getTime() + HOUR_MS), late);
  await client.query(
    `insert into hourly_rollup (hour, event_name, platform, country, channel, campaign, events)
     select date_trunc('hour', occurred_at, 'UTC'), event_name, platform, country, channel, campaign, count(*)
       from events
      where (occurred_at >= $1 and occurred_at < $2)${lateWhere}
      group by 1, 2, 3, 4, 5, 6`,
    values,
  );
}

// API 서버 안의 타이머(1분). setInterval이 아니라 끝난 뒤 다음을 건다(한 프로세스 안에서 실행 둘이 섞이지 않게).
export function startRollupLoop(pool: pg.Pool, log: FastifyBaseLogger, everyMs = 60_000) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      const result = await runRollup(pool);
      if (!result.skipped && result.chunks > 1) log.info(result, "집계 작업");
    } catch (err) {
      log.error({ err }, "집계 작업 실패");
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, everyMs);
        timer.unref();
      }
    }
  };
  timer = setTimeout(tick, 0);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

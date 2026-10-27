import type { FunnelQuery, FunnelResult } from "@event-analytics/shared";
import type pg from "pg";
import { RETENTION_DAYS } from "../db/partitions.js";
import { buildFunnelSql, toFunnelRows } from "./funnel-sql.js";
import { END, START } from "./sql.js";
import { checkRetention, inReportTransaction, type QueryLimits, retainedFromSql } from "./transaction.js";

// 퍼널을 돌린다(DESIGN 6.5, 10장 42~44). 트랜잭션 틀은 리포트와 같다.
// asOf: 보관 기간과 provisional을 판단할 "지금"(ISO). 없으면 DB의 now()다.
export type FunnelOptions = QueryLimits & { asOf?: string };

export function runFunnel(pool: pg.Pool, q: FunnelQuery, { asOf, ...limits }: FunnelOptions = {}): Promise<FunnelResult> {
  return inReportTransaction(pool, limits, async (client) => {
    // 중첩 반복 조인을 끈다(이 트랜잭션 안에서만). 원본에 user_id 인덱스가 없어 중첩 반복은 단계 이벤트를 진입 사용자마다 다시 훑는다.
    // 통계가 없으면(새 파티션, autovacuum 전) 계획기가 진입 사용자를 몇 명으로 어림해 그것을 고른다: 3만 건에 39초, 통계가 있으면 31ms(5단계 PR).
    await client.query("select set_config('enable_nestloop', 'off', true)");
    // windowEnd(기간 끝 + 전환 기간)를 여기서 계산해 퍼널 문장에 매개변수로 넘긴다. 문장 안에서 더하면 STABLE이라 계획할 때 가지를 못 친다.
    // provisional: windowEnd가 최근 7일 안이면 늦은 이벤트가 더 올 수 있다.
    const range = await client.query<{ from: Date; to: Date; window_end: Date; retained_from: Date; provisional: boolean }>(
      `select ${START} as "from", ${END} as "to", w.window_end,
              ${retainedFromSql("$5", "$6")} as retained_from,
              w.window_end > coalesce($5::timestamptz, now()) - interval '7 days' as provisional
         from (select ${END} + make_interval(mins => $4::int) as window_end) w`,
      [q.from, q.to, q.timezone, q.windowMinutes, asOf ?? null, RETENTION_DAYS],
    );
    const { from, to, window_end: windowEnd, retained_from: retainedFrom, provisional } = range.rows[0]!;
    checkRetention(from, retainedFrom);
    const { text, values } = buildFunnelSql(q, windowEnd);
    const { rows } = await client.query(text, values);
    return {
      rows: toFunnelRows(q, rows),
      meta: {
        timezone: q.timezone,
        entry: "first" as const,
        rangeStart: from.toISOString(),
        rangeEnd: to.toISOString(),
        windowEnd: windowEnd.toISOString(),
        provisional,
      },
    };
  });
}

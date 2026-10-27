import { IngestEvent, type IngestResult } from "@event-analytics/shared";
import type pg from "pg";
import type { z } from "zod";

// 수집(DESIGN 6.1). 이벤트를 한 건씩 판단해 틀린 것만 거절하고, 나머지를 한 문장으로 넣는다.
// 중복은 기본 키 (event_id, occurred_at)와 ON CONFLICT DO NOTHING이 거른다. 같은 문장 안의 중복도 거른다.

const DAY_MS = 86_400_000;
const MAX_AGE_MS = 7 * DAY_MS;
const MAX_AHEAD_MS = 60 * 60_000;

// 다시 보내면 되는 실패. 라우트가 503으로 바꾼다.
export class IngestUnavailable extends Error {
  constructor(
    readonly code: "partition_missing" | "busy",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type Rejected = IngestResult["rejected"][number];

// 받을 기간: 지금 − 7일 ≤ at ≤ 지금 + 1시간(경계는 받는다, DESIGN 6.1).
export function outsideWindow(at: number, now: number): "too_old" | "too_far_in_future" | null {
  if (at < now - MAX_AGE_MS) return "too_old";
  if (at > now + MAX_AHEAD_MS) return "too_far_in_future";
  return null;
}
const WINDOW_MESSAGES = {
  too_old: "받을 기간(지금부터 7일 전까지)보다 앞입니다",
  too_far_in_future: "받을 기간(지금부터 1시간 뒤까지)보다 뒤입니다",
};
type Row = IngestEvent & { at: number };

// 어느 필드가 왜 틀렸는지(경로: 메시지). 모르는 필드는 경로가 비어 있어 메시지만 남는다.
const describe = (error: z.ZodError) =>
  error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");

// 키 순서로 넣는다. 겹치는 두 배치가 반대 순서로 넣으면 서로 상대의 키를 기다리는 교착이 난다(DESIGN 10장 23).
// 같은 키가 둘이면 배열에서 앞의 것(ord가 작은 것)이 남는다.
const INSERT = `
  insert into events (event_id, occurred_at, user_id, event_name, platform, country, channel, campaign, properties)
  select event_id, occurred_at, user_id, event_name, platform, country, channel, campaign, properties
    from unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[])
         with ordinality as x(event_id, occurred_at, user_id, event_name, platform, country, channel, campaign, properties, ord)
   order by event_id, occurred_at, ord
  on conflict (event_id, occurred_at) do nothing`;

export async function ingest(pool: pg.Pool, events: unknown[]): Promise<IngestResult> {
  const rejected: Rejected[] = [];
  const valid: { index: number; row: Row }[] = [];
  // 같은 배치에서 eventId마다 처음 본 시각. 다른 시각으로 또 오면 두 행이 되므로 뒤의 것을 거절한다(합격 기준 A1, DESIGN 10장 23).
  const firstSeen = new Map<string, { index: number; at: number }>();
  events.forEach((raw, index) => {
    const parsed = IngestEvent.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ index, reason: "invalid", message: describe(parsed.error) });
      return;
    }
    const at = Date.parse(parsed.data.occurredAt);
    const key = parsed.data.eventId.toLowerCase();
    const seen = firstSeen.get(key);
    if (seen && seen.at !== at) {
      rejected.push({
        index,
        reason: "invalid",
        message: `eventId: 같은 배치의 ${seen.index}번째 이벤트와 eventId가 같은데 시각이 다릅니다`,
      });
      return;
    }
    if (!seen) firstSeen.set(key, { index, at });
    valid.push({ index, row: { ...parsed.data, at } });
  });

  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new IngestUnavailable("busy", "DB 연결을 얻지 못했습니다. 잠시 뒤 다시 보내세요", { cause: err });
  }
  try {
    await client.query("begin");
    // 문장 5초, 잠금 대기 3초(마이그레이션 실행기의 1초보다 길게, DESIGN 6.1). SET LOCAL과 같아 트랜잭션이 끝나면 풀린다.
    // "지금"은 DB의 트랜잭션 시각이다(DESIGN 10장 16).
    const { rows } = await client.query<{ now: Date }>(
      "select set_config('statement_timeout', '5s', true), set_config('lock_timeout', '3s', true), now() as now",
    );
    const now = rows[0]!.now.getTime();
    const accepted: Row[] = [];
    for (const { index, row } of valid) {
      const reason = outsideWindow(row.at, now);
      if (reason) rejected.push({ index, reason, message: WINDOW_MESSAGES[reason] });
      else accepted.push(row);
    }
    let inserted = 0;
    if (accepted.length > 0) {
      const result = await client.query(INSERT, [
        accepted.map((e) => e.eventId),
        // 밀리초로 잘라 UTC 글자로 넘긴다. 재전송이 같은 시각을 밀리초로 다시 써도 같은 키가 된다(DESIGN 10장 17).
        accepted.map((e) => new Date(e.at).toISOString()),
        accepted.map((e) => e.userId),
        accepted.map((e) => e.eventName),
        accepted.map((e) => e.platform),
        accepted.map((e) => e.country ?? null),
        accepted.map((e) => e.channel ?? null),
        accepted.map((e) => e.campaign ?? null),
        accepted.map((e) => JSON.stringify(e.properties ?? {})),
      ]);
      inserted = result.rowCount ?? 0;
    }
    await client.query("commit");
    rejected.sort((a, b) => a.index - b.index);
    // 문장이 거르는 것은 충돌뿐이라, 받아들인 것 중 들어가지 않은 것은 모두 중복이다.
    return { received: events.length, inserted, duplicates: accepted.length - inserted, rejected };
  } catch (err) {
    // 연결이 끊겼으면 서버가 이미 되돌렸다. 원래 오류를 낸다.
    await client.query("rollback").catch(() => {});
    throw retryable(err) ?? err;
  } finally {
    client.release();
  }
}

// 파티션이 없으면 23514이고, 부모 표(events) 이름이 붙고 제약 이름이 없다(DESIGN 10장 20).
// CHECK 위반은 제약 이름이 있고, 파티션에 바로 넣다 경계를 벗어나면 파티션 이름이 붙는다.
function retryable(err: unknown) {
  const { code, constraint, table } = err as { code?: string; constraint?: string; table?: string };
  if (code === "23514" && !constraint && table === "events") {
    return new IngestUnavailable("partition_missing", "받을 기간 안인데 파티션이 없습니다. 잠시 뒤 다시 보내세요", { cause: err });
  }
  if (code === "55P03" || code === "40P01" || code === "57014") {
    return new IngestUnavailable("busy", "DB가 바빠 처리하지 못했습니다. 잠시 뒤 다시 보내세요", { cause: err });
  }
  return null;
}

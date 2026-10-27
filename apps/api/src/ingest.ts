import { IngestEvent, type IngestResult } from "@event-analytics/shared";
import type pg from "pg";
import type { z } from "zod";

// 수집(DESIGN 6.1). 이벤트를 한 건씩 판단해 틀린 것만 거절하고, 나머지를 한 문장으로 넣는다.
// 중복은 기본 키 (event_id, occurred_at)와 ON CONFLICT DO NOTHING이 거른다. 같은 문장 안의 중복도 거른다.

const DAY_MS = 86_400_000;
// 받을 기간: 지금 − 7일 ≤ occurred_at ≤ 지금 + 1시간(경계는 받는다).
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

// 어느 필드가 왜 틀렸는지(경로: 메시지). 모르는 필드는 경로가 비어 있어 메시지만 남는다.
const describe = (error: z.ZodError) =>
  error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");

const INSERT = `
  insert into events (event_id, occurred_at, user_id, event_name, platform, country, channel, campaign, properties)
  select * from unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[])
  on conflict (event_id, occurred_at) do nothing`;

export async function ingest(pool: pg.Pool, events: unknown[]): Promise<IngestResult> {
  const rejected: Rejected[] = [];
  const valid: { index: number; event: IngestEvent }[] = [];
  events.forEach((raw, index) => {
    const parsed = IngestEvent.safeParse(raw);
    if (parsed.success) valid.push({ index, event: parsed.data });
    else rejected.push({ index, reason: "invalid", message: describe(parsed.error) });
  });

  const client = await pool.connect();
  try {
    await client.query("begin");
    // 문장 5초, 잠금 대기 3초(마이그레이션 실행기의 1초보다 길게, DESIGN 6.1). SET LOCAL과 같아 트랜잭션이 끝나면 풀린다.
    // "지금"은 DB의 트랜잭션 시각이다(DESIGN 10장 16).
    const { rows } = await client.query<{ now: Date }>(
      "select set_config('statement_timeout', '5s', true), set_config('lock_timeout', '3s', true), now() as now",
    );
    const now = rows[0]!.now.getTime();
    const accepted: IngestEvent[] = [];
    for (const { index, event } of valid) {
      const at = Date.parse(event.occurredAt);
      if (at < now - MAX_AGE_MS) {
        rejected.push({ index, reason: "too_old", message: "받을 기간(지금부터 7일 전까지)보다 앞입니다" });
      } else if (at > now + MAX_AHEAD_MS) {
        rejected.push({ index, reason: "too_far_in_future", message: "받을 기간(지금부터 1시간 뒤까지)보다 뒤입니다" });
      } else {
        accepted.push(event);
      }
    }
    let inserted = 0;
    if (accepted.length > 0) {
      // 시각은 받은 글자 그대로 넘긴다(마이크로초가 남아야 재전송의 키가 같다, DESIGN 10장 17).
      const result = await client.query(INSERT, [
        accepted.map((e) => e.eventId),
        accepted.map((e) => e.occurredAt),
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
    return { received: events.length, inserted, duplicates: accepted.length - inserted, rejected };
  } catch (err) {
    // 연결이 끊겼으면 서버가 이미 되돌렸다. 원래 오류를 낸다.
    await client.query("rollback").catch(() => {});
    throw retryable(err) ?? err;
  } finally {
    client.release();
  }
}

// 파티션이 없으면 23514이고 제약 이름이 없다. CHECK 위반(같은 23514)은 제약 이름이 있다(DESIGN 10장 20).
function retryable(err: unknown) {
  const { code, constraint } = err as { code?: string; constraint?: string };
  if (code === "23514" && !constraint) {
    return new IngestUnavailable("partition_missing", "받을 기간 안인데 파티션이 없습니다. 잠시 뒤 다시 보내세요", { cause: err });
  }
  if (code === "55P03" || code === "40P01" || code === "57014") {
    return new IngestUnavailable("busy", "DB가 바빠 처리하지 못했습니다. 잠시 뒤 다시 보내세요", { cause: err });
  }
  return null;
}

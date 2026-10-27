import type { Dimension, ReportBucket, ReportQuery, ReportRow } from "@event-analytics/shared";

// 리포트 설정 → SQL(DESIGN 6.3, 10장 31~35). SQL 글자에는 아래 상수 표의 식별자만 들어가고, 설정의 값은 모두 매개변수로 넘긴다.

// 차원 이름 → 열 이름. 지금은 같지만, 설정의 글자가 SQL에 그대로 들어가지 않는다는 것을 이 표가 보장한다.
const COLUMNS: Record<Dimension, string> = {
  event_name: "event_name",
  platform: "platform",
  country: "country",
  channel: "channel",
  campaign: "campaign",
};
// 묶음 단위와 벽시계 글자 모양. total은 기간 전체가 한 묶음이다.
const UNITS = { hour: "hour", day: "day", week: "week" } as const;
const STEPS = { hour: "1 hour", day: "1 day", week: "1 week" } as const;
const LABELS = { hour: "YYYY-MM-DD HH24:MI", day: "YYYY-MM-DD", week: "YYYY-MM-DD" } as const;
const METRIC_ALIAS = { events: "m_events", users: "m_users" } as const;
// 시간 집계 표(UTC 정시)의 행을 그대로 묶을 수 있는 시간대: 정시가 UTC의 정시와 같은 곳(콜카타 +05:30만 아니다, DESIGN 10장 40).
const WHOLE_HOUR_TIMEZONES = new Set(["UTC", "Asia/Seoul", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles"]);

export type ReportSql = { text: string; values: unknown[] };
export type ReportSource = "rollup" | "raw";

// 이벤트만 묻고 시간대가 정수 시간 오프셋이면 집계 표, 아니면 원본(DESIGN 6.4 리포트).
export const reportSource = (q: ReportQuery): ReportSource =>
  q.metrics.every((m) => m === "events") && WHOLE_HOUR_TIMEZONES.has(q.timezone) ? "rollup" : "raw";

// 기간: 리포트 시간대의 from 0시 이상, to 다음 날 0시 미만($1 from, $2 to, $3 시간대). at time zone과 3인자 date_trunc는
// immutable이라 매개변수여도 계획할 때 상수가 되어 가지를 친다(이름 없는 문장, 10장 26). 리포트 실행(run.ts)도 이 식을 쓴다.
export const START = "($1::date::timestamp at time zone $3::text)";
export const END = "(($2::date + 1)::timestamp at time zone $3::text)";

// $1 from(날짜), $2 to(날짜), $3 시간대, $4… 필터 값 목록. 열 이름은 상수 표에서만 온다(설정의 글자를 SQL에 넣지 않는다).
// rollupWatermark: 있으면 집계 표 경로다(reportSource가 rollup일 때만 넘긴다). 리포트 트랜잭션(반복 읽기)에서 먼저 읽어
// 매개변수로 넘긴다. 같은 문장의 서브쿼리로 읽으면 계획할 때 값을 몰라 가지를 치지 못한다(하루 리포트도 파티션 91개를 계획, 코드 리뷰).
export function buildReportSql(q: ReportQuery, limit: number, rollupWatermark?: Date): ReportSql {
  if (rollupWatermark && reportSource(q) !== "rollup") throw new Error("집계 표로 셀 수 없는 리포트입니다");
  const values: unknown[] = [q.from, q.to, q.timezone];
  // null을 고르면 값이 없는 것도 남긴다(IN은 NULL과 맞지 않으므로 따로 묻는다). 집계 표에도 같은 열이 있다.
  const filters: string[] = [];
  for (const f of q.filters) {
    const col = COLUMNS[f.dimension];
    const present = f.values.filter((v) => v !== null);
    const conds: string[] = [];
    if (present.length > 0) {
      values.push(present);
      conds.push(`${col} = any($${values.length}::text[])`);
    }
    if (present.length < f.values.length) conds.push(`${col} is null`);
    filters.push(conds.length === 1 ? conds[0]! : `(${conds.join(" or ")})`);
  }
  const bucketOf = (col: string) => (q.granularity === "total" ? START : `date_trunc('${UNITS[q.granularity]}', ${col}, $3::text)`);
  const dims = q.dimensions.map((d, i) => `${COLUMNS[d]} as d${i}`);
  const dimCols = q.dimensions.map((_, i) => `d${i}`);
  // 안쪽 무리: 묶음 + 차원(+ 사용자)
  const groupBy = (extra = 0) => Array.from({ length: 1 + q.dimensions.length + extra }, (_, i) => String(i + 1)).join(", ");
  const where = (col: string, from: string, to: string) => [`${col} >= ${from}`, `${col} < ${to}`, ...filters].join(" and ");
  const wantsEvents = q.metrics.includes("events");

  let inner: string;
  if (rollupWatermark) {
    values.push(rollupWatermark);
    const wm = `$${values.length}::timestamptz`;
    // [시작, min(끝, 워터마크))는 집계 표, [max(시작, 워터마크), 끝)는 원본. 두 부분을 각각 묶은 뒤 합쳐 다시 묶는다.
    // 집계 표 쪽도 먼저 묶는다. 행 그대로 합치면 기간의 집계 행을 모두 정렬한다(90일이면 385만 행, 코드 리뷰).
    inner = [
      `select bucket${dimCols.map((c) => `, ${c}`).join("")}, sum(n) as m_events from (`,
      `  select ${[`${bucketOf("hour")} as bucket`, ...dims, "sum(events) as n"].join(", ")}`,
      `  from hourly_rollup where ${where("hour", START, `least(${END}, ${wm})`)}`,
      `  group by ${groupBy()}`,
      "  union all",
      `  select ${[`${bucketOf("occurred_at")} as bucket`, ...dims, "count(*) as n"].join(", ")}`,
      `  from events where ${where("occurred_at", `greatest(${START}, ${wm})`, END)}`,
      `  group by ${groupBy()}`,
      `) u group by ${groupBy()}`,
    ].join("\n");
  } else if (q.metrics.includes("users")) {
    // 고유 사용자: (묶음, 차원, 사용자)로 먼저 묶으면 그 단계가 병렬 부분 해시 집계가 된다. count(distinct)보다 4.6배 빠르다(10장 37).
    inner = [
      `select bucket${dimCols.map((c) => `, ${c}`).join("")}${wantsEvents ? ", sum(n) as m_events" : ""}, count(*) as m_users from (`,
      `  select ${[`${bucketOf("occurred_at")} as bucket`, ...dims, "user_id", "count(*) as n"].join(", ")}`,
      `  from events where ${where("occurred_at", START, END)}`,
      `  group by ${groupBy(1)}`,
      `) u group by ${groupBy()}`,
    ].join("\n");
  } else {
    inner = [
      `select ${[`${bucketOf("occurred_at")} as bucket`, ...dims, "count(*) as m_events"].join(", ")}`,
      `from events where ${where("occurred_at", START, END)}`,
      `group by ${groupBy()}`,
    ].join("\n");
  }
  const label = q.granularity === "total" ? "null::text" : `to_char(bucket at time zone $3::text, '${LABELS[q.granularity]}')`;
  const text = [
    `select bucket, ${label} as label${dimCols.map((c) => `, ${c}`).join("")}${q.metrics.map((m) => `, ${METRIC_ALIAS[m]}`).join("")}`,
    `from (${inner}) s`,
    `order by ${["bucket", ...dimCols].join(", ")}`,
    `limit ${Number(limit)}`,
  ].join("\n");
  return { text, values };
}

// 집계 표 경로의 meta.stale: 기간 안·워터마크 앞에 아직 다시 세지 않은 더러운 시간이 있는가.
export function buildStaleSql(q: ReportQuery, watermark: Date): ReportSql {
  return {
    text: `select exists (select 1 from dirty_hours where hour >= ${START} and hour < least(${END}, $4::timestamptz)) as stale`,
    values: [q.from, q.to, q.timezone, watermark],
  };
}

type RawRow = { bucket: Date; label: string | null; m_events?: number; m_users?: number } & Record<string, unknown>;

// 결과 행 → 응답 행. 요청한 지표만 싣는다. total의 label은 기간 글자다.
export function toReportRows(q: ReportQuery, rows: RawRow[]): ReportRow[] {
  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    label: r.label ?? `${q.from} ~ ${q.to}`,
    dimensions: Object.fromEntries(q.dimensions.map((d, i) => [d, (r[`d${i}`] as string | null) ?? null])),
    ...(q.metrics.includes("events") ? { events: Number(r.m_events) } : {}),
    ...(q.metrics.includes("users") ? { users: Number(r.m_users) } : {}),
  }));
}

// 기간의 모든 묶음(이벤트가 없는 것도). 4인자 generate_series는 시간대의 달력으로 한 칸씩 가므로 일광 절약 시간을 따른다.
// partial: 묶음이 기간 시작보다 앞서거나, 다음 묶음(그 시간대의 달력으로 한 칸 뒤)이 기간 끝을 넘는다.
// utc_offset_minutes: 그 순간의 시간대 오프셋(분). 일광 절약 시간이 끝나는 날의 두 01:00을 가린다.
export function buildBucketsSql(q: ReportQuery): ReportSql {
  const values = [q.from, q.to, q.timezone];
  const offset = (b: string) => `(extract(epoch from (${b} at time zone $3::text) - (${b} at time zone 'UTC'))::int / 60)`;
  if (q.granularity === "total") {
    // $2(끝)도 써야 매개변수의 형을 안다. 쓰지 않는 열로 둔다.
    const text = `select ${START} as bucket, null::text as label, ${offset(START)} as utc_offset_minutes, false as partial, ${END} as "end"`;
    return { text, values };
  }
  const unit = UNITS[q.granularity];
  const step = `interval '${STEPS[q.granularity]}'`;
  const text = [
    `select b as bucket, to_char(b at time zone $3::text, '${LABELS[q.granularity]}') as label, ${offset("b")} as utc_offset_minutes,`,
    `  (b < ${START} or ((b at time zone $3::text) + ${step}) at time zone $3::text > ${END}) as partial`,
    `from generate_series(date_trunc('${unit}', ${START}, $3::text), ${END} - interval '1 microsecond', ${step}, $3::text) as b`,
    "order by b",
  ].join("\n");
  return { text, values };
}

const formatOffset = (minutes: number) => {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};

type RawBucket = { bucket: Date; label: string | null; utc_offset_minutes: number; partial: boolean };

export function toReportBuckets(q: ReportQuery, rows: RawBucket[]): ReportBucket[] {
  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    label: r.label ?? `${q.from} ~ ${q.to}`,
    utcOffset: formatOffset(r.utc_offset_minutes),
    partial: r.partial,
  }));
}

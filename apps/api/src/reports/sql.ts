import type { Dimension, ReportQuery, ReportRow } from "@event-analytics/shared";

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
const LABELS = { hour: "YYYY-MM-DD HH24:MI", day: "YYYY-MM-DD", week: "YYYY-MM-DD" } as const;

export type ReportSql = { text: string; values: unknown[] };

// $1 from(날짜), $2 to(날짜), $3 시간대, $4… 필터 값 목록.
// 기간: 리포트 시간대의 from 0시 이상, to 다음 날 0시 미만. at time zone과 3인자 date_trunc는 immutable이라
// 매개변수여도 계획할 때 상수가 되어 가지를 친다(이름 없는 문장, 10장 26).
export function buildReportSql(q: ReportQuery, limit: number): ReportSql {
  const values: unknown[] = [q.from, q.to, q.timezone];
  const start = "($1::date::timestamp at time zone $3::text)";
  const end = "(($2::date + 1)::timestamp at time zone $3::text)";
  const bucket = q.granularity === "total" ? start : `date_trunc('${UNITS[q.granularity]}', occurred_at, $3::text)`;
  const dims = q.dimensions.map((d, i) => `${COLUMNS[d]} as d${i}`);
  const metrics = [
    ...(q.metrics.includes("events") ? ["count(*) as events"] : []),
    // 고유 사용자 수는 묶음마다 원본에서 정확히 센다. 요청하지 않으면 세지 않는다(가장 비싼 부분).
    ...(q.metrics.includes("users") ? ["count(distinct user_id) as users"] : []),
  ];
  const where = [`occurred_at >= ${start}`, `occurred_at < ${end}`];
  for (const f of q.filters) {
    values.push(f.values);
    where.push(`${COLUMNS[f.dimension]} = any($${values.length}::text[])`);
  }
  const groupBy = ["1", ...q.dimensions.map((_, i) => String(i + 2))];
  const dimCols = q.dimensions.map((_, i) => `d${i}`);
  const label = q.granularity === "total" ? "null::text" : `to_char(bucket at time zone $3::text, '${LABELS[q.granularity]}')`;
  const text = [
    `select bucket, ${label} as label${dimCols.map((c) => `, ${c}`).join("")}${q.metrics.map((m) => `, ${m}`).join("")}`,
    "from (",
    `  select ${[`${bucket} as bucket`, ...dims, ...metrics].join(", ")}`,
    "  from events",
    `  where ${where.join("\n    and ")}`,
    `  group by ${groupBy.join(", ")}`,
    ") s",
    `order by ${["bucket", ...dimCols].join(", ")}`,
    `limit ${Number(limit)}`,
  ].join("\n");
  return { text, values };
}

type RawRow = { bucket: Date; label: string | null; events?: number; users?: number } & Record<string, unknown>;

// 결과 행 → 응답 행. 요청한 지표만 싣는다. total의 label은 기간 글자다.
export function toReportRows(q: ReportQuery, rows: RawRow[]): ReportRow[] {
  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    label: r.label ?? `${q.from} ~ ${q.to}`,
    dimensions: Object.fromEntries(q.dimensions.map((d, i) => [d, (r[`d${i}`] as string | null) ?? null])),
    ...(q.metrics.includes("events") ? { events: Number(r.events) } : {}),
    ...(q.metrics.includes("users") ? { users: Number(r.users) } : {}),
  }));
}

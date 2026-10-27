// API와 화면이 함께 쓰는 요청·응답 스키마. API는 이 스키마로 검증·직렬화하고, 화면은 같은 타입을 쓴다.
import { z } from "zod";

export const HealthResponse = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const HealthUnavailable = z.object({ status: z.literal("unavailable") });

export const ErrorResponse = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ── 수집(DESIGN 6.1) ──

export const MAX_BATCH = 1_000;
export const MAX_PROPERTIES_BYTES = 4_096;
export const PLATFORMS = ["ios", "android", "web"] as const;

// PostgreSQL은 NUL(text 22021, jsonb 22P05)과 짝 없는 서로게이트(jsonb 22P02)를 받지 못해 배치 전체가 실패한다.
// 그래서 그런 글자가 든 이벤트만 거절한다(DESIGN 10장 18).
const storable = (value: string) => value.isWellFormed() && !value.includes("\u0000");
const STORABLE_MESSAGE = "NUL이나 짝 없는 서로게이트가 든 글자는 저장할 수 없습니다";
const Text = (max: number) => z.string().min(1).max(max).refine(storable, STORABLE_MESSAGE);

// properties 안의 키와 문자열 값을 모두 본다.
// properties의 키와 값을 반복문으로 본다. z.json()은 재귀로 검사해, 수천 단계로 중첩된 값에서 스택이 넘쳐
// 배치 전체가 500이 된다(리뷰가 재현함). 그래서 깊이를 먼저 막고, 그 뒤에 크기를 잰다(JSON.stringify도 재귀다).
// 객체·배열이 몇 겹인지 센다. properties 객체가 1단계다.
export const MAX_PROPERTIES_DEPTH = 10;
function propertiesIssue(properties: Record<string, unknown>): string | null {
  const stack: { value: unknown; depth: number }[] = [{ value: properties, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value === "string") {
      if (!storable(value)) return STORABLE_MESSAGE;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return "숫자가 너무 큽니다";
    } else if (value !== null && typeof value === "object") {
      if (depth > MAX_PROPERTIES_DEPTH) return `${MAX_PROPERTIES_DEPTH}단계보다 깊게 중첩할 수 없습니다`;
      if (Array.isArray(value)) {
        for (const inner of value) stack.push({ value: inner, depth: depth + 1 });
      } else {
        for (const [key, inner] of Object.entries(value)) {
          if (!storable(key)) return STORABLE_MESSAGE;
          stack.push({ value: inner, depth: depth + 1 });
        }
      }
    } else if (typeof value !== "boolean" && value !== null) {
      return "JSON 값이 아닙니다";
    }
  }
  // 화면(브라우저)도 이 스키마를 쓰므로 Buffer 대신 TextEncoder로 UTF-8 바이트를 센다.
  if (new TextEncoder().encode(JSON.stringify(properties)).length > MAX_PROPERTIES_BYTES) {
    return `JSON으로 ${MAX_PROPERTIES_BYTES}바이트까지입니다`;
  }
  return null;
}

const Properties = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const issue = propertiesIssue(value);
  if (issue) ctx.addIssue({ code: "custom", message: issue });
});

// 이벤트 이름. 퍼널의 단계와 리텐션의 시작·돌아옴 이벤트도 같은 규칙이다.
export const EventName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "영문 소문자로 시작하고 소문자·숫자·밑줄로 64자까지입니다");

// 모르는 필드는 거절한다(strict). 조용히 버리면 보내는 쪽의 오타(campain 등)가 데이터 손실이 된다.
export const IngestEvent = z.strictObject({
  // UUID 버전은 묻지 않는다. PostgreSQL uuid가 받는 하이픈 형식이면 된다.
  eventId: z.guid(),
  // 오프셋이 있어야 한다(Z, +09:00). 수집은 밀리초로 잘라 저장한다(DESIGN 10장 17).
  occurredAt: z.iso.datetime({ offset: true }),
  userId: Text(128),
  eventName: EventName,
  platform: z.enum(PLATFORMS),
  country: z.string().regex(/^[A-Z]{2}$/, "대문자 두 글자(ISO 3166-1)입니다").optional(),
  channel: Text(128).optional(),
  campaign: Text(128).optional(),
  properties: Properties.optional(),
});
export type IngestEvent = z.infer<typeof IngestEvent>;

// 봉투만 여기서 본다. 이벤트는 한 건씩 IngestEvent로 판단해, 틀린 것만 거절한다(DESIGN 10장 15).
export const IngestBatch = z.strictObject({
  events: z.array(z.unknown()).min(1).max(MAX_BATCH),
});

export const REJECT_REASONS = ["invalid", "too_old", "too_far_in_future"] as const;

export const IngestResult = z.object({
  received: z.number().int(),
  inserted: z.number().int(),
  duplicates: z.number().int(),
  rejected: z.array(
    z.object({
      index: z.number().int(),
      reason: z.enum(REJECT_REASONS),
      message: z.string(),
    }),
  ),
});
export type IngestResult = z.infer<typeof IngestResult>;

// 다시 보내면 되는 실패(503). partition_missing은 받을 기간 안인데 파티션이 없음, busy는 잠금·교착·시간 초과다.
export const IngestUnavailable = z.object({
  error: z.string(),
  code: z.enum(["partition_missing", "busy"]),
});

// ── 리포트(DESIGN 6.3) ──

export const METRICS = ["events", "users"] as const;
export const DIMENSIONS = ["event_name", "platform", "country", "channel", "campaign"] as const;
export const GRANULARITIES = ["hour", "day", "week", "total"] as const;
// 일광 절약 시간이 있는 곳(America/*, Europe/London)과 30분 단위 오프셋(Asia/Kolkata)이 들어 있다.
export const TIMEZONES = [
  "UTC",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
] as const;
// 보관 기간(90일)과 같다. 기간의 시작이 보관 기간보다 앞서면 422 out_of_retention이다.
export const MAX_REPORT_DAYS = 90;
// 90일 시간별 × 플랫폼(6,480행), 30일 일별 × 캠페인(6,030행)이 들어간다. 넘으면 잘라 주지 않고 422다.
export const MAX_REPORT_ROWS = 20_000;
export type Metric = (typeof METRICS)[number];
export type Dimension = (typeof DIMENSIONS)[number];

const distinct = <T>(items: T[]) => new Set(items).size === items.length;
// 날짜의 하한. zod는 0000년도 받지만 PostgreSQL date는 거절해(22008) 500이 된다. 보관 기간보다 훨씬 앞이라 실제로 막는 것은 없다.
const MIN_REPORT_DATE = "2000-01-01";
const ReportDate = z.iso.date().refine((d) => d >= MIN_REPORT_DATE, `${MIN_REPORT_DATE} 이후의 날짜입니다`);
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

// 값 목록 안에 있으면 남긴다(IN). null을 넣으면 값이 없는 것도 남긴다. 여러 필터는 모두 맞아야 한다(AND).
const filtersOf = <const D extends readonly [string, ...string[]]>(dimensions: D) =>
  z
    .array(z.strictObject({ dimension: z.enum(dimensions), values: z.array(Text(128).nullable()).min(1).max(100) }))
    .max(dimensions.length)
    .refine((filters) => distinct(filters.map((f) => f.dimension)), "같은 차원의 필터가 둘입니다")
    .default([]);

// 리포트 설정. 모든 이름은 허용 목록이고 모르는 필드는 거절한다. SQL에는 코드의 상수 식별자와 매개변수만 들어간다(10장 31~32).
export const ReportQuery = z
  .strictObject({
    metrics: z.array(z.enum(METRICS)).min(1).max(2).refine(distinct, "지표가 겹칩니다"),
    dimensions: z.array(z.enum(DIMENSIONS)).max(2).refine(distinct, "차원이 겹칩니다").default([]),
    filters: filtersOf(DIMENSIONS),
    // 리포트 시간대의 날짜, 둘 다 포함
    from: ReportDate,
    to: ReportDate,
    granularity: z.enum(GRANULARITIES),
    timezone: z.enum(TIMEZONES).default("Asia/Seoul"),
  })
  .refine((q) => q.from <= q.to, { message: "from이 to보다 늦습니다", path: ["from"] })
  .refine((q) => daysBetween(q.from, q.to) < MAX_REPORT_DAYS, { message: `기간은 ${MAX_REPORT_DAYS}일까지입니다`, path: ["to"] });
export type ReportQuery = z.infer<typeof ReportQuery>;

// 행에는 요청한 지표만 있다. bucket은 묶음의 시작 순간(UTC ISO), label은 리포트 시간대의 벽시계 글자다
// (hour: YYYY-MM-DD HH:MM, day·week: YYYY-MM-DD, total: from ~ to). 일광 절약 시간이 끝나는 날에는 같은 label이 둘이다(bucket이 다르다).
// users는 행끼리 더할 수 없다(같은 사람이 여러 묶음·차원 값에 나온다). 기간 전체의 사용자 수는 total, 차원 없이 묻는다.
export const ReportRow = z.object({
  bucket: z.string(),
  label: z.string(),
  dimensions: z.record(z.string(), z.string().nullable()),
  events: z.number().int().optional(),
  users: z.number().int().optional(),
});
export type ReportRow = z.infer<typeof ReportRow>;

// 기간의 모든 묶음(이벤트가 없는 것도). 화면은 이것으로 빈 묶음을 0으로 채운다.
// utcOffset으로 일광 절약 시간이 끝나는 날의 두 01:00을 가리고, partial은 기간 끝에서 일부만 찬 묶음이다.
export const ReportBucket = z.object({ bucket: z.string(), label: z.string(), utcOffset: z.string(), partial: z.boolean() });
export type ReportBucket = z.infer<typeof ReportBucket>;

export const ReportResult = z.object({
  rows: z.array(ReportRow),
  meta: z.object({
    timezone: z.enum(TIMEZONES),
    // 요청의 from·to(리포트 시간대의 날짜, 둘 다 포함)를 바꾼 순간(UTC ISO): rangeStart 이상, rangeEnd 미만
    rangeStart: z.string(),
    rangeEnd: z.string(),
    rowCount: z.number().int(),
    // rollup: 시간 집계 표(워터마크 앞) + 원본(워터마크 뒤). raw: 원본만(고유 사용자, 30분 단위 시간대)
    source: z.enum(["rollup", "raw"]),
    // rollup일 때의 워터마크(UTC ISO)
    rollupWatermark: z.string().nullable(),
    // 기간 안·워터마크 앞에 늦은 이벤트가 들어와 아직 다시 세지 않은 시간이 있다(다음 집계 작업까지 옛 값)
    stale: z.boolean(),
    // 끝이 최근 7일 안이면 늦은 이벤트가 더 올 수 있다(받을 기간 7일)
    provisional: z.boolean(),
    buckets: z.array(ReportBucket),
  }),
});
export type ReportResult = z.infer<typeof ReportResult>;

// 422: too_many_rows(묶음 × 차원 값이 너무 많음), out_of_retention(시작이 보관 기간보다 앞섬).
// 503: report_timeout(문장 한도), busy(잠금 대기·교착·연결 대기).
export const ReportFailure = z.object({
  error: z.string(),
  code: z.enum(["too_many_rows", "out_of_retention", "report_timeout", "busy"]),
});

// ── 퍼널과 리텐션(DESIGN 6.5) ──

// 퍼널·리텐션의 필터와 나눔에는 이벤트 이름이 없다(단계와 시작·돌아옴 이벤트가 이벤트 이름이다).
export const EVENT_DIMENSIONS = ["platform", "country", "channel", "campaign"] as const;
export const MAX_FUNNEL_STEPS = 6;
export const MAX_FUNNEL_WINDOW_MINUTES = 10_080;
export const MAX_RETENTION_COHORT_DAYS = 31;
export const MAX_RETENTION_DAYS = 30;

// 첫 진입 기준 전환: 사용자의 기간 안 첫 1단계가 진입이고, 뒤 단계는 앞 단계보다 엄격히 뒤의 첫 이벤트로
// [진입, 진입 + 전환 기간) 안이어야 한다. 필터는 모든 단계의 이벤트에, 나눔은 진입 이벤트의 값에 건다(10장 42~43).
export const FunnelQuery = z
  .strictObject({
    steps: z.array(EventName).min(2).max(MAX_FUNNEL_STEPS),
    windowMinutes: z.number().int().min(1).max(MAX_FUNNEL_WINDOW_MINUTES),
    filters: filtersOf(EVENT_DIMENSIONS),
    breakdown: z.array(z.enum(EVENT_DIMENSIONS)).max(1).default([]),
    from: ReportDate,
    to: ReportDate,
    timezone: z.enum(TIMEZONES).default("Asia/Seoul"),
  })
  .refine((q) => q.from <= q.to, { message: "from이 to보다 늦습니다", path: ["from"] })
  .refine((q) => daysBetween(q.from, q.to) < MAX_REPORT_DAYS, { message: `기간은 ${MAX_REPORT_DAYS}일까지입니다`, path: ["to"] });
export type FunnelQuery = z.infer<typeof FunnelQuery>;

// steps[i]는 i + 1단계까지 온 사용자 수다. 전환율은 화면이 나눈다. 나눔의 행은 서로 겹치지 않아 더하면 전체다.
export const FunnelResult = z.object({
  rows: z.array(z.object({ dimensions: z.record(z.string(), z.string().nullable()), steps: z.array(z.number().int()) })),
  meta: z.object({
    timezone: z.enum(TIMEZONES),
    // 첫 진입 기준 전환(다음 시도의 전환은 세지 않는다). 화면이 이 이름을 붙인다.
    entry: z.literal("first"),
    rangeStart: z.string(),
    rangeEnd: z.string(),
    // 기간 끝 + 전환 기간(UTC ISO). 지금보다 뒤면 전환 기간이 아직 끝나지 않은 진입이 "전환 안 함"으로 세어져 있다.
    windowEnd: z.string(),
    // windowEnd가 최근 7일 안이면 늦은 이벤트가 더 올 수 있다
    provisional: z.boolean(),
  }),
});
export type FunnelResult = z.infer<typeof FunnelResult>;

// 날마다 무리: 무리 d는 그날 시작 이벤트가 있는 사용자 전부이고, N일째는 d + N일에 돌아옴 이벤트가 있다(10장 45).
// 이벤트 이름이 없으면 모든 이벤트다. 필터는 시작과 돌아옴 이벤트 모두에 건다.
export const RetentionQuery = z
  .strictObject({
    startEvent: EventName.optional(),
    returnEvent: EventName.optional(),
    days: z.number().int().min(1).max(MAX_RETENTION_DAYS),
    filters: filtersOf(EVENT_DIMENSIONS),
    from: ReportDate,
    to: ReportDate,
    timezone: z.enum(TIMEZONES).default("Asia/Seoul"),
  })
  .refine((q) => q.from <= q.to, { message: "from이 to보다 늦습니다", path: ["from"] })
  .refine((q) => daysBetween(q.from, q.to) < MAX_RETENTION_COHORT_DAYS, {
    message: `무리의 기간은 ${MAX_RETENTION_COHORT_DAYS}일까지입니다`,
    path: ["to"],
  });
export type RetentionQuery = z.infer<typeof RetentionQuery>;

// 기간의 모든 날이 행이다. 무리끼리 더할 수 없다(한 사람이 여러 무리에 든다). returned[i]는 i + 1일째이고,
// 아직 다 지나지 않은 날의 칸은 null이다(0이면 "아무도 안 돌아왔다"로 읽힌다).
export const RetentionResult = z.object({
  rows: z.array(
    z.object({
      cohort: z.string(),
      cohortStart: z.string(),
      // 무리의 날이 아직 오지 않았으면 null
      users: z.number().int().nullable(),
      returned: z.array(z.number().int().nullable()),
    }),
  ),
  meta: z.object({
    timezone: z.enum(TIMEZONES),
    rangeStart: z.string(),
    rangeEnd: z.string(),
    days: z.number().int(),
    // 마지막 칸의 날의 끝(to + 1 + days일 자정)이 최근 7일 안이면 늦은 이벤트가 더 올 수 있다
    provisional: z.boolean(),
  }),
});
export type RetentionResult = z.infer<typeof RetentionResult>;

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
function storableJson(value: unknown): boolean {
  if (typeof value === "string") return storable(value);
  if (Array.isArray(value)) return value.every(storableJson);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([key, inner]) => storable(key) && storableJson(inner));
  }
  return true;
}

const Properties = z
  .record(z.string(), z.json())
  .refine(storableJson, STORABLE_MESSAGE)
  // 화면(브라우저)도 이 스키마를 쓰므로 Buffer 대신 TextEncoder로 UTF-8 바이트를 센다.
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_PROPERTIES_BYTES,
    `JSON으로 ${MAX_PROPERTIES_BYTES}바이트까지입니다`,
  );

// 모르는 필드는 거절한다(strict). 조용히 버리면 보내는 쪽의 오타(campain 등)가 데이터 손실이 된다.
export const IngestEvent = z.strictObject({
  // UUID 버전은 묻지 않는다. PostgreSQL uuid가 받는 하이픈 형식이면 된다.
  eventId: z.guid(),
  // 오프셋이 있어야 한다(Z, +09:00). 글자 그대로 DB에 넘긴다(DESIGN 10장 17).
  occurredAt: z.iso.datetime({ offset: true }),
  userId: Text(128),
  eventName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "영문 소문자로 시작하고 소문자·숫자·밑줄로 64자까지입니다"),
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

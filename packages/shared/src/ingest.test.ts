import { describe, expect, it } from "vitest";
import { IngestBatch, IngestEvent, MAX_PROPERTIES_BYTES } from "./index.js";

const base = {
  eventId: "0193a8a0-0000-7000-8000-000000000001",
  occurredAt: "2026-10-27T10:00:00Z",
  userId: "anon-1",
  eventName: "page_view",
  platform: "web",
};
const ok = (patch: Record<string, unknown>) => IngestEvent.safeParse({ ...base, ...patch }).success;
// 어느 필드가 틀렸는지 응답의 message에 싣는다(DESIGN 6.1). 경로가 잡히는지 본다.
const failedPath = (patch: Record<string, unknown>) =>
  IngestEvent.safeParse({ ...base, ...patch }).error?.issues.map((i) => i.path.join("."));

describe("IngestEvent", () => {
  it("필수 필드만으로, 그리고 선택 필드를 모두 채워도 통과한다", () => {
    expect(ok({})).toBe(true);
    expect(ok({ country: "KR", channel: "naver", campaign: "fall_sale", properties: { seat: "A-1", n: 2, ok: true, x: null, a: [1] } })).toBe(true);
  });

  it.each([
    ["Z", "2026-10-27T10:00:00Z", true],
    ["마이크로초", "2026-10-27T10:00:00.123456Z", true],
    ["+09:00", "2026-10-27T19:00:00+09:00", true],
    ["오프셋 없음", "2026-10-27T10:00:00", false],
    ["콜론 없는 오프셋", "2026-10-27T19:00:00+0900", false],
    ["날짜만", "2026-10-27", false],
    ["없는 날", "2026-02-30T10:00:00Z", false],
  ])("occurredAt %s → %s", (_, occurredAt, expected) => {
    expect(ok({ occurredAt })).toBe(expected);
  });

  it("eventId는 버전을 묻지 않고 하이픈 형식의 16진수면 된다", () => {
    expect(ok({ eventId: "8c2f1d1e-3b4a-4c5d-9e6f-7a8b9c0d1e2f" })).toBe(true);
    expect(ok({ eventId: "00000000-0000-0000-0000-000000000000" })).toBe(true);
    expect(failedPath({ eventId: "not-a-uuid" })).toEqual(["eventId"]);
  });

  it.each([
    ["eventName 대문자", { eventName: "PageView" }, "eventName"],
    ["eventName 65자", { eventName: `a${"b".repeat(64)}` }, "eventName"],
    ["platform", { platform: "tv" }, "platform"],
    ["country 소문자", { country: "kr" }, "country"],
    ["빈 userId", { userId: "" }, "userId"],
    ["129자 campaign", { campaign: "c".repeat(129) }, "campaign"],
    ["배열 properties", { properties: [1, 2] }, "properties"],
    ["모르는 필드", { campain: "typo" }, ""],
  ])("%s는 거절하고 그 필드를 가리킨다", (_, patch, path) => {
    expect(failedPath(patch)).toEqual([path]);
  });

  // PostgreSQL이 받지 못하는 글자(DESIGN 10장 18). 그대로 넘기면 배치 전체가 실패한다.
  it.each([
    ["userId의 NUL", { userId: `a${String.fromCharCode(0)}b` }, "userId"],
    ["campaign의 짝 없는 서로게이트", { campaign: `a${String.fromCharCode(0xd800)}` }, "campaign"],
    ["properties 값의 짝 없는 서로게이트", { properties: { k: [`x${String.fromCharCode(0xdc00)}`] } }, "properties"],
    ["properties 키의 NUL", { properties: { [`k${String.fromCharCode(0)}`]: 1 } }, "properties"],
  ])("%s는 거절한다", (_, patch, path) => {
    expect(failedPath(patch)).toEqual([path]);
  });

  it("짝이 맞는 서로게이트(이모지)와 한글은 받는다", () => {
    expect(ok({ userId: "사용자😀", properties: { "이름": "좌석😀" } })).toBe(true);
  });

  it(`properties는 JSON으로 ${MAX_PROPERTIES_BYTES}바이트까지다(글자 수가 아니라 UTF-8 바이트)`, () => {
    // {"k":"…"}는 8바이트 + 값. 한글 한 자는 3바이트다.
    const hangul = Math.floor((MAX_PROPERTIES_BYTES - 8) / 3);
    const fits = "가".repeat(hangul) + "a".repeat(MAX_PROPERTIES_BYTES - 8 - hangul * 3);
    expect(new TextEncoder().encode(JSON.stringify({ k: fits })).length).toBe(MAX_PROPERTIES_BYTES);
    expect(ok({ properties: { k: fits } })).toBe(true);
    expect(failedPath({ properties: { k: `${fits}a` } })).toEqual(["properties"]);
  });
});

describe("IngestBatch(봉투)", () => {
  it("1~1,000건의 배열만 받고, 이벤트 하나하나는 여기서 보지 않는다", () => {
    expect(IngestBatch.safeParse({ events: [{}] }).success).toBe(true);
    expect(IngestBatch.safeParse({ events: Array.from({ length: 1_000 }, () => ({})) }).success).toBe(true);
    expect(IngestBatch.safeParse({ events: [] }).success).toBe(false);
    expect(IngestBatch.safeParse({ events: Array.from({ length: 1_001 }, () => ({})) }).success).toBe(false);
    expect(IngestBatch.safeParse({ events: {} }).success).toBe(false);
    expect(IngestBatch.safeParse({ events: [{}], extra: 1 }).success).toBe(false);
  });
});

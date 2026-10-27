import { describe, expect, it } from "vitest";
import { FunnelQuery, RetentionQuery } from "./index.js";

// 퍼널·리텐션 설정도 허용 목록이다(DESIGN 6.5, 10장 43·46).
const funnel = { steps: ["performance_list_viewed", "seat_map_viewed"], windowMinutes: 60, from: "2026-10-01", to: "2026-10-31" };
const retention = { days: 7, from: "2026-10-01", to: "2026-10-31" };

describe("FunnelQuery", () => {
  it("기본값을 채운다(필터·나눔 없음, Asia/Seoul). 같은 이름이 다시 나와도 된다", () => {
    expect(FunnelQuery.parse(funnel)).toEqual({ ...funnel, filters: [], breakdown: [], timezone: "Asia/Seoul" });
    expect(FunnelQuery.safeParse({ ...funnel, steps: ["a", "a"] }).success).toBe(true);
  });

  it.each([
    ["단계 하나", { steps: ["a"] }],
    ["단계 일곱", { steps: ["a", "b", "c", "d", "e", "f", "g"] }],
    ["이벤트 이름 규칙 밖(SQL 글자)", { steps: ["a", "b'; drop table events; --"] }],
    ["전환 기간 0분", { windowMinutes: 0 }],
    ["전환 기간 7일 넘음", { windowMinutes: 10_081 }],
    ["전환 기간이 정수가 아님", { windowMinutes: 1.5 }],
    ["이벤트 이름 필터(단계가 이벤트 이름)", { filters: [{ dimension: "event_name", values: ["a"] }] }],
    ["이벤트 이름 나눔", { breakdown: ["event_name"] }],
    ["나눔 둘", { breakdown: ["platform", "channel"] }],
    ["91일", { from: "2026-08-02", to: "2026-10-31" }],
    ["모르는 필드", { entry: "any" }],
  ])("%s는 거절한다", (_, patch) => {
    expect(FunnelQuery.safeParse({ ...funnel, ...patch }).success).toBe(false);
  });
});

describe("RetentionQuery", () => {
  it("이벤트 이름이 없으면 모든 이벤트다", () => {
    expect(RetentionQuery.parse(retention)).toEqual({ ...retention, filters: [], timezone: "Asia/Seoul" });
  });

  it.each([
    ["0일째", { days: 0 }],
    ["31일째", { days: 31 }],
    ["무리 32일", { from: "2026-10-01", to: "2026-11-01" }],
    ["이벤트 이름 필터", { filters: [{ dimension: "event_name", values: ["a"] }] }],
    ["이벤트 이름 규칙 밖", { startEvent: "Page View" }],
    ["from이 to보다 늦음", { from: "2026-11-01" }],
  ])("%s는 거절한다", (_, patch) => {
    expect(RetentionQuery.safeParse({ ...retention, ...patch }).success).toBe(false);
  });

  it("무리 31일까지 받는다", () => {
    expect(RetentionQuery.safeParse({ ...retention, from: "2026-10-01", to: "2026-10-31" }).success).toBe(true);
  });
});

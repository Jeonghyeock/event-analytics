import { describe, expect, it } from "vitest";
import { ReportQuery } from "./index.js";

const base = { metrics: ["events"], from: "2026-10-01", to: "2026-10-31", granularity: "day" };
const ok = (patch: Record<string, unknown>) => ReportQuery.safeParse({ ...base, ...patch }).success;

// 리포트 설정은 허용 목록이다(DESIGN 6.3, 10장 31).
describe("ReportQuery", () => {
  it("기본값을 채운다(차원·필터 없음, Asia/Seoul)", () => {
    expect(ReportQuery.parse(base)).toEqual({ ...base, dimensions: [], filters: [], timezone: "Asia/Seoul" });
  });

  it.each([
    ["모르는 지표", { metrics: ["revenue"] }],
    ["겹친 지표", { metrics: ["events", "events"] }],
    ["지표 없음", { metrics: [] }],
    ["모르는 차원(SQL 글자)", { dimensions: ["platform; drop table events"] }],
    ["차원 셋", { dimensions: ["platform", "country", "channel"] }],
    ["겹친 차원", { dimensions: ["platform", "platform"] }],
    ["같은 차원의 필터 둘", { filters: [{ dimension: "platform", values: ["ios"] }, { dimension: "platform", values: ["web"] }] }],
    ["빈 필터 값 목록", { filters: [{ dimension: "platform", values: [] }] }],
    ["NUL이 든 필터 값", { filters: [{ dimension: "platform", values: [`a${String.fromCharCode(0)}`] }] }],
    ["허용 목록 밖의 시간대", { timezone: "Asia/Pyongyang" }],
    ["모르는 단위", { granularity: "month" }],
    ["없는 날", { from: "2026-02-30" }],
    ["0000년(PostgreSQL date가 거절)", { from: "0000-01-01", to: "0000-01-02" }],
    ["from이 to보다 늦음", { from: "2026-11-01" }],
    ["91일", { from: "2026-08-02", to: "2026-10-31" }],
    ["모르는 필드", { limit: 10 }],
  ])("%s는 거절한다", (_, patch) => {
    expect(ok(patch)).toBe(false);
  });

  it("90일, 차원 둘, 필터 다섯, 값 없음(null)을 고르는 필터는 받는다", () => {
    expect(ok({ from: "2026-08-03", to: "2026-10-31", dimensions: ["platform", "campaign"] })).toBe(true);
    expect(ok({ filters: [{ dimension: "campaign", values: [null, "camp_001"] }] })).toBe(true);
    const filters = ["event_name", "platform", "country", "channel", "campaign"].map((dimension) => ({ dimension, values: ["x"] }));
    expect(ok({ filters })).toBe(true);
  });
});

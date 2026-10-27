import { FunnelQuery, ReportQuery, RetentionQuery } from "@event-analytics/shared";
import { describe, expect, it } from "vitest";
import { equalWeights, reportMix, todayIn } from "./mix.js";

// S2 리포트 묶음(DESIGN 6.8). 설정이 API의 스키마를 지나야 k6가 400을 재지 않는다.
describe("S2 리포트 묶음", () => {
  const mix = reportMix("2026-10-28");
  const schemas = { "/reports/query": ReportQuery, "/funnels/query": FunnelQuery, "/retention/query": RetentionQuery };

  it("일곱 종류가 모두 그 경로의 스키마를 지나고, 몫은 3·2·2·2·1·1·2다", () => {
    expect(mix.map((k) => k.key)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    for (const kind of mix) expect(schemas[kind.path].safeParse(kind.body).success, kind.key).toBe(true);
    expect(mix.map((k) => k.weight)).toEqual([3, 2, 2, 2, 1, 1, 2]);
    expect(equalWeights(mix).every((k) => k.weight === 1)).toBe(true);
  });

  it("7만 시작한 날의 최근 7일이고, 1~6은 날짜가 고정이다", () => {
    expect(mix.at(-1)!.body).toMatchObject({ from: "2026-10-22", to: "2026-10-28" });
    const other = reportMix("2026-11-03");
    expect(other.slice(0, 6)).toEqual(mix.slice(0, 6));
  });

  it("리텐션은 돌아옴 범위가 데이터 끝(10-26) 안이다(오늘 파티션을 읽지 않는다)", () => {
    const retention = RetentionQuery.parse(mix.find((k) => k.key === "r6")!.body);
    const returnEnd = new Date(Date.parse(`${retention.to}T00:00:00Z`) + (1 + retention.days) * 86_400_000).toISOString().slice(0, 10);
    expect(returnEnd <= "2026-10-27").toBe(true);
  });

  it("리포트 시간대의 오늘", () => {
    expect(todayIn("Asia/Seoul", new Date("2026-10-27T15:30:00Z"))).toBe("2026-10-28");
    expect(todayIn("Asia/Seoul", new Date("2026-10-27T14:59:59Z"))).toBe("2026-10-27");
  });
});

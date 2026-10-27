import type { FunnelResult, RetentionResult } from "@event-analytics/shared";
import { describe, expect, it } from "vitest";
import { formatRate, stepViews, totalCounts, windowOpen } from "./funnel";
import { retentionRows } from "./retention";

// 퍼널·리텐션 응답 → 화면(DESIGN 6.7).
const funnelMeta: FunnelResult["meta"] = {
  timezone: "Asia/Seoul",
  entry: "first",
  rangeStart: "2026-10-19T15:00:00.000Z",
  rangeEnd: "2026-10-26T15:00:00.000Z",
  windowEnd: "2026-10-27T15:00:00.000Z",
  provisional: true,
  asOf: "2026-10-27T12:00:00.000Z",
};

describe("퍼널", () => {
  it("전환율은 앞 단계 대비와 1단계 대비이고, 나눌 수가 0이면 \"—\"다", () => {
    expect(stepViews(["a", "b", "c"], [200, 120, 0])).toEqual([
      { name: "a", users: 200, fromPrevious: null, fromFirst: null },
      { name: "b", users: 120, fromPrevious: 0.6, fromFirst: 0.6 },
      { name: "c", users: 0, fromPrevious: 0, fromFirst: 0 },
    ]);
    expect(stepViews(["a", "b"], [0, 0])[1]).toMatchObject({ fromPrevious: null, fromFirst: null });
    expect(formatRate(0.6)).toBe("60.0%");
    expect(formatRate(null)).toBe("—");
  });

  it("나눔의 행은 겹치지 않아 단계마다 더하면 전체다", () => {
    const result: FunnelResult = {
      rows: [
        { dimensions: { channel: "naver" }, steps: [3, 2, 1] },
        { dimensions: { channel: null }, steps: [11, 6, 1] },
      ],
      meta: funnelMeta,
    };
    expect(totalCounts(result, 3)).toEqual([14, 8, 2]);
  });

  it("전환 기간이 아직 끝나지 않은 진입은 서버의 \"지금\"으로 가린다", () => {
    expect(windowOpen(funnelMeta)).toBe(true);
    expect(windowOpen({ ...funnelMeta, windowEnd: "2026-10-27T11:00:00.000Z" })).toBe(false);
  });
});

describe("리텐션", () => {
  const meta: RetentionResult["meta"] = {
    timezone: "Asia/Seoul",
    rangeStart: "2026-10-24T15:00:00.000Z",
    rangeEnd: "2026-10-28T15:00:00.000Z",
    days: 2,
    today: "2026-10-27",
    provisional: true,
  };

  it("아직 지나지 않은 칸은 pending, 0명인 무리의 비율은 zero, 오늘의 무리는 진행 중, 오지 않은 날의 무리는 뺀다", () => {
    const rows = retentionRows({
      rows: [
        { cohort: "2026-10-25", cohortStart: "2026-10-24T15:00:00.000Z", users: 10, returned: [4, null] },
        { cohort: "2026-10-26", cohortStart: "2026-10-25T15:00:00.000Z", users: 0, returned: [0, null] },
        { cohort: "2026-10-27", cohortStart: "2026-10-26T15:00:00.000Z", users: 3, returned: [null, null] },
        { cohort: "2026-10-28", cohortStart: "2026-10-27T15:00:00.000Z", users: null, returned: [null, null] },
      ],
      meta,
    });
    expect(rows.map((r) => [r.cohort, r.current, r.cells.map((c) => c.state)])).toEqual([
      ["2026-10-25", false, ["known", "pending"]],
      ["2026-10-26", false, ["zero", "pending"]],
      ["2026-10-27", true, ["pending", "pending"]],
    ]);
    expect(rows[0]!.cells[0]).toEqual({ count: 4, rate: 0.4, state: "known" });
  });
});

import type { FunnelResult } from "@event-analytics/shared";
import { describe, expect, it } from "vitest";
import { formatRate, stepViews, totalCounts, windowLabel, windowOpen } from "./funnel";

// 퍼널 응답 → 화면(DESIGN 6.7).
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
  it("전환율은 앞 단계 대비와 1단계 대비이고(1단계는 앞 단계가 없고 1단계 대비 100%), 나눌 수가 0이면 \"—\"다", () => {
    expect(stepViews(["a", "b", "c"], [200, 120, 0])).toEqual([
      { name: "a", users: 200, fromPrevious: null, fromFirst: 1 },
      { name: "b", users: 120, fromPrevious: 0.6, fromFirst: 0.6 },
      { name: "c", users: 0, fromPrevious: 0, fromFirst: 0 },
    ]);
    expect(stepViews(["a", "b"], [0, 0])).toMatchObject([{ fromFirst: null }, { fromPrevious: null, fromFirst: null }]);
    // 앞 단계가 0이고 1단계는 0이 아니면: 앞 단계 대비만 0/0
    expect(stepViews(["a", "b", "c"], [10, 0, 0])[2]).toMatchObject({ fromPrevious: null, fromFirst: 0 });
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

  it("전환 기간 글자: 고를 것에 없는 값(저장한 설정)도 읽기 쉬운 단위로", () => {
    expect(windowLabel(60)).toBe("1시간");
    expect(windowLabel(120)).toBe("2시간");
    expect(windowLabel(2_880)).toBe("2일");
    expect(windowLabel(90)).toBe("90분");
  });
});

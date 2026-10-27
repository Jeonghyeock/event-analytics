import { describe, expect, it } from "vitest";
import { outsideWindow } from "./ingest.js";

// 받을 기간의 경계(DESIGN 6.1). DB 시각과 테스트의 시계가 달라 수집 테스트는 1분의 여유를 두므로, 경계 그 자체는 여기서 본다.
describe("받을 기간", () => {
  const now = Date.UTC(2026, 9, 27, 12);
  const day = 86_400_000;
  const hour = 3_600_000;

  it.each([
    ["7일 전 정각", now - 7 * day, null],
    ["7일 전보다 1ms 앞", now - 7 * day - 1, "too_old"],
    ["1시간 뒤 정각", now + hour, null],
    ["1시간 뒤보다 1ms 뒤", now + hour + 1, "too_far_in_future"],
    ["지금", now, null],
  ])("%s → %s", (_, at, expected) => {
    expect(outsideWindow(at, now)).toBe(expected);
  });
});

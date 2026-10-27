import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChartBucket } from "../lib/series";
import { TimeSeriesChart } from "./TimeSeriesChart";

// 시간 계열 그래프(DESIGN 6.7): 키보드로 묶음을 옮겨 읽고, 결과가 바뀌어 묶음이 줄어도 깨지지 않는다.
const bucketsOf = (n: number): ChartBucket[] =>
  Array.from({ length: n }, (_, i) => ({ bucket: `2026-10-${10 + i}T15:00:00.000Z`, label: `2026-10-${11 + i}`, state: "done", partial: false }));
const seriesOf = (n: number) => [{ key: "[]", label: "전체", color: "red", values: Array.from({ length: n }, (_, i) => i * 10) }];

describe("TimeSeriesChart", () => {
  it("포커스하면 마지막 묶음을, 화살표로 옮긴 묶음의 값을 읽어 준다", () => {
    render(<TimeSeriesChart title="이벤트 수" buckets={bucketsOf(5)} series={seriesOf(5)} />);
    const plot = screen.getByRole("group", { name: /이벤트 수 그래프/ });
    fireEvent.focus(plot);
    expect(document.querySelector("[aria-live]")!.textContent).toBe("2026-10-15: 전체 40");
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(document.querySelector("[aria-live]")!.textContent).toBe("2026-10-14: 전체 30");
  });

  it("툴팁이 떠 있는 채 묶음이 줄어도(앞의 결과를 보이며 다시 셈) 깨지지 않는다", () => {
    const { rerender } = render(<TimeSeriesChart title="이벤트 수" buckets={bucketsOf(30)} series={seriesOf(30)} />);
    fireEvent.focus(screen.getByRole("group", { name: /이벤트 수 그래프/ }));
    rerender(<TimeSeriesChart title="이벤트 수" buckets={bucketsOf(2)} series={seriesOf(2)} />);
    expect(screen.getByRole("group", { name: /이벤트 수 그래프/ })).toBeTruthy();
  });
});

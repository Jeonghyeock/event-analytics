import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { FunnelsPage } from "./FunnelsPage";

// 퍼널 화면(DESIGN 6.7): 단계는 이벤트 이름 목록에서 고르고, 전환율은 화면이 나눈다.
// "지금"은 2026-10-27 12:00 UTC다. 기본 기간은 한국 시각의 최근 7일(10-21~10-27)이다.
const reportMeta = {
  timezone: "Asia/Seoul",
  rangeStart: "2026-10-20T15:00:00.000Z",
  rangeEnd: "2026-10-27T15:00:00.000Z",
  rowCount: 2,
  source: "raw",
  rollupWatermark: null,
  stale: false,
  provisional: true,
  asOf: "2026-10-27T12:00:00.000Z",
  buckets: [],
};
const funnelMeta = {
  timezone: "Asia/Seoul",
  entry: "first",
  rangeStart: "2026-10-20T15:00:00.000Z",
  rangeEnd: "2026-10-27T15:00:00.000Z",
  windowEnd: "2026-10-27T16:00:00.000Z",
  provisional: true,
  asOf: "2026-10-27T12:00:00.000Z",
};

const funnelRequests: Record<string, unknown>[] = [];
let funnelBody: unknown;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  funnelRequests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url === "/api/reports/query") {
        // 이벤트 이름 목록
        const names = ["list_viewed", "seat_map_viewed", "paid"];
        const rows = names.map((n, i) => ({ bucket: reportMeta.rangeStart, label: "", dimensions: { event_name: n }, events: 100 - i }));
        return new Response(JSON.stringify({ rows, meta: reportMeta }));
      }
      funnelRequests.push(body);
      return new Response(JSON.stringify(funnelBody));
    }),
  );
});
afterEach(() => vi.useRealTimers());

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <FunnelsPage />
    </QueryClientProvider>,
  );
}

async function chooseSteps() {
  const steps = screen.getByRole("list", { name: "단계" });
  await within(steps).findAllByRole("option", { name: "list_viewed" });
  fireEvent.change(screen.getByLabelText("1단계"), { target: { value: "list_viewed" } });
  fireEvent.change(screen.getByLabelText("2단계"), { target: { value: "seat_map_viewed" } });
}

describe("FunnelsPage", () => {
  it("단계를 고르지 않으면 보내지 않는다", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect((await screen.findByRole("alert")).textContent).toContain("단계마다 이벤트를 고르세요");
    expect(funnelRequests).toHaveLength(0);
  });

  it("고른 단계·전환 기간을 보내고, 단계별 수와 전환율, 첫 진입 기준 설명, 열린 전환 기간을 보인다", async () => {
    funnelBody = { rows: [{ dimensions: {}, steps: [200, 120] }], meta: funnelMeta };
    renderPage();
    await chooseSteps();
    fireEvent.change(screen.getByLabelText("전환 기간"), { target: { value: "1440" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(funnelRequests[0]).toEqual({
      steps: ["list_viewed", "seat_map_viewed"],
      windowMinutes: 1440,
      filters: [],
      breakdown: [],
      timezone: "Asia/Seoul",
      from: "2026-10-21",
      to: "2026-10-27",
    });
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "단계사용자 수앞 단계 대비1단계 대비",
      "1. list_viewed200——",
      "2. seat_map_viewed12060.0%60.0%",
    ]);
    expect(screen.getByText(/첫 진입 기준 전환/)).toBeTruthy();
    expect(screen.getByText(/1일 안에 끝낸 사용자만/)).toBeTruthy();
    // windowEnd(16:00) > asOf(12:00)
    expect(screen.getByText("전환 기간이 아직 끝나지 않은 진입이 있음(더 늘 수 있음)")).toBeTruthy();
  });

  it("나눔이면 값마다 표와 합계 행(나눔의 행은 겹치지 않아 더할 수 있다)", async () => {
    funnelBody = {
      rows: [
        { dimensions: { channel: "naver" }, steps: [30, 10] },
        { dimensions: { channel: null }, steps: [70, 20] },
      ],
      meta: { ...funnelMeta, windowEnd: "2026-10-27T11:00:00.000Z" },
    };
    renderPage();
    await chooseSteps();
    fireEvent.change(screen.getByLabelText("나눔"), { target: { value: "channel" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    const table = await screen.findByRole("table", { name: "채널(진입 이벤트)로 나눔" });
    expect(within(table).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "채널1단계2단계끝까지",
      "naver301033.3%",
      "(없음)702028.6%",
      "합계1003030.0%",
    ]);
    // 전환 기간이 끝났으면 알리지 않는다
    expect(screen.queryByText(/전환 기간이 아직 끝나지 않은/)).toBeNull();
  });
});

import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { RetentionPage } from "./RetentionPage";

// 리텐션 화면(DESIGN 6.7): 표 하나. 빈칸은 아직 지나지 않은 날, "—"는 0명인 무리, 오늘의 무리는 진행 중이다.
const requests: Record<string, unknown>[] = [];
const retentionMeta = {
  timezone: "Asia/Seoul",
  rangeStart: "2026-10-24T15:00:00.000Z",
  rangeEnd: "2026-10-28T15:00:00.000Z",
  days: 2,
  today: "2026-10-27",
  provisional: true,
};
const defaultRows = [
  { cohort: "2026-10-25", cohortStart: "2026-10-24T15:00:00.000Z", users: 10, returned: [4, null] },
  { cohort: "2026-10-26", cohortStart: "2026-10-25T15:00:00.000Z", users: 0, returned: [0, null] },
  { cohort: "2026-10-27", cohortStart: "2026-10-26T15:00:00.000Z", users: 3, returned: [null, null] },
  { cohort: "2026-10-28", cohortStart: "2026-10-27T15:00:00.000Z", users: null, returned: [null, null] },
];
let retentionBody: unknown;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  requests.length = 0;
  retentionBody = { rows: defaultRows, meta: retentionMeta };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/saved-reports") return new Response(JSON.stringify({ items: [] }));
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url === "/api/reports/query") {
        // 이벤트 이름 목록
        const meta = {
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
        const rows = ["list_viewed", "paid"].map((n) => ({ bucket: meta.rangeStart, label: "", dimensions: { event_name: n }, events: 10 }));
        return new Response(JSON.stringify({ rows, meta }));
      }
      requests.push(body);
      return new Response(JSON.stringify(retentionBody));
    }),
  );
});
afterEach(() => vi.useRealTimers());

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/retention"]}>
        <RetentionPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RetentionPage", () => {
  it("기본 설정(한국 시각 최근 7일, 7일째까지, 모든 이벤트)을 보내고 무리 × N일째 표를 그린다", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(requests[0]).toEqual({ days: 7, filters: [], timezone: "Asia/Seoul", from: "2026-10-21", to: "2026-10-27" });
    const table = await screen.findByRole("table");
    // 오지 않은 날(10-28)의 무리는 빠지고, 빈칸은 아직 지나지 않은 날, "—"는 0명인 무리다. 명 수는 화면 읽기 프로그램에도 읽힌다.
    expect(within(table).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "무리의 날무리 크기1일째2일째",
      "2026-10-251040.0% (4명)",
      "2026-10-260—",
      "2026-10-27 진행 중3",
    ]);
    // 농도는 표의 가장 큰 비율이 가장 짙다(40%)
    expect(within(table).getByText("40.0%").closest("td")!.getAttribute("style")).toContain("var(--series-1) 40%");
    // 그날만 센다(누적이 아니다)
    expect(screen.getByText(/그날만 셉니다/)).toBeTruthy();
  });

  it("고른 이벤트·며칠째·기간을 보낸다", async () => {
    renderPage();
    await screen.findAllByRole("option", { name: "paid" });
    fireEvent.change(screen.getByLabelText("시작 이벤트"), { target: { value: "list_viewed" } });
    fireEvent.change(screen.getByLabelText("돌아옴 이벤트"), { target: { value: "paid" } });
    fireEvent.change(screen.getByLabelText("며칠째까지"), { target: { value: "30" } });
    await userEvent.click(screen.getByRole("button", { name: "최근 31일" }));
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(requests[0]).toEqual({
      days: 30,
      filters: [],
      timezone: "Asia/Seoul",
      startEvent: "list_viewed",
      returnEvent: "paid",
      from: "2026-09-27",
      to: "2026-10-27",
    });
  });

  it("무리의 기간이 31일을 넘으면 보내지 않고 까닭을 보인다", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("시작"), { target: { value: "2026-09-26" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect((await screen.findByRole("alert")).textContent).toContain("31일");
    expect(requests).toHaveLength(0);
  });

  it("같은 설정으로 다시 \"보기\"를 누르면 다시 센다", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
  });

  it("무리가 하나도 없으면 머리 행만 있는 표 대신 안내", async () => {
    retentionBody = { rows: defaultRows.slice(1, 2), meta: retentionMeta };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(await screen.findByText(/이 기간에 무리가 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

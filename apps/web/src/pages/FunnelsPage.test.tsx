import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { defaultFunnelForm, FunnelFormView } from "../components/FunnelForm";
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
// 참이면 이벤트 이름 목록(리포트 API)이 422로 실패한다.
let namesFail = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  funnelRequests.length = 0;
  namesFail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url === "/api/reports/query") {
        if (namesFail) {
          return new Response(JSON.stringify({ code: "out_of_retention", message: "보관 기간 밖입니다" }), { status: 422 });
        }
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
    // 1단계는 앞 단계가 없어 비우고, 1단계 대비는 100%다
    expect(within(table).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "단계사용자 수앞 단계 대비1단계 대비",
      "1. list_viewed200100.0%",
      "2. seat_map_viewed12060.0%60.0%",
    ]);
    expect(screen.getByText(/첫 진입 기준 전환/)).toBeTruthy();
    expect(screen.getByText(/1일 안에 끝낸 사용자만/)).toBeTruthy();
    // 비교 대상은 마지막 단계의 이름이다(늘 "결제"가 아니다)
    expect(screen.getByText(/"seat_map_viewed" 사용자 수 리포트보다/)).toBeTruthy();
    // windowEnd(16:00) > asOf(12:00)
    expect(screen.getByText("전환 기간이 아직 끝나지 않은 진입이 있음(더 늘 수 있음)")).toBeTruthy();
  });

  it("나눔이면 값마다 표(진입 수가 큰 값부터)와 합계 행(나눔의 행은 겹치지 않아 더할 수 있다)", async () => {
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
      "채널1단계2단계끝까지 전환율",
      "(없음)702028.6%",
      "naver301033.3%",
      "합계1003030.0%",
    ]);
    // 전환 기간이 끝났으면 알리지 않는다
    expect(screen.queryByText(/전환 기간이 아직 끝나지 않은/)).toBeNull();
  });

  it("진입이 0이면 빈 막대 대신 안내", async () => {
    funnelBody = { rows: [{ dimensions: {}, steps: [0, 0] }], meta: funnelMeta };
    renderPage();
    await chooseSteps();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(await screen.findByText("이 기간에 1단계(진입)가 없습니다. 기간이나 필터를 확인하세요.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("같은 설정으로 다시 \"보기\"를 누르면 다시 센다", async () => {
    funnelBody = { rows: [{ dimensions: {}, steps: [200, 120] }], meta: funnelMeta };
    renderPage();
    await chooseSteps();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await vi.waitFor(() => expect(funnelRequests).toHaveLength(2));
  });

  it("이벤트 목록을 못 읽으면 까닭을 알린다(고를 것이 없는 막다른 곳이 되지 않게)", async () => {
    namesFail = true;
    renderPage();
    expect(await screen.findAllByText("이벤트 목록을 읽지 못했습니다. 기간을 확인하세요.")).toHaveLength(2);
  });

  it("단계 더하기·빼기: 값의 순서가 남고, 뺀 자리의 단계로 포커스가 간다", async () => {
    renderPage();
    await chooseSteps();
    await userEvent.click(screen.getByRole("button", { name: "단계 더하기" }));
    fireEvent.change(screen.getByLabelText("3단계"), { target: { value: "paid" } });
    await userEvent.click(screen.getByRole("button", { name: "2단계 빼기" }));
    expect((screen.getByLabelText("1단계") as HTMLSelectElement).value).toBe("list_viewed");
    expect((screen.getByLabelText("2단계") as HTMLSelectElement).value).toBe("paid");
    expect(document.activeElement).toBe(screen.getByLabelText("2단계"));
    // 두 단계면 뺄 수 없다
    expect(screen.queryByRole("button", { name: /단계 빼기/ })).toBeNull();
  });
});

describe("FunnelFormView", () => {
  it("저장한 설정의 값이 고를 것에 없어도 보이는 값과 보내는 값이 같다", async () => {
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <FunnelFormView initial={{ ...defaultFunnelForm(), steps: ["list_viewed", "gone_event"], windowMinutes: 120 }} onSubmit={onSubmit} />
      </QueryClientProvider>,
    );
    const windowSelect = screen.getByLabelText("전환 기간") as HTMLSelectElement;
    expect(windowSelect.selectedOptions[0]!.textContent).toBe("2시간");
    // 이 기간 목록에 없는 단계 이벤트는 그대로 보이되 "(이 기간에 없음)"을 붙인다
    const step2 = screen.getByLabelText("2단계") as HTMLSelectElement;
    await vi.waitFor(() => expect(step2.selectedOptions[0]!.textContent).toBe("gone_event (이 기간에 없음)"));
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ steps: ["list_viewed", "gone_event"], windowMinutes: 120 }));
  });
});

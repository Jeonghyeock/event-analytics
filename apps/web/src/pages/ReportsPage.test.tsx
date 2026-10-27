import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { ReportsPage } from "./ReportsPage";

// 리포트 화면(DESIGN 6.7): 설정 → 요청 → 그래프와 표. 서버는 fetch를 바꿔 흉내 낸다.
// "지금"은 2026-10-27 12:00 UTC(한국 시각 21:00)다. 기본 기간은 한국 시각의 최근 7일(10-21~10-27)이다.
const day = (d: number) => ({ bucket: `2026-10-${d - 1}T15:00:00.000Z`, label: `2026-10-${d}`, utcOffset: "+09:00", partial: false });
const meta = {
  timezone: "Asia/Seoul",
  rangeStart: "2026-10-20T15:00:00.000Z",
  rangeEnd: "2026-10-27T15:00:00.000Z",
  rowCount: 3,
  source: "rollup",
  rollupWatermark: "2026-10-27T12:00:00.000Z",
  stale: false,
  provisional: true,
  asOf: "2026-10-27T12:00:00.000Z",
  buckets: [21, 22, 23, 24, 25, 26, 27].map(day),
};

type Handler = (body: Record<string, unknown>) => { status: number; body: unknown };
let handler: Handler;
const requests: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(body);
      const res = handler(body);
      return new Response(JSON.stringify(res.body), { status: res.status });
    }),
  );
});
afterEach(() => vi.useRealTimers());

function renderPage() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

describe("ReportsPage", () => {
  it("기본 설정(한국 시각 최근 7일, 일별, 이벤트 수)을 보내고 표와 그래프를 그린다", async () => {
    handler = () => ({
      status: 200,
      body: {
        rows: [
          { bucket: day(21).bucket, label: "2026-10-21", dimensions: {}, events: 120 },
          { bucket: day(27).bucket, label: "2026-10-27", dimensions: {}, events: 30 },
        ],
        meta,
      },
    });
    renderPage();
    expect(screen.getByText('설정을 고르고 "보기"를 누르세요.')).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(requests[0]).toEqual({
      metrics: ["events"],
      dimensions: [],
      filters: [],
      granularity: "day",
      timezone: "Asia/Seoul",
      from: "2026-10-21",
      to: "2026-10-27",
    });
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    // 머리, 행 둘, 합계. 오늘(10-27)은 진행 중이다
    expect(rows.map((r) => r.textContent)).toEqual(["묶음이벤트 수", "2026-10-21120", "2026-10-27 진행 중30", "합계150"]);
    expect(screen.getByRole("group", { name: /이벤트 수 그래프/ })).toBeTruthy();
    expect(screen.getByText("최근 7일이 들어 있어 늦은 이벤트가 더 올 수 있음")).toBeTruthy();
  });

  it("차원이 있으면 상위 N개와 기타, 사용자 수 탭은 기타 없이 숨긴 수를 적는다", async () => {
    const campaigns = ["a", "b", "c", "d", "e", "f", null];
    handler = () => ({
      status: 200,
      body: {
        rows: campaigns.map((c, i) => ({ bucket: day(21).bucket, label: "2026-10-21", dimensions: { campaign: c }, events: 100 - i, users: 10 })),
        meta,
      },
    });
    renderPage();
    fireEvent.click(screen.getByLabelText("사용자 수"));
    fireEvent.change(screen.getByLabelText("차원 1"), { target: { value: "campaign" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    const legend = await screen.findByRole("list", { name: "계열" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["a", "b", "c", "d", "e", "기타"]);
    expect(screen.getByText('값 2개를 "기타"로 더했습니다.')).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "사용자 수" }));
    expect(within(screen.getByRole("list", { name: "계열" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["a", "b", "c", "d", "e"]);
    expect(screen.getByText(/값 2개를 그래프에서 숨겼습니다/)).toBeTruthy();
    // 표는 모든 값을 보인다. 값이 없는 캠페인은 "(없음)"이다
    expect(within(screen.getByRole("table")).getByText("(없음)")).toBeTruthy();
  });

  it("422는 서버의 문장을 보이고 다시 하기가 없다, 503은 다시 하기가 있다", async () => {
    handler = () => ({ status: 422, body: { error: "보관 기간(90일) 밖입니다", code: "out_of_retention" } });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect((await screen.findByRole("alert")).textContent).toContain("보관 기간(90일) 밖입니다");
    expect(screen.queryByRole("button", { name: "다시 하기" })).toBeNull();

    handler = () => ({ status: 503, body: { error: "DB가 바빠 처리하지 못했습니다", code: "busy" } });
    fireEvent.change(screen.getByLabelText("시작"), { target: { value: "2026-10-22" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(await screen.findByRole("button", { name: "다시 하기" })).toBeTruthy();
  });

  it("틀린 설정은 보내지 않고 양식에 알린다", async () => {
    handler = () => ({ status: 200, body: { rows: [], meta } });
    renderPage();
    fireEvent.change(screen.getByLabelText("시작"), { target: { value: "2026-10-28" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect((await screen.findByRole("alert")).textContent).toContain("from이 to보다 늦습니다");
    expect(requests).toHaveLength(0);
  });

  it("필터의 값은 리포트 API로 읽은 목록에서 고르고, 값이 없는 것은 \"(없음)\"이다", async () => {
    handler = (body) =>
      body.granularity === "total"
        ? {
            status: 200,
            body: {
              rows: [
                { bucket: meta.rangeStart, label: "", dimensions: { channel: "naver" }, events: 5 },
                { bucket: meta.rangeStart, label: "", dimensions: { channel: null }, events: 9 },
              ],
              meta,
            },
          }
        : { status: 200, body: { rows: [], meta } };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "필터 더하기" }));
    fireEvent.change(screen.getByLabelText("차원"), { target: { value: "channel" } });
    const values = await screen.findByRole("list", { name: "채널 값" });
    // 많은 것부터
    expect(within(values).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["(없음) (9)", "naver (5)"]);
    await userEvent.click(within(values).getByLabelText(/\(없음\)/));
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(requests.at(-1)).toMatchObject({ filters: [{ dimension: "channel", values: [null] }] });
  });

  it("고른 필터 값이 기간을 바꿔 목록에서 사라져도 위에 보이고 풀 수 있다", async () => {
    // 10-22부터는 naver가 없다
    handler = (body) =>
      body.granularity === "total"
        ? {
            status: 200,
            body: {
              rows: (body.from === "2026-10-21" ? ["naver", "google"] : ["google"]).map((c) => ({ bucket: meta.rangeStart, label: "", dimensions: { channel: c }, events: 1 })),
              meta,
            },
          }
        : { status: 200, body: { rows: [], meta } };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "필터 더하기" }));
    fireEvent.change(screen.getByLabelText("차원"), { target: { value: "channel" } });
    await userEvent.click(await screen.findByLabelText(/^naver/));
    fireEvent.change(screen.getByLabelText("시작"), { target: { value: "2026-10-22" } });
    await screen.findByText("(이 기간에 없음)");
    const values = screen.getByRole("list", { name: "채널 값" });
    expect(within(values).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["naver (이 기간에 없음)", "google (1)"]);
    await userEvent.click(within(values).getByLabelText(/^naver/));
    expect(screen.getByText("값을 하나 이상 고르세요.")).toBeTruthy();
  });

  it("같은 설정으로 다시 \"보기\"를 누르면 다시 센다", async () => {
    handler = () => ({ status: 200, body: { rows: [], meta } });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await screen.findByText("이 기간에 이벤트가 없습니다.");
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
  });

  it("양식의 오류는 한국어로, 어느 칸인지 붙여 하나씩 알린다", async () => {
    handler = () => ({ status: 200, body: { rows: [], meta } });
    renderPage();
    fireEvent.click(screen.getByLabelText("이벤트 수"));
    await userEvent.click(screen.getByRole("button", { name: "필터 더하기" }));
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    const items = within(await screen.findByRole("alert")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toContain("필터: 값을 하나 이상 고르세요");
    expect(items.some((t) => t?.startsWith("지표: "))).toBe(true);
    expect(items.join(" ")).not.toMatch(/Too small|expected/);
    expect(requests.filter((r) => r.granularity !== "total")).toHaveLength(0);
  });
});

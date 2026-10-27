import type { SavedReport } from "@event-analytics/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { routes } from "../router";

// 저장한 리포트(DESIGN 6.7, 10장 52): 왼쪽 목록에서 열고, 보이는 결과의 설정을 저장한다. 서버는 fetch를 바꿔 흉내 낸 저장소다.
// "지금"은 2026-10-27 12:00 UTC다.
const ID = {
  daily: "00000000-0000-4000-8000-000000000001",
  hourly: "00000000-0000-4000-8000-000000000002",
  funnel: "00000000-0000-4000-8000-000000000003",
  broken: "00000000-0000-4000-8000-000000000004",
  oddValue: "00000000-0000-4000-8000-000000000005",
};
const reportConfig = (patch: Record<string, unknown> = {}) => ({
  metrics: ["events"],
  dimensions: [],
  filters: [],
  granularity: "day",
  timezone: "Asia/Seoul",
  from: "2026-10-21",
  to: "2026-10-27",
  ...patch,
});
const funnelConfig = {
  steps: ["list_viewed", "paid"],
  windowMinutes: 60,
  filters: [],
  breakdown: [],
  timezone: "Asia/Seoul",
  from: "2026-10-21",
  to: "2026-10-27",
};
const item = (id: string, name: string, kind: SavedReport["kind"], config: unknown, valid = true): SavedReport => ({
  id,
  name,
  kind,
  config,
  valid,
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
});

const reportMeta = {
  timezone: "Asia/Seoul",
  rangeStart: "2026-10-20T15:00:00.000Z",
  rangeEnd: "2026-10-27T15:00:00.000Z",
  rowCount: 1,
  source: "raw",
  rollupWatermark: null,
  stale: false,
  provisional: true,
  asOf: "2026-10-27T12:00:00.000Z",
  buckets: [{ bucket: "2026-10-20T15:00:00.000Z", label: "2026-10-21", utcOffset: "+09:00", partial: false }],
};

let store: SavedReport[];
// 리포트·퍼널 요청(이벤트 이름 목록은 빼고)과 저장한 리포트 쓰기
let runs: { path: string; body: Record<string, unknown> }[];
let writes: { method: string; path: string; body?: unknown }[];
let reportFailure: { status: number; body: unknown } | null;
let listFails: boolean;
// 저장한 리포트 쓰기(hold)와 리포트 세기(holdRuns)의 응답을 붙잡아 둔다(기다리는 사이의 일을 보려고). 풀면 응답이 나간다.
let hold: Promise<void> | null;
let holdRuns: Promise<void> | null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  store = [
    item(ID.daily, "일별 이벤트", "report", reportConfig()),
    item(ID.hourly, "시간별 이벤트", "report", reportConfig({ granularity: "hour", from: "2026-10-27" })),
    item(ID.funnel, "결제 퍼널", "funnel", funnelConfig),
    // 서버가 이미 맞지 않다고 한 옛 설정
    item(ID.broken, "옛 리포트", "report", { metrics: ["sessions"] }, false),
    // 서버는 맞다고 했지만 화면의 지금 스키마에는 맞지 않는 것(화면이 열 때 다시 검사한다)
    item(ID.oddValue, "분 단위 리포트", "report", reportConfig({ granularity: "minute" })),
  ];
  runs = [];
  writes = [];
  reportFailure = null;
  listFails = false;
  hold = null;
  holdRuns = null;
  let next = 100;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
      if (url === "/api/saved-reports" && method === "GET") {
        if (listFails) return json({ error: "서버 오류" }, 500);
        return json({ items: store.toSorted((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())) });
      }
      if (url.startsWith("/api/saved-reports")) {
        writes.push({ method, path: url, body });
        if (hold) await hold;
        const id = url.split("/")[3];
        const taken = (name: unknown, except?: string) => store.some((i) => i.name === name && i.id !== except);
        if (method === "POST") {
          if (taken(body!.name)) return json({ error: "같은 이름이 있습니다", code: "name_taken" }, 409);
          const created = item(`00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`, String(body!.name), body!.kind as SavedReport["kind"], body!.config);
          store.push(created);
          return json({ item: created }, 201);
        }
        const found = store.find((i) => i.id === id);
        if (!found) return json({ error: "없습니다", code: "not_found" }, 404);
        if (method === "PUT") {
          if (taken(body!.name, id)) return json({ error: "같은 이름이 있습니다", code: "name_taken" }, 409);
          Object.assign(found, { name: body!.name, kind: body!.kind, config: body!.config, valid: true });
          return json({ item: found });
        }
        store = store.filter((i) => i.id !== id);
        return new Response(null, { status: 204 });
      }
      if (url === "/api/reports/query") {
        const dimensions = (body!.dimensions as string[] | undefined) ?? [];
        // 단계 고르기의 이벤트 이름 목록
        if (dimensions[0] === "event_name") {
          const rows = ["list_viewed", "paid"].map((n) => ({ bucket: reportMeta.rangeStart, label: "", dimensions: { event_name: n }, events: 10 }));
          return json({ rows, meta: reportMeta });
        }
        runs.push({ path: url, body: body! });
        if (holdRuns) await holdRuns;
        if (reportFailure) return json(reportFailure.body, reportFailure.status);
        return json({ rows: [{ bucket: reportMeta.rangeStart, label: "2026-10-21", dimensions: {}, events: 42 }], meta: reportMeta });
      }
      runs.push({ path: url, body: body! });
      const funnelMeta = {
        timezone: "Asia/Seoul",
        entry: "first",
        rangeStart: reportMeta.rangeStart,
        rangeEnd: reportMeta.rangeEnd,
        windowEnd: "2026-10-27T16:00:00.000Z",
        provisional: true,
        asOf: reportMeta.asOf,
      };
      return json({ rows: [{ dimensions: {}, steps: [10, 4] }], meta: funnelMeta });
    }),
  );
});
afterEach(() => vi.useRealTimers());

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const savedList = () => screen.getByRole("navigation", { name: "저장한 리포트" });
const nameInput = () => screen.getByLabelText("저장할 이름") as HTMLInputElement;
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
// 화면 읽기 프로그램이 읽는 알림 자리(늘 있다)
const announced = () => screen.getByRole("status").textContent;

async function viewAndName(name: string) {
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await screen.findByRole("table");
  fireEvent.change(nameInput(), { target: { value: name } });
}

describe("왼쪽 목록", () => {
  it("이름 순으로 종류와 함께 보이고, 맞지 않는 옛 설정에는 \"열 수 없음\"을 붙인다", async () => {
    renderAt("/reports");
    const links = await within(savedList()).findAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "결제 퍼널, 퍼널",
      "분 단위 리포트, 리포트",
      "시간별 이벤트, 리포트",
      "옛 리포트, 리포트 · 열 수 없음",
      "일별 이벤트, 리포트",
    ]);
    expect(links[0]!.getAttribute("href")).toBe(`/funnels?saved=${ID.funnel}`);
  });

  it("없으면 저장하는 방법을 알린다", async () => {
    store = [];
    renderAt("/reports");
    expect(await within(savedList()).findByText("아직 없습니다. 결과를 본 뒤 저장하세요.")).toBeTruthy();
  });

  it("목록을 못 읽으면 알리고 다시 할 수 있다", async () => {
    listFails = true;
    renderAt("/reports");
    expect(await within(savedList()).findByText(/목록을 읽지 못했습니다/)).toBeTruthy();
    listFails = false;
    await userEvent.click(within(savedList()).getByRole("button", { name: "다시 하기" }));
    expect(await within(savedList()).findByRole("link", { name: /일별 이벤트/ })).toBeTruthy();
  });

  it("지금 연 것은 그 종류의 화면에서만 표시한다(다른 화면에 퍼널의 id를 붙인 주소는 연 것이 아니다)", async () => {
    renderAt(`/reports?saved=${ID.funnel}`);
    await within(savedList()).findAllByRole("link");
    expect(within(savedList()).queryByRole("link", { current: "page" })).toBeNull();
  });
});

describe("열기", () => {
  it("목록에서 열면 그 설정으로 양식을 채우고 바로 센다. 다른 것을 열면 양식이 그것으로 바뀐다", async () => {
    renderAt("/reports");
    await userEvent.click(await within(savedList()).findByRole("link", { name: /시간별 이벤트/ }));
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(runs.at(-1)!.body).toEqual(reportConfig({ granularity: "hour", from: "2026-10-27" }));
    expect(select("단위").value).toBe("hour");
    expect(nameInput().value).toBe("시간별 이벤트");
    expect(within(savedList()).getByRole("link", { current: "page" }).textContent).toContain("시간별 이벤트");
    expect(screen.queryByText("저장 안 된 변경")).toBeNull();

    await userEvent.click(within(savedList()).getByRole("link", { name: /일별 이벤트/ }));
    await vi.waitFor(() => expect(select("단위").value).toBe("day"));
    expect(nameInput().value).toBe("일별 이벤트");
    await vi.waitFor(() => expect(runs.at(-1)!.body).toEqual(reportConfig()));
  });

  it("연 것을 목록에서 다시 누르면 고친 양식이 저장한 설정으로 돌아간다", async () => {
    renderAt(`/reports?saved=${ID.daily}`);
    await screen.findByRole("table");
    fireEvent.change(select("단위"), { target: { value: "week" } });
    await userEvent.click(within(savedList()).getByRole("link", { name: /일별 이벤트/ }));
    await vi.waitFor(() => expect(select("단위").value).toBe("day"));
  });

  it("퍼널은 퍼널 화면에서 열고 그 설정으로 센다", async () => {
    const router = renderAt("/reports");
    await userEvent.click(await within(savedList()).findByRole("link", { name: /결제 퍼널/ }));
    expect(router.state.location.pathname).toBe("/funnels");
    expect(await screen.findByRole("heading", { name: "퍼널" })).toBeTruthy();
    await vi.waitFor(() => expect(runs.at(-1)).toMatchObject({ path: "/api/funnels/query", body: { steps: ["list_viewed", "paid"] } }));
  });

  it("서버가 맞지 않다고 한 옛 설정은 열지 않고 내용과 지우기만 보인다", async () => {
    renderAt(`/reports?saved=${ID.broken}`);
    expect((await screen.findByRole("alert")).textContent).toContain("설정이 바뀌어 열 수 없습니다");
    expect(screen.getByText(/"sessions"/)).toBeTruthy();
    expect(screen.queryByRole("form", { name: "리포트 설정" })).toBeNull();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(screen.getByRole("button", { name: "지우기" })).toBeTruthy();
    expect(runs).toHaveLength(0);
  });

  it("서버는 맞다고 했어도 화면의 지금 스키마에 맞지 않으면 열지 않는다", async () => {
    renderAt(`/reports?saved=${ID.oddValue}`);
    expect((await screen.findByRole("alert")).textContent).toContain("설정이 바뀌어 열 수 없습니다");
    expect(runs).toHaveLength(0);
  });

  it("없는 id는 알리고 새 설정으로 둔다", async () => {
    renderAt("/reports?saved=00000000-0000-4000-8000-0000000000ff");
    expect(await screen.findByText(/저장한 리포트를 찾을 수 없습니다/)).toBeTruthy();
    expect(screen.getByRole("form", { name: "리포트 설정" })).toBeTruthy();
  });

  it("다른 종류의 id면 그 화면으로 가는 길을 준다", async () => {
    renderAt(`/reports?saved=${ID.funnel}`);
    const link = await screen.findByRole("link", { name: "퍼널 화면에서 열기" });
    expect(link.getAttribute("href")).toBe(`/funnels?saved=${ID.funnel}`);
    expect(runs).toHaveLength(0);
  });

  it("저장한 기간 그대로 셀 때 보관 기간을 지났으면(422) 날짜를 고치라고 덧붙인다(설정을 바꾼 뒤의 422에는 아니다)", async () => {
    reportFailure = { status: 422, body: { error: "보관 기간(90일) 밖입니다.", code: "out_of_retention" } };
    renderAt(`/reports?saved=${ID.daily}`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("보관 기간(90일) 밖입니다.");
    expect(alert.textContent).toContain("위에서 날짜를 고친 뒤");
    fireEvent.change(select("단위"), { target: { value: "week" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).not.toContain("위에서 날짜를 고친 뒤"));
  });
});

describe("저장", () => {
  it("결과가 나오기 전에는 저장할 수 없고, 까닭이 단추에 이어진다", async () => {
    renderAt("/reports");
    const button = (await screen.findByRole("button", { name: "저장" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("결과가 나온 뒤 저장할 수 있습니다.");
  });

  it("보이는 결과의 설정을 새로 저장하면 그 리포트를 연 화면이 되고(주소를 바꿔 넣음), 알리고, 제목으로 포커스를 옮긴다", async () => {
    const router = renderAt("/reports");
    await viewAndName("  새 리포트 ");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await vi.waitFor(() => expect(router.state.location.search).toMatch(/^\?saved=/));
    expect(router.state.historyAction).toBe("REPLACE");
    // 이름은 앞뒤 공백을 자르고, 설정은 검사를 거친 값(기본값이 채워진 것)이다
    expect(writes).toEqual([{ method: "POST", path: "/api/saved-reports", body: { kind: "report", name: "새 리포트", config: reportConfig() } }]);
    await vi.waitFor(() => expect(announced()).toBe('"새 리포트"을(를) 저장했습니다.'));
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "리포트" })));
    expect(within(savedList()).getByRole("link", { current: "page" }).textContent).toContain("새 리포트");
    expect(nameInput().value).toBe("새 리포트");
    // 그 뒤 다른 설정으로 보면 "저장했습니다" 대신 "저장 안 된 변경"이다
    fireEvent.change(select("단위"), { target: { value: "week" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(await screen.findByText("저장 안 된 변경")).toBeTruthy();
    expect(screen.getByRole("form", { name: "저장" }).textContent).not.toContain("저장했습니다");
  });

  it("다른 설정으로 세는 동안에는 저장할 수 없다(흐린 앞의 결과는 저장하지 않는다)", async () => {
    renderAt(`/reports?saved=${ID.daily}`);
    await screen.findByRole("table");
    const saveButton = () => screen.getByRole("button", { name: "저장" }) as HTMLButtonElement;
    expect(saveButton().disabled).toBe(false);
    let release!: () => void;
    holdRuns = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.change(select("단위"), { target: { value: "week" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    // 세는 중에도 바뀐 것은 바로 알린다
    expect(screen.getByText("저장 안 된 변경")).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    release();
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
  });

  it("저장 알림은 그 리포트를 보는 동안만이다(다른 것을 열었다 돌아오면 없다)", async () => {
    renderAt("/reports");
    await viewAndName("알림 리포트");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await vi.waitFor(() => expect(announced()).toContain("저장했습니다"));
    await userEvent.click(within(savedList()).getByRole("link", { name: /일별 이벤트/ }));
    await vi.waitFor(() => expect(nameInput().value).toBe("일별 이벤트"));
    expect(announced()).toBe("");
    await userEvent.click(within(savedList()).getByRole("link", { name: /알림 리포트/ }));
    await vi.waitFor(() => expect(nameInput().value).toBe("알림 리포트"));
    expect(announced()).toBe("");
    expect(screen.queryByText(/저장했습니다/)).toBeNull();
  });

  it("이름이 비면 보내지 않는다", async () => {
    renderAt("/reports");
    await viewAndName("");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByText(/^이름: /)).textContent).toBe("이름: 이름을 쓰세요");
    expect(writes).toHaveLength(0);
  });

  it("연 뒤 다른 설정으로 보면 \"저장 안 된 변경\"이고, 저장하면(PUT) 사라진다", async () => {
    renderAt(`/reports?saved=${ID.daily}`);
    await screen.findByRole("table");
    fireEvent.change(select("단위"), { target: { value: "week" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(await screen.findByText("저장 안 된 변경")).toBeTruthy();
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await vi.waitFor(() => expect(screen.queryByText("저장 안 된 변경")).toBeNull());
    expect(writes).toEqual([{ method: "PUT", path: `/api/saved-reports/${ID.daily}`, body: { kind: "report", name: "일별 이벤트", config: reportConfig({ granularity: "week" }) } }]);
    expect(announced()).toBe('"일별 이벤트"을(를) 저장했습니다.');
  });

  it("연 것을 다른 이름으로 저장하면 새 리포트가 된다(퍼널)", async () => {
    const router = renderAt(`/funnels?saved=${ID.funnel}`);
    await screen.findByRole("table");
    fireEvent.change(nameInput(), { target: { value: "결제 퍼널 2" } });
    await userEvent.click(screen.getByRole("button", { name: "다른 이름으로 저장" }));
    await vi.waitFor(() => expect(router.state.location.search).not.toBe(`?saved=${ID.funnel}`));
    expect(writes).toEqual([{ method: "POST", path: "/api/saved-reports", body: { kind: "funnel", name: "결제 퍼널 2", config: funnelConfig } }]);
    expect(router.state.location.pathname).toBe("/funnels");
  });

  it("이름을 그대로 두고 다른 이름으로 저장하면 자기 자신을 덮어쓰라고 하지 않는다", async () => {
    renderAt(`/reports?saved=${ID.daily}`);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "다른 이름으로 저장" }));
    expect((await screen.findByRole("alert")).textContent).toContain("지금 연 리포트의 이름입니다");
    expect(screen.queryByRole("button", { name: "덮어쓰기" })).toBeNull();
  });

  it("이름이 같은 리포트가 있으면(409) 덮어쓰기를 권하고, 덮어쓰면 그 리포트를 연 화면이 된다", async () => {
    const router = renderAt("/reports");
    await viewAndName("시간별 이벤트");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toContain("같은 이름의 리포트가 있습니다");
    await userEvent.click(screen.getByRole("button", { name: "덮어쓰기" }));
    await vi.waitFor(() => expect(router.state.location.search).toBe(`?saved=${ID.hourly}`));
    expect(writes.at(-1)).toEqual({ method: "PUT", path: `/api/saved-reports/${ID.hourly}`, body: { kind: "report", name: "시간별 이벤트", config: reportConfig() } });
  });

  it("다른 종류가 그 이름을 쓰면 덮어쓰기를 권하지 않는다(덮으면 그 퍼널이 사라진다)", async () => {
    renderAt("/reports");
    await viewAndName("결제 퍼널");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toContain('이 이름은 퍼널 "결제 퍼널"에서 쓰고 있습니다');
    expect(screen.queryByRole("button", { name: "덮어쓰기" })).toBeNull();
  });

  it("연 것의 이름을 다른 리포트의 이름으로 바꾸면(409) 다른 이름을 고르게 한다", async () => {
    renderAt(`/reports?saved=${ID.daily}`);
    await screen.findByRole("table");
    fireEvent.change(nameInput(), { target: { value: "시간별 이벤트" } });
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toContain("이 이름은 이미 있습니다");
    expect(screen.queryByRole("button", { name: "덮어쓰기" })).toBeNull();
  });

  it("연 것이 그 사이 지워졌으면(PUT 404) 보던 설정과 결과를 두고 새로 저장하게 한다", async () => {
    renderAt(`/reports?saved=${ID.daily}`);
    await screen.findByRole("table");
    fireEvent.change(select("단위"), { target: { value: "week" } });
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(false));
    store = store.filter((i) => i.id !== ID.daily);
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    expect((await screen.findByRole("alert")).textContent).toContain("그 사이 지워졌습니다");
    expect(select("단위").value).toBe("week");
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("저장을 기다리는 사이 다른 것을 열면, 저장이 끝나도 그 화면을 빼앗지 않는다", async () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const router = renderAt("/reports");
    await viewAndName("늦은 저장");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    await userEvent.click(within(savedList()).getByRole("link", { name: /시간별 이벤트/ }));
    await vi.waitFor(() => expect(router.state.location.search).toBe(`?saved=${ID.hourly}`));
    release();
    // 저장은 되어 목록에 더해지지만 화면은 시간별 이벤트에 남는다
    expect(await within(savedList()).findByRole("link", { name: /늦은 저장/ })).toBeTruthy();
    expect(router.state.location.search).toBe(`?saved=${ID.hourly}`);
  });
});

describe("지우기", () => {
  it("두 번 눌러 지우면(204) 새 설정 화면으로 가고(주소를 바꿔 넣음), 알리고, 목록에서 빠진다. 포커스는 확인 묶음과 제목으로 옮긴다", async () => {
    const router = renderAt(`/reports?saved=${ID.daily}`);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "지우기" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "그만두기" }));
    await userEvent.click(screen.getByRole("button", { name: "그만두기" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "지우기" }));
    await userEvent.click(screen.getByRole("button", { name: "지우기" }));
    expect(writes).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "정말 지우기" }));
    await vi.waitFor(() => expect(router.state.location.search).toBe(""));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(writes).toEqual([{ method: "DELETE", path: `/api/saved-reports/${ID.daily}`, body: undefined }]);
    await vi.waitFor(() => expect(announced()).toBe('"일별 이벤트"을(를) 지웠습니다.'));
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "리포트" })));
    await vi.waitFor(() => expect(within(savedList()).queryByRole("link", { name: /일별 이벤트/ })).toBeNull());
  });

  it("저장한 뒤 지우면 \"저장했습니다\"가 남지 않는다", async () => {
    const router = renderAt("/reports");
    await viewAndName("잠깐 리포트");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));
    await vi.waitFor(() => expect(announced()).toContain("저장했습니다"));
    await userEvent.click(screen.getByRole("button", { name: "지우기" }));
    await userEvent.click(screen.getByRole("button", { name: "정말 지우기" }));
    await vi.waitFor(() => expect(router.state.location.search).toBe(""));
    await vi.waitFor(() => expect(announced()).toBe('"잠깐 리포트"을(를) 지웠습니다.'));
    expect(screen.queryByText(/저장했습니다/)).toBeNull();
  });

  it("이미 지워졌으면(404) 지운 것으로 보고 새 설정 화면으로 간다", async () => {
    const router = renderAt(`/reports?saved=${ID.daily}`);
    await screen.findByRole("table");
    store = store.filter((i) => i.id !== ID.daily);
    await userEvent.click(screen.getByRole("button", { name: "지우기" }));
    await userEvent.click(screen.getByRole("button", { name: "정말 지우기" }));
    await vi.waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("열 수 없는 옛 설정도 지울 수 있다", async () => {
    const router = renderAt(`/reports?saved=${ID.broken}`);
    await userEvent.click(await screen.findByRole("button", { name: "지우기" }));
    await userEvent.click(screen.getByRole("button", { name: "정말 지우기" }));
    await vi.waitFor(() => expect(router.state.location.search).toBe(""));
    expect(writes.map((w) => w.method)).toEqual(["DELETE"]);
  });
});

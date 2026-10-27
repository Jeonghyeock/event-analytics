import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queries";
import { RetentionPage } from "./RetentionPage";

// 리텐션 화면(DESIGN 6.7): 표 하나. 빈칸은 아직 지나지 않은 날, "—"는 0명인 무리, 오늘의 무리는 진행 중이다.
const requests: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  requests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url === "/api/reports/query") {
        const meta = {
          timezone: "Asia/Seoul",
          rangeStart: "2026-10-20T15:00:00.000Z",
          rangeEnd: "2026-10-27T15:00:00.000Z",
          rowCount: 0,
          source: "raw",
          rollupWatermark: null,
          stale: false,
          provisional: true,
          asOf: "2026-10-27T12:00:00.000Z",
          buckets: [],
        };
        return new Response(JSON.stringify({ rows: [], meta }));
      }
      requests.push(body);
      return new Response(
        JSON.stringify({
          rows: [
            { cohort: "2026-10-25", cohortStart: "2026-10-24T15:00:00.000Z", users: 10, returned: [4, null] },
            { cohort: "2026-10-26", cohortStart: "2026-10-25T15:00:00.000Z", users: 0, returned: [0, null] },
            { cohort: "2026-10-27", cohortStart: "2026-10-26T15:00:00.000Z", users: 3, returned: [null, null] },
            { cohort: "2026-10-28", cohortStart: "2026-10-27T15:00:00.000Z", users: null, returned: [null, null] },
          ],
          meta: {
            timezone: "Asia/Seoul",
            rangeStart: "2026-10-24T15:00:00.000Z",
            rangeEnd: "2026-10-28T15:00:00.000Z",
            days: 2,
            today: "2026-10-27",
            provisional: true,
          },
        }),
      );
    }),
  );
});
afterEach(() => vi.useRealTimers());

describe("RetentionPage", () => {
  it("기본 설정(한국 시각 최근 7일, 7일째까지, 모든 이벤트)을 보내고 무리 × N일째 표를 그린다", async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RetentionPage />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "보기" }));
    expect(requests[0]).toEqual({ days: 7, filters: [], timezone: "Asia/Seoul", from: "2026-10-21", to: "2026-10-27" });
    const table = await screen.findByRole("table");
    // 오지 않은 날(10-28)의 무리는 빠지고, 빈칸은 아직 지나지 않은 날, "—"는 0명인 무리다
    expect(within(table).getAllByRole("row").map((r) => r.textContent)).toEqual([
      "무리의 날무리1일째2일째",
      "2026-10-251040.0%",
      "2026-10-260—",
      "2026-10-27 진행 중3",
    ]);
  });
});

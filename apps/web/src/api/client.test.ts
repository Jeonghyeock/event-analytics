import { ReportResult } from "@event-analytics/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError, ContractError, NetworkError } from "./client";
import { runReport } from "./endpoints";

// API 함수(DESIGN 6.7): 보내기 전에 설정을 검사하고, 받은 응답도 검사한다.
const query = { metrics: ["events" as const], granularity: "day" as const, from: "2026-10-20", to: "2026-10-26" };
const meta = {
  timezone: "Asia/Seoul",
  rangeStart: "2026-10-19T15:00:00.000Z",
  rangeEnd: "2026-10-26T15:00:00.000Z",
  rowCount: 0,
  source: "rollup",
  rollupWatermark: "2026-10-27T13:00:00.000Z",
  stale: false,
  provisional: true,
  asOf: "2026-10-27T12:00:00.000Z",
  buckets: [],
};

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(body === undefined ? "" : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("runReport", () => {
  it("기본값을 채운 설정을 /api/reports/query로 보내고, 응답을 스키마로 읽는다", async () => {
    const fetchMock = respond(200, { rows: [], meta });
    expect(await runReport(query)).toEqual(ReportResult.parse({ rows: [], meta }));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/reports/query");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ...query, dimensions: [], filters: [], timezone: "Asia/Seoul" });
  });

  it("틀린 설정은 보내지 않는다", async () => {
    const fetchMock = respond(200, {});
    await expect(runReport({ ...query, from: "2026-10-27" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("422·503은 이유와 서버의 문장을 가진 ApiError다", async () => {
    respond(422, { error: "보관 기간(90일) 밖입니다", code: "out_of_retention" });
    const err = await runReport(query).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: "out_of_retention", serverMessage: "보관 기간(90일) 밖입니다" });
  });

  it("2xx인데 응답이 스키마와 다르면 ContractError다(조용히 틀리게 그리지 않는다)", async () => {
    respond(200, { rows: [], meta: { ...meta, source: "cache" } });
    await expect(runReport(query)).rejects.toBeInstanceOf(ContractError);
  });

  it("프록시가 API에 닿지 못한 502(빈 본문)는 NetworkError다, JSON이 아닌 500은 문장 없는 ApiError다", async () => {
    respond(502, undefined);
    await expect(runReport(query)).rejects.toBeInstanceOf(NetworkError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 500 })));
    const err = await runReport(query).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500, serverMessage: undefined });
  });

  it("서버에 닿지 않으면 NetworkError다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(runReport(query)).rejects.toBeInstanceOf(NetworkError);
  });
});

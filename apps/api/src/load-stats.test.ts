import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";
import { createLoadStats, loopDelayMs, summarize } from "./load-stats.js";

// 부하 측정의 1초 지표(DESIGN 6.8). seat-booking의 테스트를 이 API의 풀 셋과 실패 code에 맞게 옮겼다.
describe("부하 측정 지표(LOAD_STATS)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "load-stats-"));
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const reportPool = createPool({ connectionString: inject("databaseUrl"), max: 2 });
  const config = { poolMax: 10, reportPoolMax: 2, logLevel: "info", loadStatsDir: dir };
  // 타이머로는 쓰지 않고 flush를 직접 부른다.
  const stats = createLoadStats({ dir, pools: { ingest: pool, reports: reportPool }, config, intervalMs: 3_600_000 });
  const app = buildApp(pool, {}, { reportPool });
  app.get("/test/busy", async (_request, reply) => reply.code(503).send({ error: "바쁨", code: "busy" }));
  app.get("/test/plain-error", async (_request, reply) => reply.code(400).send("code 없음"));
  stats.attach(app);
  stats.start();
  afterAll(async () => {
    await app.close();
    await Promise.all([pool.end(), reportPool.end()]);
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = () =>
    readFileSync(path.join(dir, "api-stats.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const lastLine = () => {
    stats.flush();
    return lines().at(-1);
  };

  it("첫 줄에 설정을 쓰고, 1초 줄에 경로별 요청 수·상태·처리 시간과 4xx·5xx 본문의 code를 쓴다", async () => {
    for (let i = 0; i < 3; i++) expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject("/test/busy")).statusCode).toBe(503);
    expect((await app.inject("/test/plain-error")).statusCode).toBe(400);
    // 실제 경로: 보관 기간 밖이면 422 out_of_retention
    const old = await app.inject({
      method: "POST",
      url: "/reports/query",
      payload: { metrics: ["events"], granularity: "day", from: "2020-01-01", to: "2020-01-02" },
    });
    expect(old.statusCode).toBe(422);
    expect((await app.inject("/no-such-route")).statusCode).toBe(404);
    const tick = lastLine();
    expect(lines()[0]).toMatchObject({ type: "start", pid: process.pid, config });
    expect(tick.type).toBe("tick");
    expect(tick.routes["GET /health"]).toMatchObject({ count: 3, statuses: { 200: 3 } });
    const { p50, p95, max } = tick.routes["GET /health"];
    expect(0 <= p50 && p50 <= p95 && p95 <= max).toBe(true);
    expect(tick.routes["GET /health"].codes).toBeUndefined();
    expect(tick.routes["GET /test/busy"]).toMatchObject({ statuses: { 503: 1 }, codes: { busy: 1 } });
    expect(tick.routes["GET /test/plain-error"].codes).toBeUndefined();
    expect(tick.routes["POST /reports/query"]).toMatchObject({ statuses: { 422: 1 }, codes: { out_of_retention: 1 } });
    expect(tick.routes["GET (없는 경로)"]).toMatchObject({ statuses: { 404: 1 } });
  });

  it("풀마다 연결 수와 연결을 받기까지 기다린 시간을 쓴다", async () => {
    await pool.query("select 1");
    const client = await reportPool.connect();
    client.release();
    await reportPool.query("select 1");
    const tick = lastLine();
    expect(tick.pools.ingest.connectWait.count).toBe(1);
    expect(tick.pools.reports.connectWait.count).toBe(2);
    expect(tick.pools.reports).toMatchObject({ connectErrors: 0, waiting: 0 });
    expect(tick.pools.ingest.total).toBeGreaterThanOrEqual(1);
  });

  it("요청이 풀에서 연결을 받기까지 기다린 시간을 응답 머리 Server-Timing으로 알린다(DB를 쓰지 않은 요청에는 없다)", async () => {
    expect((await app.inject("/health")).headers["server-timing"]).toMatch(/^pool;dur=\d+\.\d$/);
    expect((await app.inject("/test/busy")).headers["server-timing"]).toBeUndefined();
    // 리포트 풀(2개)을 모두 쥐고 있으면 리포트 요청은 놓아줄 때까지 기다린다
    const held = await Promise.all([reportPool.connect(), reportPool.connect()]);
    const pending = app.inject({
      method: "POST",
      url: "/reports/query",
      payload: { metrics: ["events"], granularity: "day", from: "2020-01-01", to: "2020-01-02" },
    });
    await new Promise((r) => setTimeout(r, 300));
    for (const client of held) client.release();
    const res = await pending;
    const waited = Number(/pool;dur=([\d.]+)/.exec(res.headers["server-timing"] as string)?.[1]);
    expect(waited).toBeGreaterThanOrEqual(250);
  });

  it("연결을 받지 못한 것(대기 한도)을 연결 오류로 세고, 새로 맺은 연결 수를 쓴다", async () => {
    // 한도는 새 연결을 맺는 시간에도 걸리므로, 첫 연결이 다른 테스트 파일과 겹쳐 늦어도 맺어지게 넉넉히 둔다.
    const small = createPool({ connectionString: inject("databaseUrl"), max: 1, connectionTimeoutMillis: 1000 });
    const smallDir = mkdtempSync(path.join(tmpdir(), "load-stats-small-"));
    const smallStats = createLoadStats({ dir: smallDir, pools: { small }, config, intervalMs: 3_600_000 });
    try {
      const held = await small.connect();
      await Promise.all([small.query("select 1").catch(() => undefined), small.connect().catch(() => undefined)]);
      held.release();
      smallStats.flush();
      const tick = readFileSync(path.join(smallDir, "api-stats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      expect(tick.pools.small).toMatchObject({ connectErrors: 2, newConnections: 1 });
      expect(tick.pools.small.connectWait.count).toBe(3);
    } finally {
      await small.end();
      rmSync(smallDir, { recursive: true, force: true });
    }
  });

  it("집계 작업 한 바퀴를 쓰고, 다음 줄은 지난 줄 뒤의 값만 쓴다", async () => {
    stats.recordRollup({ skipped: false, chunks: 1, hours: 3, watermark: "2026-10-27T12:00:00.000Z" }, 12.345);
    stats.recordRollup({ skipped: true }, 1);
    stats.recordRollup({ failed: true }, 60_000);
    expect(lastLine().rollup).toEqual([
      { skipped: false, chunks: 1, hours: 3, watermark: "2026-10-27T12:00:00.000Z", ms: 12.35 },
      { skipped: true, ms: 1 },
      { failed: true, ms: 60_000 },
    ]);
    await app.inject("/health");
    lastLine();
    const tick = lastLine();
    expect(tick.routes).toEqual({});
    expect(tick.pools.ingest.connectWait).toBeNull();
    expect(tick.rollup).toEqual([]);
  });

  it("Node 지표(ELU, CPU)는 그 줄 동안의 값이다", async () => {
    // 200ms 동안 이벤트 루프를 막으면 그 줄의 ELU가 높고, 쉬면 낮다. 누적 값이면 줄마다 떨어지지 않는다.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        const until = performance.now() + 200;
        while (performance.now() < until);
        resolve();
      }, 5),
    );
    const busy = lastLine().node;
    expect(busy.elu).toBeGreaterThan(0.5);
    expect(busy.cpuPct).toBeGreaterThan(10);
    await new Promise((r) => setTimeout(r, 100));
    const idle = lastLine().node;
    expect(idle.elu).toBeLessThan(0.5);
    expect(idle.heapMb).toBeGreaterThan(0);
  });

  it("클라이언트가 응답 전에 끊은 요청은 본문이 있는 POST도 aborted로 센다(상태와 code는 세지 않는다)", async () => {
    // 끊으려면 실제 소켓이 있어야 해서, 느린 경로를 더한 앱을 따로 만들어 임의 포트로 띄운다.
    // Fastify의 onRequestAbort는 본문을 다 읽은 POST에서는 불리지 않는다(재는 경로가 모두 그렇다, 코드 리뷰).
    const slowDir = mkdtempSync(path.join(tmpdir(), "load-stats-slow-"));
    const slowPool = createPool({ connectionString: inject("databaseUrl") });
    const slowStats = createLoadStats({ dir: slowDir, pools: { ingest: slowPool }, config, intervalMs: 3_600_000 });
    const slow = buildApp(slowPool);
    const wait = () => new Promise((r) => setTimeout(r, 500));
    slow.get("/test/slow", async () => {
      await wait();
      return { ok: true };
    });
    // 끊긴 뒤에 503을 보내도(리포트의 시간 한도) code만 남지 않는다
    slow.post("/test/slow", async (_request, reply) => {
      await wait();
      return reply.code(503).send({ error: "시간 한도", code: "report_timeout" });
    });
    slowStats.attach(slow);
    try {
      const address = await slow.listen({ port: 0, host: "127.0.0.1" });
      await fetch(`${address}/test/slow`, { signal: AbortSignal.timeout(100) }).catch(() => undefined);
      await fetch(`${address}/test/slow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ any: "body" }),
        signal: AbortSignal.timeout(100),
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 700));
      // 끊기지 않은 요청은 aborted가 아니다
      await fetch(`${address}/test/slow`);
      slowStats.flush();
      const tick = readFileSync(path.join(slowDir, "api-stats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      expect(tick.routes["GET /test/slow"]).toMatchObject({ aborted: 1, statuses: { 200: 1 } });
      expect(tick.routes["POST /test/slow"]).toMatchObject({ aborted: 1, statuses: {} });
      expect(tick.routes["POST /test/slow"].codes).toBeUndefined();
    } finally {
      await slow.close();
      await slowPool.end();
      rmSync(slowDir, { recursive: true, force: true });
    }
  });

  it("멈추면 남은 값을 쓴다", async () => {
    await app.inject("/health");
    stats.stop();
    expect(lines().at(-1).routes["GET /health"].count).toBe(1);
  });

  it("백분위는 가장 가까운 순위다. 이벤트 루프 지연은 표본 간격(10ms)을 뺀 밀리초이고 0 아래로 내려가지 않는다", () => {
    expect(summarize([])).toBeNull();
    expect(summarize([5, 1, 3, 2, 4])).toEqual({ count: 5, p50: 3, p95: 5, max: 5 });
    expect(loopDelayMs(10_400_000)).toBe(0.4);
    expect(loopDelayMs(25_000_000)).toBe(15);
    expect(loopDelayMs(9_000_000)).toBe(0);
  });
});

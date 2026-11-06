import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";
import { inReportTransaction } from "./reports/transaction.js";

describe("GET /health", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("DB에 닿으면 200과 status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("DB에 닿지 않으면 503, 오류 내용은 응답에 없음", async () => {
    const down = createPool({
      connectionString: "postgres://nobody:nothing@127.0.0.1:1/none",
      connectionTimeoutMillis: 1000,
    });
    const broken = buildApp(down);
    try {
      const res = await broken.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "unavailable" });
    } finally {
      await broken.close();
      await down.end();
    }
  });

  it("풀의 쉬는 연결이 끊겨도 프로세스가 죽지 않고, 다음 요청에 새로 맺는다", async () => {
    const idle = createPool({ connectionString: inject("databaseUrl"), application_name: "health-idle-test" });
    const server = buildApp(idle);
    const killer = createPool({ connectionString: inject("databaseUrl"), max: 1 });
    try {
      expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect(idle.idleCount).toBe(1);
      // 듣는 쪽이 없으면 여기서 'error'가 처리되지 않은 오류로 테스트 실행을 깬다
      const { rows } = await killer.query(
        "select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = 'health-idle-test' and datname = current_database()",
      );
      expect(rows).toEqual([{ ok: true }]);
      for (let i = 0; i < 100 && idle.totalCount > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(idle.totalCount).toBe(0);
      expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await server.close();
      await idle.end();
      await killer.end();
    }
  });

  it("트랜잭션에 빌려 간 연결이 쿼리 사이에 끊겨도 프로세스가 죽지 않고, 그 작업만 실패한다", async () => {
    const busy = createPool({ connectionString: inject("databaseUrl"), application_name: "health-tx-test" });
    const server = buildApp(busy);
    const killer = createPool({ connectionString: inject("databaseUrl"), max: 1 });
    let paused!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((r) => (paused = r));
    const gate = new Promise<void>((r) => (resume = r));
    // 리포트·퍼널·리텐션이 쓰는 트랜잭션(수집·집계 작업도 같은 식으로 연결을 빌린다). 시작 문장 뒤 연결을 쥔 채 멈춘다.
    const work = inReportTransaction(busy, {}, async (client) => {
      paused();
      await gate;
      await client.query("select 1");
    });
    try {
      await reached;
      // 빌려 간 연결에서는 pg-pool이 리스너를 뗀다. 듣는 쪽이 없으면 여기서 연결의 'error'가 처리되지 않은 오류로 테스트 실행을 깬다
      const { rows } = await killer.query(
        "select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = 'health-tx-test' and datname = current_database() and state = 'idle in transaction'",
      );
      expect(rows).toEqual([{ ok: true }]);
      // 백엔드가 끝난 뒤에 이어 간다. 끊김은 다음 쿼리를 보내기 전, 연결을 쥐고 멈춘 동안 온다
      let left = 1;
      for (let i = 0; i < 100 && left > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
        left = (
          await killer.query(
            "select count(*) as n from pg_stat_activity where application_name = 'health-tx-test' and datname = current_database()",
          )
        ).rows[0].n;
      }
      expect(left).toBe(0);
      resume();
      await expect(work).rejects.toThrow();
      // 끊긴 연결은 돌려줄 때 풀이 버리고, 다음 요청에 새로 맺는다
      expect(busy.totalCount).toBe(0);
      expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      resume();
      await work.catch(() => {});
      await server.close();
      await busy.end();
      await killer.end();
    }
  });

  it("없는 경로는 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("Host 검사", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  const app = buildApp(pool);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("이 컴퓨터 이름이 아닌 Host는 421 — DNS 리바인딩으로 다른 사이트가 리포트를 읽거나 지우지 못한다(#4 리뷰)", async () => {
    for (const host of ["evil.example:3002", "localhost.evil.example", "192.168.0.5:3002"]) {
      const list = await app.inject({ method: "GET", url: "/saved-reports", headers: { host } });
      expect(list.statusCode, host).toBe(421);
      const health = await app.inject({ method: "GET", url: "/health", headers: { host } });
      expect(health.statusCode, host).toBe(421);
      // 수집도 같다. 400이 아니라서 seat-booking relay가 주소 문제를 '본문이 틀렸다'로 보지 않는다
      const ingest = await app.inject({ method: "POST", url: "/ingest", headers: { host }, payload: { events: [] } });
      expect(ingest.statusCode, host).toBe(421);
    }
  });

  it("127.0.0.1·localhost·[::1]은 포트와 상관없이 받는다(Vite 프록시는 화면의 Host를 그대로 넘긴다)", async () => {
    for (const host of ["127.0.0.1:3002", "localhost:5180", "LOCALHOST", "[::1]:3002"]) {
      expect((await app.inject({ method: "GET", url: "/saved-reports", headers: { host } })).statusCode, host).toBe(200);
    }
  });
});

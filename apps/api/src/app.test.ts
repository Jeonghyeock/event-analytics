import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";

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
        "select pg_terminate_backend(pid) as ok from pg_stat_activity where application_name = 'health-idle-test'",
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

  it("없는 경로는 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});

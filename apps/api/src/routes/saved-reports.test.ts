import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../test/fresh-database.js";
import { buildApp } from "../app.js";
import { createPool } from "../db/pool.js";

// 저장한 리포트(DESIGN 6.7, 10장 52). 이 파일만 쓰는 새 DB에서 앱 role로 돈다.
let db: Awaited<ReturnType<typeof openDatabase>>;
let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await openDatabase("saved");
  pool = createPool({ connectionString: db.app });
  app = buildApp(pool);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const report = { metrics: ["events"], granularity: "day", from: "2026-10-20", to: "2026-10-26" };
const funnel = { steps: ["a", "b"], windowMinutes: 60, from: "2026-10-20", to: "2026-10-26" };
const retention = { days: 7, from: "2026-10-20", to: "2026-10-26" };
const send = (method: "POST" | "PUT" | "DELETE" | "GET", url: string, payload?: object) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
const create = async (name: string, kind = "report", config: object = report) =>
  (await send("POST", "/saved-reports", { name, kind, config })).json().item;

describe("저장한 리포트", () => {
  it("저장하면 검사를 거친 설정(기본값이 채워진 것)과 앞뒤 공백을 자른 이름이 남는다. 세 종류 모두 저장한다", async () => {
    const res = await send("POST", "/saved-reports", { name: "  주간 리포트 ", kind: "report", config: report });
    expect(res.statusCode).toBe(201);
    expect(res.json().item).toMatchObject({
      name: "주간 리포트",
      kind: "report",
      valid: true,
      config: { ...report, dimensions: [], filters: [], timezone: "Asia/Seoul" },
    });
    expect(await create("퍼널 하나", "funnel", funnel)).toMatchObject({ kind: "funnel", valid: true, config: { breakdown: [], filters: [] } });
    expect(await create("리텐션 하나", "retention", retention)).toMatchObject({ kind: "retention", valid: true, config: { filters: [] } });
  });

  it("목록은 대소문자를 가리지 않은 이름 순이다(코드 포인트 순이면 Zeta가 alpha2보다 앞)", async () => {
    for (const name of ["beta", "Zeta", "Alpha", "alpha2"]) await create(name, "funnel", funnel);
    const names = (await send("GET", "/saved-reports")).json().items.map((i: { name: string }) => i.name);
    expect(names.filter((n: string) => /^[A-Za-z]/.test(n))).toEqual(["Alpha", "alpha2", "beta", "Zeta"]);
  });

  it("이름이 겹치면 종류가 달라도 409다", async () => {
    await create("겹침");
    const res = await send("POST", "/saved-reports", { name: "겹침", kind: "funnel", config: funnel });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: expect.any(String), code: "name_taken" });
  });

  it("덮어쓰기는 이름·설정을 바꾸고 바뀐 시각만 새로 적는다(만든 시각은 그대로)", async () => {
    const created = await create("gamma");
    // 같은 밀리초 안에 두 번 쓰여도 가릴 수 있게 바뀐 시각을 과거로 돌려 둔다
    await pool.query("update saved_reports set updated_at = '2026-01-01 00:00+00' where id = $1", [created.id]);
    const res = await send("PUT", `/saved-reports/${created.id}`, { name: "gamma 2", kind: "report", config: { ...report, granularity: "week" } });
    expect(res.statusCode).toBe(200);
    const item = res.json().item;
    expect(item).toMatchObject({ id: created.id, name: "gamma 2", createdAt: created.createdAt, config: { granularity: "week" } });
    expect(item.updatedAt > "2026-01-01T00:00:00.000Z").toBe(true);
    // 자기 이름 그대로 덮어써도 된다
    expect((await send("PUT", `/saved-reports/${created.id}`, { name: "gamma 2", kind: "report", config: report })).statusCode).toBe(200);
  });

  it("덮어쓰기: 다른 것의 이름이면 409, 없는 id는 404, id가 uuid가 아니면 400이다", async () => {
    const created = await create("delta");
    await create("epsilon");
    expect((await send("PUT", `/saved-reports/${created.id}`, { name: "epsilon", kind: "report", config: report })).statusCode).toBe(409);
    const missing = await send("PUT", "/saved-reports/00000000-0000-4000-8000-000000000000", { name: "x", kind: "report", config: report });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: expect.any(String), code: "not_found" });
    expect((await send("PUT", "/saved-reports/nope", { name: "x", kind: "report", config: report })).statusCode).toBe(400);
  });

  it("지우면 204(본문 없음), 다시 지우면 404다", async () => {
    const created = await create("zeta to delete");
    const res = await send("DELETE", `/saved-reports/${created.id}`);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect((await send("DELETE", `/saved-reports/${created.id}`)).statusCode).toBe(404);
  });

  it.each([
    ["빈 이름(공백뿐)", { name: "   ", kind: "report", config: report }],
    ["NUL이 든 이름", { name: `a${String.fromCharCode(0)}`, kind: "report", config: report }],
    ["101자 이름", { name: "a".repeat(101), kind: "report", config: report }],
    ["종류에 맞지 않는 설정", { name: "x", kind: "report", config: funnel }],
    ["모르는 종류", { name: "x", kind: "dashboard", config: report }],
    ["모르는 필드", { name: "x", kind: "report", config: report, shared: true }],
  ])("%s는 400이다", async (_, body) => {
    expect((await send("POST", "/saved-reports", body)).statusCode).toBe(400);
  });

  it("지금의 스키마에 맞지 않는 옛 설정은 목록을 깨지 않고 valid: false로 온다", async () => {
    await pool.query("insert into saved_reports (name, kind, config) values ($1, 'report', $2)", ["옛 설정", JSON.stringify({ metrics: ["revenue"] })]);
    const res = await send("GET", "/saved-reports");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.find((i: { name: string }) => i.name === "옛 설정")).toMatchObject({ valid: false, config: { metrics: ["revenue"] } });
  });

  it("앱 role은 이 표에 DML만 할 수 있다(0000의 기본 권한)", async () => {
    const { rows } = await pool.query(
      `select ${["select", "insert", "update", "delete", "truncate"].map((p) => `has_table_privilege('saved_reports', '${p}') as ${p}`).join(", ")}`,
    );
    expect(rows[0]).toEqual({ select: true, insert: true, update: true, delete: true, truncate: false });
  });
});

import { RetentionQuery } from "@event-analytics/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../test/fresh-database.js";
import { buildApp } from "../app.js";
import { createDailyPartitions } from "../db/partitions.js";
import { createPool } from "../db/pool.js";
import { buildRetentionSql } from "../reports/retention-sql.js";
import { runRetention } from "../reports/retention-run.js";

// 리텐션(DESIGN 6.5, 10장 45): 작은 고정 데이터에서 손으로 센 값과 같다. 이 파일만 쓰는 새 DB에 넣는다.
// 날마다 무리(그날 이벤트가 있는 사용자 전부), N일째 = 무리의 날 + N일에 이벤트가 있음. 시각은 한국 시각(괄호 안은 UTC).
//   r1  10-20 10:00, 10-21 10:00, 10-23 10:00
//   r2  10-20 23:30(14:30), 10-21 00:30(10-20 15:30)   UTC로는 같은 날이지만 한국 시각으로 1일째
//   r3  10-22 12:00
//   r4  10-19 12:00(기간 앞), 10-21 12:00
//   r5  10-25 12:00, 10-26 12:00                        "지금"(10-27) 근처
//   r8  10-20 15:00 ios, 10-21 15:00 web               나머지는 ios
//   r7  10-10 signup, 10-11 purchase, 10-12 page        나머지 이름은 page
//   r6  뉴욕 10-31 00:30 EDT(04:30), 11-01 23:30 EST(11-02 04:30)   48시간 뒤지만 날짜로는 1일째
let db: Awaited<ReturnType<typeof openDatabase>>;
let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
const asOf = "2026-10-27T12:00:00Z";

const FIXTURE: [user: string, at: string, name?: string, platform?: string][] = [
  ["r1", "2026-10-20 01:00"],
  ["r1", "2026-10-21 01:00"],
  ["r1", "2026-10-23 01:00"],
  ["r2", "2026-10-20 14:30"],
  ["r2", "2026-10-20 15:30"],
  ["r3", "2026-10-22 03:00"],
  ["r4", "2026-10-19 03:00"],
  ["r4", "2026-10-21 03:00"],
  ["r5", "2026-10-25 03:00"],
  ["r5", "2026-10-26 03:00"],
  ["r8", "2026-10-20 06:00", "page", "ios"],
  ["r8", "2026-10-21 06:00", "page", "web"],
  ["r7", "2026-10-10 03:00", "signup"],
  ["r7", "2026-10-11 03:00", "purchase"],
  ["r7", "2026-10-12 03:00"],
  ["r6", "2026-10-31 04:30"],
  ["r6", "2026-11-02 04:30"],
];

beforeAll(async () => {
  db = await openDatabase("retention");
  const owner = new pg.Client({ connectionString: db.owner });
  await owner.connect();
  try {
    await createDailyPartitions(owner, "2026-10-09", "2026-11-05", { retryDelaysMs: [] });
    for (const [user, at, name = "page", platform = "ios"] of FIXTURE) {
      await owner.query(
        `insert into events (event_id, occurred_at, user_id, event_name, platform) values (gen_random_uuid(), $1::timestamptz, $2, $3, $4)`,
        [`${at}+00`, user, name, platform],
      );
    }
  } finally {
    await owner.end();
  }
  pool = createPool({ connectionString: db.app });
  app = buildApp(pool, {}, { reports: { asOf } });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const base = { days: 3, from: "2026-10-20", to: "2026-10-22", timezone: "Asia/Seoul" };
async function retention(body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/retention/query", payload: { ...base, ...body } });
  return { status: res.statusCode, body: res.json() };
}

describe("손으로 센 리텐션(날마다 무리)", () => {
  it("한 사용자가 여러 무리에 들고, 한국 시각 자정을 사이에 둔 것도 1일째다", async () => {
    expect(await retention({})).toEqual({
      status: 200,
      body: {
        rows: [
          // r1·r2·r8. 1일째 셋 다(r2는 한국 시각 10-21 00:30), 3일째 r1
          { cohort: "2026-10-20", cohortStart: "2026-10-19T15:00:00.000Z", users: 3, returned: [3, 0, 1] },
          // r1·r2·r4·r8. 2일째(10-23) r1
          { cohort: "2026-10-21", cohortStart: "2026-10-20T15:00:00.000Z", users: 4, returned: [0, 1, 0] },
          { cohort: "2026-10-22", cohortStart: "2026-10-21T15:00:00.000Z", users: 1, returned: [0, 0, 0] },
        ],
        meta: {
          timezone: "Asia/Seoul",
          rangeStart: "2026-10-19T15:00:00.000Z",
          rangeEnd: "2026-10-22T15:00:00.000Z",
          days: 3,
          today: "2026-10-27",
          provisional: true,
        },
      },
    });
  });

  it("무리 크기는 같은 날의 리포트 사용자 수와 같다", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/reports/query",
      payload: { metrics: ["users"], granularity: "day", from: "2026-10-20", to: "2026-10-22", timezone: "Asia/Seoul" },
    });
    expect(res.json().rows.map((r: { users: number }) => r.users)).toEqual([3, 4, 1]);
  });

  it("from을 바꿔도 같은 날의 무리는 같다(기간 앞의 r4는 10-19 무리에 따로 든다)", async () => {
    const rows = (await retention({ from: "2026-10-19" })).body.rows;
    expect(rows[0]).toMatchObject({ cohort: "2026-10-19", users: 1, returned: [0, 1, 0] });
    expect(rows[1]).toMatchObject({ cohort: "2026-10-20", users: 3, returned: [3, 0, 1] });
  });

  it("필터는 시작과 돌아옴 모두에 건다: ios면 r8의 10-21(web)이 빠진다", async () => {
    const rows = (await retention({ filters: [{ dimension: "platform", values: ["ios"] }] })).body.rows;
    expect(rows.map((r: { users: number; returned: number[] }) => [r.users, r.returned])).toEqual([
      [3, [2, 0, 1]],
      [3, [0, 1, 0]],
      [1, [0, 0, 0]],
    ]);
  });

  it("아직 다 지나지 않은 칸은 null이고(오늘 10-27과 그 뒤), 오지 않은 날의 무리 크기도 null이다", async () => {
    const res = await retention({ from: "2026-10-25", to: "2026-10-28" });
    expect(res.body.rows).toEqual([
      { cohort: "2026-10-25", cohortStart: "2026-10-24T15:00:00.000Z", users: 1, returned: [1, null, null] },
      { cohort: "2026-10-26", cohortStart: "2026-10-25T15:00:00.000Z", users: 1, returned: [null, null, null] },
      // 오늘의 무리는 지금까지 센 값(이 데이터에는 없음), 내일은 모른다
      { cohort: "2026-10-27", cohortStart: "2026-10-26T15:00:00.000Z", users: 0, returned: [null, null, null] },
      { cohort: "2026-10-28", cohortStart: "2026-10-27T15:00:00.000Z", users: null, returned: [null, null, null] },
    ]);
  });

  it("\"오늘\"은 리포트 시간대의 날짜다(한국 시각 10-28 00:30 = UTC 10-27 15:30)", async () => {
    const q = RetentionQuery.parse({ days: 3, from: "2026-10-25", to: "2026-10-28", timezone: "Asia/Seoul" });
    const result = await runRetention(pool, q, { asOf: "2026-10-27T15:30:00Z" });
    expect(result.meta.today).toBe("2026-10-28");
    expect(result.rows.map((r) => [r.users, r.returned])).toEqual([
      [1, [1, 0, null]],
      [1, [0, null, null]],
      [0, [null, null, null]],
      // 오늘의 무리는 지금까지 센 값(0), 아직 오지 않은 날이 아니다
      [0, [null, null, null]],
    ]);
  });

  it("provisional은 마지막 칸의 날의 끝으로 판단한다(기간 끝이 아니라)", async () => {
    // 10-10 무리, 2일째의 끝 10-13 0시(KST)는 "지금" − 7일(10-20 12:00 UTC)보다 앞
    expect((await retention({ from: "2026-10-10", to: "2026-10-10", days: 2 })).body.meta.provisional).toBe(false);
    // 10-18 무리, 7일째의 끝 10-26 0시(KST)는 뒤. 기간 끝(10-19 0시)으로 판단하면 false가 된다
    expect((await retention({ from: "2026-10-18", to: "2026-10-18", days: 7 })).body.meta.provisional).toBe(true);
  });

  it("시작·돌아옴 이벤트를 고른다(signup → purchase)", async () => {
    const pick = { from: "2026-10-10", to: "2026-10-10", days: 2, startEvent: "signup" };
    expect((await retention({ ...pick, returnEvent: "purchase" })).body.rows[0]).toMatchObject({ users: 1, returned: [1, 0] });
    expect((await retention(pick)).body.rows[0]).toMatchObject({ users: 1, returned: [1, 1] });
    expect((await retention({ ...pick, startEvent: "purchase" })).body.rows[0]).toMatchObject({ users: 0, returned: [0, 0] });
  });

  it("뉴욕 일광 절약 시간이 끝나는 날을 사이에 둔 48시간 뒤도 날짜로는 1일째다", async () => {
    const q = RetentionQuery.parse({ days: 2, from: "2026-10-31", to: "2026-10-31", timezone: "America/New_York" });
    const result = await runRetention(pool, q, { asOf: "2026-11-10T00:00:00Z" });
    expect(result.rows).toEqual([{ cohort: "2026-10-31", cohortStart: "2026-10-31T04:00:00.000Z", users: 1, returned: [1, 0] }]);
  });

  it("보관 기간 밖이면 422, 무리 32일은 400이다", async () => {
    expect(await retention({ from: "2026-07-28", to: "2026-07-30" })).toMatchObject({ status: 422, body: { code: "out_of_retention" } });
    expect((await retention({ from: "2026-10-01", to: "2026-11-01" })).status).toBe(400);
  });
});

describe("가지치기", () => {
  it("무리 10-20~10-22, 3일째까지는 10-19~10-25 파티션만 계획한다(돌아옴의 끝이 날짜 산술)", async () => {
    const { text, values } = buildRetentionSql(RetentionQuery.parse(base));
    const { rows } = await pool.query(`explain (format json, costs off) ${text}`, values);
    const names = new Set<string>();
    // 실행 시작 때 쳐낸 것(STABLE 식)은 이름에서 빠지지만 "Subplans Removed"로 남는다. 계획할 때 쳐야 한다.
    const walk = (n: { "Relation Name"?: string; "Subplans Removed"?: number; Plans?: unknown[] }) => {
      if (n["Relation Name"]) names.add(n["Relation Name"]);
      if (n["Subplans Removed"]) names.add(`removed at startup: ${n["Subplans Removed"]}`);
      (n.Plans as (typeof n)[] | undefined)?.forEach(walk);
    };
    walk(rows[0]["QUERY PLAN"][0].Plan);
    expect([...names].sort()).toEqual(["19", "20", "21", "22", "23", "24", "25"].map((d) => `events_p202610${d}`));
  });
});

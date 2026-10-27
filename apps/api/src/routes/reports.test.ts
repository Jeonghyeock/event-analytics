import type { ReportQuery } from "@event-analytics/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../test/fresh-database.js";
import { buildApp } from "../app.js";
import { createDailyPartitions } from "../db/partitions.js";
import { createPool } from "../db/pool.js";
import { buildReportSql } from "../reports/sql.js";

// 합격 기준 A5: 리포트 결과가 작은 고정 데이터에서 손으로 센 값과 같다(DESIGN 6.3). 이 파일만 쓰는 새 DB에 넣는다.
//
// 고정 데이터(UTC 시각 → 한국 시각):
//   1  10-26 14:30 → 10-26 23:30  u1 page_view       ios     KR   naver   camp_a
//   2  10-26 15:30 → 10-27 00:30  u1 page_view       ios     KR   naver   camp_a
//   3  10-26 16:10 → 10-27 01:10  u2 seat_map_viewed android KR   google  camp_b
//   4  10-27 03:00 → 10-27 12:00  u1 seat_map_viewed web     없음 organic 없음
//   5  10-27 14:59 → 10-27 23:59  u3 page_view       ios     JP   naver   camp_a
//   6  10-27 15:00 → 10-28 00:00  u3 page_view       ios     JP   naver   camp_a
//   뉴욕 2027-03-14(23시간)와 2026-11-01(25시간): 그 날의 정시마다 1건씩(u9), 이름 dst
// 보관 기간과 provisional은 "지금" = 2026-10-27 12:00 UTC로 판단한다(보관 기간의 시작은 07-29 0시 UTC).
//   콜카타(+05:30): 10-26 18:29 → 10-26 23:59, 10-26 18:31 → 10-27 00:01(u8), 이름 ist
let db: Awaited<ReturnType<typeof openDatabase>>;
let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
const asOf = "2026-10-27T12:00:00Z";

beforeAll(async () => {
  db = await openDatabase("report");
  const owner = new pg.Client({ connectionString: db.owner });
  await owner.connect();
  try {
    for (const [from, to] of [
      ["2027-03-14", "2027-03-15"],
      // 10-24·10-25는 비어 있지만, 가지치기가 기간의 아래 끝도 지키는지 보려고 만든다
      ["2026-10-24", "2026-11-04"],
    ] as const) {
      await createDailyPartitions(owner, from, to, { retryDelaysMs: [] });
    }
    await owner.query(`
      insert into events (event_id, occurred_at, user_id, event_name, platform, country, channel, campaign) values
        (gen_random_uuid(), '2026-10-26 14:30+00', 'u1', 'page_view', 'ios', 'KR', 'naver', 'camp_a'),
        (gen_random_uuid(), '2026-10-26 15:30+00', 'u1', 'page_view', 'ios', 'KR', 'naver', 'camp_a'),
        (gen_random_uuid(), '2026-10-26 16:10+00', 'u2', 'seat_map_viewed', 'android', 'KR', 'google', 'camp_b'),
        (gen_random_uuid(), '2026-10-27 03:00+00', 'u1', 'seat_map_viewed', 'web', null, 'organic', null),
        (gen_random_uuid(), '2026-10-27 14:59+00', 'u3', 'page_view', 'ios', 'JP', 'naver', 'camp_a'),
        (gen_random_uuid(), '2026-10-27 15:00+00', 'u3', 'page_view', 'ios', 'JP', 'naver', 'camp_a'),
        (gen_random_uuid(), '2026-10-26 18:29+00', 'u8', 'ist', 'web', 'IN', null, null),
        (gen_random_uuid(), '2026-10-26 18:31+00', 'u8', 'ist', 'web', 'IN', null, null)`);
    // 뉴욕의 그 날 0시부터 다음 날 0시 전까지 UTC 정시마다 1건(3월 14일은 23건, 11월 1일은 25건)
    for (const [from, to] of [
      ["2027-03-14 05:00+00", "2027-03-15 03:00+00"],
      ["2026-11-01 04:00+00", "2026-11-02 04:00+00"],
    ]) {
      await owner.query(
        `insert into events (event_id, occurred_at, user_id, event_name, platform)
         select gen_random_uuid(), t, 'u9', 'dst', 'web' from generate_series($1::timestamptz, $2::timestamptz, interval '1 hour') t`,
        [from, to],
      );
    }
    // 집계 작업은 돌리지 않는다. 워터마크를 고정 데이터보다 앞에 두어, 이벤트만 묻는 리포트도 집계 표가 비고 원본 꼬리가 모두 센다
    // (마이그레이션은 실제 오늘 기준으로 넣으므로 날짜가 지나면 결과가 달라지지 않게 고정한다).
    await owner.query("update rollup_state set watermark = '2026-01-01 00:00+00'");
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

async function report(body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/reports/query", payload: { metrics: ["events", "users"], ...body } });
  return { status: res.statusCode, body: res.json() };
}
const kst = { timezone: "Asia/Seoul" };
const noDst = { filters: [{ dimension: "event_name", values: ["page_view", "seat_map_viewed"] }] };

describe("A5 — 한국 시각과 UTC의 하루", () => {
  it("한국 시각 10월 27일은 2~5번(4건, 사용자 셋)이고, UTC 10월 27일은 4~6번(3건, 사용자 둘)이다", async () => {
    const day = { from: "2026-10-27", to: "2026-10-27", granularity: "day", filters: noDst.filters };
    expect((await report({ ...day, ...kst })).body).toEqual({
      rows: [{ bucket: "2026-10-26T15:00:00.000Z", label: "2026-10-27", dimensions: {}, events: 4, users: 3 }],
      meta: {
        timezone: "Asia/Seoul",
        rangeStart: "2026-10-26T15:00:00.000Z",
        rangeEnd: "2026-10-27T15:00:00.000Z",
        rowCount: 1,
        source: "raw",
        rollupWatermark: null,
        stale: false,
        provisional: true,
        buckets: [{ bucket: "2026-10-26T15:00:00.000Z", label: "2026-10-27", utcOffset: "+09:00", partial: false }],
      },
    });
    expect((await report({ ...day, timezone: "UTC" })).body.rows).toEqual([
      { bucket: "2026-10-27T00:00:00.000Z", label: "2026-10-27", dimensions: {}, events: 3, users: 2 },
    ]);
  });

  it("시간별 사용자의 합(4)은 하루 사용자(3)가 아니다. u1이 두 시간에 나온다", async () => {
    const { body } = await report({ from: "2026-10-27", to: "2026-10-27", granularity: "hour", filters: noDst.filters, ...kst });
    expect(body.rows.map((r: { label: string; users: number }) => [r.label, r.users])).toEqual([
      ["2026-10-27 00:00", 1],
      ["2026-10-27 01:00", 1],
      ["2026-10-27 12:00", 1],
      ["2026-10-27 23:00", 1],
    ]);
  });

  it("total은 기간 전체 한 묶음이다(10월 26~27일 한국 시각, 1~5번)", async () => {
    const { body } = await report({ from: "2026-10-26", to: "2026-10-27", granularity: "total", filters: noDst.filters, ...kst });
    expect(body.rows).toEqual([
      { bucket: "2026-10-25T15:00:00.000Z", label: "2026-10-26 ~ 2026-10-27", dimensions: {}, events: 5, users: 3 },
    ]);
  });
});

describe("A5 — 차원과 필터", () => {
  it("플랫폼별로 묶고 이름 순으로 놓는다", async () => {
    const { body } = await report({ from: "2026-10-27", to: "2026-10-27", granularity: "day", dimensions: ["platform"], filters: noDst.filters, ...kst });
    expect(body.rows.map((r: { dimensions: object; events: number; users: number }) => [r.dimensions, r.events, r.users])).toEqual([
      [{ platform: "android" }, 1, 1],
      [{ platform: "ios" }, 2, 2],
      [{ platform: "web" }, 1, 1],
    ]);
  });

  it("값이 없는 차원은 null로 묶고 맨 뒤에 놓는다", async () => {
    const { body } = await report({ from: "2026-10-27", to: "2026-10-27", granularity: "day", dimensions: ["country", "campaign"], filters: noDst.filters, ...kst });
    expect(body.rows.map((r: { dimensions: object; events: number }) => [r.dimensions, r.events])).toEqual([
      [{ country: "JP", campaign: "camp_a" }, 1],
      [{ country: "KR", campaign: "camp_a" }, 1],
      [{ country: "KR", campaign: "camp_b" }, 1],
      [{ country: null, campaign: null }, 1],
    ]);
  });

  it("필터 여러 개는 모두 맞아야 한다(ios·web 그리고 naver → 2·5번)", async () => {
    const filters = [
      { dimension: "platform", values: ["ios", "web"] },
      { dimension: "channel", values: ["naver"] },
    ];
    const { body } = await report({ from: "2026-10-27", to: "2026-10-27", granularity: "day", metrics: ["events"], filters, ...kst });
    expect(body.rows).toEqual([{ bucket: "2026-10-26T15:00:00.000Z", label: "2026-10-27", dimensions: {}, events: 2 }]);
  });

  it("null을 고르면 값이 없는 것도 남긴다(캠페인 없음 → 4번)", async () => {
    const filters = [...noDst.filters, { dimension: "campaign", values: [null] }];
    const { body } = await report({ from: "2026-10-27", to: "2026-10-27", granularity: "day", metrics: ["events"], filters, ...kst });
    expect(body.rows).toEqual([{ bucket: "2026-10-26T15:00:00.000Z", label: "2026-10-27", dimensions: {}, events: 1 }]);
  });

  it("events를 고르지 않으면 행에 events가 없다", async () => {
    const { body } = await report({ from: "2026-10-27", to: "2026-10-27", granularity: "day", metrics: ["users"], filters: noDst.filters, ...kst });
    expect(body.rows).toEqual([{ bucket: "2026-10-26T15:00:00.000Z", label: "2026-10-27", dimensions: {}, users: 3 }]);
  });
});

describe("A5 — 시간대의 경계", () => {
  // 3월 14일 2시가 3시로 건너뛴다. 정시마다 1건이면 시간 묶음 23개, 2시가 없다.
  it("뉴욕 2027-03-14는 23시간이라 시간 묶음이 23개이고 02:00이 없다", async () => {
    const { body } = await report({ from: "2027-03-14", to: "2027-03-14", granularity: "hour", timezone: "America/New_York", metrics: ["events"] });
    const labels = body.rows.map((r: { label: string }) => r.label);
    expect(labels).toHaveLength(23);
    expect(labels).not.toContain("2027-03-14 02:00");
    expect(body.meta.buckets.map((b: { label: string }) => b.label)).toEqual(labels);
    expect(body.rows.every((r: { events: number }) => r.events === 1)).toBe(true);
  });

  // 11월 1일 2시가 1시로 돌아간다. 01:00이 두 번이고 bucket(UTC 순간)으로 가린다.
  it("뉴욕 2026-11-01은 25시간이라 시간 묶음이 25개이고, 01:00이 둘(05:00Z, 06:00Z)이며 하루 묶음은 25건이다", async () => {
    const hourly = await report({ from: "2026-11-01", to: "2026-11-01", granularity: "hour", timezone: "America/New_York", metrics: ["events"] });
    expect(hourly.body.rows).toHaveLength(25);
    expect(hourly.body.rows.filter((r: { label: string }) => r.label === "2026-11-01 01:00").map((r: { bucket: string }) => r.bucket)).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T06:00:00.000Z",
    ]);
    const daily = await report({ from: "2026-11-01", to: "2026-11-01", granularity: "day", timezone: "America/New_York", metrics: ["events"] });
    expect(daily.body.rows).toEqual([{ bucket: "2026-11-01T04:00:00.000Z", label: "2026-11-01", dimensions: {}, events: 25 }]);
  });

  it("30분 단위 시간대(콜카타): 18:29Z는 26일, 18:31Z는 27일 00:00 묶음이다", async () => {
    const { body } = await report({
      from: "2026-10-26",
      to: "2026-10-27",
      granularity: "hour",
      timezone: "Asia/Kolkata",
      metrics: ["events"],
      filters: [{ dimension: "event_name", values: ["ist"] }],
    });
    expect(body.rows).toEqual([
      { bucket: "2026-10-26T17:30:00.000Z", label: "2026-10-26 23:00", dimensions: {}, events: 1 },
      { bucket: "2026-10-26T18:30:00.000Z", label: "2026-10-27 00:00", dimensions: {}, events: 1 },
    ]);
  });

  it("수요일(10-28)에 시작하는 기간의 주 묶음은 그 주 월요일이지만 기간 안의 이벤트(6번)만 세고, 일부만 찬 묶음으로 표시한다", async () => {
    const { body } = await report({ from: "2026-10-28", to: "2026-11-03", granularity: "week", metrics: ["events"], filters: noDst.filters, ...kst });
    expect(body.rows).toEqual([{ bucket: "2026-10-25T15:00:00.000Z", label: "2026-10-26", dimensions: {}, events: 1 }]);
    // 이벤트가 없는 둘째 주도 목록에 있다(화면이 0으로 채운다)
    expect(body.meta.buckets.map((b: { label: string; partial: boolean }) => [b.label, b.partial])).toEqual([
      ["2026-10-26", true],
      ["2026-11-02", true],
    ]);
  });
});

describe("보관 기간과 늦은 이벤트", () => {
  it("시작이 보관 기간(07-29 0시 UTC)보다 앞서면 422 out_of_retention이다(한국 시각 07-29는 07-28 15시 UTC에 시작)", async () => {
    const res = await report({ from: "2026-07-29", to: "2026-08-05", granularity: "day", ...kst });
    expect(res).toEqual({ status: 422, body: { error: expect.any(String), code: "out_of_retention" } });
    expect((await report({ from: "2026-07-30", to: "2026-08-05", granularity: "day", ...kst })).status).toBe(200);
    expect((await report({ from: "2026-07-29", to: "2026-08-05", granularity: "day", timezone: "UTC" })).status).toBe(200);
  });

  it("끝이 최근 7일 안이면 provisional이고, 그보다 앞이면 아니다", async () => {
    expect((await report({ from: "2026-10-01", to: "2026-10-19", granularity: "day", ...kst })).body.meta.provisional).toBe(false);
    expect((await report({ from: "2026-10-01", to: "2026-10-20", granularity: "day", ...kst })).body.meta.provisional).toBe(true);
  });
});

describe("설정과 실패", () => {
  it("SQL 글자가 든 필터 값은 그저 값이다(0행, 표는 그대로)", async () => {
    const filters = [{ dimension: "campaign", values: ["x'); drop table events; --"] }];
    expect((await report({ from: "2026-10-27", to: "2026-10-27", granularity: "day", filters })).body.rows).toEqual([]);
    const { rows } = await pool.query("select count(*)::int as n from events");
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it.each([
    ["허용 목록 밖의 차원", { dimensions: ["user_id"] }],
    ["허용 목록 밖의 시간대", { timezone: "Asia/Pyongyang" }],
    ["91일", { from: "2026-08-03", to: "2026-11-01" }],
  ])("%s는 400이다", async (_, patch) => {
    expect((await report({ from: "2026-10-27", to: "2026-10-27", granularity: "day", ...patch })).status).toBe(400);
  });

  // 한국 시각 10-27의 플랫폼별은 세 행(android, ios, web)이다. 한도 3이면 받고, 2면 잘라 주지 않는다.
  it.each([
    [3, 200],
    [2, 422],
  ])("행 한도 %i이면 %i(넘으면 잘라 주지 않고 too_many_rows)", async (maxRows, status) => {
    const small = buildApp(pool, {}, { reports: { maxRows, asOf } });
    try {
      const res = await small.inject({
        method: "POST",
        url: "/reports/query",
        payload: { metrics: ["events"], from: "2026-10-27", to: "2026-10-27", granularity: "day", dimensions: ["platform"], filters: noDst.filters, ...kst },
      });
      expect(res.statusCode).toBe(status);
      if (status === 200) expect(res.json().rows).toHaveLength(3);
      else expect(res.json()).toEqual({ error: expect.any(String), code: "too_many_rows" });
    } finally {
      await small.close();
    }
  });

  // 표를 통째로 잠근 트랜잭션 뒤에서: 잠금 대기 한도에 먼저 닿으면 busy, 문장 한도에 먼저 닿으면 report_timeout
  it.each([
    ["잠금 대기 한도", { lockTimeout: "200ms", statementTimeout: "30s" }, "busy"],
    ["문장 한도", { lockTimeout: "30s", statementTimeout: "200ms" }, "report_timeout"],
  ] as const)("%s에 닿으면 503 %s", async (_, reports, code) => {
    const owner = new pg.Client({ connectionString: db.owner });
    await owner.connect();
    const limited = buildApp(pool, {}, { reports: { ...reports, asOf } });
    try {
      await owner.query("begin");
      await owner.query("lock table events in access exclusive mode");
      const res = await limited.inject({
        method: "POST",
        url: "/reports/query",
        payload: { metrics: ["events"], from: "2026-10-27", to: "2026-10-27", granularity: "day" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: expect.any(String), code });
    } finally {
      await owner.query("rollback");
      await owner.end();
      await limited.close();
    }
  });

  // 계획에 남은 표 이름. EXPLAIN은 실행하지 않으므로, 계획할 때(매개변수 값으로) 가지를 친 것만 빠진다.
  const planned = async (text: string, values: unknown[]) => {
    const { rows } = await pool.query(`explain (format json, costs off) ${text}`, values);
    const names = new Set<string>();
    const walk = (n: { "Relation Name"?: string; Plans?: unknown[] }) => {
      if (n["Relation Name"]) names.add(n["Relation Name"]);
      (n.Plans as (typeof n)[] | undefined)?.forEach(walk);
    };
    walk(rows[0]["QUERY PLAN"][0].Plan);
    return names;
  };
  const kstDay: ReportQuery = { metrics: ["events"], dimensions: [], filters: [], from: "2026-10-27", to: "2026-10-27", granularity: "day", timezone: "Asia/Seoul" };
  const partitions = (names: Set<string>) => [...names].filter((n) => n.startsWith("events_p")).sort();

  it("리포트 SQL은 한국 시각 하루에 파티션 둘만 읽는다(앞뒤 파티션 10-25·10-28은 계획에서 빠진다, 가지치기, A3)", async () => {
    const { text, values } = buildReportSql(kstDay, 10);
    expect(partitions(await planned(text, values))).toEqual(["events_p20261026", "events_p20261027"]);
  });

  it("집계 표 경로의 원본 꼬리는 워터마크부터의 파티션만 계획한다(워터마크가 매개변수라서)", async () => {
    // 한국 시각 10-27 = UTC 10-26 15:00 ~ 10-27 15:00. 워터마크 10-27 03:00 → 원본 꼬리는 UTC 10-27 파티션 하나다.
    const { text, values } = buildReportSql(kstDay, 10, new Date("2026-10-27T03:00:00Z"));
    const names = await planned(text, values);
    expect(partitions(names)).toEqual(["events_p20261027"]);
    expect(names.has("hourly_rollup")).toBe(true);
  });
});

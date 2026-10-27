import type { FunnelQuery } from "@event-analytics/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../test/fresh-database.js";
import { buildApp } from "../app.js";
import { createDailyPartitions } from "../db/partitions.js";
import { createPool } from "../db/pool.js";
import { insertEvents } from "../ingest.js";
import { FUNNEL, generate } from "../load/generate.js";
import { buildFunnelSql } from "../reports/funnel-sql.js";

// 퍼널(DESIGN 6.5, 10장 42~43): 작은 고정 데이터에서 손으로 센 값과 같다. 이 파일만 쓰는 새 DB에 넣는다.
// 단계 a → b → c, 전환 기간 60분, 기간은 한국 시각 10-27(UTC 10-26 15:00 ~ 10-27 15:00). 시각은 UTC다.
//   u1  a 16:00, b 16:10, c 16:20 (naver)                → 3
//   u2  b 16:00, a 16:05                                 → 1 (2단계가 앞)
//   u3  a 17:00, b 18:00(진입 + 60분 정각)                → 1 (반열린 구간)
//   u4  a 18:00, a 20:00, b 20:10                        → 1 (첫 진입만, 두 번째 시도의 전환은 세지 않음)
//   u5  a 19:00:00.000, b 19:00:00.000                   → 1 (같은 밀리초는 뒤가 아님)
//   u6  a 10-26 14:00(기간 앞), a 21:00, b 21:30         → 2 (기간 안의 a로 진입)
//   u7  a 10-27 14:30, b 10-27 15:10(기간 끝 뒤, 전환 기간 안) → 2
//   u8  a 22:00 ios, b 22:10 web                         → 2 (ios로 거르면 1)
//   u9  a 23:00 naver, b 23:10 google                    → 2 (나눔은 진입의 naver)
//   u10 a 10-27 00:00 naver와 google(같은 밀리초)          → 1 (나눔은 event_id가 작은 google)
//   u11 a 10-27 01:00, a 01:30                           → 1 (a → a면 2)
// 합: 1단계 11, 2단계 5(u1, u6, u7, u8, u9), 3단계 1(u1). 나머지 플랫폼은 ios, 채널은 없음.
let db: Awaited<ReturnType<typeof openDatabase>>;
let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;
const asOf = "2026-10-27T12:00:00Z";

type Row = [user: string, name: string, at: string, platform?: string, channel?: string | null, eventId?: string];
const FIXTURE: Row[] = [
  ["u1", "a", "2026-10-26 16:00", "ios", "naver"],
  ["u1", "b", "2026-10-26 16:10", "ios", "naver"],
  ["u1", "c", "2026-10-26 16:20", "ios", "naver"],
  ["u2", "b", "2026-10-26 16:00"],
  ["u2", "a", "2026-10-26 16:05"],
  ["u3", "a", "2026-10-26 17:00"],
  ["u3", "b", "2026-10-26 18:00"],
  ["u4", "a", "2026-10-26 18:00"],
  ["u4", "a", "2026-10-26 20:00"],
  ["u4", "b", "2026-10-26 20:10"],
  ["u5", "a", "2026-10-26 19:00:00.000"],
  ["u5", "b", "2026-10-26 19:00:00.000"],
  ["u6", "a", "2026-10-26 14:00"],
  ["u6", "a", "2026-10-26 21:00"],
  ["u6", "b", "2026-10-26 21:30"],
  ["u7", "a", "2026-10-27 14:30"],
  ["u7", "b", "2026-10-27 15:10"],
  ["u8", "a", "2026-10-26 22:00", "ios"],
  ["u8", "b", "2026-10-26 22:10", "web"],
  ["u9", "a", "2026-10-26 23:00", "ios", "naver"],
  ["u9", "b", "2026-10-26 23:10", "ios", "google"],
  ["u10", "a", "2026-10-27 00:00", "ios", "naver", "ffffffff-0000-4000-8000-000000000000"],
  ["u10", "a", "2026-10-27 00:00", "ios", "google", "00000000-0000-4000-8000-000000000000"],
  ["u11", "a", "2026-10-27 01:00"],
  ["u11", "a", "2026-10-27 01:30"],
];

beforeAll(async () => {
  db = await openDatabase("funnel");
  const owner = new pg.Client({ connectionString: db.owner });
  await owner.connect();
  try {
    // 10-24·10-25는 비어 있지만 가지치기의 아래 끝을 보려고 만든다. 10-01~10-08은 생성기 데이터다.
    await createDailyPartitions(owner, "2026-09-30", "2026-11-05", { retryDelaysMs: [] });
    for (const [user, name, at, platform = "ios", channel = null, eventId] of FIXTURE) {
      await owner.query(
        `insert into events (event_id, occurred_at, user_id, event_name, platform, channel)
         values (coalesce($1::uuid, gen_random_uuid()), $2::timestamptz, $3, $4, $5, $6)`,
        [eventId ?? null, `${at}+00`, user, name, platform, channel],
      );
    }
    const rows = [...generate({ seed: 5, events: 30_000, from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-08T00:00:00Z") })];
    for (let i = 0; i < rows.length; i += 1_000) {
      await insertEvents(owner, rows.slice(i, i + 1_000).map((e) => ({ ...e, at: Date.parse(e.occurredAt) })), { markDirty: false });
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

const day = { steps: ["a", "b", "c"], windowMinutes: 60, from: "2026-10-27", to: "2026-10-27", timezone: "Asia/Seoul" };
async function funnel(body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/funnels/query", payload: { ...day, ...body } });
  return { status: res.statusCode, body: res.json() };
}

describe("손으로 센 퍼널(첫 진입 기준)", () => {
  it("한국 시각 10-27: 1단계 11, 2단계 5, 3단계 1이고, meta에 첫 진입 기준과 windowEnd를 싣는다", async () => {
    expect(await funnel({})).toEqual({
      status: 200,
      body: {
        rows: [{ dimensions: {}, steps: [11, 5, 1] }],
        meta: {
          timezone: "Asia/Seoul",
          entry: "first",
          rangeStart: "2026-10-26T15:00:00.000Z",
          rangeEnd: "2026-10-27T15:00:00.000Z",
          windowEnd: "2026-10-27T16:00:00.000Z",
          provisional: true,
        },
      },
    });
  });

  it("필터는 모든 단계에 건다: ios면 u8의 2단계(web)가 빠지고, naver면 u9의 2단계(google)가 빠진다", async () => {
    expect((await funnel({ filters: [{ dimension: "platform", values: ["ios"] }] })).body.rows).toEqual([{ dimensions: {}, steps: [11, 4, 1] }]);
    expect((await funnel({ filters: [{ dimension: "channel", values: ["naver"] }] })).body.rows).toEqual([{ dimensions: {}, steps: [3, 1, 1] }]);
  });

  it("나눔은 진입 이벤트의 값이고(u9는 naver), 같은 밀리초는 event_id로 정하며(u10은 google), 행의 합이 전체다", async () => {
    expect((await funnel({ breakdown: ["channel"] })).body.rows).toEqual([
      { dimensions: { channel: "google" }, steps: [1, 0, 0] },
      { dimensions: { channel: "naver" }, steps: [2, 2, 1] },
      { dimensions: { channel: null }, steps: [8, 3, 0] },
    ]);
  });

  it("a → a: 같은 이벤트를 두 번 쓰지 않고(u10), 엄격히 뒤의 a가 전환 기간 안이면 2단계다(u11)", async () => {
    // u4는 두 번째 a(20:00)가 진입(18:00) + 60분 밖, u6은 기간 안의 a가 하나, u10은 두 a가 같은 밀리초
    expect((await funnel({ steps: ["a", "a"] })).body.rows).toEqual([{ dimensions: {}, steps: [11, 1] }]);
  });

  it("전환 기간을 늘리면 u3(정각)·u4(두 번째 시도)도 2단계다", async () => {
    // 1일: u3의 b(18:00), u4의 b(20:10)가 진입 + 1일 안. u2(순서)·u5(같은 밀리초)는 그대로 1
    expect((await funnel({ windowMinutes: 1_440 })).body.rows).toEqual([{ dimensions: {}, steps: [11, 7, 1] }]);
  });

  it("진입이 없으면 0인 한 행이다", async () => {
    expect((await funnel({ from: "2026-10-30", to: "2026-10-30" })).body.rows).toEqual([{ dimensions: {}, steps: [0, 0, 0] }]);
  });

  it("보관 기간 밖이면 422, 이벤트 이름 필터는 400이다", async () => {
    expect(await funnel({ from: "2026-07-28", to: "2026-07-30" })).toMatchObject({ status: 422, body: { code: "out_of_retention" } });
    expect((await funnel({ filters: [{ dimension: "event_name", values: ["a"] }] })).status).toBe(400);
  });
});

describe("가지치기", () => {
  // 계획에 남은 원본 파티션. EXPLAIN은 실행하지 않으므로 계획할 때(매개변수 값으로) 가지를 친 것만 빠진다.
  const planned = async (q: FunnelQuery, windowEnd: string) => {
    const { text, values } = buildFunnelSql(q, new Date(windowEnd));
    const { rows } = await pool.query(`explain (format json, costs off) ${text}`, values);
    const names = new Set<string>();
    const walk = (n: { "Relation Name"?: string; Plans?: unknown[] }) => {
      if (n["Relation Name"]) names.add(n["Relation Name"]);
      (n.Plans as (typeof n)[] | undefined)?.forEach(walk);
    };
    walk(rows[0]["QUERY PLAN"][0].Plan);
    return [...names].sort();
  };
  const q = { ...day, filters: [], breakdown: [] } as FunnelQuery;

  it("한국 시각 하루 + 60분은 10-26·10-27 파티션만 계획한다(10-25·10-28은 빠짐)", async () => {
    expect(await planned(q, "2026-10-27T16:00:00Z")).toEqual(["events_p20261026", "events_p20261027"]);
  });

  it("전환 기간 7일이면 windowEnd(11-03 15:00)의 파티션까지다", async () => {
    const names = await planned({ ...q, windowMinutes: 10_080 }, "2026-11-03T15:00:00Z");
    expect(names[0]).toBe("events_p20261026");
    expect(names.at(-1)).toBe("events_p20261103");
    expect(names).toHaveLength(9);
  });
});

describe("생성기 데이터", () => {
  // 통계 없이(ANALYZE 전) 돈다. 중첩 반복을 끄지 않으면 계획기가 진입 사용자를 몇 명으로 어림해 단계마다 원본을 거듭 훑어 30초 한도에 닿는다.
  // 생성기는 세션마다 단계를 정한 비율(FUNNEL)로 잇고, 단계 사이는 5초~2분이다. 전환 기간 15분이면 첫 세션 안에서만 이어
  // 단계 비율이 생성기의 비율 근처다(측정 전에 적은 예상, DESIGN 6.5). 1일이면 같은 사용자의 다음 세션이 들어 더 높다.
  it("전환 기간 15분이면 단계 비율이 생성기의 비율(60·35·70·85%)에서 5%p 안이다", async () => {
    const steps = FUNNEL.map(([name]) => name);
    const narrow = await funnel({ steps, windowMinutes: 15, from: "2026-10-01", to: "2026-10-07" });
    const counts: number[] = narrow.body.rows[0].steps;
    FUNNEL.slice(1).forEach(([, rate], i) => {
      expect(Math.abs(counts[i + 1]! / counts[i]! - rate)).toBeLessThan(0.05);
    });
    const wide = await funnel({ steps, windowMinutes: 1_440, from: "2026-10-01", to: "2026-10-07" });
    expect(wide.body.rows[0].steps.at(-1)).toBeGreaterThan(counts.at(-1)!);
  });
});

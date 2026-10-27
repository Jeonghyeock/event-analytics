import { randomUUID } from "node:crypto";
import { ReportQuery } from "@event-analytics/shared";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../test/fresh-database.js";
import { createDailyPartitions } from "../db/partitions.js";
import { createPool } from "../db/pool.js";
import { insertEvents } from "../ingest.js";
import { generate } from "../load/generate.js";
import { runRollup } from "../rollup.js";
import { runReport } from "./run.js";

// 합격 기준 A5(집계 표 = 원본)와 A6(늦은 이벤트, DESIGN 6.4). 생성기 데이터(10-19 ~ 11-02 12시)를 넣고 집계 작업을 "지금" = 11-01 12:30으로
// 돌린다. 그러면 기간이 집계 표(11-01 12시 앞)와 원본 꼬리(그 뒤)로 나뉜다. 같은 설정을 두 경로로 돌려 견준다.
// 런던(10-25 01:00 UTC)과 뉴욕(11-01 06:00 UTC)의 일광 절약 시간이 끝나는 때는 집계 표 쪽에 든다.
let db: Awaited<ReturnType<typeof openDatabase>>;
let pool: pg.Pool;
const asOf = "2026-10-27T12:00:00Z";
const now = "2026-11-01T12:30:00Z";

beforeAll(async () => {
  db = await openDatabase("rollreport");
  const owner = new pg.Client({ connectionString: db.owner });
  await owner.connect();
  try {
    await createDailyPartitions(owner, "2026-10-18", "2026-11-03", { retryDelaysMs: [] });
    await owner.query("update rollup_state set watermark = '2026-10-19 00:00+00'");
    const rows = [...generate({ seed: 11, events: 30_000, from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-11-02T12:00:00Z") })];
    for (let i = 0; i < rows.length; i += 1_000) {
      await insertEvents(owner, rows.slice(i, i + 1_000).map((e) => ({ ...e, at: Date.parse(e.occurredAt) })), { markDirty: false });
    }
  } finally {
    await owner.end();
  }
  pool = createPool({ connectionString: db.app, max: 3 });
  await runRollup(pool, { now });
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const both = async (body: Record<string, unknown>) => {
  const q = ReportQuery.parse({ metrics: ["events"], ...body });
  const rollup = await runReport(pool, q, { asOf });
  const raw = await runReport(pool, q, { asOf, forceRaw: true });
  return { rollup, raw };
};

const ZONES = ["UTC", "Asia/Seoul", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles"];

describe("A5 — 집계 표 경로 = 원본 경로", () => {
  it.each(ZONES)("%s: 일·주·전체, 차원과 필터", async (timezone) => {
    for (const body of [
      { granularity: "day", from: "2026-10-26", to: "2026-11-02" },
      { granularity: "week", from: "2026-10-20", to: "2026-11-01", dimensions: ["platform"] },
      { granularity: "total", from: "2026-10-20", to: "2026-11-02", dimensions: ["campaign", "country"] },
      {
        granularity: "day",
        from: "2026-10-21",
        to: "2026-10-25",
        dimensions: ["event_name"],
        filters: [
          { dimension: "channel", values: ["naver", null] },
          { dimension: "platform", values: ["ios", "web"] },
        ],
      },
    ]) {
      const { rollup, raw } = await both({ ...body, timezone });
      expect(rollup.meta.source).toBe("rollup");
      expect(raw.meta.source).toBe("raw");
      expect(rollup.rows).toEqual(raw.rows);
      expect(rollup.rows.length).toBeGreaterThan(0);
    }
  });

  it("시간 단위도 같고(워터마크 11-01 12시를 사이에 둔 이틀), 워터마크를 알린다", async () => {
    const { rollup, raw } = await both({ granularity: "hour", from: "2026-10-31", to: "2026-11-01", timezone: "UTC", dimensions: ["platform"] });
    expect(rollup.rows).toEqual(raw.rows);
    expect(rollup.meta.rollupWatermark).toBe("2026-11-01T12:00:00.000Z");
    expect(raw.meta.rollupWatermark).toBeNull();
  });

  // 집계 표 쪽에서도 일광 절약 시간이 끝나는 날의 두 01:00을 따로 센다(코드 리뷰)
  it.each([
    ["Europe/London", "2026-10-24", "2026-10-25", "2026-10-25 01:00"],
    ["America/New_York", "2026-10-31", "2026-11-01", "2026-11-01 01:00"],
  ])("%s 시간 단위: 일광 절약 시간이 끝나는 날", async (timezone, from, to, twice) => {
    const { rollup, raw } = await both({ granularity: "hour", from, to, timezone });
    expect(rollup.meta.source).toBe("rollup");
    expect(rollup.rows).toEqual(raw.rows);
    expect(rollup.rows.filter((r) => r.label === twice)).toHaveLength(2);
  });

  it("기간이 워터마크 뒤에서 시작하면 원본으로 센다고 알린다", async () => {
    const { rollup } = await both({ granularity: "day", from: "2026-11-02", to: "2026-11-02", timezone: "UTC" });
    expect(rollup.meta).toMatchObject({ source: "raw", rollupWatermark: null, stale: false });
  });
});

describe("A6 — 늦은 이벤트", () => {
  it("집계된 시간에 늦은 이벤트가 들어오면 다음 작업까지 stale이고 옛 값이며, 작업 뒤 다시 같다", async () => {
    const body = { granularity: "day", from: "2026-10-21", to: "2026-10-21", timezone: "UTC" };
    const before = await both(body);
    expect(before.rollup.meta.stale).toBe(false);
    const client = await pool.connect();
    try {
      await insertEvents(client, [
        { eventId: randomUUID(), occurredAt: "2026-10-21T08:15:00Z", at: Date.parse("2026-10-21T08:15:00Z"), userId: "late", eventName: "late", platform: "web" },
      ]);
    } finally {
      client.release();
    }
    const stale = await both(body);
    expect(stale.rollup.meta.stale).toBe(true);
    expect(stale.rollup.rows[0]!.events).toBe(before.raw.rows[0]!.events);
    expect(stale.raw.rows[0]!.events).toBe(before.raw.rows[0]!.events! + 1);
    await runRollup(pool, { now });
    const after = await both(body);
    expect(after.rollup.meta.stale).toBe(false);
    expect(after.rollup.rows).toEqual(after.raw.rows);
  });
});

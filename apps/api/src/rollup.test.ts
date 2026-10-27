import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, onTestFinished } from "vitest";
import { freshDatabase } from "../test/fresh-database.js";
import { createDailyPartitions } from "./db/partitions.js";
import { createPool } from "./db/pool.js";
import { insertEvents } from "./ingest.js";
import { generate } from "./load/generate.js";
import { runRollup } from "./rollup.js";

// 집계 작업(DESIGN 6.4, 합격 기준 A5·A6). 테스트마다 새 DB에 생성기 데이터를 넣고, "지금"을 정해 돌린다.
const now = "2026-10-27T12:30:00Z";
const fast = { now, chunkHours: 24 };

async function setup(watermark = "2026-10-20T00:00:00Z") {
  const db = await freshDatabase("rollup");
  const owner = new pg.Client({ connectionString: db.owner });
  await owner.connect();
  onTestFinished(() => owner.end());
  await createDailyPartitions(owner, "2026-10-15", "2026-10-28", { retryDelaysMs: [] });
  await owner.query("update rollup_state set watermark = $1", [watermark]);
  const pool = createPool({ connectionString: db.app, max: 3 });
  onTestFinished(() => pool.end());
  return { owner, pool };
}

// 한 주의 생성기 이벤트(수만 건). 집계 작업이 셀 데이터다.
async function load(client: pg.ClientBase, events = 20_000) {
  const rows = [...generate({ seed: 7, events, from: new Date("2026-10-20T00:00:00Z"), to: new Date("2026-10-27T12:00:00Z") })];
  for (let i = 0; i < rows.length; i += 1_000) {
    await insertEvents(client, rows.slice(i, i + 1_000).map((e) => ({ ...e, at: Date.parse(e.occurredAt) })), { markDirty: false });
  }
}

const event = (occurredAt: string, campaign: string | undefined = "camp_x") => ({
  eventId: randomUUID(),
  occurredAt,
  at: Date.parse(occurredAt),
  userId: "late",
  eventName: "seat_map_viewed",
  platform: "ios" as const,
  country: "KR",
  ...(campaign ? { campaign } : {}),
});

// 워터마크 앞의 집계 표가 원본을 시간 × 차원 다섯으로 센 것과 같은지. 다른 행 수를 돌려준다(0이면 같다).
async function diff(client: pg.ClientBase | pg.Pool, before: string) {
  const { rows } = await client.query<{ n: number }>(
    `with raw as (
       select date_trunc('hour', occurred_at, 'UTC') as hour, event_name, platform, country, channel, campaign, count(*)::bigint as events
         from events where occurred_at < $1 group by 1, 2, 3, 4, 5, 6),
     roll as (select hour, event_name, platform, country, channel, campaign, events from hourly_rollup where hour < $1)
     select ((select count(*) from (select * from raw except select * from roll) a) +
             (select count(*) from (select * from roll except select * from raw) b))::int as n`,
    [before],
  );
  return rows[0]!.n;
}

describe("집계 작업", () => {
  it("워터마크부터 끝난 시간(지금의 정시)까지 조각으로 채우고, 집계 표가 원본과 같다(A5)", async () => {
    const { owner, pool } = await setup();
    await load(owner);
    const result = await runRollup(pool, fast);
    // 10-20 0시 → 10-27 12시: 180시간, 하루씩 8조각
    expect(result).toEqual({ skipped: false, chunks: 8, hours: 180, watermark: "2026-10-27T12:00:00.000Z" });
    expect(await diff(pool, "2026-10-27T12:00:00Z")).toBe(0);
    const { rows } = await pool.query("select sum(events)::int as n from hourly_rollup");
    expect(rows[0].n).toBe(20_000);
    // 다시 돌리면 할 일이 없다
    expect(await runRollup(pool, fast)).toEqual({ skipped: false, chunks: 1, hours: 0, watermark: "2026-10-27T12:00:00.000Z" });
  });

  it("늦은 이벤트가 든 시간은 다음 실행까지 옛 값이고, 실행 뒤 다시 같다(A6)", async () => {
    const { owner, pool } = await setup();
    await load(owner);
    await runRollup(pool, fast);
    const client = await pool.connect();
    try {
      await insertEvents(client, [event("2026-10-21T05:30:00Z"), event("2026-10-21T05:31:00Z", undefined)]);
    } finally {
      client.release();
    }
    expect(await diff(pool, "2026-10-27T12:00:00Z")).toBeGreaterThan(0);
    const result = await runRollup(pool, fast);
    expect(result).toMatchObject({ hours: 1 });
    expect(await diff(pool, "2026-10-27T12:00:00Z")).toBe(0);
  });

  // 설계 리뷰·조언이 찾은 경쟁: 더러운 시간이 유일 키 + DO NOTHING이면 둘째 실행이 할 일을 찾지 못해 영영 다르다.
  it("커밋 전인 수집의 시간은 실행이 지우지 못하고 남아, 그 수집이 커밋한 뒤 다음 실행이 센다", async () => {
    const { owner, pool } = await setup();
    await load(owner);
    await runRollup(pool, fast);
    // H에는 이미 더러운 행이 하나 있다(앞선 늦은 이벤트)
    const h = "2026-10-22T07:00:00Z";
    await insertEvents(owner, [event("2026-10-22T07:10:00Z")]);
    const t = await pool.connect();
    try {
      await t.query("begin");
      await insertEvents(t, [event("2026-10-22T07:20:00Z")]);
      // T가 쥔 동안 실행: 앞선 행만 가져가고 T의 이벤트는 아직 보이지 않는다
      await runRollup(pool, fast);
      await t.query("commit");
    } finally {
      t.release();
    }
    expect(await diff(pool, "2026-10-27T12:00:00Z")).toBeGreaterThan(0);
    const { rows } = await pool.query("select count(*)::int as n from dirty_hours where hour = $1", [h]);
    expect(rows[0].n).toBe(1);
    await runRollup(pool, fast);
    expect(await diff(pool, "2026-10-27T12:00:00Z")).toBe(0);
  });

  it("가져온 시간이 그 조각의 범위 안에 있어도 한 번만 센다(따로 넣으면 유일 키에 막혀 워터마크가 멈춘다)", async () => {
    const { owner, pool } = await setup("2026-10-25T00:00:00Z");
    await load(owner);
    // 10-25 05시(첫 조각 안)와 10-22 03시(워터마크 앞)가 더럽다. 10-22는 아직 한 번도 세지 않았으니 미리 센 것처럼 행을 넣어 둔다.
    await owner.query(
      `insert into hourly_rollup (hour, event_name, platform, country, channel, campaign, events)
       select date_trunc('hour', occurred_at, 'UTC'), event_name, platform, country, channel, campaign, count(*)
         from events where occurred_at < '2026-10-25 00:00+00' group by 1, 2, 3, 4, 5, 6`,
    );
    await insertEvents(owner, [event("2026-10-25T05:15:00Z"), event("2026-10-22T03:15:00Z")]);
    const result = await runRollup(pool, fast);
    expect(result).toMatchObject({ skipped: false, chunks: 3, watermark: "2026-10-27T12:00:00.000Z" });
    expect(await diff(pool, "2026-10-27T12:00:00Z")).toBe(0);
  });

  it("여러 날에 걸친 늦은 이벤트를 조각마다 빠짐없이 센다", async () => {
    const { owner, pool } = await setup();
    await load(owner);
    await runRollup(pool, fast);
    await insertEvents(owner, ["2026-10-20T01:05:00Z", "2026-10-23T11:05:00Z", "2026-10-26T22:05:00Z"].map((t) => event(t)));
    // 작은 조각(6시간)으로 돌아도 모두 센다
    await runRollup(pool, { ...fast, chunkHours: 6 });
    expect(await diff(pool, "2026-10-27T12:00:00Z")).toBe(0);
  });

  it("다른 실행이 상태 행을 쥐고 있으면 바로 건너뛰고, 상태 행이 없으면 오류다", async () => {
    const { owner, pool } = await setup();
    await owner.query("begin");
    await owner.query("select * from rollup_state for update");
    const started = Date.now();
    expect(await runRollup(pool, fast)).toEqual({ skipped: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    await owner.query("rollback");
    await owner.query("delete from rollup_state");
    await expect(runRollup(pool, fast)).rejects.toThrow(/rollup_state 행이 없습니다/);
  });

  it("워터마크가 보관 기간보다 앞이면 보관 기간의 시작부터 센다(지운 날은 세지 않는다)", async () => {
    const { owner, pool } = await setup("2026-01-01T00:00:00Z");
    await load(owner, 2_000);
    // 지금 10-27 → 보관 기간의 시작은 07-29 0시. 그 앞 날을 세지 않으니 조각은 07-29부터다.
    const result = await runRollup(pool, { ...fast, chunkHours: 24 * 100 });
    expect(result).toMatchObject({ chunks: 1, hours: (Date.parse("2026-10-27T12:00:00Z") - Date.parse("2026-07-29T00:00:00Z")) / 3_600_000 });
    expect(await diff(pool, "2026-10-27T12:00:00Z")).toBe(0);
  });
});

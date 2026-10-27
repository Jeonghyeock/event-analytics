import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";
import { withDatabase } from "../db/databases.js";
import { createDailyPartitions, partitionName, utcDay } from "../db/partitions.js";
import { createPool } from "../db/pool.js";

// POST /ingest(DESIGN 6.1, 합격 기준 A1·A2). 저장 결과는 응답이 아니라 DB를 직접 세어 확인한다(DESIGN 3장).
// 쓰기 키는 실행마다 만든다(저장소에 키 같은 글자를 두지 않는다).
const writeKey = randomBytes(32).toString("hex");
const pool = createPool({ connectionString: inject("databaseUrl") });
const app = buildApp(pool, {}, { ingestWriteKey: writeKey });
const watcher = createPool({ connectionString: inject("databaseUrl"), max: 1 });
afterAll(async () => {
  await app.close();
  await Promise.all([pool.end(), watcher.end()]);
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

function event(patch: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    occurredAt: iso(Date.now() - MINUTE),
    userId: "anon-1",
    eventName: "seat_map_viewed",
    platform: "web",
    country: "KR",
    channel: "naver",
    campaign: "fall_sale",
    properties: { performanceId: 7 },
    ...patch,
  };
}

// key가 null이면 키 헤더를 붙이지 않는다.
async function post(target: ReturnType<typeof buildApp>, body: unknown, key: string | null = writeKey) {
  const res = await target.inject({
    method: "POST",
    url: "/ingest",
    headers: { "content-type": "application/json", ...(key === null ? {} : { "x-write-key": key }) },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = res.json();
  // 응답의 수는 늘 맞아떨어진다
  if (res.statusCode === 200) expect(json.received).toBe(json.inserted + json.duplicates + json.rejected.length);
  return { status: res.statusCode, body: json };
}
const send = (events: unknown[], key: string | null = writeKey) => post(app, { events }, key);

const stored = async (db: pg.Pool, ids: string[]) =>
  (await db.query<{ n: number }>("select count(*)::int as n from events where event_id = any($1::uuid[])", [ids])).rows[0]!.n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("기다리던 상태가 되지 않았습니다");
}
// 수집 문장이 다른 트랜잭션의 같은 키를 기다리는 중인지. 기다리는 쪽의 트랜잭션 밖에서(따로 접속해) 본다.
const ingestWaitingOnLock = async () =>
  (
    await watcher.query(
      `select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%insert into events%unnest%'`,
    )
  ).rows.length === 1;

describe("A1 — 한 번만 저장", () => {
  it("같은 배치를 다시 보내면 모두 중복으로 세고, DB에는 한 번씩만 있다", async () => {
    const events = [event(), event(), event()];
    const ids = events.map((e) => e.eventId);
    expect((await send(events)).body).toEqual({ received: 3, inserted: 3, duplicates: 0, rejected: [] });
    expect((await send(events)).body).toEqual({ received: 3, inserted: 0, duplicates: 3, rejected: [] });
    expect(await stored(pool, ids)).toBe(3);
  });

  it("한 배치 안의 같은 이벤트(같은 순간을 다른 오프셋으로 쓴 것도)는 한 번만 넣는다", async () => {
    const at = Date.now() - 10 * MINUTE;
    const e = event({ occurredAt: iso(at) });
    const sameInstantSeoul = { ...e, occurredAt: new Date(at + 9 * 60 * MINUTE).toISOString().replace("Z", "+09:00") };
    const { body } = await send([e, e, sameInstantSeoul]);
    expect(body).toEqual({ received: 3, inserted: 1, duplicates: 2, rejected: [] });
    expect(await stored(pool, [e.eventId])).toBe(1);
  });

  it("같은 이벤트를 넣는 다른 트랜잭션이 끝나길 기다렸다가, 그쪽이 커밋하면 중복으로 센다", async () => {
    const e = event();
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "insert into events (event_id, occurred_at, user_id, event_name, platform) values ($1, $2, 'other', 'x', 'ios')",
        [e.eventId, e.occurredAt],
      );
      const pending = send([e]);
      await waitUntil(ingestWaitingOnLock);
      await holder.query("commit");
      expect((await pending).body).toEqual({ received: 1, inserted: 0, duplicates: 1, rejected: [] });
    } finally {
      holder.release();
    }
    const { rows } = await pool.query("select user_id from events where event_id = $1", [e.eventId]);
    expect(rows).toEqual([{ user_id: "other" }]);
  });

  it("그쪽이 되돌리면 기다린 쪽이 넣는다", async () => {
    const e = event();
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "insert into events (event_id, occurred_at, user_id, event_name, platform) values ($1, $2, 'other', 'x', 'ios')",
        [e.eventId, e.occurredAt],
      );
      const pending = send([e]);
      await waitUntil(ingestWaitingOnLock);
      await holder.query("rollback");
      expect((await pending).body).toEqual({ received: 1, inserted: 1, duplicates: 0, rejected: [] });
    } finally {
      holder.release();
    }
    expect(await stored(pool, [e.eventId])).toBe(1);
  });

  it("그쪽이 잠금 대기 한도(3초)를 넘게 쥐고 있으면 503 busy이고, 아무것도 넣지 않는다", { timeout: 15_000 }, async () => {
    const e = event();
    const other = event();
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "insert into events (event_id, occurred_at, user_id, event_name, platform) values ($1, $2, 'other', 'x', 'ios')",
        [e.eventId, e.occurredAt],
      );
      const started = Date.now();
      const res = await send([other, e]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
      expect(res).toEqual({ status: 503, body: { error: expect.any(String), code: "busy" } });
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect(await stored(pool, [e.eventId, other.eventId])).toBe(0);
    // 다시 보내면 된다
    expect((await send([other, e])).body).toMatchObject({ inserted: 2 });
  });
});

describe("파티션이 없을 때", () => {
  // 파티션을 지우는 시험이라, 다른 파일과 함께 쓰지 않는 DB(isolated)에서 한다.
  const isolatedUrl = inject("isolatedDatabaseUrl");
  const isolatedPool = createPool({ connectionString: isolatedUrl });
  const isolatedApp = buildApp(isolatedPool, {}, { ingestWriteKey: writeKey });
  const isolatedOwner = new pg.Pool({
    connectionString: withDatabase(inject("ownerDatabaseUrl"), new URL(isolatedUrl).pathname.slice(1)),
    max: 1,
  });
  afterAll(async () => {
    await isolatedApp.close();
    await Promise.all([isolatedPool.end(), isolatedOwner.end()]);
  });

  it("받을 기간 안인데 파티션이 없으면 503 partition_missing이고 배치 전체를 넣지 않으며, 파티션을 만든 뒤 다시 보내면 들어간다", async () => {
    const day = utcDay(new Date(Date.now() - 3 * DAY));
    await isolatedOwner.query(`drop table ${partitionName(day)}`);
    const missing = event({ occurredAt: `${day}T12:00:00Z` });
    const fine = event();
    const res = await post(isolatedApp, { events: [fine, missing] });
    expect(res).toEqual({ status: 503, body: { error: expect.any(String), code: "partition_missing" } });
    expect(await stored(isolatedPool, [fine.eventId, missing.eventId])).toBe(0);

    const client = await isolatedOwner.connect();
    try {
      expect(await createDailyPartitions(client, day, day)).toEqual([partitionName(day)]);
    } finally {
      client.release();
    }
    expect((await post(isolatedApp, { events: [fine, missing] })).body).toMatchObject({ inserted: 2 });
  });
});

describe("A2 — 받을 기간 밖과 틀린 이벤트는 이유와 함께 거절", () => {
  it("경계 안쪽은 받고, 바깥쪽은 too_old·too_far_in_future로 거절한다", async () => {
    const now = Date.now();
    const events = [
      event({ occurredAt: iso(now - 7 * DAY + MINUTE) }),
      event({ occurredAt: iso(now - 7 * DAY - MINUTE) }),
      event({ occurredAt: iso(now + 60 * MINUTE - MINUTE) }),
      event({ occurredAt: iso(now + 60 * MINUTE + MINUTE) }),
    ];
    const { status, body } = await send(events);
    expect(status).toBe(200);
    expect(body).toEqual({
      received: 4,
      inserted: 2,
      duplicates: 0,
      rejected: [
        { index: 1, reason: "too_old", message: expect.any(String) },
        { index: 3, reason: "too_far_in_future", message: expect.any(String) },
      ],
    });
    expect(await stored(pool, [events[0]!.eventId, events[2]!.eventId])).toBe(2);
    expect(await stored(pool, [events[1]!.eventId, events[3]!.eventId])).toBe(0);
  });

  it("틀린 이벤트는 어느 필드가 틀렸는지와 함께 거절하고, 나머지는 넣는다", async () => {
    const good = event();
    const events = [
      { ...event(), platform: "tv" },
      good,
      { ...event(), userId: `a${String.fromCharCode(0)}b` },
      { ...event(), properties: { k: `x${String.fromCharCode(0xd800)}` } },
      { ...event(), campain: "typo" },
      "not an object",
    ];
    const { status, body } = await send(events);
    expect(status).toBe(200);
    expect(body.inserted).toBe(1);
    expect(body.rejected.map((r: { index: number; reason: string }) => [r.index, r.reason])).toEqual([
      [0, "invalid"],
      [2, "invalid"],
      [3, "invalid"],
      [4, "invalid"],
      [5, "invalid"],
    ]);
    expect(body.rejected[0].message).toMatch(/^platform: /);
    expect(body.rejected[1].message).toMatch(/^userId: /);
    expect(body.rejected[2].message).toMatch(/^properties: /);
    expect(body.rejected[3].message).toMatch(/campain/);
    expect(await stored(pool, [good.eventId])).toBe(1);
    const ids = events.flatMap((e) => (typeof e === "object" && e.eventId !== good.eventId ? [e.eventId] : []));
    expect(await stored(pool, ids)).toBe(0);
  });

  it("마이크로초를 담은 시각은 그대로 저장되고, 같은 글자로 다시 보내면 중복이다", async () => {
    const e = event({ occurredAt: `${iso(Date.now() - MINUTE).slice(0, 19)}.123456Z` });
    expect((await send([e])).body).toMatchObject({ inserted: 1 });
    expect((await send([e])).body).toMatchObject({ inserted: 0, duplicates: 1 });
    const { rows } = await pool.query("select to_char(occurred_at, 'US') as us from events where event_id = $1", [e.eventId]);
    expect(rows).toEqual([{ us: "123456" }]);
  });
});

describe("봉투와 쓰기 키", () => {
  it.each([
    ["키 없음", null],
    ["틀린 키", randomBytes(32).toString("hex")],
    ["길이가 다른 키", "short"],
  ])("%s는 401이다", async (_, key) => {
    const e = event();
    expect((await send([e], key)).status).toBe(401);
    expect(await stored(pool, [e.eventId])).toBe(0);
  });

  it("키가 틀리면 본문이 틀려도 400이 아니라 401이다(본문을 읽기 전에 본다)", async () => {
    expect((await post(app, "{not json", null)).status).toBe(401);
  });

  it.each([
    ["빈 배열", { events: [] }],
    ["배열이 아님", { events: {} }],
    ["1,001건", { events: Array.from({ length: 1_001 }, () => event()) }],
    ["모르는 필드", { events: [event()], extra: true }],
    ["JSON이 아님", "{not json"],
    ["properties 안의 __proto__", `{"events":[{"properties":{"__proto__":{"admin":true}}}]}`],
  ])("봉투가 틀리면(%s) 400이다", async (_, body) => {
    const { status, body: res } = await post(app, body);
    expect(status).toBe(400);
    expect(res).toEqual({ error: expect.any(String) });
  });

  it("본문이 5MiB를 넘으면 413이다", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    expect((await post(app, { events: [event({ properties: { big } })] })).status).toBe(413);
  });
});

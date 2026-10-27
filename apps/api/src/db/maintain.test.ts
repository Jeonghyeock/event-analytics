import pg from "pg";
import { describe, expect, inject, it, onTestFinished } from "vitest";
import { missingSoon } from "../partition-watch.js";
import { dropDatabase, NEW_DATABASE_OPTIONS, withAdminClient, withDatabase } from "./databases.js";
import { runMigrations } from "./migrate.js";
import { createDailyPartitions, listPartitions, maintain, missingPartitionDays } from "./partitions.js";

// 파티션 관리 작업(DESIGN 6.2, 10장 28). 파티션을 만들고 떼므로 테스트마다 새 DB를 만들어 마이그레이션하고, 끝나면 지운다.
const ownerUrl = inject("ownerDatabaseUrl");
const appUrl = inject("databaseUrl");
let created = 0;

async function freshDatabase() {
  const name = `event_analytics_maint_${process.pid}_${++created}`;
  await withAdminClient(ownerUrl, async (client) => {
    await dropDatabase(client, name);
    await client.query(`CREATE DATABASE ${name} ${NEW_DATABASE_OPTIONS}`);
  });
  onTestFinished(() => withAdminClient(ownerUrl, (client) => dropDatabase(client, name)));
  const url = withDatabase(ownerUrl, name);
  await runMigrations(url);
  return { owner: url, app: withDatabase(appUrl, name) };
}

async function connect(url: string, options = "-c TimeZone=UTC") {
  const client = new pg.Client({ connectionString: url, options });
  client.on("error", () => {});
  await client.connect();
  onTestFinished(() => client.end());
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("기다리던 상태가 되지 않았습니다");
}

const today = "2026-10-27";
const fast = { retryDelaysMs: [] };
const insertSql = (day: string) =>
  `insert into events (event_id, occurred_at, user_id, event_name, platform) values (gen_random_uuid(), '${day} 01:00+00', 'u', 'e', 'web')`;
// 떼기가 다른 트랜잭션이 끝나길 기다리는 중인지(따로 접속해 본다)
const detachWaiting = (watcher: pg.Client) => async () =>
  (
    await watcher.query(
      `select 1 from pg_stat_activity
        where datname = current_database() and wait_event = 'virtualxid' and query ilike '%detach partition%concurrently%'`,
    )
  ).rows.length === 1;

// name을 떼다가 취소해 "떼는 중"으로 남긴다. 떼기가 기다리도록 그동안 부모를 읽은 트랜잭션을 열어 둔다.
async function leavePending(db: { owner: string; app: string }, name: string) {
  const reader = await connect(db.app);
  const watcher = await connect(db.owner);
  const detacher = await connect(db.owner);
  await reader.query("begin");
  await reader.query("select count(*) from events");
  const pid = (await detacher.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const detaching = detacher.query(`alter table events detach partition ${name} concurrently`).catch((e: unknown) => e);
  await waitUntil(detachWaiting(watcher));
  await watcher.query("select pg_cancel_backend($1)", [pid]);
  expect(await detaching).toMatchObject({ code: "57014" });
  await reader.query("commit");
}

describe("관리 작업", () => {
  it("오늘 ±7일 가운데 없는 날을 ATTACH로 만들고, 다시 돌리면 아무것도 하지 않는다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    const first = await maintain(owner, { today, ...fast });
    expect(first.created).toHaveLength(15);
    expect(first.created[0]).toBe("events_p20261020");
    expect(first.created.at(-1)).toBe("events_p20261103");
    expect(await maintain(owner, { today, ...fast })).toEqual({ created: [], finalized: [], dropped: [], errors: [] });

    // 새 파티션의 기본 키 인덱스는 부모 인덱스에 붙었고, 앱 role은 소유자의 기본 권한으로 DML을 할 수 있다
    const { rows } = await owner.query(
      `select count(*)::int as attached_indexes,
              bool_and(has_table_privilege('event_analytics_app', x.indrelid, 'SELECT, INSERT, UPDATE, DELETE')) as app_dml
         from pg_inherits i join pg_index x on x.indexrelid = i.inhrelid
        where i.inhparent = 'events_pkey'::regclass`,
    );
    expect(rows).toEqual([{ attached_indexes: 15, app_dml: true }]);
    const app = await connect(db.app);
    await app.query(insertSql(today));
  });

  it("ATTACH로 만드는 동안 열린 SELECT·INSERT를 막지 않는다(1단계의 PARTITION OF는 막힌다)", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    await createDailyPartitions(owner, today, today, fast);
    const reader = await connect(db.app);
    const writer = await connect(db.app);
    await reader.query("begin");
    await reader.query("select count(*) from events");
    await writer.query("begin");
    await writer.query(insertSql(today));

    // 열린 SELECT·INSERT가 있어도 1초 안에 만든다
    expect(await createDailyPartitions(owner, "2026-11-10", "2026-11-10", fast)).toEqual(["events_p20261110"]);

    // 만드는 트랜잭션이 끝나지 않은 동안에도 다른 연결의 INSERT가 된다
    await owner.query("begin");
    await owner.query("create table events_p20261111 (like events including all)");
    await owner.query("alter table events attach partition events_p20261111 for values from ('2026-11-11 00:00+00') to ('2026-11-12 00:00+00')");
    const other = await connect(db.app, "-c TimeZone=UTC -c lock_timeout=1s");
    await other.query(insertSql(today));
    await owner.query("commit");

    // 비교: PARTITION OF는 부모를 AccessExclusiveLock으로 잠그려다 열린 SELECT 뒤에서 1초 한도에 닿는다
    await owner.query("set lock_timeout = '1s'");
    await expect(
      owner.query("create table events_p20261112 partition of events for values from ('2026-11-12 00:00+00') to ('2026-11-13 00:00+00')"),
    ).rejects.toMatchObject({ code: "55P03" });
    await reader.query("commit");
    await writer.query("commit");
  });

  it("90일 지난 파티션은 CONCURRENTLY로 떼고 지운다. 그 파티션을 본 트랜잭션을 기다리는 동안 수집은 막히지 않는다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    // 90일 전은 2026-07-29다. 그보다 앞선 두 날을 지우고 그날은 남긴다
    await createDailyPartitions(owner, "2026-07-27", "2026-07-29", fast);
    await createDailyPartitions(owner, today, today, fast);
    const reader = await connect(db.app);
    const watcher = await connect(db.owner);
    await reader.query("begin");
    await reader.query("select count(*) from events");

    const running = maintain(owner, { today, ...fast });
    await waitUntil(detachWaiting(watcher));
    const ingest = await connect(db.app, "-c TimeZone=UTC -c lock_timeout=1s");
    const started = Date.now();
    await ingest.query(insertSql(today));
    expect(Date.now() - started).toBeLessThan(500);
    await reader.query("commit");

    expect((await running).dropped).toEqual(["events_p20260727", "events_p20260728"]);
    const left = await watcher.query("select to_regclass('events_p20260727') is null as gone, to_regclass('events_p20260729') is not null as kept");
    expect(left.rows).toEqual([{ gone: true, kept: true }]);
  });

  it("중간에 끊긴 떼기를 다음 실행이 마무리하고 지운다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    await createDailyPartitions(owner, "2026-07-27", "2026-07-27", fast);
    await createDailyPartitions(owner, today, today, fast);
    await leavePending(db, "events_p20260727");
    expect((await listPartitions(owner)).find((p) => p.name === "events_p20260727")).toMatchObject({ pending: true });

    const result = await maintain(owner, { today, ...fast });
    // 마무리한 표는 붙지 않은 채 남으므로 치우기 단계가 지운다
    expect(result).toMatchObject({ finalized: ["events_p20260727"], dropped: ["events_p20260727"], errors: [] });
  });

  // 리뷰가 확인한 것: CONCURRENTLY는 그 파티션을 읽지 않았어도 부모에 잠금을 쥔 트랜잭션을 모두 기다린다.
  it("잊힌 트랜잭션 앞에서 떼기는 시간 한도에 닿아 떼는 중으로 남고, 만들기는 이미 끝났으며, 다음 실행들이 마무리하고 지운다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    await createDailyPartitions(owner, "2026-07-27", "2026-07-27", fast);
    // 오늘만 읽고 트랜잭션을 연 채 잊은 세션(가지치기로 7월 27일은 읽지 않았다). REPEATABLE READ라 스냅샷도 쥐고 있다
    const forgotten = await connect(db.app);
    await forgotten.query("begin isolation level repeatable read");
    await forgotten.query("select count(*) from events where occurred_at >= '2026-10-27 00:00+00' and occurred_at < '2026-10-28 00:00+00'");

    const first = await maintain(owner, { today, ...fast, detachTimeout: "1s" });
    expect(first.created).toHaveLength(15);
    expect(first.errors).toEqual([expect.stringMatching(/^떼기: /)]);
    expect((await listPartitions(owner)).find((p) => p.name === "events_p20260727")).toMatchObject({ pending: true });

    // 아직 열려 있으면 마무리(더 오래된 스냅샷을 기다린다)도 1초 안에 못 하고, 떼기는 건너뛴다
    const second = await maintain(owner, { today, ...fast });
    expect(second.errors).toEqual([expect.stringMatching(/^마무리: /), expect.stringMatching(/^떼기: 떼는 중인 파티션/)]);

    await forgotten.query("commit");
    expect(await maintain(owner, { today, ...fast })).toEqual({
      created: [],
      finalized: ["events_p20260727"],
      dropped: ["events_p20260727"],
      errors: [],
    });
  });

  it("다른 관리 작업이 돌고 있으면 바로 실패한다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    const other = await connect(db.owner);
    await other.query("select pg_advisory_lock(7340203)");
    await expect(maintain(owner, { today, ...fast })).rejects.toThrow(/다른 관리 작업/);
  });

  it("붙지 않은 채 남은 표: 만들 범위 안이면 붙이고(행도 보인다), 보관 기간이 지났으면 지운다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    await owner.query("create table events_p20261028 (like events including all)");
    await owner.query(insertSql("2026-10-28").replace("into events", "into events_p20261028"));
    await owner.query("create table events_p20260701 (like events including all)");

    const result = await maintain(owner, { today, ...fast });
    expect(result.created).toContain("events_p20261028");
    expect(result.dropped).toEqual(["events_p20260701"]);
    expect(result.errors).toEqual([]);
    const { rows } = await owner.query("select count(*)::int as n from events where occurred_at >= '2026-10-28 00:00+00' and occurred_at < '2026-10-29 00:00+00'");
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("없는 날을 찾는다(떼는 중인 것은 없는 것으로 본다). 서버의 경고는 앱 role로 본다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    await createDailyPartitions(owner, "2026-10-20", "2026-10-29", fast);
    await owner.query("drop table events_p20261025");
    await leavePending(db, "events_p20261026");
    expect(await missingPartitionDays(owner, "2026-10-24", "2026-10-31")).toEqual(["2026-10-25", "2026-10-26", "2026-10-30", "2026-10-31"]);
    const app = new pg.Pool({ connectionString: db.app, max: 1 });
    onTestFinished(() => app.end());
    // 받을 기간(과거 7일)부터 앞으로 3일까지
    expect(await missingSoon(app, today)).toEqual(["2026-10-25", "2026-10-26", "2026-10-30"]);
  });

  it("하루가 실패해도 다른 날은 만들고(오늘 포함), 만든 것과 실패한 날을 함께 알린다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    // 붙지 않은 10월 22일 표에 그 날이 아닌 행이 있어 붙일 수 없다
    await owner.query("create table events_p20261022 (like events including all)");
    await owner.query(insertSql("2026-10-25").replace("into events", "into events_p20261022"));
    const result = await maintain(owner, { today, ...fast });
    expect(result.created).toHaveLength(14);
    expect(result.created).toContain("events_p20261027");
    expect(result.errors).toEqual([expect.stringMatching(/^만들기: events_p20261022: /)]);
  });

  it("만들 범위 안의 파티션이 떼는 중이었으면 마무리한 뒤 같은 실행에서 다시 붙인다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    await createDailyPartitions(owner, "2026-10-28", "2026-10-28", fast);
    await leavePending(db, "events_p20261028");
    const result = await maintain(owner, { today, ...fast });
    expect(result.finalized).toEqual(["events_p20261028"]);
    expect(result.created).toContain("events_p20261028");
    expect(result.errors).toEqual([]);
    expect(await missingPartitionDays(owner, "2026-10-20", "2026-11-03")).toEqual([]);
  });

  it("부른 쪽이 트랜잭션 안이면 거절한다(우리 COMMIT이 그 트랜잭션을 끝내 버리므로)", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    await owner.query("begin");
    await expect(createDailyPartitions(owner, today, today, fast)).rejects.toThrow(/트랜잭션 밖/);
    await expect(maintain(owner, { today, ...fast })).rejects.toThrow(/트랜잭션 밖/);
    await owner.query("rollback");
  });
});

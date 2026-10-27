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

describe("관리 작업", () => {
  it("오늘 ±7일 가운데 없는 날을 ATTACH로 만들고, 다시 돌리면 아무것도 하지 않는다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    const first = await maintain(owner, { today, ...fast });
    expect(first.created).toHaveLength(15);
    expect(first.created[0]).toBe("events_p20261020");
    expect(first.created.at(-1)).toBe("events_p20261103");
    expect(await maintain(owner, { today, ...fast })).toEqual({ finalized: [], created: [], dropped: [] });

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
    const reader = await connect(db.app);
    const watcher = await connect(db.owner);
    const detacher = await connect(db.owner);
    await reader.query("begin");
    await reader.query("select count(*) from events");

    const pid = (await detacher.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    const detaching = detacher.query("alter table events detach partition events_p20260727 concurrently").catch((e: unknown) => e);
    await waitUntil(detachWaiting(watcher));
    await watcher.query("select pg_cancel_backend($1)", [pid]);
    expect(await detaching).toMatchObject({ code: "57014" });
    await reader.query("commit");
    expect((await listPartitions(owner)).find((p) => p.name === "events_p20260727")).toMatchObject({ pending: true });

    const result = await maintain(owner, { today, ...fast });
    expect(result.finalized).toEqual(["events_p20260727"]);
    expect(result.dropped).toEqual(["events_p20260727"]);
  });

  it("없는 날을 찾는다(떼는 중인 것은 없는 것으로 본다). 서버의 경고는 앱 role로 본다", async () => {
    const db = await freshDatabase();
    const owner = await connect(db.owner);
    await createDailyPartitions(owner, "2026-10-20", "2026-10-29", fast);
    await owner.query("drop table events_p20261025");
    expect(await missingPartitionDays(owner, "2026-10-24", "2026-10-31")).toEqual(["2026-10-25", "2026-10-30", "2026-10-31"]);
    const app = new pg.Pool({ connectionString: db.app, max: 1 });
    onTestFinished(() => app.end());
    // 받을 기간(과거 7일)부터 앞으로 3일까지
    expect(await missingSoon(app, today)).toEqual(["2026-10-25", "2026-10-30"]);
  });
});

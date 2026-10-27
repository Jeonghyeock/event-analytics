import pg from "pg";
import { describe, expect, inject, it, onTestFinished } from "vitest";
import { freshDatabase } from "../../test/fresh-database.js";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { addDays, createDailyPartitions, dbToday, partitionName } from "../db/partitions.js";
import { insertEvents } from "../ingest.js";
import { generate } from "./generate.js";
import { buildLoadTemplate, cloneLoadDatabase, loadDatabaseState } from "./template.js";

// 측정 템플릿(DESIGN 6.8, 10장 59). 실제 이름(event_analytics_load*) 대신 테스트마다의 이름으로 만든다.
describe("측정 템플릿", () => {
  // FILE_COPY 복제는 앞뒤로 체크포인트를 해서, 다른 테스트 파일과 함께 돌면 몇 초씩 걸린다
  it("원본을 복제해 집계를 끝까지 돌리고 VACUUM·ANALYZE 뒤 autovacuum을 끈다. 복제본에는 오늘부터의 파티션을 만든다", { timeout: 60_000 }, async () => {
    const source = await freshDatabase("tmplsrc");
    const owner = new pg.Client({ connectionString: source.owner });
    await owner.connect();
    const today = await dbToday(owner);
    await createDailyPartitions(owner, addDays(today, -3), addDays(today, -1), { retryDelaysMs: [] });
    const events = [...generate({ seed: 7, events: 3_000, from: new Date(`${addDays(today, -3)}T00:00:00Z`), to: new Date(`${today}T00:00:00Z`) })];
    await insertEvents(
      owner,
      events.map((e) => ({ ...e, at: Date.parse(e.occurredAt) })),
      { markDirty: false },
    );
    await owner.query(
      "insert into dirty_hours (hour) select generate_series($1::timestamptz, $2::timestamptz - interval '1 hour', interval '1 hour')",
      [`${addDays(today, -3)}T00:00:00Z`, `${today}T00:00:00Z`],
    );
    // 복제하려면 원본에 연결이 없어야 한다
    await owner.end();

    const ownerUrl = inject("ownerDatabaseUrl");
    const template = `event_analytics_tmpl_${process.pid}`;
    const target = `event_analytics_tmplrun_${process.pid}`;
    onTestFinished(() =>
      withAdminClient(ownerUrl, async (client) => {
        await dropDatabase(client, target);
        await dropDatabase(client, template);
      }),
    );
    const sourceName = new URL(source.owner).pathname.slice(1);
    const state = await buildLoadTemplate(ownerUrl, { source: sourceName, template });
    expect(state.dirtyHours).toBe(0);
    expect(state.partitions).toBe(3);
    expect(Math.round(state.eventRows)).toBe(3_000);
    const parts = state.tables.find((t) => t.name === "events_*")!;
    expect(parts).toMatchObject({ autovacuum_off: true });
    // VACUUM으로 가시성 맵이 섰다(행이 있는 파티션의 모든 페이지)
    expect(parts.visible_min).toBe(1);
    expect(parts.analyzed_min).not.toBeNull();
    expect(state.settings).toHaveProperty("io_method");

    const url = await cloneLoadDatabase(ownerUrl, { template, target });
    expect(url).toBe(withDatabase(ownerUrl, target));
    const cloned = await loadDatabaseState(url);
    // 오늘부터 앞으로 7일이 더해졌다
    expect(cloned.partitions).toBe(3 + 8);
    expect(cloned.days.last).toBe(partitionName(addDays(today, 7)).slice(8));
    expect(cloned.dirtyHours).toBe(0);
  });

  // PostgreSQL은 원본의 연결이 사라지길 5초 기다린 뒤 실패한다
  it("원본에 연결이 남아 있으면 까닭을 알린다", { timeout: 20_000 }, async () => {
    const source = await freshDatabase("tmplbusy");
    const held = new pg.Client({ connectionString: source.owner });
    await held.connect();
    onTestFinished(() => held.end());
    const ownerUrl = inject("ownerDatabaseUrl");
    const template = `event_analytics_tmplbusy_${process.pid}`;
    onTestFinished(() => withAdminClient(ownerUrl, (client) => dropDatabase(client, template)));
    await expect(buildLoadTemplate(ownerUrl, { source: new URL(source.owner).pathname.slice(1), template })).rejects.toThrow(
      /연결이 남아 있어/,
    );
  });
});

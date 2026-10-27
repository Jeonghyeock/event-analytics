import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { withDatabase } from "./databases.js";
import { addDays, createDailyPartitions, partitionName, utcDay } from "./partitions.js";
import { createPool } from "./pool.js";

// 이벤트 표와 일 파티션(DESIGN 5장, 6.1, 6.2). 테스트 DB는 다른 파일과 함께 쓰므로 모두 트랜잭션 안에서 하고 되돌린다.
// 파티션을 만드는 시험은 부모 표를 통째로 잠근다. 수집 테스트가 잠금 대기를 지켜보는 DB와 겹치지 않게 isolated DB에서 한다.
const isolatedDb = new URL(inject("isolatedDatabaseUrl")).pathname.slice(1);
const owner = new pg.Pool({
  connectionString: withDatabase(inject("ownerDatabaseUrl"), isolatedDb),
  max: 1,
  options: "-c TimeZone=Asia/Seoul",
});
const app = createPool({ connectionString: inject("databaseUrl"), max: 1 });
afterAll(() => Promise.all([owner.end(), app.end()]));

async function inRolledBack<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await work(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

const today = utcDay(new Date());
const insert = (client: pg.ClientBase, id: string, occurredAt: string, platform = "web") =>
  client.query(
    `insert into events (event_id, occurred_at, user_id, event_name, platform) values ($1, $2, 'u1', 'page_view', $3)
     on conflict do nothing returning tableoid::regclass::text as partition`,
    [id, occurredAt, platform],
  );

describe("일 파티션", () => {
  it("날짜마다 UTC 자정 경계로 만들고, 이미 있는 날은 건너뛴다(세션 시간대가 Asia/Seoul이어도)", async () => {
    await inRolledBack(owner, async (client) => {
      const from = "2100-01-30";
      expect(await createDailyPartitions(client, from, "2100-02-01")).toEqual([
        "events_p21000130",
        "events_p21000131",
        "events_p21000201",
      ]);
      expect(await createDailyPartitions(client, from, "2100-02-01")).toEqual([]);
      const { rows } = await client.query(
        `select c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound
           from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'events'::regclass and c.relname = 'events_p21000131'`,
      );
      // 경계 글자는 세션 시간대(Asia/Seoul)로 보이지만, 같은 순간이 UTC 자정이다
      expect(rows).toEqual([
        { name: "events_p21000131", bound: "FOR VALUES FROM ('2100-01-31 09:00:00+09') TO ('2100-02-01 09:00:00+09')" },
      ]);
    });
  });

  it("UTC 자정 직전과 자정은 다른 파티션으로 간다(+09:00으로 써도 같은 순간)", async () => {
    await inRolledBack(app, async (client) => {
      const next = addDays(today, 1);
      const before = await insert(client, randomUUID(), `${today}T23:59:59.999999Z`);
      const at = await insert(client, randomUUID(), `${next}T09:00:00+09:00`);
      expect([before.rows[0].partition, at.rows[0].partition]).toEqual([partitionName(today), partitionName(next)]);
    });
  });

  it("파티션이 없는 시각은 제약 이름 없는 23514로 실패한다(CHECK 위반은 제약 이름이 있다)", async () => {
    await inRolledBack(app, async (client) => {
      await client.query("savepoint s");
      await expect(insert(client, randomUUID(), "2000-01-01T00:00:00Z")).rejects.toMatchObject({
        code: "23514",
        constraint: undefined,
      });
      await client.query("rollback to savepoint s");
      await expect(insert(client, randomUUID(), `${today}T00:00:00Z`, "tv")).rejects.toMatchObject({
        code: "23514",
        constraint: "events_platform_check",
      });
    });
  });

  it("날짜 글자가 틀리면 DB에 손대기 전에 거절한다", async () => {
    await inRolledBack(owner, async (client) => {
      await expect(createDailyPartitions(client, "2100-02-30", "2100-03-01")).rejects.toThrow(/YYYY-MM-DD/);
      await expect(createDailyPartitions(client, "2100-1-1", "2100-01-02")).rejects.toThrow(/YYYY-MM-DD/);
    });
  });
});

describe("이벤트 기본 키 (event_id, occurred_at)", () => {
  it("같은 순간을 다른 오프셋으로 써도 같은 키다", async () => {
    await inRolledBack(app, async (client) => {
      const id = randomUUID();
      expect((await insert(client, id, `${today}T01:00:00.123456Z`)).rowCount).toBe(1);
      expect((await insert(client, id, `${today}T10:00:00.123456+09:00`)).rowCount).toBe(0);
    });
  });

  // 그래서 수집은 밀리초로 잘라 넘긴다. 재전송이 같은 시각을 밀리초로 다시 써도 같은 키가 되게(DESIGN 10장 17).
  it("DB의 키는 마이크로초까지 본다", async () => {
    await inRolledBack(app, async (client) => {
      const id = randomUUID();
      expect((await insert(client, id, `${today}T01:00:00.123456Z`)).rowCount).toBe(1);
      expect((await insert(client, id, `${today}T01:00:00.123Z`)).rowCount).toBe(1);
    });
  });

  // 알고 받아들인 한계(DESIGN 6.1): 보내는 쪽이 재전송 때 시각을 새로 만들면 두 행이 된다.
  it("같은 event_id라도 시각이 다르면 두 행이다", async () => {
    await inRolledBack(app, async (client) => {
      const id = randomUUID();
      await insert(client, id, `${today}T01:00:00Z`);
      await insert(client, id, `${today}T01:00:01Z`);
      const { rows } = await client.query("select count(*)::int as n from events where event_id = $1", [id]);
      expect(rows).toEqual([{ n: 2 }]);
    });
  });
});

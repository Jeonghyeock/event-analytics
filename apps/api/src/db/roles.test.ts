import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

// 앱 role은 DML만 한다(DESIGN 10장 12, seat-booking DESIGN 6.7과 같음).
// 오류·경고 메시지는 로컬(한국어)과 CI(영어)가 달라 코드로 본다. 테스트 DB는 다른 파일과 함께 쓰므로,
// 시험용 표 하나만 만들어 두고 끝에 지우며, 나머지는 모두 트랜잭션 안에서 하고 되돌린다.
describe("앱 role의 권한", () => {
  const app = new pg.Pool({ connectionString: inject("databaseUrl"), max: 1 });
  const owner = new pg.Pool({ connectionString: inject("ownerDatabaseUrl"), max: 1 });
  beforeAll(() => owner.query("create table roles_test_t (id int generated always as identity primary key, name text)"));
  afterAll(async () => {
    await owner.query("drop table if exists roles_test_t");
    await Promise.all([app.end(), owner.end()]);
  });

  // 트랜잭션 안에서 work를 하고 되돌린다. 그 사이의 notice(경고)를 "코드 메시지"로 모아 준다.
  async function inRolledBack(pool: pg.Pool, work: (client: pg.PoolClient, notices: string[]) => Promise<void>) {
    const client = await pool.connect();
    const notices: string[] = [];
    const onNotice = (n: { code?: string; message?: string }) => notices.push(`${n.code} ${n.message}`);
    client.on("notice", onNotice);
    try {
      await client.query("begin");
      await work(client, notices);
    } finally {
      await client.query("rollback");
      client.off("notice", onNotice);
      client.release();
    }
  }

  it("앱 role로 접속하고, 그 role은 DB 소유자도 슈퍼유저도 아니다", async () => {
    const { rows } = await app.query(
      `select current_user as role, current_user = pg_get_userbyid(d.datdba) as owner, r.rolsuper as superuser
         from pg_database d, pg_roles r where d.datname = current_database() and r.rolname = current_user`,
    );
    expect(rows).toEqual([{ role: "event_analytics_app", owner: false, superuser: false }]);
  });

  // 이것이 없으면 앱 연결이 남은 테스트 DB를 소유자가 DROP … WITH (FORCE)로 지우지 못한다(README role 만들기).
  it("소유자는 앱 role의 권한을 이어받아 그 연결을 끊을 수 있고, 거꾸로는 아니다", async () => {
    const { rows } = await owner.query(
      `select pg_has_role('event_analytics', 'event_analytics_app', 'USAGE') as owner_has_app,
              pg_has_role('event_analytics_app', 'event_analytics', 'MEMBER') as app_has_owner`,
    );
    expect(rows).toEqual([{ owner_has_app: true, app_has_owner: false }]);
  });

  it.each([
    ["표 만들기", "create table roles_test_new (id int)"],
    ["인덱스 만들기", "create index roles_test_idx on roles_test_t (name)"],
    ["열 더하기", "alter table roles_test_t add column extra int"],
    ["표 지우기", "drop table roles_test_t"],
    ["표 비우기", "truncate roles_test_t"],
    ["스키마 만들기", "create schema roles_test"],
    ["소유자 role 쓰기", "set role event_analytics"],
    ["role 주기", "grant event_analytics to event_analytics_app"],
    ["적용 기록 읽기", 'select * from "drizzle"."__drizzle_migrations"'],
  ])("%s는 42501로 실패한다", async (_, sql) => {
    await inRolledBack(app, async (client) => {
      await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("표의 GRANT·REVOKE는 경고만 내고 권한을 바꾸지 못한다", async () => {
    // 되돌리기 전에 같은 트랜잭션 안에서 본다(되돌린 뒤에 보면 바뀌었어도 같다)
    const acl = async (client: pg.PoolClient | pg.Pool) =>
      (await client.query("select relacl::text as acl from pg_class where oid = 'roles_test_t'::regclass")).rows;
    const before = await acl(owner);
    await inRolledBack(app, async (client, notices) => {
      await client.query("grant select on roles_test_t to public");
      await client.query("revoke select on roles_test_t from event_analytics_app");
      expect(notices.map((n) => n.split(" ")[0])).toEqual(expect.arrayContaining(["01007", "01006"]));
      expect(await acl(client)).toEqual(before);
    });
  });

  // 01000은 일반 경고 코드라, 메시지에 표 이름이 있는지도 본다(메시지 말은 로컬과 CI가 다르다).
  const skipped = [expect.stringMatching(/^01000 .*"roles_test_t"/)];

  it("ANALYZE는 경고만 내고 건너뛴다", async () => {
    await inRolledBack(app, async (client, notices) => {
      await client.query("analyze roles_test_t");
      expect(notices).toEqual(skipped);
    });
  });

  it("VACUUM도 경고만 내고 건너뛴다", async () => {
    // VACUUM은 트랜잭션 안에서 돌지 않는다
    const client = await app.connect();
    const notices: string[] = [];
    const onNotice = (n: { code?: string; message?: string }) => notices.push(`${n.code} ${n.message}`);
    client.on("notice", onNotice);
    try {
      await client.query("vacuum roles_test_t");
      expect(notices).toEqual(skipped);
    } finally {
      client.off("notice", onNotice);
      client.release();
    }
  });

  it("DML과 임시 표는 되고, identity 열 INSERT는 시퀀스 권한 없이 된다", async () => {
    await inRolledBack(app, async (client) => {
      const { rows } = await client.query<{ id: number }>("insert into roles_test_t (name) values ('a') returning id");
      await client.query("update roles_test_t set name = 'b' where id = $1", [rows[0]!.id]);
      await client.query("delete from roles_test_t where id = $1", [rows[0]!.id]);
      await client.query("create temp table roles_test_tmp (id int) on commit drop");
      const seq = await client.query("select has_sequence_privilege('roles_test_t_id_seq', 'USAGE') as usage");
      expect(seq.rows).toEqual([{ usage: false }]);
    });
  });

  // 2단계에서 소유자가 파티션을 날마다 만든다. 파티션에도 권한이 붙어야 앱이 파티션을 직접 읽고 쓸 수 있다.
  it("소유자가 뒤에 만든 표와 파티션에도 앱의 DML 권한이 붙고, TRUNCATE는 붙지 않는다", async () => {
    await inRolledBack(owner, async (client) => {
      await client.query("create table roles_test_later (id int)");
      await client.query("create table roles_test_parent (at timestamptz not null) partition by range (at)");
      await client.query(
        "create table roles_test_part partition of roles_test_parent for values from ('2026-10-27 00:00+00') to ('2026-10-28 00:00+00')",
      );
      const { rows } = await client.query(
        `select t as table,
                has_table_privilege('event_analytics_app', t, 'SELECT, INSERT, UPDATE, DELETE') as dml,
                has_table_privilege('event_analytics_app', t, 'TRUNCATE') as truncate
           from unnest(array['roles_test_later', 'roles_test_parent', 'roles_test_part']) as t`,
      );
      expect(rows).toEqual([
        { table: "roles_test_later", dml: true, truncate: false },
        { table: "roles_test_parent", dml: true, truncate: false },
        { table: "roles_test_part", dml: true, truncate: false },
      ]);
    });
  });
});

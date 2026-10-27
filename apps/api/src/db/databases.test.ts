import pg from "pg";
import { afterAll, describe, expect, inject, it, onTestFinished } from "vitest";
import { checkDatabaseLocale, dropDatabase, withAdminClient, withDatabase } from "./databases.js";

// 테스트 DB는 NEW_DATABASE_OPTIONS로 만든 템플릿을 복제한다(test/global-setup.ts). 로컬과 CI가 같은 정렬을 쓰는지 본다(DESIGN 10장 13).
describe("DB 설정", () => {
  const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 1 });
  afterAll(() => pool.end());

  it("UTF8, builtin C.UTF-8이다", async () => {
    const { rows } = await pool.query(
      `select pg_encoding_to_char(encoding) as encoding, datlocprovider as provider, datlocale as locale
         from pg_database where datname = current_database()`,
    );
    expect(rows).toEqual([{ encoding: "UTF8", provider: "b", locale: "C.UTF-8" }]);
  });

  it("정렬은 코드 포인트 순서이고, 대소문자는 유니코드로 바꾼다", async () => {
    const { rows } = await pool.query(
      `select array_agg(x order by x) as sorted, upper('éa') as upper
         from unnest(array['b', 'B', 'a', '가', 'é', 'Z']) as x`,
    );
    expect(rows).toEqual([{ sorted: ["B", "Z", "a", "b", "é", "가"], upper: "ÉA" }]);
  });

  it("마이그레이션 명령은 옵션 없이(template1, OS 정렬) 만든 DB를 거절한다", async () => {
    const baseUrl = inject("ownerDatabaseUrl");
    await expect(checkDatabaseLocale(baseUrl)).resolves.toBeUndefined();
    const name = `event_analytics_locale_${process.pid}`;
    await withAdminClient(baseUrl, async (client) => {
      await dropDatabase(client, name);
      await client.query(`CREATE DATABASE ${name}`);
    });
    onTestFinished(() => withAdminClient(baseUrl, (client) => dropDatabase(client, name)));
    await expect(checkDatabaseLocale(withDatabase(baseUrl, name))).rejects.toThrow(/builtin C.UTF-8이 아닙니다/);
  });
});

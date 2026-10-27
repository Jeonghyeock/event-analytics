import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

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
});

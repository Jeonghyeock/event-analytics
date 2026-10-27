import { afterAll, describe, expect, inject, it } from "vitest";
import { createPool } from "./pool.js";

describe("createPool", () => {
  const pool = createPool({ connectionString: inject("databaseUrl") });
  afterAll(() => pool.end());

  it("count(*)와 bigint를 number로 돌려준다", async () => {
    const { rows } = await pool.query<{ n: unknown; id: unknown }>("select count(*) as n, 42::bigint as id");
    expect(rows[0]).toEqual({ n: 1, id: 42 });
  });

  it("number의 안전한 범위를 넘는 int8은 오류를 낸다", async () => {
    await expect(pool.query("select 9007199254740993::bigint as big")).rejects.toThrow(RangeError);
  });

  // 서버 기본값(로컬 Asia/Seoul, CI UTC)과 상관없이 같은 날이 된다(DESIGN 10장 14).
  it("세션 시간대는 UTC라, 시간대 없는 시각 글자와 날짜 변환이 UTC 기준이다", async () => {
    const { rows } = await pool.query<{ tz: string; day: string; at: string }>(
      `select current_setting('TimeZone') as tz,
              ('2026-10-27 23:30+00'::timestamptz)::date::text as day,
              to_char('2026-10-27 00:00'::timestamptz at time zone 'UTC', 'HH24:MI') as at`,
    );
    expect(rows[0]).toEqual({ tz: "UTC", day: "2026-10-27", at: "00:00" });
  });

  // pg는 주소의 ?options=로 config.options를 덮어쓴다. 어느 쪽으로 넘겨도 고정이 남고, 넘긴 설정도 산다.
  const withUrlOptions = (options: string) => {
    const u = new URL(inject("databaseUrl"));
    u.searchParams.set("options", options);
    return u.toString();
  };
  it.each([
    ["config.options", { connectionString: inject("databaseUrl"), options: "-c statement_timeout=1234" }],
    ["주소의 ?options=", { connectionString: withUrlOptions("-c statement_timeout=1234") }],
    ["주소의 TimeZone(고정이 이긴다)", { connectionString: withUrlOptions("-c TimeZone=Asia/Seoul -c statement_timeout=1234") }],
  ])("%s를 지우지 않고 덧붙인다", async (_, config) => {
    const other = createPool(config);
    try {
      const { rows } = await other.query("select current_setting('TimeZone') as tz, current_setting('statement_timeout') as st");
      expect(rows[0]).toEqual({ tz: "UTC", st: "1234ms" });
    } finally {
      await other.end();
    }
  });
});

import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { addDays, partitionName, utcDay } from "./partitions.js";
import { createPool } from "./pool.js";

// 합격 기준 A3: 하루 범위의 리포트는 그날의 파티션만 읽는다(DESIGN 6.2, 10장 26). 실행 계획에 나오는 파티션을 센다.
// 테스트 템플릿에는 오늘(UTC) 기준 −8일 ~ +2일의 파티션 11개가 있다.
const pool = createPool({ connectionString: inject("databaseUrl"), max: 1 });
afterAll(() => pool.end());

type PlanNode = { "Relation Name"?: string; "Subplans Removed"?: number; Plans?: PlanNode[] };
function partitionsIn(plan: PlanNode) {
  const relations = new Set<string>();
  let removed = 0;
  const walk = (node: PlanNode) => {
    if (node["Relation Name"]) relations.add(node["Relation Name"]);
    removed += node["Subplans Removed"] ?? 0;
    node.Plans?.forEach(walk);
  };
  walk(plan);
  return { partitions: [...relations].sort(), removed };
}

async function explain(client: pg.ClientBase | pg.Pool, sql: string, params: unknown[] = []) {
  const { rows } = await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(`explain (format json, costs off) ${sql}`, params);
  return partitionsIn(rows[0]!["QUERY PLAN"][0]!.Plan);
}

const today = utcDay(new Date());
const all = Array.from({ length: 11 }, (_, i) => partitionName(addDays(today, i - 8)));

describe("A3 — 가지치기", () => {
  it("UTC 하루를 반열린 구간으로 거르면 그날의 파티션 하나만 읽는다", async () => {
    const plan = await explain(pool, "select count(*) from events where occurred_at >= $1 and occurred_at < $2", [
      `${today}T00:00:00Z`,
      `${addDays(today, 1)}T00:00:00Z`,
    ]);
    expect(plan.partitions).toEqual([partitionName(today)]);
  });

  it("한국 시각의 하루는 UTC로 두 날에 걸쳐 두 파티션을 읽는다", async () => {
    const plan = await explain(pool, "select count(*) from events where occurred_at >= $1 and occurred_at < $2", [
      `${today}T00:00:00+09:00`,
      `${addDays(today, 1)}T00:00:00+09:00`,
    ]);
    expect(plan.partitions).toEqual([partitionName(addDays(today, -1)), partitionName(today)]);
  });

  // 일반 계획은 값을 모른 채 만든 계획이라 모든 파티션을 담고, 실행할 때 값을 보고 나머지를 뺀다.
  it("일반 계획(prepared statement)은 실행할 때 나머지 파티션을 뺀다", async () => {
    const client = await pool.connect();
    try {
      await client.query("set plan_cache_mode = force_generic_plan");
      await client.query("prepare one_day(timestamptz, timestamptz) as select count(*) from events where occurred_at >= $1 and occurred_at < $2");
      const { rows } = await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
        `explain (format json, costs off, analyze, timing off, summary off) execute one_day('${today} 00:00+00', '${addDays(today, 1)} 00:00+00')`,
      );
      expect(partitionsIn(rows[0]!["QUERY PLAN"][0]!.Plan)).toEqual({ partitions: [partitionName(today)], removed: all.length - 1 });
    } finally {
      await client.query("deallocate all");
      await client.query("reset plan_cache_mode");
      client.release();
    }
  });

  // 파티션 키에 형 변환이나 함수를 씌우면 가지치기가 되지 않는다. timestamptz → date는 세션 시간대에 따라 값이 달라진다.
  it.each([
    ["::date", "occurred_at::date = $1::date"],
    ["at time zone", "(occurred_at at time zone 'Asia/Seoul')::date = $1::date"],
    ["date_trunc", "date_trunc('day', occurred_at, 'UTC') = $1::timestamptz"],
  ])("파티션 키에 %s를 씌우면 모든 파티션을 읽는다", async (_, where) => {
    const plan = await explain(pool, `select count(*) from events where ${where}`, [today]);
    expect(plan.partitions).toEqual(all);
  });
});

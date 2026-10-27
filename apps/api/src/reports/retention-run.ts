import type { RetentionQuery, RetentionResult } from "@event-analytics/shared";
import type pg from "pg";
import { RETENTION_DAYS } from "../db/partitions.js";
import { buildCohortDaysSql, buildRetentionSql, RETURN_END, toRetentionRows } from "./retention-sql.js";
import { END, START } from "./sql.js";
import { checkRetention, inReportTransaction, type QueryLimits, retainedFromSql } from "./transaction.js";

// 리텐션을 돌린다(DESIGN 6.5, 10장 45~46). 트랜잭션 틀은 리포트와 같다.
// asOf: 보관 기간, provisional, 다 지나지 않은 칸을 판단할 "지금"(ISO). 없으면 DB의 now()다.
export type RetentionOptions = QueryLimits & { asOf?: string };

export function runRetention(pool: pg.Pool, q: RetentionQuery, { asOf, ...limits }: RetentionOptions = {}): Promise<RetentionResult> {
  return inReportTransaction(pool, limits, async (client) => {
    // 퍼널과 같은 까닭으로 중첩 반복 조인을 끈다(10장 47). user_id 인덱스가 없어 중첩 반복은 안쪽을 거듭 훑고, 조인 조건의
    // 날짜 차이 범위(1~N)에 계획기가 기본 선택도를 써 통계가 있어도 그것을 고를 수 있다.
    await client.query("select set_config('enable_nestloop', 'off', true)");
    // today: "지금"의 리포트 시간대 날짜(그날과 그 뒤의 칸은 아직 모른다). provisional: 마지막 칸의 날의 끝이 최근 7일 안.
    const range = await client.query<{ from: Date; to: Date; retained_from: Date; today: string; provisional: boolean }>(
      `select ${START} as "from", ${END} as "to", ${retainedFromSql("$5", "$6")} as retained_from,
              to_char(coalesce($5::timestamptz, now()) at time zone $3::text, 'YYYY-MM-DD') as today,
              ${RETURN_END} > coalesce($5::timestamptz, now()) - interval '7 days' as provisional`,
      [q.from, q.to, q.timezone, q.days, asOf ?? null, RETENTION_DAYS],
    );
    const { from, to, retained_from: retainedFrom, today, provisional } = range.rows[0]!;
    checkRetention(from, retainedFrom);
    const counts = buildRetentionSql(q);
    const countRows = (await client.query<{ cohort: string; n: number; users: number }>(counts.text, counts.values)).rows;
    const days = buildCohortDaysSql(q);
    const dayRows = (await client.query<{ cohort: string; start: Date }>(days.text, days.values)).rows;
    return {
      rows: toRetentionRows(q, dayRows, countRows, today),
      meta: { timezone: q.timezone, rangeStart: from.toISOString(), rangeEnd: to.toISOString(), days: q.days, provisional },
    };
  });
}

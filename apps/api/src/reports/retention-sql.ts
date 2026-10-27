import type { RetentionQuery, RetentionResult } from "@event-analytics/shared";
import { END, filterConditions, type ReportSql, START } from "./sql.js";

// 리텐션 → SQL(DESIGN 6.5, 10장 45). 날마다 무리: 무리 d는 그날 시작 이벤트가 있는 사용자 전부이고,
// N일째는 그 사용자가 d + N일에 돌아옴 이벤트가 있는 것이다. 날 차이는 날짜끼리 뺀다(25시간인 날도 하루).
//   c: (사용자, 날)로 묶은 시작 이벤트, [from 자정, to + 1 자정)
//   b: (사용자, 날)로 묶은 돌아옴 이벤트, [from + 1 자정, to + 1 + N 자정)
// 끝을 END + interval로 쓰면 STABLE이라 계획할 때 가지를 못 치고, 뉴욕 일광 절약 시간이 끝나는 주에 한 시간이 빠진다.
// 날짜 산술은 변하지 않는 식이다.
//
// $1 from, $2 to, $3 시간대, $4 N, $5… 이벤트 이름과 필터 값. 무리 크기는 n = 0인 행이다.
export const RETURN_START = "(($1::date + 1)::timestamp at time zone $3::text)";
export const RETURN_END = "(($2::date + 1 + $4::int)::timestamp at time zone $3::text)";

export function buildRetentionSql(q: RetentionQuery): ReportSql {
  const values: unknown[] = [q.from, q.to, q.timezone, q.days];
  const eventIs = (name: string | undefined) => {
    if (!name) return "";
    values.push(name);
    return ` and e.event_name = $${values.length}::text`;
  };
  const startEvent = eventIs(q.startEvent);
  const returnEvent = eventIs(q.returnEvent);
  // 필터는 시작과 돌아옴 이벤트 모두에 건다
  const filters = filterConditions(q.filters, values, "e.").map((c) => ` and ${c}`).join("");
  const day = "(e.occurred_at at time zone $3::text)::date";
  const text = `with c as (select e.user_id, ${day} as d from events e
    where e.occurred_at >= ${START} and e.occurred_at < ${END}${startEvent}${filters}
    group by 1, 2),
b as (select e.user_id, ${day} as d from events e
    where e.occurred_at >= ${RETURN_START} and e.occurred_at < ${RETURN_END}${returnEvent}${filters}
    group by 1, 2)
select c.d::text as cohort, 0 as n, count(*)::int as users from c group by c.d
union all
select c.d::text, b.d - c.d, count(*)::int from c join b on b.user_id = c.user_id and b.d - c.d between 1 and $4::int
group by c.d, b.d - c.d
order by 1, 2`;
  return { text, values };
}

// 기간의 모든 날과 그 자정(리포트 시간대)의 순간. 무리가 없는 날도 행이 있게 한다.
export function buildCohortDaysSql(q: RetentionQuery): ReportSql {
  return {
    text: `select d::date::text as cohort, (d::date::timestamp at time zone $3::text) as start
      from generate_series($1::date, $2::date, interval '1 day') d order by 1`,
    values: [q.from, q.to, q.timezone],
  };
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// 결과 → 응답 행. today는 "지금"의 리포트 시간대 날짜다. d + N일이 today와 같거나 뒤면 그 칸은 아직 모른다(null).
export function toRetentionRows(
  q: RetentionQuery,
  days: { cohort: string; start: Date }[],
  counts: { cohort: string; n: number; users: number }[],
  today: string,
): RetentionResult["rows"] {
  const count = new Map(counts.map((r) => [`${r.cohort}:${r.n}`, r.users]));
  return days.map(({ cohort, start }) => ({
    cohort,
    cohortStart: start.toISOString(),
    users: count.get(`${cohort}:0`) ?? 0,
    returned: Array.from({ length: q.days }, (_, i) => (addDays(cohort, i + 1) < today ? (count.get(`${cohort}:${i + 1}`) ?? 0) : null)),
  }));
}

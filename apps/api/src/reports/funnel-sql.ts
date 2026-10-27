import type { FunnelQuery, FunnelResult } from "@event-analytics/shared";
import { COLUMNS, END, filterConditions, type ReportSql, START } from "./sql.js";

// 퍼널 → SQL(DESIGN 6.5, 10장 42~44). 첫 진입 기준 전환을 단계마다 조인해 센다.
//   s1: 기간 안의 1단계를 사용자로 묶어 진입 순간 t1(나눔이 있으면 진입 이벤트의 차원 d0도)
//   sk: s(k−1)과 k단계 이벤트를 user_id로 조인해, 앞 단계보다 엄격히 뒤이고 t1 + 전환 기간 앞인 것의 최솟값 t
// 진입이 정해지면 단계마다 가장 이른 이벤트가 늘 최선이라(뒤 단계에 남는 시간이 가장 길다) 찾기 없이 최솟값 하나다.
//
// $1 from, $2 to, $3 시간대, $4 전환 기간(분), $5 windowEnd(기간 끝 + 전환 기간, 트랜잭션 첫 문장에서 계산), $6… 단계 이름, 필터 값.
// windowEnd를 문장 안에서 END + interval로 쓰면 STABLE이라 계획할 때 가지를 못 친다(10장 44).
export function buildFunnelSql(q: FunnelQuery, windowEnd: Date): ReportSql {
  const values: unknown[] = [q.from, q.to, q.timezone, q.windowMinutes, windowEnd];
  const steps = q.steps.map((name) => {
    values.push(name);
    return `$${values.length}::text`;
  });
  // 필터는 모든 단계의 이벤트에 건다(e는 원본)
  const filters = filterConditions(q.filters, values, "e.").map((c) => ` and ${c}`).join("");
  const breakdown = q.breakdown[0];
  const d0 = breakdown ? `, e.${COLUMNS[breakdown]} as d0` : "";
  const keep = breakdown ? ", s.d0" : "";
  const ctes = [
    breakdown
      ? // 같은 밀리초의 1단계 둘이면 event_id로 정한다(없으면 같은 데이터에서도 고르는 것이 바뀐다, 설계 리뷰)
        `s1 as (select distinct on (e.user_id) e.user_id, e.occurred_at as t1${d0} from events e
    where e.occurred_at >= ${START} and e.occurred_at < ${END} and e.event_name = ${steps[0]}${filters}
    order by e.user_id, e.occurred_at, e.event_id)`
      : `s1 as (select e.user_id, min(e.occurred_at) as t1 from events e
    where e.occurred_at >= ${START} and e.occurred_at < ${END} and e.event_name = ${steps[0]}${filters}
    group by e.user_id)`,
  ];
  for (let k = 2; k <= steps.length; k++) {
    const previous = k === 2 ? "s.t1" : "s.t";
    ctes.push(`s${k} as (select s.user_id, s.t1${keep}, min(e.occurred_at) as t from s${k - 1} s join events e on e.user_id = s.user_id
    where e.event_name = ${steps[k - 1]} and e.occurred_at > ${previous} and e.occurred_at < s.t1 + make_interval(mins => $4::int)
      and e.occurred_at >= ${START} and e.occurred_at < $5::timestamptz${filters}
    group by s.user_id, s.t1${keep})`);
  }
  const body = breakdown
    ? steps.map((_, i) => `select d0, ${i + 1} as step, count(*)::int as n from s${i + 1} group by d0`).join("\nunion all\n") +
      "\norder by 1, 2"
    : // 무리로 묶지 않고 단계마다 센다. 진입이 0이어도 한 행이다.
      `select ${steps.map((_, i) => `(select count(*)::int from s${i + 1}) as n${i + 1}`).join(", ")}`;
  return { text: `with ${ctes.join(",\n")}\n${body}`, values };
}

type CountRow = Record<string, unknown>;

// 결과 → 응답 행. 나눔이 없으면 한 행이다. 나눔 값의 차례는 SQL의 정렬(코드 포인트 순서, null은 맨 뒤)이다.
export function toFunnelRows(q: FunnelQuery, rows: CountRow[]): FunnelResult["rows"] {
  const breakdown = q.breakdown[0];
  if (!breakdown) return [{ dimensions: {}, steps: q.steps.map((_, i) => Number(rows[0]![`n${i + 1}`])) }];
  const byValue = new Map<string | null, number[]>();
  for (const r of rows) {
    const value = (r.d0 as string | null) ?? null;
    if (!byValue.has(value)) byValue.set(value, q.steps.map(() => 0));
    byValue.get(value)![Number(r.step) - 1] = Number(r.n);
  }
  return [...byValue].map(([value, steps]) => ({ dimensions: { [breakdown]: value }, steps }));
}

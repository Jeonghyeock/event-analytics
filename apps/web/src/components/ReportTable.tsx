import type { ReportQuery, ReportResult } from "@event-analytics/shared";
import { DIMENSION_LABELS } from "../lib/form";
import { buildTable, formatCount, METRIC_LABELS } from "../lib/series";
import styles from "./Table.module.css";

// 리포트의 표(DESIGN 6.7): 서버의 행 그대로(묶음 × 계열)이고 모든 값을 보인다. 그래프의 대안이자 정확한 수다.
// 합계 행은 이벤트 수에만 둔다(사용자 수는 행끼리 더할 수 없다). 행이 없으면 화면이 표 대신 문장을 보인다.
export function ReportTable({ query, result }: { query: ReportQuery; result: ReportResult }) {
  const { rows, eventsTotal } = buildTable(query, result);
  const hasSeries = query.dimensions.length > 0;
  // 사용자 수의 기간 전체는 단위 "전체", 차원 없이 묻는다. 이미 그 설정이면 안내하지 않는다.
  const usersNote = query.metrics.includes("users") && (query.granularity !== "total" || hasSeries);
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">리포트 결과</caption>
        <thead>
          <tr>
            <th scope="col">묶음</th>
            {hasSeries && <th scope="col">{query.dimensions.map((d) => DIMENSION_LABELS[d]).join(" · ")}</th>}
            {query.metrics.map((m) => (
              <th key={m} scope="col" className={styles.number}>
                {METRIC_LABELS[m]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.bucket}:${r.seriesKey}`}>
              <td>
                {r.label}
                {r.note && <span className={styles.note}> {r.note}</span>}
              </td>
              {hasSeries && <td>{r.series}</td>}
              {query.metrics.map((m) => (
                <td key={m} className={styles.number}>
                  {formatCount(r[m] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {eventsTotal !== null && (
          <tfoot>
            <tr>
              <th scope="row" colSpan={1 + (hasSeries ? 1 : 0)}>
                합계
              </th>
              {query.metrics.map((m) => (
                <td key={m} className={styles.number}>
                  {m === "events" ? formatCount(eventsTotal) : "—"}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {usersNote && (
        <p className={styles.muted}>사용자 수는 행끼리 더할 수 없습니다. 기간 전체의 사용자 수는 단위를 "전체", 차원 없이 다시 보세요.</p>
      )}
    </div>
  );
}

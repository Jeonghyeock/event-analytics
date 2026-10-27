import type { ReportQuery, ReportResult } from "@event-analytics/shared";
import { buildTable, formatCount, METRIC_LABELS } from "../lib/series";
import styles from "./Table.module.css";

// 리포트의 표(DESIGN 6.7): 서버의 행 그대로(묶음 × 계열)이고 모든 값을 보인다. 그래프의 대안이자 정확한 수다.
// 합계 행은 이벤트 수에만 둔다(사용자 수는 행끼리 더할 수 없다).
export function ReportTable({ query, result }: { query: ReportQuery; result: ReportResult }) {
  const { rows, eventsTotal } = buildTable(query, result);
  const hasSeries = query.dimensions.length > 0;
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">리포트 결과</caption>
        <thead>
          <tr>
            <th scope="col">묶음</th>
            {hasSeries && <th scope="col">값</th>}
            {query.metrics.map((m) => (
              <th key={m} scope="col" className={styles.number}>
                {METRIC_LABELS[m]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={1 + (hasSeries ? 1 : 0) + query.metrics.length} className={styles.muted}>
                이 기간에 이벤트가 없습니다.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.bucket}:${r.series}`}>
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
        {eventsTotal !== null && rows.length > 0 && (
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
      {query.metrics.includes("users") && (
        <p className={styles.muted}>사용자 수는 행끼리 더할 수 없습니다. 기간 전체의 사용자 수는 단위를 "전체"로 다시 보세요.</p>
      )}
    </div>
  );
}

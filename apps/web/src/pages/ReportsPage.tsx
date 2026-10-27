import type { Metric, ReportQuery, ReportResult } from "@event-analytics/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { runReport } from "../api/endpoints";
import { BarChart } from "../components/BarChart";
import { ReportForm } from "../components/ReportForm";
import { ReportTable } from "../components/ReportTable";
import { LoadError, Loading } from "../components/States";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import { defaultReportForm } from "../lib/form";
import { assignColors, buildChartData, METRIC_LABELS, OTHER_KEY } from "../lib/series";
import styles from "./ReportsPage.module.css";

// 리포트 화면(DESIGN 6.7): 설정 → 그래프와 표. 다시 셀 때는 앞의 결과를 흐리게 둔다(자리가 튀지 않게).
export function ReportsPage() {
  const [query, setQuery] = useState<ReportQuery | null>(null);
  const report = useQuery({
    queryKey: ["report", query],
    enabled: query !== null,
    // 결과와 그것을 만든 설정을 함께 둔다(앞의 결과를 보이는 동안 설정이 바뀌어도 어긋나지 않게)
    queryFn: async () => ({ query: query!, result: await runReport(query!) }),
    placeholderData: keepPreviousData,
  });
  const [initial] = useState(defaultReportForm);

  return (
    <>
      <h1>리포트</h1>
      <ReportForm initial={initial} onSubmit={setQuery} />
      <section className={styles.result} aria-label="결과" aria-busy={report.isFetching}>
        {query === null ? (
          <p className={styles.muted}>설정을 고르고 "보기"를 누르세요.</p>
        ) : report.isPending ? (
          <Loading />
        ) : report.isError ? (
          <LoadError error={report.error} onRetry={() => void report.refetch()} />
        ) : (
          <div className={report.isPlaceholderData ? styles.stale : undefined}>
            <ReportView query={report.data.query} result={report.data.result} />
          </div>
        )}
      </section>
    </>
  );
}

const colorOf = (key: string, slots: ReadonlyMap<string, number>) => (key === OTHER_KEY ? "var(--series-other)" : `var(--series-${slots.get(key)})`);

function ReportView({ query, result }: { query: ReportQuery; result: ReportResult }) {
  const [metric, setMetric] = useState<Metric>(query.metrics[0]!);
  const shown: Metric = query.metrics.includes(metric) ? metric : query.metrics[0]!;
  const data = useMemo(() => buildChartData(query, result), [query, result]);
  // 색은 계열을 따라간다: 다시 세어도 남은 계열은 같은 색이다
  const slotsRef = useRef<ReadonlyMap<string, number>>(new Map());
  const slots = useMemo(() => {
    slotsRef.current = assignColors(
      data.series.map((s) => s.key),
      slotsRef.current,
    );
    return slotsRef.current;
  }, [data]);
  const series = data.series.filter((s) => s.values[shown] !== undefined);
  const title = METRIC_LABELS[shown];

  return (
    <>
      <ul className={styles.badges}>
        <li>{result.meta.source === "rollup" ? "시간 집계 표 + 원본" : "원본"}에서 셈</li>
        {result.meta.provisional && <li>최근 7일이 들어 있어 늦은 이벤트가 더 올 수 있음</li>}
        {result.meta.stale && <li>다시 세기 전인 늦은 이벤트가 있음(1분 안에 다시 셈)</li>}
      </ul>
      {query.metrics.length > 1 && (
        <div className={styles.tabs} role="group" aria-label="그래프의 지표">
          {query.metrics.map((m) => (
            <button key={m} type="button" aria-pressed={m === shown} onClick={() => setMetric(m)}>
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
      )}
      {query.granularity === "total" ? (
        <BarChart
          title={title}
          bars={series.map((s) => ({ key: s.key, label: s.label, value: s.values[shown]![0] ?? 0, color: colorOf(s.key, slots) }))}
        />
      ) : (
        <TimeSeriesChart
          title={title}
          buckets={data.buckets}
          series={series.map((s) => ({ key: s.key, label: s.label, color: colorOf(s.key, slots), values: s.values[shown]! }))}
        />
      )}
      {data.hidden > 0 && (
        <p className={styles.muted}>
          {shown === "events"
            ? `값 ${data.hidden}개를 "기타"로 더했습니다.`
            : `값 ${data.hidden}개를 그래프에서 숨겼습니다(사용자 수는 더할 수 없어 "기타"로 묶지 않습니다).`}
          {data.rankedBy === "users" && " 순위는 묶음별 사용자 수의 합입니다(고유 사용자 수가 아닙니다)."}
        </p>
      )}
      <ReportTable query={query} result={result} />
    </>
  );
}

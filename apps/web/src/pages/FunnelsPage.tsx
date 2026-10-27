import type { FunnelQuery, FunnelResult } from "@event-analytics/shared";
import { hashKey, keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { runFunnel } from "../api/endpoints";
import { BarChart } from "../components/BarChart";
import { defaultFunnelForm, FunnelFormView } from "../components/FunnelForm";
import { LoadError, Loading } from "../components/States";
import { DIMENSION_LABELS } from "../lib/form";
import { formatRate, stepViews, totalCounts, windowLabel, windowOpen } from "../lib/funnel";
import { formatCount, NONE_LABEL } from "../lib/series";
import tableStyles from "../components/Table.module.css";
import styles from "./ReportsPage.module.css";

// 퍼널 화면(DESIGN 6.5, 6.7): 단계별 사용자 수와 전환율. 전환율은 화면이 나눈다.
export function FunnelsPage() {
  const [query, setQuery] = useState<FunnelQuery | null>(null);
  // 같은 설정으로 다시 "보기"를 누르면 다시 센다(키가 같아 저절로는 다시 묻지 않는다)
  const submit = (q: FunnelQuery) => {
    if (query !== null && hashKey(["funnel", q]) === hashKey(["funnel", query])) void funnel.refetch();
    else setQuery(q);
  };
  const funnel = useQuery({
    queryKey: ["funnel", query],
    enabled: query !== null,
    queryFn: async () => ({ query: query!, result: await runFunnel(query!) }),
    placeholderData: keepPreviousData,
  });
  const [initial] = useState(defaultFunnelForm);

  return (
    <>
      <h1>퍼널</h1>
      <FunnelFormView initial={initial} onSubmit={submit} />
      <section className={styles.result} aria-label="결과" aria-busy={funnel.isFetching}>
        {query === null ? (
          <p className={styles.muted}>단계를 고르고 "보기"를 누르세요.</p>
        ) : funnel.isPending ? (
          <Loading />
        ) : funnel.isError ? (
          <LoadError error={funnel.error} onRetry={() => void funnel.refetch()} />
        ) : (
          <div className={funnel.isPlaceholderData ? styles.stale : undefined}>
            <FunnelView query={funnel.data.query} result={funnel.data.result} />
          </div>
        )}
      </section>
    </>
  );
}

function FunnelView({ query, result }: { query: FunnelQuery; result: FunnelResult }) {
  const views = stepViews(query.steps, totalCounts(result, query.steps.length));
  const breakdown = query.breakdown[0];
  // 큰 값이 위에 오게 진입 수 내림차순(같으면 서버 순서). 캠페인처럼 값이 많을 때 묻히지 않게.
  const rows = result.rows.toSorted((a, b) => (b.steps[0] ?? 0) - (a.steps[0] ?? 0));
  const header = (
    <>
      <p className={styles.explain}>
        <strong>첫 진입 기준 전환</strong>: 기간 안 첫 1단계부터 {windowLabel(query.windowMinutes)} 안에 끝낸 사용자만 셉니다. 같은 기간의 "
        {query.steps.at(-1)}" 사용자 수 리포트보다 작거나 다를 수 있습니다. 필터는 모든 단계에, 나눔은 진입(1단계) 이벤트에 겁니다.
      </p>
      <ul className={styles.badges}>
        {windowOpen(result.meta) && <li>전환 기간이 아직 끝나지 않은 진입이 있음(더 늘 수 있음)</li>}
        {/* provisional은 전환 기간의 끝(windowEnd) 기준이다(고른 기간이 아니라) */}
        {result.meta.provisional && <li>전환 기간까지 읽는 구간이 최근 7일에 걸쳐 늦은 이벤트가 더 올 수 있음</li>}
      </ul>
    </>
  );
  if (views[0]!.users === 0) {
    return (
      <>
        {header}
        <p className={styles.muted}>이 기간에 1단계(진입)가 없습니다. 기간이나 필터를 확인하세요.</p>
      </>
    );
  }
  return (
    <>
      {header}
      <BarChart
        title="단계별 사용자 수"
        bars={views.map((v, i) => ({
          key: String(i),
          label: `${i + 1}. ${v.name}`,
          value: v.users,
          color: "var(--series-1)",
          ...(i > 0 ? { note: `앞 단계 대비 ${formatRate(v.fromPrevious)}` } : {}),
        }))}
      />
      <div className={tableStyles.wrap}>
        <table className={tableStyles.table}>
          <caption className="visually-hidden">단계별 사용자 수와 전환율</caption>
          <thead>
            <tr>
              <th scope="col">단계</th>
              <th scope="col" className={tableStyles.number}>
                사용자 수
              </th>
              <th scope="col" className={tableStyles.number}>
                앞 단계 대비
              </th>
              <th scope="col" className={tableStyles.number}>
                1단계 대비
              </th>
            </tr>
          </thead>
          <tbody>
            {views.map((v, i) => (
              <tr key={`${i}:${v.name}`}>
                <th scope="row">
                  {i + 1}. {v.name}
                </th>
                <td className={tableStyles.number}>{formatCount(v.users)}</td>
                {/* 1단계는 앞 단계가 없어 비운다("—"는 0/0이다) */}
                <td className={tableStyles.number}>{i === 0 ? "" : formatRate(v.fromPrevious)}</td>
                <td className={tableStyles.number}>{formatRate(v.fromFirst)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {breakdown && (
        <div className={tableStyles.wrap}>
          <table className={tableStyles.table}>
            <caption>{DIMENSION_LABELS[breakdown]}(진입 이벤트)로 나눔</caption>
            <thead>
              <tr>
                <th scope="col">{DIMENSION_LABELS[breakdown]}</th>
                {query.steps.map((s, i) => (
                  <th key={`${i}:${s}`} scope="col" className={tableStyles.number}>
                    {i + 1}단계
                  </th>
                ))}
                <th scope="col" className={tableStyles.number}>
                  끝까지 전환율
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const value = r.dimensions[breakdown] ?? null;
                return (
                  <tr key={value ?? "\u0000none"}>
                    <th scope="row">{value ?? NONE_LABEL}</th>
                    {r.steps.map((n, i) => (
                      <td key={i} className={tableStyles.number}>
                        {formatCount(n)}
                      </td>
                    ))}
                    <td className={tableStyles.number}>{formatRate(stepViews(query.steps, r.steps).at(-1)!.fromFirst)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                {/* 나눔의 행은 겹치지 않아 더할 수 있다(사용자마다 진입이 하나) */}
                <th scope="row">합계</th>
                {views.map((v, i) => (
                  <td key={`${i}:${v.name}`} className={tableStyles.number}>
                    {formatCount(v.users)}
                  </td>
                ))}
                <td className={tableStyles.number}>{formatRate(views.at(-1)!.fromFirst)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}

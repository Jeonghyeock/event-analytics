import { EVENT_DIMENSIONS, RetentionQuery, type RetentionResult } from "@event-analytics/shared";
import { hashKey, keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { z } from "zod";
import { runRetention } from "../api/endpoints";
import { type OpenedReport, savedErrorHint } from "../api/saved";
import formStyles from "../components/Form.module.css";
import { EventSelect, FilterList, RangeFields } from "../components/FormParts";
import { SaveControls } from "../components/SaveControls";
import { SavedGate } from "../components/SavedGate";
import { LoadError, Loading } from "../components/States";
import tableStyles from "../components/Table.module.css";
import { lastDays } from "../lib/form";
import { formatRate } from "../lib/funnel";
import { issueMessages } from "../lib/issues";
import { DAYS_PRESETS, retentionRows } from "../lib/retention";
import { formatCount } from "../lib/series";
import styles from "./ReportsPage.module.css";

// 리텐션 화면(DESIGN 6.5, 6.7): 날마다 무리 × N일째 표 하나(그래프 없음, 10장 49).
export type RetentionForm = z.input<typeof RetentionQuery>;

export function defaultRetentionForm(now = new Date()): RetentionForm {
  const timezone = "Asia/Seoul";
  return { days: 7, filters: [], timezone, ...lastDays(timezone, 7, now) };
}

export function RetentionPage() {
  return (
    <SavedGate kind="retention" title="리텐션">
      {(opened) => <RetentionScreen opened={opened} />}
    </SavedGate>
  );
}

function RetentionScreen({ opened }: { opened: OpenedReport<"retention"> | null }) {
  const [query, setQuery] = useState<RetentionQuery | null>(opened?.config ?? null);
  // 같은 설정으로 다시 "보기"를 누르면 다시 센다(키가 같아 저절로는 다시 묻지 않는다)
  const submit = (q: RetentionQuery) => {
    if (query !== null && hashKey(["retention", q]) === hashKey(["retention", query])) void retention.refetch();
    else setQuery(q);
  };
  const retention = useQuery({
    queryKey: ["retention", query],
    enabled: query !== null,
    queryFn: async () => ({ query: query!, result: await runRetention(query!) }),
    placeholderData: keepPreviousData,
  });
  const [initial] = useState(() => opened?.config ?? defaultRetentionForm());
  const shown = retention.isSuccess && !retention.isPlaceholderData ? retention.data.query : null;
  return (
    <>
      <RetentionFormView initial={initial} onSubmit={submit} />
      <SaveControls kind="retention" opened={opened} shown={shown} />
      <section className={styles.result} aria-label="결과" aria-busy={retention.isFetching}>
        {query === null ? (
          <p className={styles.muted}>무리의 기간을 고르고 "보기"를 누르세요.</p>
        ) : retention.isPending ? (
          <Loading />
        ) : retention.isError ? (
          <LoadError error={retention.error} onRetry={() => void retention.refetch()} hint={savedErrorHint(opened, retention.error)} />
        ) : (
          <div className={retention.isPlaceholderData ? styles.stale : undefined}>
            <RetentionTable result={retention.data.result} />
          </div>
        )}
      </section>
    </>
  );
}

function RetentionFormView({ initial, onSubmit }: { initial: RetentionForm; onSubmit: (q: RetentionQuery) => void }) {
  const id = useId();
  const [form, setForm] = useState<RetentionForm>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const set = (patch: Partial<RetentionForm>) => setForm((f) => ({ ...f, ...patch }));
  const range = { from: form.from, to: form.to, timezone: form.timezone ?? ("Asia/Seoul" as const) };
  const days = form.days ?? 7;
  return (
    <form
      className={formStyles.form}
      aria-label="리텐션 설정"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = RetentionQuery.safeParse(form);
        if (!parsed.success) {
          setErrors(issueMessages(parsed.error.issues));
          return;
        }
        setErrors([]);
        onSubmit(parsed.data);
      }}
    >
      <RangeFields value={range} onChange={(r) => set(r)} presets={[7, 14, 31]} />
      <div className={formStyles.row}>
        <EventSelect label="시작 이벤트" optional value={form.startEvent ?? ""} range={range} onChange={(v) => set({ startEvent: v || undefined })} />
        <EventSelect label="돌아옴 이벤트" optional value={form.returnEvent ?? ""} range={range} onChange={(v) => set({ returnEvent: v || undefined })} />
        <label htmlFor={`${id}-days`}>며칠째까지</label>
        <select id={`${id}-days`} value={days} onChange={(e) => set({ days: Number(e.target.value) })}>
          {/* 저장한 설정의 값이 고를 것에 없어도 보이는 값과 보내는 값이 같게 */}
          {!DAYS_PRESETS.some((d) => d === days) && <option value={days}>{days}일째</option>}
          {DAYS_PRESETS.map((d) => (
            <option key={d} value={d}>
              {d}일째
            </option>
          ))}
        </select>
      </div>
      <FilterList
        filters={form.filters ?? []}
        dimensions={EVENT_DIMENSIONS}
        range={range}
        onChange={(filters) => set({ filters: filters as RetentionForm["filters"] })}
      />
      <div className={formStyles.row}>
        <button type="submit" className={formStyles.primary}>
          보기
        </button>
      </div>
      {errors.length > 0 && (
        <ul className={formStyles.errors} role="alert">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

// 비율은 한 색의 농도로도 보인다(순차 색, 값이 클수록 짙게). 표의 가장 큰 비율이 가장 짙다(40%까지): 리텐션은 대개 몇 %~몇십 %라
// 비율 그대로면 거의 보이지 않는다(코드 리뷰). 글자는 늘 글자 색이다(40% 위에서도 대비 8.8:1 이상).
const shade = (rate: number, max: number) => ({ background: `color-mix(in srgb, var(--series-1) ${Math.round((rate / max) * 40)}%, transparent)` });

function RetentionTable({ result }: { result: RetentionResult }) {
  const rows = retentionRows(result);
  const days = result.meta.days;
  const max = Math.max(0, ...rows.flatMap((r) => r.cells.map((c) => c.rate ?? 0)));
  const header = (
    <>
      <p className={styles.explain}>
        <strong>날마다 무리</strong>: 그날 시작 이벤트가 있는 사용자 전부가 그날의 무리입니다. 한 사람이 여러 무리에 들어 무리끼리 더할 수 없습니다. N일째는 무리의 날 + N일 그날에 돌아옴
        이벤트가 있는 비율입니다(그날만 셉니다, N일 안의 누적이 아닙니다).
      </p>
      <ul className={styles.badges}>
        <li>빈칸: 아직 지나지 않은 날</li>
        <li>—: 무리가 0명</li>
        {/* provisional은 마지막 칸의 날(to + N일) 기준이다(고른 기간이 아니라) */}
        {result.meta.provisional && <li>N일째까지 읽는 날이 최근 7일에 걸쳐 늦은 이벤트가 더 올 수 있음</li>}
      </ul>
    </>
  );
  if (!rows.some((r) => r.users > 0)) {
    return (
      <>
        {header}
        <p className={styles.muted}>이 기간에 무리가 없습니다(시작 이벤트가 있는 사용자가 없거나, 날이 아직 오지 않았습니다).</p>
      </>
    );
  }
  return (
    <>
      {header}
      <div className={tableStyles.wrap}>
        <table className={tableStyles.table}>
          <caption className="visually-hidden">무리의 날별 N일째 돌아온 비율</caption>
          <thead>
            <tr>
              <th scope="col">무리의 날</th>
              <th scope="col" className={tableStyles.number}>
                무리 크기
              </th>
              {Array.from({ length: days }, (_, i) => (
                <th key={i} scope="col" className={tableStyles.number}>
                  {i + 1}일째
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cohort}>
                <th scope="row">
                  {r.cohort}
                  {r.current && <span className={tableStyles.note}> 진행 중</span>}
                </th>
                <td className={tableStyles.number}>{formatCount(r.users)}</td>
                {r.cells.map((c, i) => (
                  <td
                    key={i}
                    className={tableStyles.number}
                    title={c.count === null ? "아직 지나지 않은 날" : `${formatCount(c.count)}명`}
                    style={c.state === "known" && max > 0 ? shade(c.rate!, max) : undefined}
                  >
                    {c.state === "pending" ? "" : formatRate(c.rate)}
                    {/* 명 수는 제목(마우스)뿐 아니라 화면 읽기 프로그램에도 */}
                    {c.state === "known" && <span className="visually-hidden">{` (${formatCount(c.count!)}명)`}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

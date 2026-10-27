import { EVENT_DIMENSIONS, RetentionQuery, type RetentionResult } from "@event-analytics/shared";
import { hashKey, keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { z } from "zod";
import { runRetention } from "../api/endpoints";
import formStyles from "../components/Form.module.css";
import { EventSelect, FilterList, RangeFields } from "../components/FormParts";
import { LoadError, Loading } from "../components/States";
import tableStyles from "../components/Table.module.css";
import { lastDays } from "../lib/form";
import { formatRate } from "../lib/funnel";
import { issueMessages } from "../lib/issues";
import { DAYS_PRESETS, retentionRows } from "../lib/retention";
import { formatCount } from "../lib/series";
import styles from "./ReportsPage.module.css";

// 리텐션 화면(DESIGN 6.5, 6.7): 날마다 무리 × N일째 표 하나(그래프 없음, 10장 49).
type RetentionForm = z.input<typeof RetentionQuery>;

export function RetentionPage() {
  const [query, setQuery] = useState<RetentionQuery | null>(null);
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
  return (
    <>
      <h1>리텐션</h1>
      <RetentionFormView onSubmit={submit} />
      <section className={styles.result} aria-label="결과" aria-busy={retention.isFetching}>
        {query === null ? (
          <p className={styles.muted}>무리의 기간을 고르고 "보기"를 누르세요.</p>
        ) : retention.isPending ? (
          <Loading />
        ) : retention.isError ? (
          <LoadError error={retention.error} onRetry={() => void retention.refetch()} />
        ) : (
          <div className={retention.isPlaceholderData ? styles.stale : undefined}>
            <RetentionTable result={retention.data.result} />
          </div>
        )}
      </section>
    </>
  );
}

function RetentionFormView({ onSubmit }: { onSubmit: (q: RetentionQuery) => void }) {
  const id = useId();
  const [form, setForm] = useState<RetentionForm>(() => ({ days: 7, filters: [], timezone: "Asia/Seoul", ...lastDays("Asia/Seoul", 7) }));
  const [errors, setErrors] = useState<string[]>([]);
  const set = (patch: Partial<RetentionForm>) => setForm((f) => ({ ...f, ...patch }));
  const range = { from: form.from, to: form.to, timezone: form.timezone ?? ("Asia/Seoul" as const) };
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
        <select id={`${id}-days`} value={form.days} onChange={(e) => set({ days: Number(e.target.value) })}>
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

// 비율은 한 색의 농도로도 보인다(순차 색, 값이 클수록 짙게). 글자는 늘 글자 색이고 정확한 수는 칸의 제목에 있다.
const shade = (rate: number) => ({ background: `color-mix(in srgb, var(--series-1) ${Math.round(rate * 40)}%, transparent)` });

function RetentionTable({ result }: { result: RetentionResult }) {
  const rows = retentionRows(result);
  const days = result.meta.days;
  return (
    <>
      <p className={styles.explain}>
        <strong>날마다 무리</strong>: 그날 시작 이벤트가 있는 사용자 전부가 그날의 무리입니다. 한 사람이 여러 무리에 들어 무리끼리 더할 수 없습니다. N일째는 무리의 날 + N일에 돌아옴
        이벤트가 있는 비율입니다.
      </p>
      <ul className={styles.badges}>
        <li>빈칸: 아직 지나지 않은 날</li>
        <li>—: 무리가 0명</li>
        {result.meta.provisional && <li>최근 7일이 들어 있어 늦은 이벤트가 더 올 수 있음</li>}
      </ul>
      <div className={tableStyles.wrap}>
        <table className={tableStyles.table}>
          <caption className="visually-hidden">무리의 날별 N일째 돌아온 비율</caption>
          <thead>
            <tr>
              <th scope="col">무리의 날</th>
              <th scope="col" className={tableStyles.number}>
                무리
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
                    style={c.state === "known" ? shade(c.rate!) : undefined}
                  >
                    {c.state === "pending" ? "" : formatRate(c.rate)}
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

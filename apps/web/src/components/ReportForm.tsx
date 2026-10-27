import { DIMENSIONS, GRANULARITIES, type Metric, ReportQuery, TIMEZONES } from "@event-analytics/shared";
import { useId, useState } from "react";
import { DIMENSION_LABELS, GRANULARITY_LABELS, lastDays, type ReportForm as Form } from "../lib/form";
import { METRIC_LABELS } from "../lib/series";
import { FilterEditor } from "./FilterEditor";
import styles from "./Form.module.css";

// 리포트 설정 양식(DESIGN 6.3 설정, 6.7). 보내기 전에 공유 스키마로 검사해 틀린 것을 양식에서 알린다(서버의 400 전에).
export function ReportForm({ initial, onSubmit }: { initial: Form; onSubmit: (q: ReportQuery) => void }) {
  const id = useId();
  const [form, setForm] = useState<Form>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const metrics = form.metrics ?? [];
  const dimensions = form.dimensions ?? [];
  const filters = form.filters ?? [];
  const range = { from: form.from, to: form.to, timezone: form.timezone ?? ("Asia/Seoul" as const) };

  const toggleMetric = (m: Metric) => set({ metrics: metrics.includes(m) ? metrics.filter((x) => x !== m) : [...metrics, m] });
  const setDimension = (slot: number, value: string) => {
    const next = [...dimensions];
    if (value === "") next.splice(slot, 1);
    else next[slot] = value as (typeof DIMENSIONS)[number];
    set({ dimensions: next });
  };
  const unusedFilterDimension = DIMENSIONS.find((d) => !filters.some((f) => f.dimension === d));

  return (
    <form
      className={styles.form}
      aria-label="리포트 설정"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = ReportQuery.safeParse(form);
        if (!parsed.success) {
          setErrors(parsed.error.issues.map((i) => i.message));
          return;
        }
        setErrors([]);
        onSubmit(parsed.data);
      }}
    >
      <fieldset className={styles.row}>
        <legend>지표</legend>
        {(["events", "users"] as const).map((m) => (
          <label key={m}>
            <input type="checkbox" checked={metrics.includes(m)} onChange={() => toggleMetric(m)} />
            {METRIC_LABELS[m]}
          </label>
        ))}
      </fieldset>

      <div className={styles.row}>
        <label htmlFor={`${id}-from`}>시작</label>
        <input id={`${id}-from`} type="date" value={form.from} onChange={(e) => set({ from: e.target.value })} required />
        <label htmlFor={`${id}-to`}>끝</label>
        <input id={`${id}-to`} type="date" value={form.to} onChange={(e) => set({ to: e.target.value })} required />
        {[7, 30, 90].map((days) => (
          <button key={days} type="button" onClick={() => set(lastDays(range.timezone, days))}>
            최근 {days}일
          </button>
        ))}
      </div>

      <div className={styles.row}>
        <label htmlFor={`${id}-granularity`}>단위</label>
        <select id={`${id}-granularity`} value={form.granularity} onChange={(e) => set({ granularity: e.target.value as Form["granularity"] })}>
          {GRANULARITIES.map((g) => (
            <option key={g} value={g}>
              {GRANULARITY_LABELS[g]}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-timezone`}>시간대</label>
        <select id={`${id}-timezone`} value={range.timezone} onChange={(e) => set({ timezone: e.target.value as Form["timezone"] })}>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        {[0, 1].map((slot) => (
          <span key={slot} className={styles.field}>
            <label htmlFor={`${id}-dimension-${slot}`}>차원 {slot + 1}</label>
            <select
              id={`${id}-dimension-${slot}`}
              value={dimensions[slot] ?? ""}
              disabled={slot === 1 && dimensions.length === 0}
              onChange={(e) => setDimension(slot, e.target.value)}
            >
              <option value="">없음</option>
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {DIMENSION_LABELS[d]}
                </option>
              ))}
            </select>
          </span>
        ))}
      </div>

      {filters.map((f, i) => (
        <FilterEditor
          key={f.dimension}
          filter={f}
          dimensions={DIMENSIONS.filter((d) => d === f.dimension || !filters.some((g) => g.dimension === d))}
          range={range}
          onChange={(next) => set({ filters: filters.map((g, j) => (j === i ? next : g)) })}
          onRemove={() => set({ filters: filters.filter((_, j) => j !== i) })}
        />
      ))}

      <div className={styles.row}>
        {unusedFilterDimension && (
          <button type="button" onClick={() => set({ filters: [...filters, { dimension: unusedFilterDimension, values: [] }] })}>
            필터 더하기
          </button>
        )}
        <button type="submit" className={styles.primary}>
          보기
        </button>
      </div>

      {errors.length > 0 && (
        <ul className={styles.errors} role="alert">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

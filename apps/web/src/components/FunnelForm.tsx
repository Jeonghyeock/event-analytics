import { EVENT_DIMENSIONS, FunnelQuery, MAX_FUNNEL_STEPS } from "@event-analytics/shared";
import { useId, useState } from "react";
import type { z } from "zod";
import { DIMENSION_LABELS, lastDays } from "../lib/form";
import { WINDOW_PRESETS } from "../lib/funnel";
import styles from "./Form.module.css";
import { EventSelect, FilterList, RangeFields } from "./FormParts";

// 퍼널 설정 양식(DESIGN 6.5, 6.7). 단계는 이벤트 이름 목록에서 고른다. 필터·나눔에는 이벤트 이름이 없다(단계가 이벤트 이름이다).
export type FunnelForm = z.input<typeof FunnelQuery>;

export function defaultFunnelForm(now = new Date()): FunnelForm {
  const timezone = "Asia/Seoul";
  return { steps: ["", ""], windowMinutes: 60, filters: [], breakdown: [], timezone, ...lastDays(timezone, 7, now) };
}

export function FunnelFormView({ initial, onSubmit }: { initial: FunnelForm; onSubmit: (q: FunnelQuery) => void }) {
  const id = useId();
  const [form, setForm] = useState<FunnelForm>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const set = (patch: Partial<FunnelForm>) => setForm((f) => ({ ...f, ...patch }));
  const range = { from: form.from, to: form.to, timezone: form.timezone ?? ("Asia/Seoul" as const) };
  const steps = form.steps;

  return (
    <form
      className={styles.form}
      aria-label="퍼널 설정"
      onSubmit={(e) => {
        e.preventDefault();
        if (steps.some((s) => s === "")) {
          setErrors(["단계마다 이벤트를 고르세요"]);
          return;
        }
        const parsed = FunnelQuery.safeParse(form);
        if (!parsed.success) {
          setErrors(parsed.error.issues.map((i) => i.message));
          return;
        }
        setErrors([]);
        onSubmit(parsed.data);
      }}
    >
      <RangeFields value={range} onChange={(r) => set(r)} />

      <ol className={styles.steps} aria-label="단계">
        {steps.map((step, i) => (
          // 단계는 차례가 뜻이라 자리(i)가 키다
          <li key={i} className={styles.row}>
            <EventSelect label={`${i + 1}단계`} value={step} range={range} onChange={(v) => set({ steps: steps.map((s, j) => (j === i ? v : s)) })} />
            {steps.length > 2 && (
              <button type="button" onClick={() => set({ steps: steps.filter((_, j) => j !== i) })}>
                {i + 1}단계 빼기
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className={styles.row}>
        {steps.length < MAX_FUNNEL_STEPS && (
          <button type="button" onClick={() => set({ steps: [...steps, ""] })}>
            단계 더하기
          </button>
        )}
        <label htmlFor={`${id}-window`}>전환 기간</label>
        <select id={`${id}-window`} value={form.windowMinutes} onChange={(e) => set({ windowMinutes: Number(e.target.value) })}>
          {WINDOW_PRESETS.map((p) => (
            <option key={p.minutes} value={p.minutes}>
              {p.label}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-breakdown`}>나눔</label>
        <select
          id={`${id}-breakdown`}
          value={form.breakdown?.[0] ?? ""}
          onChange={(e) => set({ breakdown: e.target.value === "" ? [] : [e.target.value as (typeof EVENT_DIMENSIONS)[number]] })}
        >
          <option value="">없음</option>
          {EVENT_DIMENSIONS.map((d) => (
            <option key={d} value={d}>
              {DIMENSION_LABELS[d]}
            </option>
          ))}
        </select>
      </div>

      <FilterList
        filters={form.filters ?? []}
        dimensions={EVENT_DIMENSIONS}
        range={range}
        onChange={(filters) => set({ filters: filters as FunnelForm["filters"] })}
      />

      <div className={styles.row}>
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

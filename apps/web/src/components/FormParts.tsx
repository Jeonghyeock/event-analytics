import { type Dimension, TIMEZONES } from "@event-analytics/shared";
import { useId } from "react";
import { type Range, useDimensionValues } from "../api/values";
import { lastDays } from "../lib/form";
import { type Filter, FilterEditor } from "./FilterEditor";
import styles from "./Form.module.css";

// 퍼널·리텐션 양식이 함께 쓰는 칸(DESIGN 6.7): 기간과 시간대, 필터 목록, 이벤트 이름 고르기.

export function RangeFields({ value, onChange, presets = [7, 30, 90] }: { value: Range; onChange: (r: Range) => void; presets?: number[] }) {
  const id = useId();
  return (
    <div className={styles.row}>
      <label htmlFor={`${id}-from`}>시작</label>
      <input id={`${id}-from`} type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} required />
      <label htmlFor={`${id}-to`}>끝</label>
      <input id={`${id}-to`} type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} required />
      {presets.map((days) => (
        <button key={days} type="button" onClick={() => onChange({ ...value, ...lastDays(value.timezone, days) })}>
          최근 {days}일
        </button>
      ))}
      <label htmlFor={`${id}-timezone`}>시간대</label>
      <select id={`${id}-timezone`} value={value.timezone} onChange={(e) => onChange({ ...value, timezone: e.target.value as Range["timezone"] })}>
        {TIMEZONES.map((tz) => (
          <option key={tz} value={tz}>
            {tz}
          </option>
        ))}
      </select>
    </div>
  );
}

export function FilterList({
  filters,
  dimensions,
  range,
  onChange,
}: {
  filters: Filter[];
  dimensions: readonly Dimension[];
  range: Range;
  onChange: (filters: Filter[]) => void;
}) {
  const unused = dimensions.find((d) => !filters.some((f) => f.dimension === d));
  return (
    <>
      {filters.map((f, i) => (
        <FilterEditor
          key={f.dimension}
          filter={f}
          dimensions={dimensions.filter((d) => d === f.dimension || !filters.some((g) => g.dimension === d))}
          range={range}
          onChange={(next) => onChange(filters.map((g, j) => (j === i ? next : g)))}
          onRemove={() => onChange(filters.filter((_, j) => j !== i))}
        />
      ))}
      {unused && (
        <div className={styles.row}>
          <button type="button" onClick={() => onChange([...filters, { dimension: unused, values: [] }])}>
            필터 더하기
          </button>
        </div>
      )}
    </>
  );
}

// 이벤트 이름은 리포트 API(차원 event_name)로 읽은 목록에서 고른다(손으로 친 이름의 오타가 0이 되지 않게, 10장 54).
// optional이면 "모든 이벤트"(빈 값)를 고를 수 있다.
export function EventSelect({
  label,
  value,
  range,
  optional = false,
  onChange,
}: {
  label: string;
  value: string;
  range: Range;
  optional?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const names = useDimensionValues("event_name", range);
  const options = (names.data ?? []).flatMap((o) => (o.value === null ? [] : [o.value]));
  // 고른 이름이 이 기간의 목록에 없어도(저장한 설정 등) 그대로 보인다. 목록을 읽었는데 없으면 그 기간에는 0이 나온다고 알린다.
  const missing = value !== "" && !options.includes(value);
  if (missing) options.unshift(value);
  return (
    <span className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{optional ? "모든 이벤트" : names.isPending ? "읽는 중…" : "고르세요"}</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
            {missing && name === value && names.isSuccess ? " (이 기간에 없음)" : ""}
          </option>
        ))}
      </select>
      {/* 목록을 못 읽으면(보관 기간 밖, API 꺼짐) 고를 것이 없는 까닭을 알린다(코드 리뷰) */}
      {names.isError && <span className={styles.hint}>이벤트 목록을 읽지 못했습니다. 기간을 확인하세요.</span>}
    </span>
  );
}

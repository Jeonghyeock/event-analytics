import type { Dimension } from "@event-analytics/shared";
import { useId, useState } from "react";
import { type Range, useDimensionValues, type ValueOption } from "../api/values";
import { DIMENSION_LABELS } from "../lib/form";
import { formatCount, NONE_LABEL } from "../lib/series";
import styles from "./Form.module.css";

// 필터 하나: 차원과 그 값들(DESIGN 6.7). 값은 리포트 API로 읽은 목록에서 고른다(손으로 친 값의 오타가 0이 되지 않게).
// 값이 없는 것은 "(없음)"으로 고른다(null).
export type Filter = { dimension: Dimension; values: (string | null)[] };

export function FilterEditor({
  filter,
  dimensions,
  range,
  onChange,
  onRemove,
}: {
  filter: Filter;
  dimensions: readonly Dimension[];
  range: Range;
  onChange: (filter: Filter) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const options = useDimensionValues(filter.dimension, range);
  const chosen = new Set(filter.values);
  const listed = options.data ?? [];
  // 고른 값이 이 기간의 목록에 없거나(기간을 바꿈) 찾기로 가려져도 늘 위에 보인다. 보이지 않으면 풀 수 없고, 리포트가 까닭 없이 0이 된다(코드 리뷰).
  const missing: ValueOption[] = filter.values.filter((v) => !listed.some((o) => o.value === v)).map((value) => ({ value, events: 0 }));
  const matches = (o: ValueOption) => (o.value ?? NONE_LABEL).toLowerCase().includes(search.toLowerCase());
  const shown = [...missing, ...listed.filter((o) => chosen.has(o.value)), ...listed.filter((o) => !chosen.has(o.value) && matches(o))];
  const toggle = (value: string | null) =>
    onChange({ ...filter, values: chosen.has(value) ? filter.values.filter((v) => v !== value) : [...filter.values, value] });

  return (
    <fieldset className={styles.filter}>
      <legend className="visually-hidden">필터</legend>
      <div className={styles.row}>
        <label htmlFor={`${id}-dimension`}>차원</label>
        <select
          id={`${id}-dimension`}
          value={filter.dimension}
          onChange={(e) => onChange({ dimension: e.target.value as Dimension, values: [] })}
        >
          {dimensions.map((d) => (
            <option key={d} value={d}>
              {DIMENSION_LABELS[d]}
            </option>
          ))}
        </select>
        <input
          type="search"
          aria-label={`${DIMENSION_LABELS[filter.dimension]} 값 찾기`}
          placeholder="값 찾기"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          // 찾기 칸의 Enter가 양식을 내지 않게(리포트가 돌지 않게)
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
        />
        <button type="button" onClick={onRemove}>
          필터 빼기
        </button>
      </div>
      {options.isPending ? (
        <p className={styles.muted}>값을 읽는 중…</p>
      ) : options.isError ? (
        <p className={styles.muted}>값을 읽지 못했습니다. 기간을 확인하세요.</p>
      ) : (
        <ul className={styles.values} aria-label={`${DIMENSION_LABELS[filter.dimension]} 값`}>
          {shown.map((o) => (
            <li key={o.value ?? "\u0000none"}>
              <label>
                <input type="checkbox" checked={chosen.has(o.value)} onChange={() => toggle(o.value)} />
                {o.value ?? NONE_LABEL}{" "}
                <span className={styles.muted}>{missing.includes(o) ? "(이 기간에 없음)" : `(${formatCount(o.events)})`}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {filter.values.length === 0 && <p className={styles.muted}>값을 하나 이상 고르세요.</p>}
    </fieldset>
  );
}

import { useState } from "react";
import { type ChartBucket, formatCompact, formatCount, niceTicks } from "../lib/series";
import styles from "./Chart.module.css";

// 시간 계열 선 그래프(DESIGN 6.7, 10장 50). 손으로 쓴 SVG다.
// - x축은 묶음 순서로 같은 간격이다(23·25시간인 날도 한 칸).
// - 아직 오지 않은 묶음(null)은 그리지 않는다. 진행 중이거나 일부만 찬 묶음으로 이어지는 선은 점선이다(덜 센 값).
// - 십자선이 가장 가까운 묶음에 붙고, 툴팁이 그 묶음의 모든 계열 값을 보인다. 키보드로는 왼쪽·오른쪽 화살표다.
// - 정확한 값은 늘 아래 표에 있다(그래프의 대안).

export type LineSeries = { key: string; label: string; color: string; values: (number | null)[] };

const W = 800;
const H = 260;
const M = { top: 12, right: 16, bottom: 36, left: 56 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const MAX_X_LABELS = 8;

// 글자 줄이기(날짜 계산이 아니다): "2026-10-27" → "10-27", "2026-10-27 13:00" → "10-27 13:00"
const shortLabel = (label: string) => (/^\d{4}-/.test(label) ? label.slice(5) : label);

export function TimeSeriesChart({ title, buckets, series }: { title: string; buckets: ChartBucket[]; series: LineSeries[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = buckets.length;
  const x = (i: number) => M.left + (n === 1 ? PLOT_W / 2 : (i * PLOT_W) / (n - 1));
  const max = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const y = (v: number) => M.top + PLOT_H * (1 - v / top);
  const dashed = (i: number) => buckets[i]!.state === "current" || buckets[i]!.partial;
  const step = Math.ceil(n / MAX_X_LABELS);
  const lastKnown = buckets.findLastIndex((b) => b.state !== "future");

  const paths = series.map((s) => {
    let solid = "";
    let dash = "";
    for (let i = 1; i < n; i++) {
      const a = s.values[i - 1];
      const b = s.values[i];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      const seg = `M${x(i - 1)},${y(a)}L${x(i)},${y(b)}`;
      if (dashed(i - 1) || dashed(i)) dash += seg;
      else solid += seg;
    }
    const end = s.values.findLastIndex((v) => v !== null);
    return { s, solid, dash, end };
  });

  const pick = (clientX: number, rect: DOMRect) => {
    const px = ((clientX - rect.left) / rect.width) * W;
    const i = n === 1 ? 0 : Math.round(((px - M.left) / PLOT_W) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className={styles.chart}>
      {series.length >= 2 && (
        <ul className={styles.legend} aria-label="계열">
          {series.map((s) => (
            <li key={s.key}>
              <span className={styles.lineKey} style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div
        className={styles.plot}
        tabIndex={0}
        role="group"
        aria-label={`${title} 그래프. 왼쪽·오른쪽 화살표로 묶음을 옮겨 값을 읽는다. 정확한 값은 아래 표에 있다.`}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover((h) => h ?? Math.max(0, lastKnown))}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? lastKnown) - 1));
          else if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? lastKnown) + 1));
          else if (e.key === "Escape") setHover(null);
          else return;
          e.preventDefault();
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className={styles.grid} />
              <text x={M.left - 8} y={y(t)} className={styles.yTick} dominantBaseline="middle" textAnchor="end">
                {formatCompact(t)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) =>
            i % step === 0 ? (
              <text key={b.bucket} x={x(i)} y={H - M.bottom + 18} className={styles.xTick} textAnchor="middle">
                {shortLabel(b.label)}
              </text>
            ) : null,
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + PLOT_H} className={styles.crosshair} />}
          {paths.map(({ s, solid, dash, end }) => (
            <g key={s.key}>
              {solid && <path d={solid} className={styles.line} style={{ stroke: s.color }} />}
              {dash && <path d={dash} className={`${styles.line} ${styles.dashed}`} style={{ stroke: s.color }} />}
              {end >= 0 && <circle cx={x(end)} cy={y(s.values[end]!)} r={4} className={styles.dot} style={{ fill: s.color }} />}
              {hover !== null && s.values[hover] !== null && s.values[hover] !== undefined && (
                <circle cx={x(hover)} cy={y(s.values[hover]!)} r={4} className={styles.dot} style={{ fill: s.color }} />
              )}
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div className={styles.tooltip} style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
            <p className={styles.tooltipTitle}>
              {buckets[hover]!.label}
              {buckets[hover]!.state === "current" && " · 진행 중"}
              {buckets[hover]!.partial && " · 일부"}
            </p>
            {buckets[hover]!.state === "future" ? (
              <p className={styles.muted}>아직 오지 않은 묶음</p>
            ) : (
              <ul>
                {series.map((s) => (
                  <li key={s.key}>
                    <span className={styles.lineKey} style={{ background: s.color }} aria-hidden="true" />
                    <strong>{formatCount(s.values[hover] ?? 0)}</strong> {s.label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

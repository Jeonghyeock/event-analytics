import { useRef } from "react";
import { clipText, formatCount, textWidth } from "../lib/series";
import { useWidth } from "../lib/useWidth";
import styles from "./Chart.module.css";

// 가로 막대(DESIGN 6.7, 10장 50). 단위가 "전체"인 리포트와 퍼널이 쓴다. 실제 너비로 1:1로 그린다.
// 막대는 24px을 넘지 않고, 끝(값 쪽)만 4px 둥글며 기준선 쪽은 각지다. 값은 막대 끝에 적는다(막대 몇 개라 모두 적어도 읽힌다).

export type Bar = { key: string; label: string; value: number; color: string; note?: string };

const BAR = 20;
const GAP = 12;
// 이름·값 글자 크기(Chart.module.css의 .barLabel, .barValue)
const BAR_FONT = 13;

// 끝만 둥근 막대: 왼쪽(기준선)은 각지고 오른쪽 위·아래 모서리만 4px
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h / 2);
  if (w <= 0) return "";
  return `M${x},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x}Z`;
}

export function BarChart({ title, bars }: { title: string; bars: Bar[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const W = useWidth(ref);
  // 이름 칸은 너비의 3할까지(폰에서도 막대 자리가 남게). 이름이 칸보다 길면 말줄임을 하고 전체 이름은 막대의 제목(<title>)에 둔다.
  const labelW = Math.min(180, Math.round(W * 0.3));
  // 값 칸은 가장 긴 값 글자만큼(막대 끝 뒤 8px 포함), 너비의 4.5할까지. 덧붙임(note)까지 들어가지 않으면 값만 적는다(덧붙임은 제목과 표에 있다).
  const valueText = (b: Bar, withNote: boolean) => `${formatCount(b.value)}${withNote && b.note ? ` · ${b.note}` : ""}`;
  const widest = (withNote: boolean) => Math.max(0, ...bars.map((b) => textWidth(valueText(b, withNote), BAR_FONT))) + 16;
  const showNotes = widest(true) <= W * 0.45;
  const valueW = Math.min(Math.round(W * 0.45), widest(showNotes));
  const max = Math.max(1, ...bars.map((b) => b.value));
  const plotW = Math.max(1, W - labelW - valueW);
  const h = bars.length * (BAR + GAP) + GAP;
  return (
    <div className={styles.chart} ref={ref}>
      <svg viewBox={`0 0 ${W} ${h}`} width={W} height={h} className={styles.svg} role="img" aria-label={`${title} 막대그래프. 정확한 값은 아래 표에 있다.`}>
        <line x1={labelW} x2={labelW} y1={0} y2={h} className={styles.axis} />
        {bars.map((b, i) => {
          const y = GAP + i * (BAR + GAP);
          const w = (b.value / max) * plotW;
          return (
            <g key={b.key}>
              <title>{`${b.label}: ${formatCount(b.value)}${b.note ? ` (${b.note})` : ""}`}</title>
              <text x={labelW - 8} y={y + BAR / 2} className={styles.barLabel} dominantBaseline="middle" textAnchor="end">
                {clipText(b.label, labelW - 8, BAR_FONT)}
              </text>
              <path d={barPath(labelW, y, w, BAR)} style={{ fill: b.color }} />
              <text x={labelW + w + 8} y={y + BAR / 2} className={styles.barValue} dominantBaseline="middle">
                {valueText(b, showNotes)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

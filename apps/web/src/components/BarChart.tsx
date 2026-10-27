import { formatCount } from "../lib/series";
import styles from "./Chart.module.css";

// 가로 막대(DESIGN 6.7, 10장 50). 단위가 "전체"인 리포트와 퍼널이 쓴다.
// 막대는 24px을 넘지 않고, 끝(값 쪽)만 4px 둥글며 기준선 쪽은 각지다. 값은 막대 끝에 적는다(막대 몇 개라 모두 적어도 읽힌다).

export type Bar = { key: string; label: string; value: number; color: string; note?: string };

const BAR = 20;
const GAP = 12;
const LABEL_W = 180;
const VALUE_W = 200;
const W = 800;
// 이름 칸(180)에 들어가는 글자 수쯤. 넘으면 말줄임을 하고 전체 이름은 막대의 제목(<title>)에 둔다(코드 리뷰).
const MAX_LABEL = 22;

// 끝만 둥근 막대: 왼쪽(기준선)은 각지고 오른쪽 위·아래 모서리만 4px
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h / 2);
  if (w <= 0) return "";
  return `M${x},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x}Z`;
}

const clip = (label: string) => (label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label);

export function BarChart({ title, bars }: { title: string; bars: Bar[] }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const plotW = W - LABEL_W - VALUE_W;
  const h = bars.length * (BAR + GAP) + GAP;
  return (
    <div className={styles.chart}>
      <svg viewBox={`0 0 ${W} ${h}`} className={styles.svg} role="img" aria-label={`${title} 막대그래프. 정확한 값은 아래 표에 있다.`}>
        <line x1={LABEL_W} x2={LABEL_W} y1={0} y2={h} className={styles.axis} />
        {bars.map((b, i) => {
          const y = GAP + i * (BAR + GAP);
          const w = (b.value / max) * plotW;
          return (
            <g key={b.key}>
              <title>{`${b.label}: ${formatCount(b.value)}${b.note ? ` (${b.note})` : ""}`}</title>
              <text x={LABEL_W - 8} y={y + BAR / 2} className={styles.barLabel} dominantBaseline="middle" textAnchor="end">
                {clip(b.label)}
              </text>
              <path d={barPath(LABEL_W, y, w, BAR)} style={{ fill: b.color }} />
              <text x={LABEL_W + w + 8} y={y + BAR / 2} className={styles.barValue} dominantBaseline="middle">
                {formatCount(b.value)}
                {b.note ? ` · ${b.note}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

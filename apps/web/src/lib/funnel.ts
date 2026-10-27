import type { FunnelResult } from "@event-analytics/shared";

// 퍼널 응답 → 막대와 표(DESIGN 6.7). 서버는 단계별 사용자 수만 주고, 전환율은 화면이 나눈다.

export type StepView = {
  name: string;
  users: number;
  // 앞 단계 대비(1단계는 null, 앞 단계가 없다), 1단계 대비(1단계는 100%). 나눌 수가 0이면 null("—")이다.
  fromPrevious: number | null;
  fromFirst: number | null;
};

const rate = (n: number, d: number | undefined) => (d === undefined || d === 0 ? null : n / d);

export function stepViews(steps: readonly string[], counts: readonly number[]): StepView[] {
  return steps.map((name, i) => ({
    name,
    users: counts[i] ?? 0,
    fromPrevious: i === 0 ? null : rate(counts[i] ?? 0, counts[i - 1]),
    fromFirst: rate(counts[i] ?? 0, counts[0]),
  }));
}

// 나눔의 행은 겹치지 않는다(사용자마다 진입이 하나). 그래서 단계마다 더하면 나누지 않은 퍼널과 같다(6.5).
export function totalCounts(result: FunnelResult, steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => result.rows.reduce((sum, r) => sum + (r.steps[i] ?? 0), 0));
}

// 전환 기간이 아직 끝나지 않은 진입이 있다(서버의 "지금"으로 판단, 화면의 시계가 아니다)
export const windowOpen = (meta: FunnelResult["meta"]) => meta.windowEnd > meta.asOf;

const percent = new Intl.NumberFormat("ko-KR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const formatRate = (r: number | null) => (r === null ? "—" : percent.format(r));

export const WINDOW_PRESETS = [
  { minutes: 15, label: "15분" },
  { minutes: 30, label: "30분" },
  { minutes: 60, label: "1시간" },
  { minutes: 1_440, label: "1일" },
  { minutes: 10_080, label: "7일" },
] as const;

// 고를 것에 없는 값(저장한 설정 등)도 읽기 쉬운 단위로 적는다
export const windowLabel = (minutes: number) =>
  WINDOW_PRESETS.find((p) => p.minutes === minutes)?.label ??
  (minutes % 1_440 === 0 ? `${minutes / 1_440}일` : minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`);

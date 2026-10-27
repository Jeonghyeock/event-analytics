import type { RetentionResult } from "@event-analytics/shared";

// 리텐션 응답 → 표(DESIGN 6.7). 무리끼리 더하지 않는다(한 사람이 여러 무리에 든다). 합계·평균 행은 없다.

// known: 센 칸. pending: 아직 다 지나지 않은 날(서버의 null, 빈칸). zero: 무리가 0명이라 비율이 0/0("—")이다.
export type CellState = "known" | "pending" | "zero";
export type RetentionCell = { count: number | null; rate: number | null; state: CellState };
export type RetentionRowView = { cohort: string; users: number; current: boolean; cells: RetentionCell[] };

export function retentionRows(result: RetentionResult): RetentionRowView[] {
  return (
    result.rows
      // 아직 오지 않은 날의 무리(users: null)는 보이지 않는다
      .filter((r): r is typeof r & { users: number } => r.users !== null)
      .map((r) => ({
        cohort: r.cohort,
        users: r.users,
        // 오늘(리포트 시간대, 서버가 정함)의 무리는 지금까지 센 값이다
        current: r.cohort === result.meta.today,
        cells: r.returned.map((count): RetentionCell => {
          if (count === null) return { count, rate: null, state: "pending" };
          if (r.users === 0) return { count, rate: null, state: "zero" };
          return { count, rate: count / r.users, state: "known" };
        }),
      }))
  );
}

export const DAYS_PRESETS = [7, 14, 30] as const;

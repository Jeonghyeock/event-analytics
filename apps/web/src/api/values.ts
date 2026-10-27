import type { Dimension, TIMEZONES } from "@event-analytics/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { runReport } from "./endpoints";

// 차원 값 목록(DESIGN 6.7, 10장 54). 새 API 없이 리포트 API(이벤트 수, 단위 "전체", 차원 하나)로 채운다.
// 많은 것부터. 값이 없는 것(null)도 하나의 값이다("(없음)"). 기간을 바꿔 다시 읽는 동안 앞의 목록을 둔다(깜박이지 않게).
export type ValueOption = { value: string | null; events: number };

export type Range = { from: string; to: string; timezone: (typeof TIMEZONES)[number] };

export function useDimensionValues(dimension: Dimension, range: Range) {
  return useQuery({
    queryKey: ["dimensionValues", dimension, range.from, range.to, range.timezone],
    queryFn: async (): Promise<ValueOption[]> => {
      const result = await runReport({ metrics: ["events"], granularity: "total", dimensions: [dimension], ...range });
      return result.rows
        .map((r) => ({ value: r.dimensions[dimension] ?? null, events: r.events ?? 0 }))
        .sort((a, b) => b.events - a.events);
    },
    placeholderData: keepPreviousData,
  });
}

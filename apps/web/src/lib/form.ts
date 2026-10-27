import type { Dimension, ReportQuery } from "@event-analytics/shared";
import type { z } from "zod";

// 양식의 기간(DESIGN 6.7). 화면이 리포트 시간대의 "오늘"을 읽는 하나뿐인 곳이다: Intl로 읽어 "최근 n일"(기본값과 단추)을 만든다.
// 검사는 서버가 한다(보관 기간 밖이면 422).
export function todayIn(timezone: string, now = new Date()): string {
  // en-CA는 YYYY-MM-DD로 쓴다
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// 달력의 날짜끼리 빼기(시각이 아니라 날짜라 일광 절약 시간과 상관없다)
export function addCalendarDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function lastDays(timezone: string, days: number, now = new Date()) {
  const to = todayIn(timezone, now);
  return { from: addCalendarDays(to, -(days - 1)), to };
}

export type ReportForm = z.input<typeof ReportQuery>;

export function defaultReportForm(now = new Date()): ReportForm {
  const timezone = "Asia/Seoul";
  return { metrics: ["events"], dimensions: [], filters: [], granularity: "day", timezone, ...lastDays(timezone, 7, now) };
}

export const DIMENSION_LABELS: Record<Dimension, string> = {
  event_name: "이벤트 이름",
  platform: "플랫폼",
  country: "나라",
  channel: "채널",
  campaign: "캠페인",
};

export const GRANULARITY_LABELS = { hour: "시간", day: "일", week: "주", total: "전체" } as const;

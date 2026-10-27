import type { z } from "zod";

// 양식의 검사 오류 → 사람이 읽는 문장(DESIGN 6.7). 어느 칸인지 앞에 붙이고, 같은 문장은 하나만 보인다.
// 기본 문장은 공유 스키마가 켠 한국어(z.locales.ko)다.
const FIELD_LABELS: Record<string, string> = {
  metrics: "지표",
  dimensions: "차원",
  filters: "필터",
  from: "시작",
  to: "끝",
  granularity: "단위",
  timezone: "시간대",
  steps: "단계",
  windowMinutes: "전환 기간",
  breakdown: "나눔",
  startEvent: "시작 이벤트",
  returnEvent: "돌아옴 이벤트",
  days: "며칠째까지",
};

export function issueMessages(issues: readonly z.core.$ZodIssue[]): string[] {
  const messages = issues.map((i) => {
    const field = typeof i.path[0] === "string" ? FIELD_LABELS[i.path[0]] : undefined;
    // 값을 고르지 않은 필터는 따로 알린다(기본 문장은 "배열은 1개 이상"이라 무엇을 하라는지 모른다)
    if (i.path[0] === "filters" && i.path.at(-1) === "values" && i.code === "too_small") return "필터: 값을 하나 이상 고르세요";
    return field ? `${field}: ${i.message}` : i.message;
  });
  return [...new Set(messages)];
}

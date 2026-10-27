import { addDays, RETENTION_DAYS } from "../db/partitions.js";
import { FUNNEL } from "./generate.js";

// S2의 리포트 묶음(DESIGN 6.8 "리포트 묶음"). k6(실행기가 날짜를 채워 JSON으로 넘김)와 load:report-bench가 함께 쓴다.
// 1~6은 날짜를 데이터 끝(10-26)에 고정해 회차 사이와 고치기 전후가 같은 일을 한다. 7만 시작한 날(리포트 시간대)의 최근 7일이다.
// weight는 대시보드에서 자주 보는 정도(이벤트 수 리포트를 자주, 퍼널·리텐션을 가끔). 같은 몫으로도 재서 순위가 바뀌는지 본다.

export type MixKind = {
  key: string;
  name: string;
  path: "/reports/query" | "/funnels/query" | "/retention/query";
  weight: number;
  body: Record<string, unknown>;
};

export const MIX_TIMEZONE = "Asia/Seoul";
const kst = { timezone: MIX_TIMEZONE };
const last30 = { from: "2026-09-27", to: "2026-10-26" };

export function reportMix(today: string): MixKind[] {
  return [
    {
      key: "r1",
      name: "30일 일별, 이벤트 수",
      path: "/reports/query",
      weight: 3,
      body: { metrics: ["events"], granularity: "day", ...last30, ...kst },
    },
    {
      key: "r2",
      name: "7일 시간별 × 플랫폼, 이벤트 수",
      path: "/reports/query",
      weight: 2,
      body: { metrics: ["events"], granularity: "hour", dimensions: ["platform"], from: "2026-10-20", to: "2026-10-26", ...kst },
    },
    {
      key: "r3",
      name: "60일 캠페인별 합계, 이벤트 수",
      path: "/reports/query",
      weight: 2,
      body: { metrics: ["events"], granularity: "total", dimensions: ["campaign"], from: "2026-08-28", to: "2026-10-26", ...kst },
    },
    {
      key: "r4",
      name: "30일 일별, 이벤트 + 사용자 수",
      path: "/reports/query",
      weight: 2,
      body: { metrics: ["events", "users"], granularity: "day", ...last30, ...kst },
    },
    {
      key: "r5",
      name: "퍼널 30일, 다섯 단계, 전환 기간 1일",
      path: "/funnels/query",
      weight: 1,
      body: { steps: FUNNEL.map(([name]) => name), windowMinutes: 1_440, ...last30, ...kst },
    },
    {
      // 돌아옴 범위의 끝(무리 끝 + 1 + 30일 = 10-27)이 데이터 안이라 오늘 파티션을 읽지 않는다. 5단계에서 16초로 잰 질의다.
      key: "r6",
      name: "리텐션 무리 31일, 30일째까지",
      path: "/retention/query",
      weight: 1,
      body: { days: 30, from: "2026-08-27", to: "2026-09-26", ...kst },
    },
    {
      // 배경 수집이 쓰는 오늘을 읽는다(집계 표 + 원본 꼬리). 다른 종류와 따로 읽는다.
      key: "r7",
      name: "오늘을 포함한 최근 7일 일별, 이벤트 수",
      path: "/reports/query",
      weight: 2,
      body: { metrics: ["events"], granularity: "day", from: addDays(today, -6), to: today, ...kst },
    },
  ];
}

// 그 시각에 보관 기간 밖에 걸리는 종류. API는 기간의 시작(리포트 시간대의 자정)이 "UTC 오늘 − 90일 0시"보다 앞서면 422다.
// 날짜를 고정했으므로 시간이 지나면 걸린다(r6이 11-25 UTC로 가장 먼저, r3이 하루 뒤). 걸리면 실행기·진단 도구가 멈추고 날짜를 옮긴다.
export function outOfRetention(mix: MixKind[], now: Date) {
  const retainedFrom = Date.parse(`${addDays(now.toISOString().slice(0, 10), -RETENTION_DAYS)}T00:00:00Z`);
  return mix
    .filter((kind) => {
      const { from, timezone } = kind.body as { from: string; timezone: string };
      // 그 날짜의 리포트 시간대 자정(UTC). Asia/Seoul은 일광 절약 시간이 없어 오프셋이 하나다.
      const offset = timezone === "Asia/Seoul" ? "+09:00" : "Z";
      return Date.parse(`${from}T00:00:00${offset}`) < retainedFrom;
    })
    .map((kind) => kind.key);
}

// 같은 몫(모두 1). 몫이 고칠 곳을 미리 정하지 않는지 보려는 것이다.
export const equalWeights = (mix: MixKind[]) => mix.map((kind) => ({ ...kind, weight: 1 }));

// 리포트 시간대의 오늘(YYYY-MM-DD)
export const todayIn = (timezone: string, now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

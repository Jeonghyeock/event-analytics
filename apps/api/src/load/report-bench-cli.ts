import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FunnelQuery, ReportQuery, RetentionQuery } from "@event-analytics/shared";
import { createPool } from "../db/pool.js";
import { runFunnel } from "../reports/funnel-run.js";
import { buildFunnelSql } from "../reports/funnel-sql.js";
import { runRetention } from "../reports/retention-run.js";
import { buildRetentionSql } from "../reports/retention-sql.js";
import { runReport } from "../reports/run.js";
import { buildReportSql, type ReportSql } from "../reports/sql.js";
import { applyPlannerSettings, inReportTransaction, type ReportKind } from "../reports/transaction.js";
import { FUNNEL } from "./generate.js";
import { MIX_TIMEZONE, reportMix, todayIn } from "./mix.js";

// 정한 리포트의 시간(DESIGN 6.3 "원본에서 세는 시간", 3·4·5·7단계 기록). API와 같은 길(runReport, runFunnel, runRetention)로 센다.
// 리포트마다 첫 회차를 따로 두고, 그 뒤 n번의 가운데 값을 낸다. --explain이면 리포트마다 EXPLAIN (ANALYZE, BUFFERS, COSTS, TIMING)도
// 남긴다. EXPLAIN은 API와 같은 트랜잭션 틀(inReportTransaction)과 같은 계획 설정(applyPlannerSettings)으로 돌아, 7단계의 고침으로
// 더한 SET LOCAL이 계획에도 걸린다(DESIGN 6.8). --raw면 집계 표를 쓸 수 있는 리포트도 원본으로 센다(4단계의 전후 비교).
// --kind로 리포트·퍼널·리텐션·S2 묶음(mix) 가운데 하나를 고른다. 문장 한도는 API와 같은 30초다(API라면 503이 날 것을 끝까지 돌리지 않게).
// 7단계에서는 진단에만 쓴다(부하 중 계획). 머리 숫자(p95)는 HTTP로 잰다. 주소를 바꾸려면 DATABASE_URL을 준다(측정 복제본 등).
//   npm run load:report-bench -w @event-analytics/api -- --runs 3 --as-of 2026-10-27T12:00:00Z --explain [--raw] [--kind funnels|mix]
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "as-of": { type: "string" },
    explain: { type: "boolean", default: false },
    raw: { type: "boolean", default: false },
    kind: { type: "string", default: "reports" },
  },
});
const runs = Number(values.runs);
const asOf = values["as-of"];
const forceRaw = values.raw;
const kind = values.kind;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

const kst = { timezone: "Asia/Seoul" };
const last30 = { from: "2026-09-27", to: "2026-10-26" };
const last90 = { from: "2026-07-30", to: "2026-10-26" };
const REPORTS: Record<string, unknown> = {
  "30일 일별, 이벤트": { metrics: ["events"], granularity: "day", ...last30, ...kst },
  "30일 일별, 이벤트 + 사용자": { metrics: ["events", "users"], granularity: "day", ...last30, ...kst },
  "90일 캠페인별 합계, 이벤트": { metrics: ["events"], granularity: "total", dimensions: ["campaign"], ...last90, ...kst },
  "90일 캠페인별 합계, 이벤트 + 사용자": { metrics: ["events", "users"], granularity: "total", dimensions: ["campaign"], ...last90, ...kst },
  "7일 시간별 × 플랫폼, 이벤트": { metrics: ["events"], granularity: "hour", dimensions: ["platform"], from: "2026-10-20", to: "2026-10-26", ...kst },
  "7일 시간별 × 플랫폼, 이벤트 + 사용자": { metrics: ["events", "users"], granularity: "hour", dimensions: ["platform"], from: "2026-10-20", to: "2026-10-26", ...kst },
  "하루 시간별, 이벤트": { metrics: ["events"], granularity: "hour", from: "2026-10-26", to: "2026-10-26", ...kst },
  "하루 시간별, 이벤트 + 사용자": { metrics: ["events", "users"], granularity: "hour", from: "2026-10-26", to: "2026-10-26", ...kst },
};
// 예매 퍼널(생성기의 다섯 단계)
const steps = FUNNEL.map(([name]) => name);
const last7 = { from: "2026-10-20", to: "2026-10-26" };
const FUNNELS: Record<string, unknown> = {
  "7일, 전환 기간 15분": { steps, windowMinutes: 15, ...last7, ...kst },
  "7일, 1일": { steps, windowMinutes: 1_440, ...last7, ...kst },
  "7일, 7일": { steps, windowMinutes: 10_080, from: "2026-10-13", to: "2026-10-19", ...kst },
  "30일, 1일": { steps, windowMinutes: 1_440, ...last30, ...kst },
  "30일, 1일, 채널로 나눔": { steps, windowMinutes: 1_440, breakdown: ["channel"], ...last30, ...kst },
  "90일, 1일": { steps, windowMinutes: 1_440, ...last90, ...kst },
  "하루, 1일, 나라 VN, 채널로 나눔": {
    steps,
    windowMinutes: 1_440,
    filters: [{ dimension: "country", values: ["VN"] }],
    breakdown: ["channel"],
    from: "2026-10-26",
    to: "2026-10-26",
    ...kst,
  },
};
const RETENTIONS: Record<string, unknown> = {
  "무리 7일, 30일째까지": { days: 30, from: "2026-09-01", to: "2026-09-07", ...kst },
  "무리 31일, 30일째까지": { days: 30, from: "2026-08-27", to: "2026-09-26", ...kst },
  "무리 7일, 7일째까지, 선점 → 결제": { days: 7, startEvent: "seats_held", returnEvent: "payment_succeeded", from: "2026-10-13", to: "2026-10-19", ...kst },
};

// 한 번 돌리고, 계획을 볼 SQL을 만드는 함수(그 실행이 읽은 워터마크·windowEnd로, 잰 시간 밖에서 부름)와 계획 설정의 종류를 돌려준다.
type Measured = { source: string; watermark: string | null; rowCount: number; sql: () => ReportSql; kind: ReportKind };
const options = { ...(asOf ? { asOf } : {}), statementTimeout: "30s" };
const measureReport = async (body: unknown): Promise<Measured> => {
  const q = ReportQuery.parse(body);
  const result = await runReport(pool, q, { ...options, forceRaw });
  const watermark = result.meta.rollupWatermark;
  const sql = () => buildReportSql(q, 20_001, watermark ? new Date(watermark) : undefined);
  return { source: result.meta.source, watermark, rowCount: result.meta.rowCount, sql, kind: "report" };
};
const measureFunnel = async (body: unknown): Promise<Measured> => {
  const q = FunnelQuery.parse(body);
  const result = await runFunnel(pool, q, options);
  const sql = () => buildFunnelSql(q, new Date(result.meta.windowEnd));
  return { source: "funnel", watermark: null, rowCount: result.rows.length, sql, kind: "funnel" };
};
const measureRetention = async (body: unknown): Promise<Measured> => {
  const q = RetentionQuery.parse(body);
  const result = await runRetention(pool, q, options);
  return { source: "retention", watermark: null, rowCount: result.rows.length, sql: () => buildRetentionSql(q), kind: "retention" };
};
// S2 묶음(DESIGN 6.8): 7은 오늘(리포트 시간대)을 읽는다
const mix = reportMix(todayIn(MIX_TIMEZONE));
const MIX = Object.fromEntries(mix.map((k) => [`${k.key} ${k.name}`, { path: k.path, body: k.body }]));
const byPath = { "/reports/query": measureReport, "/funnels/query": measureFunnel, "/retention/query": measureRetention };
const CASES: Record<string, [Record<string, unknown>, (body: unknown) => Promise<Measured>]> = {
  reports: [REPORTS, measureReport],
  funnels: [FUNNELS, measureFunnel],
  retention: [RETENTIONS, measureRetention],
  mix: [MIX, (item) => {
    const { path, body } = item as (typeof MIX)[string];
    return byPath[path](body);
  }],
};

const pool = createPool({ connectionString: url, max: 1, application_name: "event-analytics-report-bench" });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const results = [];
try {
  if (!Object.hasOwn(CASES, kind)) throw new Error(`--kind는 ${Object.keys(CASES).join(", ")} 가운데 하나입니다`);
  const [bodies, measure] = CASES[kind]!;
  for (const [name, body] of Object.entries(bodies)) {
    const times: number[] = [];
    let last: Measured | undefined;
    for (let i = 0; i <= runs; i++) {
      const started = performance.now();
      last = await measure(body);
      times.push(performance.now() - started);
    }
    const [first, ...rest] = times;
    const { source, watermark, rowCount, sql, kind: plannerKind } = last!;
    let plan: string | undefined;
    if (values.explain) {
      plan = await inReportTransaction(pool, { statementTimeout: "30s" }, async (client) => {
        await applyPlannerSettings(client, plannerKind);
        const { text, values: params } = sql();
        const { rows } = await client.query(`explain (analyze, buffers, costs, timing) ${text}`, params);
        return rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
      });
    }
    const r = { name, source, watermark, rowCount, firstMs: Math.round(first!), medianMs: Math.round(median(rest)), runsMs: rest.map(Math.round), plan };
    console.log(`${name}(${source}): 행 ${rowCount}, 첫 ${r.firstMs}ms, 가운데 ${r.medianMs}ms (${r.runsMs.join(", ")})`);
    results.push(r);
  }
} finally {
  await pool.end();
}
const dir = fileURLToPath(new URL("../../../../load/results/", import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}${kind === "reports" ? "report" : kind}-bench-${new Date().toISOString().replaceAll(":", "-")}.json`;
writeFileSync(file, JSON.stringify({ kind, runs, asOf, forceRaw, database: new URL(url).pathname.slice(1), results }, null, 2));
console.log(`결과: ${file}`);

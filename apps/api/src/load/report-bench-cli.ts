import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ReportQuery } from "@event-analytics/shared";
import { createPool } from "../db/pool.js";
import { runReport } from "../reports/run.js";
import { buildReportSql } from "../reports/sql.js";

// 정한 리포트의 시간(DESIGN 6.3 "원본에서 세는 시간", 4단계와 7단계의 "전"). API와 같은 길(runReport)로 개발 DB에서 센다.
// 리포트마다 첫 회차를 따로 두고, 그 뒤 n번의 가운데 값을 낸다. --explain이면 리포트마다 EXPLAIN (ANALYZE, BUFFERS)도 남긴다.
//   npm run load:report-bench -w @event-analytics/api -- --runs 3 --as-of 2026-10-27T12:00:00Z
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "as-of": { type: "string" },
    explain: { type: "boolean", default: false },
  },
});
const runs = Number(values.runs);
const asOf = values["as-of"];

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
  "7일 시간별 × 플랫폼, 이벤트 + 사용자": { metrics: ["events", "users"], granularity: "hour", dimensions: ["platform"], from: "2026-10-20", to: "2026-10-26", ...kst },
  "하루 시간별, 이벤트 + 사용자": { metrics: ["events", "users"], granularity: "hour", from: "2026-10-26", to: "2026-10-26", ...kst },
};

const pool = createPool({ connectionString: url, max: 1, application_name: "event-analytics-report-bench" });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const results = [];
try {
  for (const [name, body] of Object.entries(REPORTS)) {
    const q = ReportQuery.parse(body);
    const times: number[] = [];
    let rowCount = 0;
    let watermark: string | null = null;
    for (let i = 0; i <= runs; i++) {
      const started = performance.now();
      const result = await runReport(pool, q, { ...(asOf ? { asOf } : {}), statementTimeout: "120s" });
      times.push(performance.now() - started);
      rowCount = result.meta.rowCount;
      watermark = result.meta.rollupWatermark;
    }
    const [first, ...rest] = times;
    let plan: string | undefined;
    if (values.explain) {
      // runReport와 같은 SQL(집계 표 경로면 그때 읽은 워터마크로)
      const { text, values: params } = buildReportSql(q, 20_001, watermark ? new Date(watermark) : undefined);
      const { rows } = await pool.query(`explain (analyze, buffers, costs off, timing off) ${text}`, params);
      plan = rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
    }
    const r = { name, rowCount, firstMs: Math.round(first!), medianMs: Math.round(median(rest)), runsMs: rest.map(Math.round), plan };
    console.log(`${name}: 행 ${rowCount}, 첫 ${r.firstMs}ms, 가운데 ${r.medianMs}ms (${r.runsMs.join(", ")})`);
    results.push(r);
  }
} finally {
  await pool.end();
}
const dir = fileURLToPath(new URL("../../../../load/results/", import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}report-bench-${new Date().toISOString().replaceAll(":", "-")}.json`;
writeFileSync(file, JSON.stringify({ runs, asOf, results }, null, 2));
console.log(`결과: ${file}`);

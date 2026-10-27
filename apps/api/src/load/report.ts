import { existsSync, readFileSync } from "node:fs";
import type { StatsSnapshot } from "./samplers.js";

// 측정 한 번의 파일을 읽어 요약을 만든다(DESIGN 6.8 "지표", "판단 규칙"). 순수 함수라 테스트로 지킨다.

export const readJsonLines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as T)
    : [];

// k6를 --log-format=json으로 띄우면 console.log 한 줄이 {"source":"console","msg":"…"}다. msg가 장면이 남긴 JSON이다.
export type ReportEvent = {
  ev: "report";
  vu: number;
  key: string;
  warm: boolean;
  startedAt: number;
  ms: number;
  status: number;
  code: string | null;
  poolMs: number | null;
};
export type K6Event = ReportEvent | { ev: "warmed"; vu: number; at: number };

export function readK6Events(file: string): K6Event[] {
  const events: K6Event[] = [];
  for (const line of readJsonLines<{ source?: string; msg?: string }>(file)) {
    if (line.source !== "console" || !line.msg) continue;
    try {
      events.push(JSON.parse(line.msg) as K6Event);
    } catch {
      // 장면이 남긴 것이 아닌 줄
    }
  }
  return events;
}

export type Window = { start: number; end: number };

// 정상 구간. 닫힌 모형: 모든 VU가 예열(묶음 한 바퀴)을 마친 때부터 마지막 요청이 끝난 때까지.
// 열린 모형: 첫 요청 + 예열 시간부터. 예열을 마치지 못한 VU가 있으면 null(그 회차는 판단에 쓸 수 없다).
export function steadyWindow(events: K6Event[], { vus, openWarmupMs }: { vus?: number; openWarmupMs?: number }): Window | null {
  const reports = events.filter((e): e is ReportEvent => e.ev === "report");
  if (reports.length === 0) return null;
  const end = Math.max(...reports.map((e) => e.startedAt + e.ms));
  if (openWarmupMs !== undefined) return { start: Math.min(...reports.map((e) => e.startedAt)) + openWarmupMs, end };
  const warmed = events.filter((e): e is Extract<K6Event, { ev: "warmed" }> => e.ev === "warmed");
  if (vus !== undefined && new Set(warmed.map((e) => e.vu)).size < vus) return null;
  return { start: Math.max(...warmed.map((e) => e.at)), end };
}

// 정상 구간이 UTC 정시를 넘는지(정시에 집계 작업이 지난 한 시간을 다시 센다, DESIGN 6.8)
export const crossesUtcHour = (window: Window) => Math.floor(window.start / 3_600_000) !== Math.floor(window.end / 3_600_000);

const round = (value: number) => Math.round(value * 10) / 10;
// 가장 가까운 순위의 백분위(load-stats와 같다)
export function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]!;
}

// 503이 이 비율을 넘으면 p95를 "한도 이상"으로 적는다(성공한 요청만의 p95는 실제보다 작게 보인다)
export const LIMIT_SHARE = 0.05;

// 종류별 요약(DESIGN 6.8 "지표", "판단 규칙"). 정상 구간 안에서 시작한, 예열이 아닌 요청만 센다.
// 기다린 시간의 몫: 종류마다 실행 시간(요청 시간 − 풀 대기, 503까지 걸린 시간 포함)에, 모든 요청의 풀 대기를
// 실행 시간(그동안 연결을 쥔 시간)의 비율로 나눠 더한다. 풀 대기는 그 연결을 쥔 종류 때문에 생긴 것으로 본다.
export function summarizeKinds(events: K6Event[], window: Window, keys: string[]) {
  const reports = events.filter(
    (e): e is ReportEvent => e.ev === "report" && !e.warm && e.startedAt >= window.start && e.startedAt < window.end,
  );
  const ownOf = (e: ReportEvent) => Math.max(0, e.ms - (e.poolMs ?? 0));
  const totalPool = reports.reduce((sum, e) => sum + (e.poolMs ?? 0), 0);
  const totalOwn = reports.reduce((sum, e) => sum + ownOf(e), 0);
  const kinds = keys.map((key) => {
    const mine = reports.filter((e) => e.key === key);
    const ok = mine.filter((e) => e.status >= 200 && e.status < 300);
    const failed = mine.filter((e) => e.status === 503);
    const codes: Record<string, number> = {};
    for (const e of mine) if (e.status >= 400 || e.status === 0) codes[`${e.status}:${e.code ?? "none"}`] = (codes[`${e.status}:${e.code ?? "none"}`] ?? 0) + 1;
    const own = mine.reduce((sum, e) => sum + ownOf(e), 0);
    const attributedPool = totalOwn > 0 ? (totalPool * own) / totalOwn : 0;
    const rate503 = mine.length > 0 ? failed.length / mine.length : 0;
    const p95 = percentile(
      ok.map((e) => e.ms),
      95,
    );
    return {
      key,
      n: mine.length,
      ok: ok.length,
      p50: round(percentile(ok.map((e) => e.ms), 50) ?? Number.NaN),
      p95: p95 === null ? null : round(p95),
      overLimit: rate503 > LIMIT_SHARE,
      rate503: Math.round(rate503 * 1000) / 1000,
      mean503Ms: failed.length > 0 ? round(failed.reduce((sum, e) => sum + e.ms, 0) / failed.length) : null,
      codes,
      totalMs: Math.round(mine.reduce((sum, e) => sum + e.ms, 0)),
      poolMs: Math.round(mine.reduce((sum, e) => sum + (e.poolMs ?? 0), 0)),
      ownMs: Math.round(own),
      attributedPoolMs: Math.round(attributedPool),
      score: Math.round(own + attributedPool),
    };
  });
  const scoreTotal = kinds.reduce((sum, k) => sum + k.score, 0);
  return {
    requests: reports.length,
    poolMs: Math.round(totalPool),
    kinds: kinds.map((k) => ({ ...k, share: scoreTotal > 0 ? Math.round((k.score / scoreTotal) * 1000) / 1000 : 0 })),
  };
}

type Tick = {
  type: string;
  at: string;
  ms?: number;
  pools: Record<string, { total: number; waiting: number; connectWait: { p95: number; max: number; count: number } | null; connectErrors: number }>;
  node: { elu: number; cpuPct: number; loopDelayMs: { p99: number } };
  routes: Record<string, { count?: number; p95?: number; statuses: Record<string, number>; codes?: Record<string, number>; aborted?: number }>;
  rollup: ({ ms: number } & Record<string, unknown>)[];
};
type CpuLine = { at: string; totalPct: number; postgresPct: number; k6Pct: number; nodePctByPid: Record<string, number> };
type ActivityLine = { at: string; samples: number; byKey: Record<string, number> };

// 1초 줄의 at은 그 창이 끝난 시각이다. 창 전체가 구간 안에 든 줄만 쓴다.
const within = (at: string, window: Window, windowMs = 1000) => {
  const end = Date.parse(at);
  return end - windowMs >= window.start && end <= window.end;
};
const mean = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null);
const maxOf = (values: number[]) => (values.length ? Math.max(...values) : null);
const sumBy = (rows: Record<string, number>[]) => {
  const total: Record<string, number> = {};
  for (const row of rows) for (const [k, v] of Object.entries(row)) total[k] = (total[k] ?? 0) + v;
  return total;
};

// API 1초 줄을 구간으로 묶는다. 풀마다 연결 대기의 1초 p95 최대, 연결 오류, 집계 바퀴(실패 포함)를 적는다.
export function summarizeApi(ticks: Tick[], window: Window) {
  const rows = ticks.filter((t) => t.type === "tick" && within(t.at, window, t.ms ?? 1000));
  const poolNames = new Set(rows.flatMap((t) => Object.keys(t.pools)));
  const pools = Object.fromEntries(
    [...poolNames].map((name) => {
      const per = rows.map((t) => t.pools[name]).filter((p) => p !== undefined);
      return [
        name,
        {
          waitingMax: maxOf(per.map((p) => p.waiting)),
          connectWaitP95Max: maxOf(per.flatMap((p) => (p.connectWait ? [p.connectWait.p95] : []))),
          connects: per.reduce((a, p) => a + (p.connectWait?.count ?? 0), 0),
          connectErrors: per.reduce((a, p) => a + p.connectErrors, 0),
        },
      ];
    }),
  );
  const routes = Object.fromEntries(
    [...new Set(rows.flatMap((t) => Object.keys(t.routes)))].map((name) => {
      const per = rows.map((t) => t.routes[name]).filter((r) => r !== undefined);
      return [
        name,
        {
          count: per.reduce((a, r) => a + (r.count ?? 0), 0),
          statuses: sumBy(per.map((r) => r.statuses)),
          codes: sumBy(per.map((r) => r.codes ?? {})),
          aborted: per.reduce((a, r) => a + (r.aborted ?? 0), 0),
        },
      ];
    }),
  );
  const rollup = rows.flatMap((t) => t.rollup.map((r) => ({ at: t.at, ...r })));
  return {
    seconds: rows.length,
    eluMean: mean(rows.map((t) => t.node.elu)),
    eluMax: maxOf(rows.map((t) => t.node.elu)),
    cpuPctMean: mean(rows.map((t) => t.node.cpuPct)),
    loopDelayP99Max: maxOf(rows.map((t) => t.node.loopDelayMs.p99)),
    pools,
    routes,
    rollup,
  };
}

// 프로세스 값은 한 코어를 100으로 본 %, 전체(totalPct)는 모든 논리 프로세서를 100으로 본 %다(seat-booking과 같다).
export function summarizeCpu(lines: CpuLine[], window: Window, apiPid: number, logicalProcessors: number) {
  const rows = lines.filter((l) => within(l.at, window));
  const api = rows.flatMap((l) => {
    const value = l.nodePctByPid[String(apiPid)];
    return value === undefined ? [] : [value];
  });
  return {
    samples: rows.length,
    apiPctMean: mean(api),
    apiPctMax: maxOf(api),
    postgresPctMean: mean(rows.map((l) => l.postgresPct)),
    postgresPctMax: maxOf(rows.map((l) => l.postgresPct)),
    k6PctMean: mean(rows.map((l) => l.k6Pct)),
    k6PctMax: maxOf(rows.map((l) => l.k6Pct)),
    othersPctMean: mean(rows.map((l) => l.totalPct * logicalProcessors - (l.nodePctByPid[String(apiPid)] ?? 0) - l.postgresPct - l.k6Pct)),
  };
}

// 표본기의 1초 줄을 구간으로 평균한다. 키는 "앱 [작업자] 상태 대기"다(samplers.ts).
export function summarizeActivity(lines: ActivityLine[], window: Window) {
  const rows = lines.filter((l) => within(l.at, window));
  const total = sumBy(rows.map((l) => l.byKey));
  const average = Object.entries(total)
    .map(([k, v]) => [k, Math.round((v / Math.max(rows.length, 1)) * 100) / 100] as const)
    .sort((a, b) => b[1] - a[1]);
  return { seconds: rows.length, byKey: Object.fromEntries(average) };
}

// k6 요약에서 시나리오 하나(수집)의 숫자. threshold를 건 하위 지표만 있다(main.js).
export function summarizeIngest(summary: { metrics: Record<string, { values: Record<string, number> }> }, scenario: string, seconds: number) {
  const metric = (name: string) => summary.metrics[name]?.values;
  const duration = metric(`http_req_duration{scenario:${scenario}}`);
  const requests = metric(`http_reqs{scenario:${scenario}}`)?.count ?? 0;
  return {
    requests,
    achievedPerSecond: Math.round((requests / seconds) * 10) / 10,
    p50: duration?.med ?? null,
    p95: duration?.["p(95)"] ?? null,
    max: duration?.max ?? null,
    dropped: metric(`dropped_iterations{scenario:${scenario}}`)?.count ?? 0,
    errors: metric(`ingest_errors{scenario:${scenario}}`)?.count ?? 0,
    duplicates: metric(`ingest_duplicates{scenario:${scenario}}`)?.count ?? 0,
    rejected: metric(`ingest_rejected{scenario:${scenario}}`)?.count ?? 0,
  };
}

// 앞뒤 통계의 차이(DESIGN 6.8 "증거"). 표는 events_*로 묶은 이름마다, 나머지는 DB·WAL·체크포인트·다른 DB.
export function diffStats(before: StatsSnapshot, after: StatsSnapshot) {
  const delta = (a: Record<string, unknown> | undefined, b: Record<string, unknown>, key: string) => Number(b[key] ?? 0) - Number(a?.[key] ?? 0);
  const tables = after.tables.map((row) => {
    const prev = before.tables.find((t) => t.name === row.name);
    const pick = (key: string) => delta(prev, row, key);
    return {
      name: row.name,
      seqScan: pick("seq_scan"),
      seqTupRead: pick("seq_tup_read"),
      idxScan: pick("idx_scan"),
      inserted: pick("n_tup_ins"),
      deleted: pick("n_tup_del"),
      deadTuples: Number(row.n_dead_tup),
      vacuums: pick("vacuums"),
      analyzes: pick("analyzes"),
      heapRead: pick("heap_blks_read"),
      heapHit: pick("heap_blks_hit"),
      idxRead: pick("idx_blks_read"),
      idxHit: pick("idx_blks_hit"),
    };
  });
  const keys = (row: Record<string, number>) => Object.keys(row);
  const diffRow = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(keys(b).map((k) => [k, delta(a, b, k)]));
  return {
    tables,
    database: diffRow(before.database, after.database),
    wal: diffRow(before.wal, after.wal),
    checkpoints: delta(before.checkpointer, after.checkpointer, "num_done"),
    otherCommits: after.otherCommits - before.otherCommits,
    progressAtEnd: after.progress,
  };
}

// 회차·단계가 무효이거나 표시해야 하는 이유(DESIGN 6.8 "무효 조건", seat-booking의 phaseProblems).
export function runProblems(input: {
  dropped: number;
  k6PctMax: number | null;
  k6Cores: number;
  othersPctMean: number | null;
  othersBaseline: number;
  otherCommits: number;
  vacuumOrAnalyze: number;
}) {
  const problems: string[] = [];
  if (input.dropped > 0) problems.push(`버린 반복 ${input.dropped}`);
  if (input.k6PctMax !== null && input.k6PctMax >= 90 * input.k6Cores) problems.push(`k6 CPU 최대 ${input.k6PctMax}%(코어 ${input.k6Cores}개)`);
  if (input.othersPctMean !== null && input.othersPctMean > input.othersBaseline + 100) {
    problems.push(`다른 프로세스 CPU 평균 ${input.othersPctMean}%(측정 전 ${input.othersBaseline}%)`);
  }
  // 측정 중에 쓴 표본기·실행기의 짧은 트랜잭션은 이 DB 것이라 세지 않는다. 다른 DB의 커밋은 다른 일이 같은 서버를 쓴 것이다.
  if (input.otherCommits > 0) problems.push(`다른 DB의 커밋 ${input.otherCommits}`);
  if (input.vacuumOrAnalyze > 0) problems.push(`측정 DB에 vacuum·analyze ${input.vacuumOrAnalyze}`);
  return problems;
}

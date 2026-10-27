import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { withDatabase } from "../db/databases.js";
import { equalWeights, MIX_TIMEZONE, outOfRetention, reportMix, todayIn } from "./mix.js";
import {
  crossesUtcHour,
  diffStats,
  readJsonLines,
  readK6Events,
  runProblems,
  steadyWindow,
  summarizeActivity,
  summarizeApi,
  summarizeCpu,
  summarizeIngest,
  summarizeKinds,
  totalDropped,
  type Window,
} from "./report.js";
import { snapshotStats, startActivitySampler } from "./samplers.js";
import { cloneLoadDatabase, LOAD_DATABASE, loadDatabaseState, RESULTS_DIR, TEMPLATE_INFO_FILE } from "./template.js";

// 부하 측정(DESIGN 6.8). seat-booking 6단계의 실행기를 가져왔다. 회차마다:
//   템플릿 복제(FILE_COPY, 지난 7일 ~ 앞으로 7일의 파티션) → 상태 기록(더러운 시간이 있으면 거절) → API(P코어, LOAD_STATS) → 집계 따라잡기
//   → 앞 통계 → 표본기(DB 0.2초, CPU 1초) → k6(E코어) → 뒤 통계(2초 뒤) → API 닫기 → 요약
// S1은 도착률마다 회차를 새로 돈다(앞 단계가 쌓은 행과 인덱스가 섞이지 않게). S2는 회차 하나다.
// 복제는 소유자로, API·표본기·확인은 앱 role로 한다. 결과는 load/results/runs/<시각>-<이름>/에 쓴다.
//   npm run load:run -w @event-analytics/api -- --scene s1 --rates 10,20,40
//   npm run load:run -w @event-analytics/api -- --scene s2 --n 4 --minutes 20
//   npm run load:run -w @event-analytics/api -- --scene s2open --open-rates r1:6,r2:4 --minutes 20

const { values: args } = parseArgs({
  options: {
    scene: { type: "string" },
    label: { type: "string", default: "run" },
    seed: { type: "string", default: "1" },
    pool: { type: "string" },
    "report-pool": { type: "string" },
    // S1: 초당 배치(200건) 도착률들, 예열·단계 초
    rates: { type: "string" },
    warmup: { type: "string", default: "20" },
    step: { type: "string", default: "60" },
    // S2: 배경 수집(초당 배치), 마케터 수, 정상 구간 분, 몫(weighted·equal), 열린 모형의 분당 도착률과 예열 초
    bg: { type: "string", default: "10" },
    n: { type: "string", default: "4" },
    minutes: { type: "string", default: "20" },
    mix: { type: "string", default: "weighted" },
    "open-rates": { type: "string" },
    "open-warmup": { type: "string", default: "60" },
    // 정상 구간이 UTC 정시를 넘지 않게 기다릴지(S2)
    "no-align": { type: "boolean", default: false },
  },
});

const appUrl = process.env.DATABASE_URL;
if (!appUrl) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
const scene = args.scene;
if (scene !== "s1" && scene !== "s2" && scene !== "s2open") throw new Error("--scene은 s1, s2, s2open 가운데 하나입니다");
if (!existsSync(TEMPLATE_INFO_FILE)) throw new Error("측정 템플릿이 없습니다. npm run load:template -w @event-analytics/api로 만드세요");
const positive = (name: string, value: string | undefined) => {
  const n = Number(value);
  if (!(n > 0)) throw new Error(`--${name}가 없거나 잘못됐습니다`);
  return n;
};

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const apiDir = path.join(repoRoot, "apps/api");
const resultsDir = fileURLToPath(RESULTS_DIR);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const runDir = path.join(resultsDir, "runs", `${stamp}-${args.label}`);
mkdirSync(runDir, { recursive: true });
const PORT = 3202;
const BASE = `http://127.0.0.1:${PORT}`;
const loadAppUrl = withDatabase(appUrl, LOAD_DATABASE);

// 자식에게는 OS가 쓰는 것만 넘긴다(.env의 다른 값이 넘어가지 않게).
const osEnv = () => ({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP });
const powershell = (list: string[]) => execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...list], { encoding: "utf8", env: osEnv() });

// k6는 저장소 밖에 체크섬을 확인한 zip으로 둔다(load/README.md). seat-booking과 같은 것을 쓴다.
const k6Path = process.env.K6 ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs/k6-v2.3.0/k6-v2.3.0-windows-amd64/k6.exe");
const k6Version = execFileSync(k6Path, ["version"], { encoding: "utf8", env: osEnv() });
if (!k6Version.includes("v2.3.0")) throw new Error(`k6 v2.3.0이 아닙니다: ${k6Version}`);

// P코어(효율 등급이 높은 논리 프로세서)에 API를, 나머지(E코어)에 k6를 묶는다. 묶을 수 없는 PC면 묶지 않고 적는다.
function cpuMasks() {
  const sets = powershell(["-File", path.join(repoRoot, "load/cpu-sets.ps1")])
    .trim()
    .split(/\s+/)
    .map((s) => s.split(":").map(Number) as [number, number, number]);
  const top = Math.max(...sets.map(([, , efficiency]) => efficiency));
  const performance = sets.filter(([, , e]) => e === top).map(([logical]) => logical);
  const efficient = sets.filter(([, , e]) => e !== top).map(([logical]) => logical);
  if (efficient.length === 0) return null;
  const mask = (list: number[]) => list.reduce((m, i) => m + 2 ** i, 0);
  return { api: mask(performance), k6: mask(efficient), performance, efficient, logical: sets.length };
}
const setAffinity = (pid: number, mask: number) => powershell(["-Command", `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`]);
const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, seconds: number, check: () => Promise<boolean>, alive: () => boolean = () => true) {
  for (const until = Date.now() + seconds * 1000; Date.now() < until && alive(); ) {
    if (await check().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`${what}을(를) ${seconds}초 안에 마치지 못했습니다`);
}

// 집계 작업이 템플릿의 워터마크에서 지금의 정시까지 따라잡았는지(DESIGN 6.8 "측정 템플릿")
async function caughtUp() {
  const client = new pg.Client({ connectionString: loadAppUrl, application_name: "event-analytics-load-runner" });
  await client.connect();
  try {
    const { rows } = await client.query<{ caught: boolean }>(
      "select watermark >= date_trunc('hour', now(), 'UTC') as caught from rollup_state",
    );
    return rows[0]?.caught === true;
  } finally {
    await client.end();
  }
}

const masks = cpuMasks();
const seed = String(positive("seed", args.seed));
// k6의 도착률은 정수다. 소수를 주면 복제·띄우기까지 거친 뒤에야 k6가 실패하므로 여기서 거절한다(코드 리뷰).
const positiveInt = (name: string, value: string | undefined) => {
  const n = positive(name, value);
  if (!Number.isInteger(n)) throw new Error(`--${name}는 정수입니다: ${value}`);
  return n;
};
// 리포트 묶음. r7의 오늘은 정시 맞추기를 기다린 뒤에 다시 정한다(prepareMix). 날짜를 고정한 종류가 보관 기간 밖이면
// 422만 재게 되므로 멈추고 날짜를 옮기게 한다(DESIGN 6.8).
const mixFile = path.join(runDir, "mix.json");
function prepareMix() {
  const now = new Date();
  const next = (args.mix === "equal" ? equalWeights : (m: ReturnType<typeof reportMix>) => m)(reportMix(todayIn(MIX_TIMEZONE, now)));
  if (scene !== "s1" && outOfRetention(next, now).length > 0) {
    throw new Error(`묶음의 ${outOfRetention(next, now).join(", ")}가 보관 기간 밖입니다. mix.ts의 날짜를 함께 옮기세요`);
  }
  writeFileSync(mixFile, JSON.stringify(next, null, 1));
  return next;
}
let mix = prepareMix();
// 열린 모형의 종류별 분당 도착률(소수 가능, k6에는 시간당 정수로 넘긴다). 키가 묶음에 없으면 그 종류가 조용히 빠지므로 거절한다.
const openRates =
  scene === "s2open"
    ? (args["open-rates"] ?? "")
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const [key, perMinute] = pair.split(":");
          if (!mix.some((k) => k.key === key)) throw new Error(`--open-rates의 ${key}는 묶음에 없습니다`);
          return `${key}:${positive("open-rates", perMinute)}`;
        })
    : [];
if (scene === "s2open" && openRates.length === 0) throw new Error("--open-rates(r1:6,r2:4 … 분당)가 없습니다");

type Cycle = { name: string; vars: Record<string, string>; seconds: number };

// 회차 한 번. 중간에 실패해도 자식 프로세스를 정리하고 모은 것을 돌려준다.
async function runCycle({ name, vars, seconds }: Cycle) {
  const dir = path.join(runDir, name);
  mkdirSync(path.join(dir, "api"), { recursive: true });
  const out: Record<string, unknown> = { name, startedAt: new Date().toISOString() };
  const children: ChildProcess[] = [];
  let activity: Awaited<ReturnType<typeof startActivitySampler>> | null = null;
  let apiPid = -1;
  let othersBaseline: number | null = null;
  try {
    await cloneLoadDatabase(ownerUrl!);
    const before = await loadDatabaseState(loadAppUrl);
    out.stateBefore = before;
    if (before.dirtyHours > 0) throw new Error(`복제본에 더러운 시간이 ${before.dirtyHours}개 있습니다. 템플릿을 다시 만드세요`);

    const apiLog = openSync(path.join(dir, "api/api.log"), "w");
    const api = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: apiDir,
      env: {
        ...osEnv(),
        DATABASE_URL: loadAppUrl,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        INGEST_WRITE_KEY: writeKey,
        LOG_LEVEL: "warn",
        LOAD_STATS: path.join(dir, "api"),
        ...(args.pool ? { DB_POOL_MAX: args.pool } : {}),
        ...(args["report-pool"] ? { REPORT_POOL_MAX: args["report-pool"] } : {}),
      },
      stdio: ["ignore", apiLog, apiLog],
    });
    children.push(api);
    closeSync(apiLog);
    api.on("error", () => undefined);
    apiPid = api.pid ?? -1;
    let apiExited = false;
    void exited(api).then(() => {
      apiExited = true;
    });
    if (masks) setAffinity(apiPid, masks.api);
    await waitFor("API 띄우기", 60, async () => (await fetch(`${BASE}/health`)).status === 200, () => !apiExited);
    await waitFor("집계 따라잡기", 300, caughtUp, () => !apiExited);

    activity = await startActivitySampler(loadAppUrl, path.join(dir, "db-activity.jsonl"));
    children.push(
      spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "load/cpu-sampler.ps1"), "-Out", path.join(dir, "cpu.jsonl")], {
        stdio: "ignore",
        env: osEnv(),
      }),
    );
    // k6를 띄우기 전 6초: 다른 프로세스가 쉴 때 쓰는 CPU의 기준선
    const baseline: Window = { start: Date.now() + 1000, end: Date.now() + 6000 };
    await sleep(6500);
    const statsBefore = await snapshotStats(loadAppUrl);

    const k6Out = openSync(path.join(dir, "k6.txt"), "w");
    const k6 = spawn(
      k6Path,
      [
        "run",
        "--log-format=json",
        `--log-output=file=${path.join(dir, "k6-log.jsonl")}`,
        ...Object.entries({ BASE_URL: BASE, OUT_DIR: dir.replace(/\\/g, "/"), SEED: seed, MIX_FILE: mixFile.replace(/\\/g, "/"), ...vars }).flatMap(
          ([key, value]) => ["-e", `${key}=${value}`],
        ),
        path.join(repoRoot, "load/k6/main.js"),
      ],
      {
        // 쓰기 키는 명령줄(-e)이 아니라 환경으로 준다(k6의 __ENV는 프로세스 환경도 담는다)
        env: {
          ...osEnv(),
          USERPROFILE: process.env.USERPROFILE,
          APPDATA: process.env.APPDATA,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          INGEST_KEY: writeKey,
          ...(masks ? { GOMAXPROCS: String(masks.efficient.length) } : {}),
        },
        stdio: ["ignore", k6Out, k6Out],
      },
    );
    children.push(k6);
    closeSync(k6Out);
    if (masks) setAffinity(k6.pid!, masks.k6);
    const k6Code = await Promise.race([exited(k6), (async () => {
      while (!apiExited) await sleep(500);
      return "api-exited" as const;
    })()]);
    if (k6Code === "api-exited") throw new Error("측정 중에 API가 끝났습니다(api/api.log)");
    out.k6Exit = k6Code;
    // API를 먼저 닫는다: 백엔드는 끝날 때 남은 누적 통계를 바로 내보낸다. 쉬는 연결은 10초마다라, 기다려 읽으면 마지막 1초쯤이 빠진다(코드 리뷰).
    api.kill();
    await exited(api);
    await sleep(1500);
    const statsAfter = await snapshotStats(loadAppUrl);
    out.stateAfter = await loadDatabaseState(loadAppUrl);
    out.stats = diffStats(statsBefore, statsAfter);
    const cpuLines = readJsonLines<Parameters<typeof summarizeCpu>[0][number]>(path.join(dir, "cpu.jsonl"));
    othersBaseline = summarizeCpu(cpuLines, baseline, apiPid, masks?.logical ?? 20).othersPctMean;
    out.othersCpuBaseline = othersBaseline;
    // k6가 죽으면(OOM, panic) 로그가 중간에서 끊겨도 표가 만들어진다. 0이 아니면 실패로 한다(seat-booking과 같음).
    if (k6Code !== 0) throw new Error(`k6가 코드 ${k6Code}로 끝났습니다(k6.txt)`);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await activity?.stop().catch(() => undefined);
  }
  return { dir, out, apiPid, othersBaseline, seconds };
}

const writeKey = randomBytes(32).toString("hex");
const report: Record<string, unknown> = {
  label: args.label,
  scene,
  startedAt: new Date().toISOString(),
  args,
  template: JSON.parse(readFileSync(TEMPLATE_INFO_FILE, "utf8")),
  mix: mix.map(({ key, name, weight }) => ({ key, name, weight })),
  pinned: masks ? { api: masks.performance, k6: masks.efficient } : "묶지 않음(코어 종류가 하나)",
};
const lines: string[] = [`# ${args.label}(${scene}, ${report.startedAt})`, ""];

// 회차 결과를 정상 구간으로 요약한다
type Summary = {
  [key: string]: unknown;
  error?: string;
  window?: { start: string; end: string; crossesUtcHour: boolean };
  ingest?: ReturnType<typeof summarizeIngest> | null;
  cpu?: ReturnType<typeof summarizeCpu>;
  problems: string[];
};
// windowError: 구간을 정하지 못한 까닭. clipEnd: API·CPU·DB 표본을 자를 끝(시나리오 끝, VU가 줄어드는 꼬리를 빼려고).
// checkpointsInvalid: S1은 단계에 든 체크포인트를 무효로(꺾이는 점이 낮게 나온다), S2는 개수만 적는다. requestedSeconds: 정상 구간의 요청 길이.
function summarize(
  cycle: Awaited<ReturnType<typeof runCycle>>,
  window: Window | null,
  ingestScenario: string,
  ingestSeconds: number,
  options: { windowError?: string; clipEnd?: number | null; checkpointsInvalid: boolean; requestedSeconds?: number },
): Summary {
  const { dir, out, apiPid, othersBaseline } = cycle;
  const error = typeof out.error === "string" ? out.error : undefined;
  if (!window) return { ...out, error: error ?? options.windowError ?? "정상 구간을 정하지 못했습니다", problems: [] };
  const sampled = { start: window.start, end: options.clipEnd ? Math.min(window.end, options.clipEnd) : window.end };
  const ticks = readJsonLines<Parameters<typeof summarizeApi>[0][number]>(path.join(dir, "api/api-stats.jsonl"));
  const cpu = summarizeCpu(readJsonLines(path.join(dir, "cpu.jsonl")), sampled, apiPid, masks?.logical ?? 20);
  const summaryFile = path.join(dir, "k6-summary.json");
  const k6Summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null;
  const ingest = k6Summary ? summarizeIngest(k6Summary, ingestScenario, ingestSeconds) : null;
  const stats = out.stats as ReturnType<typeof diffStats> | undefined;
  const vacuumOrAnalyze = (stats?.tables.reduce((a, t) => a + t.vacuums + t.analyzes, 0) ?? 0) + (stats ? stats.progressAtEnd.vacuums + stats.progressAtEnd.analyzes : 0);
  return {
    ...out,
    ...(error ? { error } : {}),
    window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString(), crossesUtcHour: crossesUtcHour(window) },
    ingest,
    api: summarizeApi(ticks, sampled),
    cpu,
    activity: summarizeActivity(readJsonLines(path.join(dir, "db-activity.jsonl")), sampled),
    problems: runProblems({
      dropped: totalDropped(k6Summary),
      k6PctMax: cpu.k6PctMax,
      k6Cores: masks?.efficient.length ?? 20,
      othersPctMean: cpu.othersPctMean,
      othersBaseline,
      otherCommits: stats?.otherCommits ?? 0,
      databasesChanged: stats?.databasesChanged ?? [],
      vacuumOrAnalyze,
      ...(options.checkpointsInvalid ? { checkpoints: stats?.checkpoints ?? 0 } : {}),
      ...(options.requestedSeconds ? { steady: { seconds: (window.end - window.start) / 1000, requested: options.requestedSeconds } } : {}),
    }),
  };
}

const startOf = (dir: string) => {
  const start = readK6Events(path.join(dir, "k6-log.jsonl")).find((e) => (e as { ev: string }).ev === "start") as { at: number } | undefined;
  return start?.at ?? null;
};

if (scene === "s1") {
  const rates = (args.rates ?? "").split(",").filter(Boolean).map((r) => positiveInt("rates", r));
  if (rates.length === 0) throw new Error("--rates(초당 배치, 쉼표로)가 없습니다");
  const warmup = positiveInt("warmup", args.warmup);
  const step = positiveInt("step", args.step);
  const cycles = [];
  for (const rate of rates) {
    const cycle = await runCycle({
      name: `s1-${rate}`,
      vars: { SCENE: "s1", INGEST_RATE: String(rate), INGEST_WARMUP_S: String(warmup), INGEST_STEP_S: String(step) },
      seconds: warmup + step,
    });
    const start = startOf(cycle.dir);
    const window = start ? { start: start + warmup * 1000, end: start + (warmup + step) * 1000 } : null;
    const summary = summarize(cycle, window, "s1_step", step, { windowError: "k6가 시작하지 않았습니다(k6.txt)", checkpointsInvalid: true });
    cycles.push({ rate, eventsPerSecond: rate * 200, ...summary });
    const ingest = summary.ingest ?? null;
    lines.push(
      `- 초당 ${rate}배치(${(rate * 200).toLocaleString()}건): ` +
        (ingest
          ? `실제 ${ingest.achievedPerSecond}배치/초, p50 ${ingest.p50?.toFixed(1)}ms, p95 ${ingest.p95?.toFixed(1)}ms, 버린 반복 ${ingest.dropped}, ` +
            `오류 ${ingest.errors}, 중복 ${ingest.duplicates}, 거절 ${ingest.rejected}`
          : "k6 요약 없음") +
        ` | API CPU ${summary.cpu?.apiPctMean ?? "-"}%, postgres ${summary.cpu?.postgresPctMean ?? "-"}%` +
        (summary.window?.crossesUtcHour ? " | UTC 정시를 넘음(정시 집계가 섞임)" : "") +
        (summary.problems.length ? ` | 무효: ${summary.problems.join(", ")}` : "") +
        (summary.error ? ` | 실패: ${summary.error}` : ""),
    );
  }
  report.cycles = cycles;
} else {
  const minutes = positive("minutes", args.minutes);
  const steadySeconds = minutes * 60;
  const bg = positiveInt("bg", args.bg);
  const vus = positiveInt("n", args.n);
  // 닫힌 모형은 예열(VU마다 묶음 한 바퀴)을 넣어 2분 더, 열린 모형은 예열 초만큼 더 돈다
  const openWarmup = positiveInt("open-warmup", args["open-warmup"]);
  const reportSeconds = steadySeconds + (scene === "s2" ? 120 : openWarmup);
  // 정상 구간이 UTC 정시를 넘지 않게: 준비(복제·띄우기·따라잡기 약 2분)와 장면이 이번 시간 안에 들지 않으면 다음 정시 1분 뒤까지 기다린다
  if (!args["no-align"]) {
    const need = (reportSeconds + 180) * 1000;
    const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    if (nextHour - Date.now() < need) {
      const wait = nextHour - Date.now() + 60_000;
      if (need > 3_600_000) throw new Error("장면이 한 시간보다 길어 정시를 피할 수 없습니다(--no-align)");
      console.log(`정상 구간이 UTC 정시를 넘지 않게 ${Math.round(wait / 60_000)}분 기다립니다`);
      await sleep(wait);
      // 기다리는 사이 날(리포트 시간대)이 바뀌었을 수 있어 r7의 오늘을 다시 정한다(코드 리뷰)
      mix = prepareMix();
    }
  }
  const vars: Record<string, string> = { SCENE: scene, BG_RATE: String(bg), REPORT_S: String(reportSeconds) };
  if (scene === "s2") vars.N = String(vus);
  else vars.OPEN_RATES = openRates.join(",");
  const cycle = await runCycle({ name: scene, vars, seconds: reportSeconds });
  const events = readK6Events(path.join(cycle.dir, "k6-log.jsonl"));
  const reportEvents = events.filter((e) => e.ev === "report").length;
  const window = steadyWindow(events, scene === "s2" ? { vus } : { openWarmupMs: openWarmup * 1000 });
  const start = startOf(cycle.dir);
  const summary = summarize(cycle, window, "background", reportSeconds + 30, {
    windowError: reportEvents === 0 ? "리포트 요청이 하나도 없습니다(k6.txt, k6-log.jsonl)" : "정상 구간을 정하지 못했습니다(예열을 마치지 못한 VU)",
    clipEnd: start ? start + reportSeconds * 1000 : null,
    checkpointsInvalid: false,
    requestedSeconds: steadySeconds,
  });
  const kinds = window ? summarizeKinds(events, window, mix.map((k) => k.key)) : null;
  report.cycles = [{ ...summary, kinds }];
  if (summary.error) lines.push(`실패: ${summary.error}`, "");
  const w = summary.window;
  const stats = summary.stats as ReturnType<typeof diffStats> | undefined;
  if (w) {
    lines.push(
      `정상 구간 ${w.start} ~ ${w.end}${w.crossesUtcHour ? "(UTC 정시를 넘음: 집계 바퀴를 함께 본다)" : ""}, 체크포인트 ${stats?.checkpoints ?? "-"}`,
    );
  }
  if (summary.problems.length) lines.push(`무효: ${summary.problems.join(", ")}`);
  if (kinds) {
    lines.push("", "| 종류 | 요청 | 성공 p50 | 성공 p95 | 503 비율 | 503까지 | 풀 대기 합 | 실행 합 | 기다린 시간의 몫 |", "|---|---|---|---|---|---|---|---|---|");
    for (const k of kinds.kinds) {
      lines.push(
        `| ${k.key} ${mix.find((m) => m.key === k.key)?.name ?? ""} | ${k.n} | ${k.p50 ?? "-"}ms | ${k.overLimit ? "한도 이상" : `${k.p95 ?? "-"}ms`} | ${(k.rate503 * 100).toFixed(1)}% | ` +
          `${k.mean503Ms ?? "-"}ms | ${(k.poolMs / 1000).toFixed(1)}초 | ${(k.ownMs / 1000).toFixed(1)}초 | ${(k.share * 100).toFixed(1)}% |`,
      );
    }
  }
  const ingest = summary.ingest ?? null;
  if (ingest) lines.push("", `배경 수집: ${ingest.achievedPerSecond}배치/초, p95 ${ingest.p95?.toFixed(1)}ms, 오류 ${ingest.errors}, 버린 반복 ${ingest.dropped}`);
}

writeFileSync(path.join(runDir, "run.json"), JSON.stringify(report, null, 1));
writeFileSync(path.join(runDir, "summary.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`결과: ${runDir}`);
const failed = (report.cycles as { error?: string }[]).some((c) => c.error);
if (failed) process.exitCode = 1;

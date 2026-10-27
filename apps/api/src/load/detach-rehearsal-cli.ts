import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { IngestEvent } from "@event-analytics/shared";
import pg from "pg";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { addDays, listPartitions, maintain, partitionName } from "../db/partitions.js";
import { generate } from "./generate.js";

// 떼기 리허설(합격 기준 A4, DESIGN 6.2). 개발 DB를 복제한 DB에 API를 띄우고 수집을 일정한 속도로 보내는 동안,
// 오래 도는 리포트를 하나 걸어 두고 가장 오래된 파티션을 뗀다. 기준선(떼지 않음), 관리 작업(CONCURRENTLY), 일반 DETACH를 같은 장면에서 견준다.
//   npm run load:detach-rehearsal -w @event-analytics/api
const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "40" },
    rate: { type: "string", default: "2000" },
    batch: { type: "string", default: "200" },
    "report-seconds": { type: "string", default: "20" },
    port: { type: "string", default: "3093" },
  },
});
const seconds = Number(values.seconds);
const rate = Number(values.rate);
const batch = Number(values.batch);
const reportSeconds = Number(values["report-seconds"]);
const port = Number(values.port);

const ownerUrl = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.DATABASE_URL;
const writeKey = process.env.INGEST_WRITE_KEY;
if (!ownerUrl || !appUrl || !writeKey) throw new Error("DATABASE_OWNER_URL, DATABASE_URL, INGEST_WRITE_KEY가 있어야 합니다(.env)");
const source = new URL(ownerUrl).pathname.slice(1);
const prefix = `${source}_rehearsal_`;
const apiRoot = fileURLToPath(new URL("../..", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// cause: 503의 원인. 수집 API는 파티션 없음을 partition_missing으로, 잠금·교착·시간 초과와 풀 연결 대기 초과를 busy로 준다.
// busy 둘은 문장으로 가린다("연결을 얻지 못했습니다" → pool, 그 밖 → db).
type Sample = { at: number; ms: number; status: number; cause?: "db" | "pool" | "partition" };
type Scenario = "baseline" | "concurrently" | "plain";

async function connect(url: string) {
  const client = new pg.Client({ connectionString: url, options: "-c TimeZone=UTC" });
  client.on("error", () => {});
  await client.connect();
  return client;
}

// 지난 실행이 남긴 복제 DB를 지운다(강제 종료되면 finally가 돌지 않는다).
async function dropLeftovers() {
  await withAdminClient(ownerUrl!, async (client) => {
    const { rows } = await client.query<{ name: string }>("select datname as name from pg_database where starts_with(datname, $1)", [prefix]);
    for (const { name } of rows) await dropDatabase(client, name);
  });
}

// 서버는 따로 띄운다(보내는 쪽과 이벤트 루프를 나눠 지연을 재려고). 소유자 주소는 넘기지 않는다.
// 포트를 다른 프로세스가 쓰고 있으면 그것을 재게 되므로 먼저 확인하고, 띄운 서버가 죽으면 바로 실패한다.
async function startServer(database: string): Promise<ChildProcess> {
  const taken = await fetch(`http://127.0.0.1:${port}/health`).then(
    () => true,
    () => false,
  );
  if (taken) throw new Error(`${port}번 포트를 이미 다른 프로세스가 씁니다`);
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: withDatabase(appUrl!, database), PORT: String(port) };
  delete env.DATABASE_OWNER_URL;
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: apiRoot, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`API가 끝났습니다: ${stderr.slice(0, 500)}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
    } catch {}
    await sleep(100);
  }
  child.kill();
  throw new Error("API가 뜨지 않았습니다");
}

// 보낼 배치를 미리 만든다(보내는 중에 만들면 그만큼 보내기가 밀린다). 받을 기간 안의 시각이다.
function prepareBatches(start: number) {
  const count = Math.ceil((seconds * rate) / batch);
  const from = new Date(start - 5 * 60_000);
  const to = new Date(start);
  return Array.from({ length: count }, (_, i) => [...generate({ seed: 10_000 + i, events: batch, from, to })]);
}

// 열린 모형: 앞 요청이 끝나길 기다리지 않고 정해진 간격으로 보낸다(막힌 동안 보내는 양이 줄어 지연이 가려지지 않게).
async function sendLoad(t0: number, batches: IngestEvent[][], samples: Sample[]) {
  const interval = (1000 * batch) / rate;
  const inFlight: Promise<void>[] = [];
  for (let i = 0; i < batches.length && Date.now() - t0 < seconds * 1000; i++) {
    const started = performance.now();
    const at = Date.now() - t0;
    inFlight.push(
      fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-write-key": writeKey! },
        body: JSON.stringify({ events: batches[i] }),
      }).then(
        async (res) => {
          const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
          const cause =
            res.status !== 503 ? undefined : body.code === "partition_missing" ? "partition" : body.error?.includes("연결") ? "pool" : "db";
          samples.push({ at, ms: performance.now() - started, status: res.status, ...(cause ? { cause } : {}) });
        },
        () => {
          samples.push({ at, ms: performance.now() - started, status: 0 });
        },
      ),
    );
    await sleep(Math.max(0, t0 + (i + 1) * interval - Date.now()));
  }
  await Promise.all(inFlight);
}

// 가장 가까운 순위(nearest-rank) 백분위.
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
function summarize(samples: Sample[]) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const status: Record<string, number> = {};
  const causes: Record<string, number> = {};
  for (const s of samples) {
    status[s.status] = (status[s.status] ?? 0) + 1;
    if (s.cause) causes[s.cause] = (causes[s.cause] ?? 0) + 1;
  }
  return { requests: samples.length, status, causes, p50: percentile(ms, 50), p99: percentile(ms, 99), max: ms.at(-1) ?? 0 };
}

async function runScenario(scenario: Scenario) {
  const database = `${prefix}${process.pid}`;
  await withAdminClient(ownerUrl!, async (client) => {
    await dropDatabase(client, database);
    const started = performance.now();
    await client.query(`CREATE DATABASE ${database} TEMPLATE ${source}`);
    console.log(`[${scenario}] 복제 ${((performance.now() - started) / 1000).toFixed(1)}초`);
  });
  let server: ChildProcess | undefined;
  const clients: pg.Client[] = [];
  try {
    const owner = await connect(withDatabase(ownerUrl!, database));
    const reporter = await connect(withDatabase(appUrl!, database));
    clients.push(owner, reporter);
    const oldest = (await listPartitions(owner)).map((p) => p.day).sort()[0]!;
    const target = partitionName(oldest);
    server = await startServer(database);
    const batches = prepareBatches(Date.now());

    const samples: Sample[] = [];
    const t0 = Date.now();
    const load = sendLoad(t0, batches, samples);
    const marks: Record<string, number> = {};
    // 5초에 오래 도는 리포트: 모든 파티션을 읽고 트랜잭션을 연 채 기다린다
    await sleep(5_000);
    marks.reportStart = Date.now() - t0;
    const report = (async () => {
      await reporter.query("begin");
      await reporter.query("select count(*) from events");
      await reporter.query("select pg_sleep($1)", [reportSeconds]);
      await reporter.query("commit");
      marks.reportEnd = Date.now() - t0;
    })();
    // 떼기가 실패해 finally가 연결을 닫으면 이 약속이 거절된다. 처리되지 않은 거절로 프로세스가 죽어 복제 DB가 남지 않게 미리 붙잡는다.
    report.catch(() => {});
    await sleep(3_000);
    // 떼기 구간: 이 시각부터 떼기(관리 작업 전체 또는 DETACH + DROP)가 끝날 때까지. 기준선은 리포트가 끝날 때까지.
    marks.detachStart = Date.now() - t0;
    let maintainResult;
    if (scenario === "baseline") {
      await report;
    } else if (scenario === "concurrently") {
      // oldest가 보관 기간(90일)을 하루 넘은 날로 관리 작업을 돌린다. 그 날만 뗀다.
      maintainResult = await maintain(owner, { today: addDays(oldest, 91) });
      if (maintainResult.errors.length > 0 || !maintainResult.dropped.includes(target)) {
        throw new Error(`관리 작업이 ${target}을 떼지 못했습니다: ${JSON.stringify(maintainResult)}`);
      }
    } else {
      // 잠금 대기 한도 없이 뗀다. 한도를 짧게 두면 떼기가 먼저 포기해 수집은 덜 다친다(DESIGN 6.2)
      await owner.query("set lock_timeout = 0");
      await owner.query(`ALTER TABLE events DETACH PARTITION ${target}`);
      await owner.query(`DROP TABLE ${target}`);
    }
    marks.detachEnd = Date.now() - t0;
    await Promise.all([report, load]);

    // 뗐는지는 DB에 직접 묻는다(DESIGN 3장)
    const { rows } = await owner.query<{ gone: boolean }>("select to_regclass($1) is null as gone", [target]);
    const detached = rows[0]!.gone;
    if (scenario !== "baseline" && !detached) throw new Error(`${target}이 남아 있습니다`);
    const during = samples.filter((s) => s.at >= marks.detachStart! && s.at < marks.detachEnd!);
    return { scenario, target, detached, maintainResult, marks, all: summarize(samples), duringDetach: summarize(during) };
  } finally {
    server?.kill();
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
    await sleep(500);
    await withAdminClient(ownerUrl!, (client) => dropDatabase(client, database));
  }
}

// Ctrl+C로 멈춰도 띄운 서버와 복제 DB를 남기지 않는다. 다음 실행도 시작할 때 남은 복제 DB를 지운다.
let stopping = false;
process.once("SIGINT", () => {
  if (stopping) return;
  stopping = true;
  void dropLeftovers().finally(() => process.exit(130));
});

await dropLeftovers();
const results = [];
for (const scenario of ["baseline", "concurrently", "plain"] as const) {
  const r = await runScenario(scenario);
  console.log(JSON.stringify(r));
  results.push(r);
}
const dir = fileURLToPath(new URL("../../../../load/results/", import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}detach-${new Date().toISOString().replaceAll(":", "-")}.json`;
writeFileSync(file, JSON.stringify({ seconds, rate, batch, reportSeconds, results }, null, 2));
console.log(`결과: ${file}`);

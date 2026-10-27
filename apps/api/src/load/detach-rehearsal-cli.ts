import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { dropDatabase, withAdminClient, withDatabase } from "../db/databases.js";
import { addDays, listPartitions, maintain } from "../db/partitions.js";
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
const apiRoot = fileURLToPath(new URL("../..", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// cause: 503의 원인. 수집 API는 잠금·교착·시간 초과와 풀 연결 대기 초과를 모두 busy로 주고 문장으로 가린다.
type Sample = { at: number; ms: number; status: number; cause?: "lock" | "pool" };
type Scenario = "baseline" | "concurrently" | "plain";

async function connect(url: string) {
  const client = new pg.Client({ connectionString: url, options: "-c TimeZone=UTC" });
  client.on("error", () => {});
  await client.connect();
  return client;
}

// 서버는 따로 띄운다(보내는 쪽과 이벤트 루프를 나눠 지연을 재려고). 소유자 주소는 넘기지 않는다.
async function startServer(database: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: withDatabase(appUrl!, database), PORT: String(port) };
  delete env.DATABASE_OWNER_URL;
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: apiRoot, env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
    } catch {}
    await sleep(100);
  }
  child.kill();
  throw new Error("API가 뜨지 않았습니다");
}

// 열린 모형: 앞 요청이 끝나길 기다리지 않고 정해진 간격으로 보낸다(막힌 동안 보내는 양이 줄어 지연이 가려지지 않게).
async function sendLoad(t0: number, samples: Sample[]) {
  const interval = (1000 * batch) / rate;
  const inFlight: Promise<void>[] = [];
  for (let i = 0; Date.now() - t0 < seconds * 1000; i++) {
    const now = Date.now();
    const events = [...generate({ seed: 10_000 + i, events: batch, from: new Date(now - 5 * 60_000), to: new Date(now) })];
    const started = performance.now();
    const at = Date.now() - t0;
    inFlight.push(
      fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-write-key": writeKey! },
        body: JSON.stringify({ events }),
      }).then(
        async (res) => {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          const cause = res.status === 503 ? (body.error?.includes("연결") ? "pool" : "lock") : undefined;
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

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
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
  const database = `${source}_rehearsal_${process.pid}`;
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
    server = await startServer(database);

    const samples: Sample[] = [];
    const t0 = Date.now();
    const load = sendLoad(t0, samples);
    const marks: Record<string, number> = {};
    // 5초에 오래 도는 리포트: 모든 파티션을 읽고 트랜잭션을 연 채 기다린다(그 파티션들을 본 스냅샷이 남는다)
    await sleep(5_000);
    marks.reportStart = Date.now() - t0;
    const report = (async () => {
      await reporter.query("begin");
      await reporter.query("select count(*) from events");
      await reporter.query("select pg_sleep($1)", [reportSeconds]);
      await reporter.query("commit");
      marks.reportEnd = Date.now() - t0;
    })();
    await sleep(3_000);
    marks.detachStart = Date.now() - t0;
    if (scenario === "baseline") {
      // 떼지 않는다. 리포트가 끝날 때까지를 같은 구간으로 본다
      await report;
    } else if (scenario === "concurrently") {
      // oldest가 보관 기간(90일)을 하루 넘은 날로 관리 작업을 돌린다. 그 날만 뗀다.
      const result = await maintain(owner, { today: addDays(oldest, 91) });
      console.log(`[${scenario}] 관리 작업`, JSON.stringify(result));
    } else {
      // 잠금 대기 한도 없이 뗀다. 한도를 짧게 두면 떼기가 먼저 포기해 수집은 덜 다친다(DESIGN 6.2)
      await owner.query("set lock_timeout = 0");
      await owner.query(`ALTER TABLE events DETACH PARTITION events_p${oldest.replaceAll("-", "")}`);
      await owner.query(`DROP TABLE events_p${oldest.replaceAll("-", "")}`);
    }
    marks.detachEnd = Date.now() - t0;
    await Promise.all([report, load]);

    const during = samples.filter((s) => s.at >= marks.detachStart! && s.at < marks.detachEnd!);
    return { scenario, oldest, marks, all: summarize(samples), duringDetach: summarize(during) };
  } finally {
    server?.kill();
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
    await sleep(500);
    await withAdminClient(ownerUrl!, (client) => dropDatabase(client, database));
  }
}

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

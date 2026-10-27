export { ingest } from "./ingest.js";
export { reportsClosed, reportsOpen } from "./reports.js";

// 부하 장면의 입구(DESIGN 6.8). 실행기(run-cli.ts)가 환경 변수로 무엇을 얼마나 돌릴지 정한다.
// SCENE=s1:      수집만. INGEST_RATE(초당 배치) 하나를 INGEST_WARMUP_S 예열 뒤 INGEST_STEP_S 동안(단계마다 실행기가 새로 복제한다).
// SCENE=s2:      배경 수집(BG_RATE 초당 배치) + 닫힌 모형 리포트(N명, REPORT_S초). 예열은 VU마다 묶음 한 바퀴다(reports.js).
// SCENE=s2open:  배경 수집 + 열린 모형 리포트(OPEN_RATES "r1:6,r2:4,…" 분당 도착률, REPORT_S초).

const scene = __ENV.SCENE;
const num = (name, fallback) => {
  const value = Number(__ENV[name] ?? fallback);
  if (!(value > 0)) throw new Error(`${name}가 없거나 잘못됐습니다`);
  return value;
};

const scenarios = {};
const thresholds = {};
// 요약에 시나리오별 숫자가 나오게 하위 지표마다 threshold를 건다(값은 늘 통과)
const surface = (metric, kind = "count") => {
  thresholds[metric] = [kind === "count" ? "count>=0" : "max>=0"];
};

// 배치 하나가 걸리는 시간의 어림(초). 미리 만들어 둘 VU 수를 정한다.
const INGEST_SECONDS = 0.1;
function ingestScenario(name, rate, seconds, startTime) {
  const maxVUs = Math.min(2000, Math.ceil(rate * INGEST_SECONDS * 10) + 50);
  scenarios[name] = {
    executor: "constant-arrival-rate",
    exec: "ingest",
    rate,
    timeUnit: "1s",
    duration: `${seconds}s`,
    startTime: `${startTime}s`,
    preAllocatedVUs: Math.min(maxVUs, Math.ceil(rate * INGEST_SECONDS * 2) + 10),
    maxVUs,
    gracefulStop: "30s",
  };
  surface(`http_reqs{scenario:${name}}`);
  surface(`http_req_duration{scenario:${name}}`, "trend");
  surface(`dropped_iterations{scenario:${name}}`);
  surface(`ingest_errors{scenario:${name}}`);
  surface(`ingest_duplicates{scenario:${name}}`);
  surface(`ingest_rejected{scenario:${name}}`);
}

if (scene === "s1") {
  const rate = num("INGEST_RATE");
  const warmup = num("INGEST_WARMUP_S", 20);
  const step = num("INGEST_STEP_S", 60);
  ingestScenario("s1_warmup", rate, warmup, 0);
  ingestScenario("s1_step", rate, step, warmup);
} else if (scene === "s2" || scene === "s2open") {
  const reportSeconds = num("REPORT_S");
  // 배경 수집은 리포트 내내 돈다(리포트가 끝나는 것을 기다리지 않게 조금 더 길게)
  ingestScenario("background", num("BG_RATE", 10), reportSeconds + 30, 0);
  if (scene === "s2") {
    scenarios.reports = { executor: "constant-vus", exec: "reportsClosed", vus: num("N"), duration: `${reportSeconds}s`, gracefulStop: "70s" };
  } else {
    for (const pair of (__ENV.OPEN_RATES || "").split(",").filter(Boolean)) {
      const [kind, perMinute] = pair.split(":");
      const rate = Number(perMinute);
      if (!kind || !(rate > 0)) throw new Error(`OPEN_RATES가 잘못됐습니다: ${pair}`);
      scenarios[`open_${kind}`] = {
        executor: "constant-arrival-rate",
        exec: "reportsOpen",
        rate,
        timeUnit: "1m",
        duration: `${reportSeconds}s`,
        preAllocatedVUs: 4,
        maxVUs: 40,
        gracefulStop: "70s",
        env: { KIND: kind },
      };
      surface(`dropped_iterations{scenario:open_${kind}}`);
    }
  }
} else {
  throw new Error(`SCENE은 s1, s2, s2open 가운데 하나입니다: ${scene}`);
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max", "count"],
};

// 시나리오가 시작하는 시각(실행기가 S1의 예열·단계 구간을 이 시각에서 센다)
export function setup() {
  console.log(JSON.stringify({ ev: "start", at: Date.now() }));
}

export function handleSummary(data) {
  const out = __ENV.OUT_DIR;
  const lines = [];
  for (const name of Object.keys(scenarios)) {
    const duration = data.metrics[`http_req_duration{scenario:${name}}`];
    const reqs = data.metrics[`http_reqs{scenario:${name}}`];
    const dropped = data.metrics[`dropped_iterations{scenario:${name}}`];
    if (!duration || !duration.values.count) continue;
    lines.push(
      `${name}: 요청 ${reqs ? reqs.values.count : 0}, p50 ${duration.values.med.toFixed(1)}ms, ` +
        `p95 ${duration.values["p(95)"].toFixed(1)}ms, 버린 반복 ${dropped ? dropped.values.count : 0}`,
    );
  }
  const result = { stdout: `${lines.join("\n")}\n` };
  if (out) result[`${out}/k6-summary.json`] = JSON.stringify(data, null, 1);
  return result;
}

import { sleep } from "k6";
import http from "k6/http";
import { BASE, errorCode, poolWaitMs, rng, SEED } from "./lib.js";

// 리포트 묶음(DESIGN 6.8 S2). 실행기가 날짜를 채운 묶음(mix.json)을 MIX_FILE로 준다.
// 요청마다 한 줄(ev: report)을 로그로 남긴다: 종류, 예열인지, 시작 시각, 걸린 시간, 상태, code, 풀 대기(Server-Timing).
// 실행기가 이 줄로 종류별 p95·503·기다린 시간의 몫을 낸다(k6 요약은 버킷이 거칠고 503을 따로 다루기 어렵다).

const MIX = JSON.parse(open(__ENV.MIX_FILE));
const THINK_MEAN_S = Number(__ENV.THINK_MEAN_S || 3);

function send(kind, warm) {
  const startedAt = Date.now();
  const res = http.post(`${BASE}${kind.path}`, JSON.stringify(kind.body), {
    headers: { "content-type": "application/json" },
    tags: { name: kind.key },
    // 서버의 한도(풀 대기 5초 + 문장 30초)보다 길게: k6가 먼저 끊어 가장 느린 요청이 빠지지 않게
    timeout: "60s",
  });
  console.log(
    JSON.stringify({
      ev: "report",
      vu: __VU,
      key: kind.key,
      warm,
      startedAt,
      ms: res.timings.duration,
      status: res.status,
      code: res.status >= 400 || res.status === 0 ? errorCode(res) : null,
      poolMs: poolWaitMs(res),
    }),
  );
}

// 닫힌 모형: 마케터 한 명(VU)이 결과를 보고 생각한 뒤 다음을 고른다.
// VU마다 시작 시각·순서·생각 시간을 씨앗으로 섞는다(같은 박자로 같은 리포트를 한꺼번에 부르지 않게).
// 예열: VU마다 묶음의 모든 종류를 한 번씩(섞은 순서로) 돈 뒤 끝난다. 끝나면 ev: warmed를 남긴다.
const random = rng(SEED * 104729 + __VU);
const weightTotal = MIX.reduce((sum, k) => sum + k.weight, 0);
function pick() {
  let r = random() * weightTotal;
  for (const kind of MIX) {
    r -= kind.weight;
    if (r < 0) return kind;
  }
  return MIX[MIX.length - 1];
}
const think = () => Math.min(15, -Math.log(1 - random()) * THINK_MEAN_S);
let warmQueue = null;

export function reportsClosed() {
  if (warmQueue === null) {
    // 처음: 시작을 0~3초 흩고, 예열 순서를 섞는다
    sleep(random() * 3);
    warmQueue = MIX.slice();
    for (let i = warmQueue.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [warmQueue[i], warmQueue[j]] = [warmQueue[j], warmQueue[i]];
    }
  }
  if (warmQueue.length > 0) {
    send(warmQueue.shift(), true);
    if (warmQueue.length === 0) console.log(JSON.stringify({ ev: "warmed", vu: __VU, at: Date.now() }));
  } else {
    send(pick(), false);
  }
  sleep(think());
}

// 열린 모형(고치기 전후 확인): 종류마다 정한 도착률로 보낸다. 실행기가 종류마다 시나리오를 만들고 KIND로 알려 준다.
export function reportsOpen() {
  const kind = MIX.find((k) => k.key === __ENV.KIND);
  send(kind, false);
}

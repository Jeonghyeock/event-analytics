// 부하 장면이 함께 쓰는 것(DESIGN 6.8 "장면"). 실행기(run-cli.ts)가 환경 변수로 주소·씨앗·키를 넘긴다.
// 쓰기 키(INGEST_KEY)는 명령줄(-e)이 아니라 프로세스 환경으로 받는다(k6의 __ENV는 프로세스 환경도 담는다).

export const BASE = __ENV.BASE_URL || "http://127.0.0.1:3202";
export const SEED = Number(__ENV.SEED || 1);

// 씨앗을 받는 작은 난수(mulberry32). k6의 Math.random은 씨앗을 줄 수 없어, VU마다 같은 순서를 다시 만들려고 쓴다.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 32비트 해시(FNV-1a의 변형). event_id의 앞 8글자를 흩어 인덱스의 무작위 자리에 가게 한다(v4와 같은 분포).
function hash32(a, b, c, d) {
  let h = 0x811c9dc5 ^ SEED;
  for (const x of [a, b, c, d]) {
    h = Math.imul(h ^ (x & 0xffff), 0x01000193);
    h = Math.imul(h ^ (x >>> 16), 0x01000193);
  }
  return h >>> 0;
}
const hex = (n, width) => (n >>> 0).toString(16).padStart(width, "0").slice(-width);
const RUN_TAG = hex(Math.imul(SEED, 0x9e3779b1), 8);

// UUID 모양의 event_id. 앞 8글자는 해시(인덱스에서 무작위 자리), 나머지는 VU·반복·순번이라 한 회차 안에서 겹치지 않는다.
// 무작위 v4를 VU마다 만드는 것보다 싸다(k6가 CPU에 밀리면 늦게 보낸다, seat-booking S1의 교훈).
export function eventId(vu, iter, i) {
  return `${hex(hash32(vu, iter, i, 7), 8)}-${hex(vu, 4)}-4${hex(iter >>> 20, 3)}-8${hex(iter >>> 8, 3)}-${hex(iter, 2)}${hex(i, 2)}${RUN_TAG}`;
}

// 본문의 code. 본문이 없거나 JSON이 아니면 none.
export function errorCode(res) {
  if (!res.body) return "none";
  try {
    return res.json("code") || "none";
  } catch {
    return "none";
  }
}

// 응답 머리 Server-Timing의 pool;dur(그 요청이 풀에서 연결을 받기까지 기다린 ms). 없으면 null.
export function poolWaitMs(res) {
  const header = res.headers["Server-Timing"] || res.headers["server-timing"];
  if (!header) return null;
  const match = /pool;dur=([\d.]+)/.exec(header);
  return match ? Number(match[1]) : null;
}

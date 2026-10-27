import http from "k6/http";
import { Counter } from "k6/metrics";
import { BASE, errorCode, eventId, rng, SEED } from "./lib.js";

// 수집(DESIGN 6.8 S1, S2의 배경). 반복 하나가 배치 하나(200건)다. 열린 모형(constant-arrival-rate)으로 돈다.
// occurred_at은 LATE_SHARE(기본 1%)가 지난 7일 안 무작위(늦은 이벤트, 집계 작업이 다시 센다), 나머지는 지금이다.
// 지난 7일에 고르게 흩는 것은 최악의 경우다(실제 늦은 이벤트는 지금 가까이에 몰린다). 받을 기간(과거 7일 ~ 미래 1시간) 안이다.

const KEY = __ENV.INGEST_KEY;
if (!KEY) throw new Error("INGEST_KEY가 없습니다(실행기가 프로세스 환경으로 준다)");
const BATCH = 200;
const LATE_SHARE = Number(__ENV.LATE_SHARE ?? 0.01);
if (!(LATE_SHARE >= 0 && LATE_SHARE <= 1)) throw new Error(`LATE_SHARE는 0~1입니다: ${__ENV.LATE_SHARE}`);
// 늦은 이벤트는 받을 기간 끝(7일)에 닿지 않게 6일 23시간까지
const LATE_MAX_MS = (7 * 24 - 1) * 3_600_000;

const PLATFORMS = ["ios", "ios", "ios", "android", "android", "web"];
const EVENTS = ["performance_list_viewed", "seat_map_viewed", "seats_held", "order_created", "payment_succeeded"];
const CAMPAIGNS = 200;

export const ingestDuplicates = new Counter("ingest_duplicates");
export const ingestRejected = new Counter("ingest_rejected");
export const ingestErrors = new Counter("ingest_errors");

// VU마다 따로인 난수(같은 씨앗이면 같은 이벤트 모양)
const random = rng(SEED * 7919 + __VU);

export function ingest() {
  const iter = __ITER;
  const now = Date.now();
  // 지금의 시각 글자는 배치마다 한 번만 만든다(99%가 같다)
  const nowIso = new Date(now).toISOString();
  const events = new Array(BATCH);
  for (let i = 0; i < BATCH; i++) {
    const late = random() < LATE_SHARE;
    const occurredAt = late ? new Date(now - Math.floor(random() * LATE_MAX_MS)).toISOString() : nowIso;
    const user = Math.floor(200_000 * random() ** 3);
    const campaign = Math.floor(CAMPAIGNS * random() ** 4);
    events[i] = {
      eventId: eventId(__VU, iter, i),
      occurredAt,
      userId: `u${user}`,
      eventName: EVENTS[Math.floor(random() * EVENTS.length)],
      platform: PLATFORMS[Math.floor(random() * PLATFORMS.length)],
      country: "KR",
      channel: campaign % 3 === 0 ? "naver" : "google",
      campaign: `camp_${campaign}`,
    };
  }
  const res = http.post(`${BASE}/ingest`, JSON.stringify({ events }), {
    headers: { "content-type": "application/json", "x-write-key": KEY },
    tags: { name: "POST /ingest" },
    timeout: "30s",
  });
  if (res.status === 200) {
    const body = res.json();
    if (body.duplicates) ingestDuplicates.add(body.duplicates);
    if (body.rejected && body.rejected.length) ingestRejected.add(body.rejected.length);
  } else {
    ingestErrors.add(1, { status: String(res.status), code: errorCode(res) });
  }
}

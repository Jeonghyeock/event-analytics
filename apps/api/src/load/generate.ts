import { createHash } from "node:crypto";
import type { IngestEvent } from "@event-analytics/shared";

// 이벤트 생성기(DESIGN 6.2 "이벤트 생성기", 6.6). 씨앗으로 정해진다. 같은 씨앗과 같은 설정이면 같은 이벤트(event_id까지)가 나온다.
// 행동은 seat-booking의 예매 흐름을 따른다. 세션마다 목록 → 좌석 지도 → 선점 → 주문 → 결제로 가다가 단계마다 이탈한다.

// 씨앗 하나로 정해지는 32비트 의사 난수(mulberry32). 0 이상 1 미만.
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
type Rand = ReturnType<typeof random>;

// 가중치 목록에서 하나를 고른다.
function weighted<T>(rand: Rand, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let r = rand() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r < 0) return item;
  }
  return items.at(-1)![0];
}

// UUID v4 모양의 id를 (씨앗, 범위, 순번)의 SHA-256에서 만든다. 같은 설정으로 다시 넣으면 같은 id(→ 모두 중복)이고,
// 씨앗이나 범위가 다르면 겹치지 않는다. 난수기(32비트 상태)에서 뽑으면 씨앗이 달라도 같은 흐름을 지나 겹칠 수 있다.
function uuid(key: string, n: number) {
  const hex = createHash("sha256").update(`${key}:${n}`).digest("hex").slice(0, 32);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// 예매 흐름의 단계와, 앞 단계에서 다음 단계로 가는 비율.
export const FUNNEL = [
  ["performance_list_viewed", 1],
  ["seat_map_viewed", 0.6],
  ["seats_held", 0.35],
  ["order_created", 0.7],
  ["payment_succeeded", 0.85],
] as const;

const PLATFORMS = [["ios", 45], ["android", 35], ["web", 20]] as const;
const COUNTRIES = [["KR", 85], ["JP", 6], ["US", 4], ["TW", 3], ["VN", 2]] as const;
// organic이면 캠페인이 없다.
const CHANNELS = [["organic", 40], ["naver", 20], ["google", 15], ["kakao", 12], ["instagram", 8], ["youtube", 5]] as const;
// 한국 시각 0~23시의 세션 비율. 새벽에 적고 점심과 저녁에 많다.
const KST_HOURS = [3, 2, 1, 1, 1, 1, 2, 4, 6, 7, 8, 9, 10, 9, 8, 8, 9, 10, 11, 12, 13, 12, 9, 6];
const HOUR_ITEMS = KST_HOURS.map((w, h) => [h, w] as const);

export type GenerateOptions = {
  seed: number;
  // 만들 이벤트 수(마지막 세션은 잘라 정확히 맞춘다).
  events: number;
  // [from, to) 안의 시각으로 만든다. 같은 시각 범위를 주면 같은 이벤트가 나온다.
  from: Date;
  to: Date;
  users?: number;
  campaigns?: number;
};

// 사용자는 소수가 이벤트 대부분을 낸다(번호가 작을수록 자주 나온다). 캠페인도 소수가 대부분을 차지한다(zipf, s = 1).
export function* generate({ seed, events, from, to, users = 200_000, campaigns = 200 }: GenerateOptions): Generator<IngestEvent> {
  // 범위도 섞는다. 같은 씨앗이라도 범위가 다르면 다른 이벤트다(같은 id가 다른 시각으로 들어가 두 배가 되지 않게).
  const key = `${seed}:${from.toISOString()}:${to.toISOString()}`;
  const rand = random(createHash("sha256").update(key).digest().readUInt32BE(0));
  const zipf = Array.from({ length: campaigns }, (_, i) => [`camp_${String(i + 1).padStart(3, "0")}`, 1 / (i + 1)] as const);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  let made = 0;
  while (made < events) {
    const user = Math.floor(users * rand() ** 3);
    const channel = weighted(rand, CHANNELS);
    const platform = weighted(rand, PLATFORMS);
    const country = weighted(rand, COUNTRIES);
    const campaign = channel === "organic" ? undefined : weighted(rand, zipf);
    const performanceId = 1 + Math.floor(40 * rand() ** 2);
    // 날은 고르게, 시각은 한국 시각의 하루 분포로 고른다(한국 시각 h시 = UTC (h − 9 + 24) % 24시).
    const day = Math.floor(rand() * days);
    const hourUtc = (weighted(rand, HOUR_ITEMS) + 15) % 24;
    let at = from.getTime() + day * 86_400_000 + hourUtc * 3_600_000 + Math.floor(rand() * 3_600_000);
    for (const [step, [name, rate]] of FUNNEL.entries()) {
      if (step > 0 && rand() >= rate) break;
      at += step === 0 ? 0 : 5_000 + Math.floor(rand() * 120_000);
      // 범위 끝을 넘으면 그 세션을 멈춘다(끝 근처에서 시작한 세션)
      if (made >= events || at >= to.getTime()) break;
      made++;
      yield {
        eventId: uuid(key, made),
        occurredAt: new Date(at).toISOString(),
        userId: `user_${user}`,
        eventName: name,
        platform,
        country,
        channel,
        ...(campaign ? { campaign } : {}),
        properties: step >= 2 ? { performanceId, seats: 1 + Math.floor(rand() * 4) } : { performanceId },
      };
    }
  }
}

import pg from "pg";
import { checkDatabaseLocale, dropDatabase, NEW_DATABASE_OPTIONS, withAdminClient } from "./databases.js";
import { runMigrations } from "./migrate.js";
import { AHEAD_DAYS, addDays, BEHIND_DAYS, createDailyPartitions, dbToday } from "./partitions.js";

// E2E 전용 DB를 새로 만든다(DESIGN 6.7 E2E, 10장 55). Playwright가 API를 띄우기 직전에 같은 환경으로 부른다.
// 소유자 주소(DATABASE_OWNER_URL)의 DB 이름이 event_analytics_e2e가 아니면 거절한다(설정이 빠져 개발 DB를 지우지 않게).
// 지우고 만들기(정렬은 builtin C.UTF-8) → 마이그레이션 → 관리 작업과 같은 범위의 파티션 → 고정 데이터.
const E2E_DATABASE = "event_analytics_e2e";

const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다");
if (new URL(url).pathname !== `/${E2E_DATABASE}`) throw new Error(`E2E 준비는 ${E2E_DATABASE} DB에만 합니다`);
// 고정 데이터의 날(한국 시각). playwright.config.ts가 한 번 정해 준비와 테스트가 함께 쓴다(각자 계산하면 자정에 어긋난다).
const day = process.env.E2E_DAY ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("E2E_DAY(YYYY-MM-DD)가 없습니다");

await withAdminClient(url, async (client) => {
  await dropDatabase(client, E2E_DATABASE);
  await client.query(`CREATE DATABASE ${E2E_DATABASE} ${NEW_DATABASE_OPTIONS}`);
});
await checkDatabaseLocale(url);
await runMigrations(url);

// 사용자 다섯의 예매 흐름(한국 시각 그날 10~14시, 시각은 오프셋을 붙인 글자). 기대값은 e2e/analytics.spec.ts에 손으로 센다.
//   e1 list 10:00 → seat 10:05 → paid 10:10 (ios, naver, camp_a)
//   e2 list 10:30 → seat 10:35            (android, google, camp_b)
//   e3 list 11:00                         (web, 채널 없음)
//   e4 list 12:00 → seat 12:05 → paid 12:20 (ios, naver, camp_a)
//   e5 seat 13:00                         (ios, 채널 없음)
const FIXTURE: [user: string, event: string, time: string, platform: string, channel: string | null, campaign: string | null][] = [
  ["e1", "list_viewed", "10:00", "ios", "naver", "camp_a"],
  ["e1", "seat_map_viewed", "10:05", "ios", "naver", "camp_a"],
  ["e1", "paid", "10:10", "ios", "naver", "camp_a"],
  ["e2", "list_viewed", "10:30", "android", "google", "camp_b"],
  ["e2", "seat_map_viewed", "10:35", "android", "google", "camp_b"],
  ["e3", "list_viewed", "11:00", "web", null, null],
  ["e4", "list_viewed", "12:00", "ios", "naver", "camp_a"],
  ["e4", "seat_map_viewed", "12:05", "ios", "naver", "camp_a"],
  ["e4", "paid", "12:20", "ios", "naver", "camp_a"],
  ["e5", "seat_map_viewed", "13:00", "ios", null, null],
];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const today = await dbToday(client);
  await createDailyPartitions(client, addDays(today, -BEHIND_DAYS), addDays(today, AHEAD_DAYS));
  for (const [user, event, time, platform, channel, campaign] of FIXTURE) {
    await client.query(
      `insert into events (event_id, occurred_at, user_id, event_name, platform, country, channel, campaign)
       values (gen_random_uuid(), $1::timestamptz, $2, $3, $4, 'KR', $5, $6)`,
      [`${day}T${time}:00+09:00`, user, event, platform, channel, campaign],
    );
  }
  console.log(`E2E DB 준비 완료: ${day}(한국 시각)에 이벤트 ${FIXTURE.length}건`);
} finally {
  await client.end();
}

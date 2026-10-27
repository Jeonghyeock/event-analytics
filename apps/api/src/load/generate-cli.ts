import { parseArgs } from "node:util";
import type { IngestEvent } from "@event-analytics/shared";
import pg from "pg";
import { addDays, createDailyPartitions, dbToday, RETENTION_DAYS } from "../db/partitions.js";
import { insertEvents } from "../ingest.js";
import { generate } from "./generate.js";

// 이벤트 생성기(DESIGN 6.2). 지난 N일을 DB에 바로 넣는다(받을 기간 밖이라 수집 API로는 못 넣는다).
// 표를 만들고 넣는 일이라 소유자 주소로 돈다. 같은 씨앗·같은 끝 날이면 같은 이벤트라, 다시 돌리면 모두 중복이다.
//   npm run load:generate -w @event-analytics/api -- --events 10000000 --days 90 --seed 1 --end-day 2026-10-27
const { values } = parseArgs({
  options: {
    events: { type: "string", default: "1000000" },
    days: { type: "string", default: "90" },
    // 이 날(UTC) 0시 직전까지 만든다. 꼭 준다. 같은 씨앗·같은 날·같은 일수면 같은 이벤트라 다시 넣어도 모두 중복이다.
    "end-day": { type: "string" },
    seed: { type: "string", default: "1" },
    batch: { type: "string", default: "1000" },
  },
});
const events = Number(values.events);
const days = Number(values.days);
const seed = Number(values.seed);
const batch = Number(values.batch);
for (const [name, n] of [["events", events], ["days", days], ["seed", seed], ["batch", batch]] as const) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name}는 1 이상의 정수입니다`);
}

const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
const client = new pg.Client({ connectionString: url, application_name: "event-analytics-generate" });
client.on("error", () => {});
await client.connect();
try {
  const today = await dbToday(client);
  const endDay = values["end-day"];
  if (!endDay) throw new Error("--end-day(YYYY-MM-DD)를 줍니다. 오늘을 기본으로 두면 다른 날 다시 돌릴 때 다른 이벤트가 된다");
  const firstDay = addDays(endDay, -days);
  // 보관 기간보다 앞선 날은 넣지 않는다. 관리 작업이 지울 날을 다시 만들게 된다(DESIGN 6.2).
  if (firstDay < addDays(today, -RETENTION_DAYS)) {
    throw new Error(`${firstDay}는 보관 기간(${RETENTION_DAYS}일)보다 앞섭니다. --days나 --end-day를 줄입니다`);
  }
  const created = await createDailyPartitions(client, firstDay, addDays(endDay, -1));
  console.log(`파티션 ${created.length}개를 만들었습니다(${firstDay} ~ ${addDays(endDay, -1)})`);

  const from = new Date(`${firstDay}T00:00:00Z`);
  const to = new Date(`${endDay}T00:00:00Z`);
  const started = performance.now();
  let pending: (IngestEvent & { at: number })[] = [];
  let made = 0;
  let inserted = 0;
  const flush = async () => {
    inserted += await insertEvents(client, pending);
    made += pending.length;
    pending = [];
    if (made % 500_000 < batch) {
      const sec = (performance.now() - started) / 1000;
      console.log(`${made.toLocaleString()}건(새로 ${inserted.toLocaleString()}) ${sec.toFixed(0)}초, 초당 ${Math.round(made / sec).toLocaleString()}건`);
    }
  };
  for (const event of generate({ seed, events, from, to })) {
    pending.push({ ...event, at: Date.parse(event.occurredAt) });
    if (pending.length >= batch) await flush();
  }
  await flush();
  const sec = (performance.now() - started) / 1000;
  console.log(`끝: ${made.toLocaleString()}건 가운데 새로 ${inserted.toLocaleString()}건, ${sec.toFixed(1)}초(초당 ${Math.round(made / sec).toLocaleString()}건)`);
} finally {
  await client.end();
}

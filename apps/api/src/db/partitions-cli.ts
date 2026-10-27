import pg from "pg";
import { addDays, createDailyPartitions, utcDay } from "./partitions.js";

// 개발 DB에 오늘(UTC) 기준 7일 전부터 7일 뒤까지의 파티션을 만든다. 표를 만드는 일이라 소유자 주소로 돈다.
// 받을 기간(과거 7일, 미래 1시간)을 덮는다. 주기적으로 미리 만드는 일과 보관 기간 떼기는 2단계다.
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");

const today = utcDay(new Date());
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const created = await createDailyPartitions(client, addDays(today, -7), addDays(today, 7));
  console.log(created.length > 0 ? `파티션을 만들었습니다: ${created.join(", ")}` : "파티션이 이미 있습니다");
} finally {
  await client.end();
}

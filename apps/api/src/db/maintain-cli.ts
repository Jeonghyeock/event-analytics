import pg from "pg";
import { maintain } from "./partitions.js";

// 파티션 관리 작업(DESIGN 6.2). 하루 한 번 OS 예약 작업으로 돌린다. 표를 만들고 떼는 일이라 소유자 주소로 돈다.
// 끊긴 떼기 마무리 → 오늘 ±7일 만들기 → 90일 지난 파티션 떼고 지우기. 여러 번 돌려도 같은 결과다.
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");

const client = new pg.Client({ connectionString: url, application_name: "event-analytics-maintain" });
client.on("error", () => {});
await client.connect();
try {
  const { finalized, created, dropped } = await maintain(client);
  const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "없음");
  console.log(`마무리: ${list(finalized)}\n만듦: ${list(created)}\n지움: ${list(dropped)}`);
} finally {
  await client.end();
}

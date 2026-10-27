import pg from "pg";
import { checkOwner } from "./migrate.js";
import { maintain } from "./partitions.js";

// 파티션 관리 작업(DESIGN 6.2). 하루 한 번 OS 예약 작업으로 돌린다. 표를 만들고 떼는 일이라 소유자 주소로 돈다.
// 만들기 → 끊긴 떼기 마무리 → 90일 지난 파티션 떼고 지우기 → 남은 표 치우기 → 부모 표의 통계. 여러 번 돌려도 같은 결과다.
// 한 단계라도 실패하면 종료 코드 1로 끝낸다(예약 작업이 실패로 보이게).
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");

// keepAlive: 소리 없이 끊긴 연결에서 멈춰 다음 예약 실행이 건너뛰어지지 않게.
const client = new pg.Client({ connectionString: url, application_name: "event-analytics-maintain", keepAlive: true });
client.on("error", () => {});
await client.connect();
try {
  // 슈퍼유저가 만든 파티션에는 앱 role의 기본 권한이 붙지 않는다(마이그레이션 실행기와 같은 확인).
  await checkOwner(client);
  const { created, finalized, dropped, analyzed, errors } = await maintain(client);
  const list = (names: string[]) => (names.length > 0 ? names.join(", ") : "없음");
  console.log(`만듦: ${list(created)}\n마무리: ${list(finalized)}\n지움: ${list(dropped)}\n부모 통계: ${analyzed ? "새로 함" : "못 함"}`);
  for (const error of errors) console.error(`실패 — ${error}`);
  if (errors.length > 0) process.exitCode = 1;
} finally {
  await client.end();
}

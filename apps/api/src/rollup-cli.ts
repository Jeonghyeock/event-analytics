import { createPool } from "./db/pool.js";
import { runRollup } from "./rollup.js";

// 집계 작업을 한 번 돈다(DESIGN 6.4). 처음 채우기와 테스트에 쓴다. 서버는 1분마다 스스로 돈다.
// 집계 표는 DML만 하므로 앱 role(DATABASE_URL)로 된다.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

const pool = createPool({ connectionString: url, max: 1, application_name: "event-analytics-rollup" });
try {
  const started = performance.now();
  const result = await runRollup(pool);
  const sec = ((performance.now() - started) / 1000).toFixed(1);
  console.log(result.skipped ? "다른 집계 작업이 돌고 있어 건너뛰었습니다" : `조각 ${result.chunks}개, 시간 ${result.hours}개, 워터마크 ${result.watermark ?? "(그대로)"}, ${sec}초`);
} finally {
  await pool.end();
}

import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";
import { startPartitionWatch } from "./partition-watch.js";
import { startRollupLoop } from "./rollup.js";

// 서버는 앱 role(DML만)로 접속한다. 마이그레이션은 소유자 주소로 따로 돌린다(db:migrate).
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

// 수집 API의 쓰기 키(DESIGN 10장 21). 짧은 키는 받지 않는다.
const ingestWriteKey = process.env.INGEST_WRITE_KEY ?? "";
if (ingestWriteKey.length < 32) throw new Error("INGEST_WRITE_KEY가 없거나 32자보다 짧습니다(.env 또는 환경 변수)");

// seat-booking(3001)과 함께 띄울 수 있게 기본값을 3002로 둔다.
const port = Number(process.env.PORT ?? 3002);
const host = process.env.HOST ?? "127.0.0.1";

// 연결을 받기까지 5초를 넘기면 실패한다. 한도가 없으면 DB에 닿지 않을 때 /health가 503 대신 멈춰 있다.
const pool = createPool({ connectionString: databaseUrl, application_name: "event-analytics-api", connectionTimeoutMillis: 5_000 });
// 리포트는 30초까지 연결을 쥘 수 있어 수집과 풀을 나눈다(DESIGN 10장 35).
const reportPool = createPool({ connectionString: databaseUrl, application_name: "event-analytics-reports", max: 4, connectionTimeoutMillis: 5_000 });
// 집계 작업은 1분마다 돌고 연결 하나를 따로 쓴다(DESIGN 10장 41).
const rollupPool = createPool({ connectionString: databaseUrl, application_name: "event-analytics-rollup", max: 1, connectionTimeoutMillis: 5_000 });
const app = buildApp(pool, { logger: true }, { ingestWriteKey, reportPool });
rollupPool.on("error", (err) => app.log.error({ err }, "집계 풀의 쉬는 연결이 끊김"));
const stopRollup = startRollupLoop(rollupPool, app.log);
// 받을 기간과 앞으로 3일 안에 파티션이 없는 날이 있으면 경고한다(DESIGN 6.2).
const stopWatch = startPartitionWatch(pool, app.log);
app.addHook("onClose", async () => {
  stopWatch();
  stopRollup();
  await Promise.all([pool.end(), reportPool.end(), rollupPool.end()]);
});

const shutdown = () => {
  void app.close().then(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);

await app.listen({ port, host });

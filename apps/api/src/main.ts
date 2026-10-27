import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";

// 서버는 앱 role(DML만)로 접속한다. 마이그레이션은 소유자 주소로 따로 돌린다(db:migrate).
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL이 없습니다(.env 또는 환경 변수)");

// seat-booking(3001)과 함께 띄울 수 있게 기본값을 3002로 둔다.
const port = Number(process.env.PORT ?? 3002);
const host = process.env.HOST ?? "127.0.0.1";

// 연결을 받기까지 5초를 넘기면 실패한다. 한도가 없으면 DB에 닿지 않을 때 /health가 503 대신 멈춰 있다.
const pool = createPool({ connectionString: databaseUrl, application_name: "event-analytics-api", connectionTimeoutMillis: 5_000 });
const app = buildApp(pool, { logger: true });
app.addHook("onClose", () => pool.end());

const shutdown = () => {
  void app.close().then(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);

await app.listen({ port, host });

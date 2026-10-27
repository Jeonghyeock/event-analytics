import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { addDays, BEHIND_DAYS, dbToday, missingPartitionDays } from "./db/partitions.js";

// 서버는 파티션을 만들지 않는다(앱 role은 DML만, DESIGN 10장 28). 대신 받을 기간(과거 7일)과 앞으로 3일 사이에
// 없는 날이 있으면 경고한다. 관리 작업은 7일을 미리 만들므로, 이 경고가 뜨면 4일 넘게 돌지 않은 것이다.
export const WATCH_AHEAD_DAYS = 3;

// "오늘"은 DB 시각의 UTC 날짜다(관리 작업과 같다).
export async function missingSoon(pool: pg.Pool, today?: string) {
  const day = today ?? (await dbToday(pool));
  return missingPartitionDays(pool, addDays(day, -BEHIND_DAYS), addDays(day, WATCH_AHEAD_DAYS));
}

// 띄울 때 한 번, 그 뒤 한 시간마다 본다. 돌려준 함수로 멈춘다.
export function startPartitionWatch(pool: pg.Pool, log: FastifyBaseLogger, everyMs = 3_600_000) {
  const check = () =>
    missingSoon(pool).then(
      (missing) => {
        if (missing.length > 0) log.warn({ missing }, "파티션이 없는 날이 있습니다. db:maintain을 돌리세요");
      },
      (err: unknown) => log.error({ err }, "파티션 확인 실패"),
    );
  void check();
  const timer = setInterval(check, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

import { sql } from "drizzle-orm";
import { bigint, boolean, check, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

// drizzle-kit이 마이그레이션을 만들 때 읽는 표 정의.
// 파티션 표(events)는 drizzle-kit이 DDL(PARTITION BY, PARTITION OF)을 내지 못해 손으로 쓴 마이그레이션에만 있고 여기에 두지 않는다(DESIGN 5장).
// 그래서 drizzle-kit generate는 여기 있는 표만 다룬다. events는 쿼리도 직접 쓴 SQL로 한다.

// 시간 집계 표(DESIGN 6.4). UTC 정시 × 차원 다섯의 이벤트 수. 값 없는 차원(null)도 한 무리라 NULLS NOT DISTINCT다.
// 이 유일 키의 인덱스가 hour 범위 조회도 맡는다(첫 열).
export const hourlyRollup = pgTable(
  "hourly_rollup",
  {
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    eventName: text("event_name").notNull(),
    platform: text("platform").notNull(),
    country: text("country"),
    channel: text("channel"),
    campaign: text("campaign"),
    events: bigint("events", { mode: "number" }).notNull(),
  },
  (t) => [unique("hourly_rollup_key").on(t.hour, t.eventName, t.platform, t.country, t.channel, t.campaign).nullsNotDistinct()],
);

// 다시 셀 시간의 기록. 유일 키가 없다: 수집 트랜잭션마다 자기 행을 덧붙인다(DESIGN 6.4, 10장 38).
// 유일 키 + ON CONFLICT DO NOTHING은 이미 있는 행을 잠그지 않아, 커밋 전인 수집을 집계 작업이 놓친 채 표시를 지울 수 있다.
export const dirtyHours = pgTable("dirty_hours", {
  hour: timestamp("hour", { withTimezone: true }).notNull(),
});

// 집계 작업의 상태(한 행). watermark 앞의 시간은 집계 표에 있다. null이면 아직 한 번도 돌지 않았다.
export const rollupState = pgTable(
  "rollup_state",
  {
    id: boolean("id").primaryKey().default(true),
    watermark: timestamp("watermark", { withTimezone: true }),
  },
  (t) => [check("rollup_state_one_row", sql`${t.id}`)],
);

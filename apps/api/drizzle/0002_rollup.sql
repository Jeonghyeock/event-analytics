-- 시간 집계 표와 늦은 이벤트(DESIGN 6.4). drizzle-kit이 만든 것에 상태 행 하나를 더했다.
CREATE TABLE "dirty_hours" (
	"hour" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hourly_rollup" (
	"hour" timestamp with time zone NOT NULL,
	"event_name" text NOT NULL,
	"platform" text NOT NULL,
	"country" text,
	"channel" text,
	"campaign" text,
	"events" bigint NOT NULL,
	CONSTRAINT "hourly_rollup_key" UNIQUE NULLS NOT DISTINCT("hour","event_name","platform","country","channel","campaign")
);
--> statement-breakpoint
CREATE TABLE "rollup_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	CONSTRAINT "rollup_state_one_row" CHECK ("rollup_state"."id")
);
--> statement-breakpoint
-- 집계 작업의 상태는 늘 한 행이다. 워터마크는 보관 기간의 시작(UTC 날짜로 90일 전 0시)에서 시작해, 첫 실행이 보관 기간 안의 데이터를 모두 센다.
INSERT INTO "rollup_state" ("id", "watermark") VALUES (true, (date_trunc('day', now() at time zone 'UTC') - interval '90 days') at time zone 'UTC');

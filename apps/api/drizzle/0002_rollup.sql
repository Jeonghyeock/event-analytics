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
	"watermark" timestamp with time zone,
	CONSTRAINT "rollup_state_one_row" CHECK ("rollup_state"."id")
);
--> statement-breakpoint
-- 집계 작업의 상태는 늘 한 행이다(아직 돌지 않았으면 watermark가 null).
INSERT INTO "rollup_state" ("id", "watermark") VALUES (true, null);

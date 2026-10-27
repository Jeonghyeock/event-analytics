-- 이벤트 원본(DESIGN 5장, 6.1). occurred_at으로 일 단위(UTC) 범위 파티션을 나눈다. 파티션은 db:partitions가 만든다(2단계에서 주기 작업으로).
-- 파티션 DDL은 drizzle-kit이 내지 못해 손으로 쓰고, 이 표는 schema.ts에 두지 않는다(DESIGN 5장).
-- 기본 키에 파티션 키(occurred_at)가 들어 있어야 한다. 파티션 표의 유일 인덱스는 파티션마다 따로라 event_id만으로는 걸 수 없다(0A000).
-- 기본 파티션은 두지 않는다. 받을 기간 안인데 파티션이 없으면 23514로 드러나게 한다(DESIGN 6.2, 10장 20).
CREATE TABLE "events" (
	"event_id" uuid NOT NULL,
	"occurred_at" timestamptz NOT NULL,
	"received_at" timestamptz DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"event_name" text NOT NULL,
	"platform" text NOT NULL,
	"country" text,
	"channel" text,
	"campaign" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "events_pkey" PRIMARY KEY ("event_id", "occurred_at"),
	CONSTRAINT "events_platform_check" CHECK ("platform" IN ('ios', 'android', 'web'))
) PARTITION BY RANGE ("occurred_at");

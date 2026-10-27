-- 앱 role(event_analytics_app)은 DML만 한다(DESIGN 10장 12, seat-booking 0008과 같음). role은 클러스터에 하나라 슈퍼유저가 먼저 만든다(README).
-- 시퀀스 권한은 주지 않는다. id는 identity 열로 만들고, identity 열 INSERT는 시퀀스 권한을 보지 않는다.
GRANT USAGE ON SCHEMA public TO event_analytics_app;
--> statement-breakpoint
-- 이 마이그레이션을 돌린 role(소유자)이 앞으로 public에 만드는 표에 같은 권한이 붙는다. 파티션도 표라 파티션마다 붙는다.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO event_analytics_app;

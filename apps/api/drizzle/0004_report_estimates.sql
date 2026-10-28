-- (사용자, 날) 무리 수의 어림(DESIGN 6.8, 10장 62). 리텐션과 사용자 수 리포트는 (사용자, 리포트 시간대의 날)로 묶는다.
-- 식에 통계가 없으면 계획기는 occurred_at 열의 n_distinct를 쓴다. 그 값은 표본에 따라 "모두 다름"(-1, 무리 수 = 행 수)도 되고
-- 같은 초가 많으면 27만도 된다. 그래서 같은 질의가 병렬 부분 묶기를 하기도 하고(8초) 안 하기도 했다(17초, 7단계 측정).
-- 부모(events)의 확장 통계는 ANALYZE ONLY events(관리 작업 5단계)가 만든다(inherited). 식은 질의와 글자까지 같아야 맞는다.
-- 시간대는 상수라 한국 시각(제품의 기본, S2 묶음)만 덮는다. 다른 시간대는 열의 어림으로 돌아간다.
-- 리텐션: (occurred_at at time zone $3::text)::date
CREATE STATISTICS events_user_date_kst (ndistinct) ON user_id, ((occurred_at AT TIME ZONE 'Asia/Seoul'::text)::date) FROM events;
--> statement-breakpoint
-- 리포트의 일별 사용자 수: date_trunc('day', occurred_at, $3::text)
CREATE STATISTICS events_user_day_kst (ndistinct) ON user_id, (date_trunc('day'::text, occurred_at, 'Asia/Seoul'::text)) FROM events;
--> statement-breakpoint
-- 배포 때 바로 쓰이게 한 번 분석한다(표본 3만 행, 1,000만 건에서 0.3초). 그 뒤로는 관리 작업이 날마다 새로 한다.
ANALYZE ONLY events;

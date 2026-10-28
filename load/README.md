# 부하 측정

7단계(DESIGN 6.8)의 도구입니다. 로컬 Windows PC에서만 돌립니다(CI에는 넣지 않습니다). 숫자는 같은 PC에서의 전후 비교로만 씁니다. 결과 요약은 [RESULTS.md](RESULTS.md)에 둡니다.

## 준비

1. k6 v2.3.0. seat-booking과 같은 것을 씁니다(`%LOCALAPPDATA%\Programs\k6-v2.3.0\`, 다른 곳이면 환경 변수 `K6`).
2. 측정 템플릿(약 20초): `npm run load:template -w @event-analytics/api`
   - 개발 DB(소유자 주소의 DB)를 `event_analytics_load_template`으로 복제합니다(`STRATEGY FILE_COPY`). 그다음 집계를 끝까지 돌리고, 잎 표마다 `VACUUM (FREEZE, ANALYZE)`를 하고, 파티션 부모(`events`)의 통계를 지운 뒤(PostgreSQL은 부모를 자동으로 분석하지 않습니다. 고친 뒤에는 회차마다 관리 작업처럼 분석합니다), 일반 표의 autovacuum을 끕니다.
   - 복제하려면 개발 DB에 연결이 없어야 합니다. 개발 API를 먼저 끕니다.
   - 기록은 `load/results/load-template.json`에 남습니다.

## 돌리기

`npm run load:run -w @event-analytics/api -- --scene <s1|s2|s2open> [옵션]`

회차마다 다음을 합니다.
1. 템플릿을 `event_analytics_load`로 복제하고, 템플릿보다 뒤의 마이그레이션을 적용하고, 지난 7일 ~ 앞으로 7일의 파티션을 만들고(관리 작업과 같은 범위, autovacuum 끔), 관리 작업처럼 부모 표(`events`)를 분석합니다.
   - 템플릿은 마이그레이션 0004(확장 통계) 앞의 개발 DB에서 만듭니다. PostgreSQL 18에는 확장 통계를 지우는 함수가 없어, 0004 뒤의 DB로 만들면 고치기 전 회차에도 그 통계가 남습니다. 상태 기록의 `parentExtStats`(확장 통계 객체 수)가 고치기 전 회차에서 0, 고친 뒤 회차에서 2여야 합니다.
2. 상태를 기록합니다. 더러운 시간이 있으면 거절합니다.
3. API를 포트 3202에 띄워 P코어에 묶습니다(로그 warn, `LOAD_STATS`).
4. 집계 작업이 지금의 정시까지 따라잡길 기다립니다.
5. 표본기를 돌리고 k6를 E코어에 묶어 돌립니다. 표본기는 DB를 0.2초마다, CPU를 1초마다 봅니다.
6. 앞뒤 통계를 기록하고 API를 닫습니다. 결과는 `load/results/runs/<시각>-<label>/`에 씁니다.

| 옵션 | 뜻 |
|---|---|
| `--label` | 결과 폴더 이름 |
| `--seed` | k6의 씨앗(이벤트 모양, 리포트 순서, 생각 시간) |
| `--pool`, `--report-pool` | `DB_POOL_MAX`, `REPORT_POOL_MAX`. 주지 않으면 API의 기본값(10, 4) |
| `--rates 10,20,40` | S1: 초당 배치(200건) 도착률. 도착률마다 새로 복제해 한 회차씩 돕니다 |
| `--warmup 20`, `--step 60` | S1: 예열과 단계의 초 |
| `--bg 10` | S2: 배경 수집의 초당 배치(기본 10 = 초당 2,000건) |
| `--late 1` | 수집 이벤트 가운데 늦은 이벤트(지난 7일 안 무작위)의 몫(%). 집계 작업이 다시 셀 시간을 크게 바꾼다 |
| `--n 4`, `--minutes 20` | S2: 마케터 수, 정상 구간 분(예열은 VU마다 묶음 한 바퀴) |
| `--mix weighted\|equal` | S2: 리포트 몫(3·2·2·2·1·1·2 또는 모두 1) |
| `--open-rates r1:6,r6:2.7,…`, `--open-warmup 60` | S2open: 종류마다 분당 도착률(소수 가능), 예열 초 |
| `--no-align` | 정상 구간이 UTC 정시를 넘지 않게 기다리지 않습니다(시험용) |

예:
- S1 꺾이는 점: `--scene s1 --rates 10,20,40,80,120`
- S2 판단 회차: `--scene s2 --n 4 --minutes 20`
- S2 N 훑기(설명용): `--scene s2 --n 1 --minutes 5`, 그다음 `--n 2`, `--n 4`, `--n 8`
- 같은 몫: `--scene s2 --n 4 --minutes 20 --mix equal`

## 결과 폴더

| 파일 | 내용 |
|---|---|
| `summary.md`, `run.json` | 요약. 종류별 p95·503·기다린 시간의 몫, 수집, API(풀·집계 바퀴), CPU, DB 대기, 통계 차이, 무효 조건 |
| `mix.json` | 날짜를 채운 리포트 묶음(k6가 읽음) |
| `<회차>/k6-log.jsonl`, `k6-summary.json` | 리포트 요청마다의 줄(종류, 시간, 상태, 풀 대기), k6 요약 |
| `<회차>/api/api-stats.jsonl` | API 1초 지표 |
| `<회차>/db-activity.jsonl`, `cpu.jsonl` | DB 표본(앱·상태·대기), CPU 표본 |

측정 중에는 빌드나 테스트처럼 무거운 일을 돌리지 않습니다. 같은 서버의 다른 DB에 커밋이 생기면 그 회차는 무효로 표시됩니다. PostgreSQL 설정은 바꾸지 않습니다(DESIGN 6.8).

## 진단(EXPLAIN)

`DATABASE_URL`을 측정 복제본으로 바꿔 `npm run load:report-bench -w @event-analytics/api -- --kind mix --runs 1 --explain`로 S2 묶음의 계획을 남깁니다. API와 같은 트랜잭션 틀과 계획 설정으로 돕니다. 진단 회차의 p95는 세지 않습니다.

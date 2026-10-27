# event-analytics

마케터가 앱·웹의 행동 이벤트를 어떻게 볼지 설정해 그래프와 표로 보는 리포트 대시보드. 이벤트를 재전송에도 한 번만 저장하고, 리포트 설정(지표 × 차원 × 필터 × 기간 × 단위)을 안전한 SQL로 바꾸고, 수천만 건에서도 파티션과 시간 집계로 빠르게 답한다. PostgreSQL을 많은 데이터에서 운영하는 것이 목적이고, 화면은 그 결과를 보는 최소한이다(리포트, 퍼널, 리텐션, 저장한 리포트).

> 6단계(화면: 날짜·시각은 서버가 정하고(양식의 "최근 n일"만 예외) 화면은 펼치고 나누고 그린다, E2E에서 화면의 수가 손으로 센 값과 같음)까지 완료. 다음은 7단계(측정과 조정). 설계: [docs/DESIGN.md](docs/DESIGN.md) · 진행 기록: [docs/PROGRESS.md](docs/PROGRESS.md) · 측정 결과: [load/RESULTS.md](load/RESULTS.md)

> Claude Code와 함께 만든다.

## 스택

TypeScript · Fastify · PostgreSQL 18 · zod · Vitest · React · TanStack Query · Vite · Playwright

## 로컬 실행

필요: Node.js 22.22 이상(24.x 권장), PostgreSQL 18(17 이상이면 된다. 아래 DB가 builtin 정렬을 쓴다).

슈퍼유저가 아닌 role 둘로 접속한다. 슈퍼유저로 psql에 들어가 한 번만 만든다.
- 소유자 `event_analytics`: 표의 주인이다. 마이그레이션과 테스트 준비가 쓴다. `CREATEDB`는 테스트가 DB를 복제하는 데 쓴다.
- 앱 `event_analytics_app`: 서버가 쓴다. DML만 하고, 권한은 마이그레이션이 준다.
- DB는 정렬을 OS에 맡기지 않는다(builtin `C.UTF-8`). 그래야 Windows와 Linux에서 차원 값의 정렬이 같다.
- 마지막 줄은 소유자가 앱 연결이 남은 테스트 DB를 지울 수 있게 한다.

```sql
CREATE ROLE event_analytics LOGIN CREATEDB PASSWORD '비밀번호';
CREATE DATABASE event_analytics OWNER event_analytics TEMPLATE template0 ENCODING 'UTF8'
  LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';
CREATE ROLE event_analytics_app LOGIN PASSWORD '다른 비밀번호';
GRANT event_analytics_app TO event_analytics;
```

`.env.example`을 `.env`로 복사하고 `DATABASE_URL`(앱)과 `DATABASE_OWNER_URL`(소유자)의 비밀번호, 수집 쓰기 키 `INGEST_WRITE_KEY`(32자 이상의 무작위 글자)를 채운 뒤 실행한다.

```sh
npm ci
npm run db:migrate -w @event-analytics/api   # 마이그레이션(apps/api/drizzle/)
npm run db:maintain -w @event-analytics/api   # 파티션 관리: 오늘(UTC) ±7일 만들기, 90일 지난 날 떼고 지우기
npm run rollup:run -w @event-analytics/api     # 시간 집계 표 채우기(서버는 1분마다 스스로 돈다)
npm test                                     # 템플릿 DB를 복제한 테스트 DB에서 돌고, 끝나면 지운다
npm run dev                                  # API: http://127.0.0.1:3002
npm run dev -w @event-analytics/web           # 화면: http://localhost:5180(/api를 API로 넘긴다)
npm run test:e2e -w @event-analytics/web      # E2E: 전용 DB(event_analytics_e2e)를 새로 만들고 API 3102·화면 5175를 띄워 돈다
                                             # (처음 한 번: npx playwright install chromium)
```

`db:maintain`은 하루 한 번 돌린다(cron, Windows 작업 스케줄러). 앞으로 7일치를 미리 만들므로 며칠 멈춰도 수집은 계속된다. 서버는 받을 기간과 앞으로 3일 안에 파티션이 없는 날이 있으면 경고 로그를 남긴다.

## API

| 경로 | 내용 |
|---|---|
| `GET /health` | DB에 닿으면 200, 아니면 503 |
| `POST /ingest` | 이벤트 1~1,000건(헤더 `X-Write-Key`). 한 건씩 판단해 틀린 것과 받을 기간(과거 7일~미래 1시간) 밖은 이유와 함께 거절하고, 나머지는 `(event_id, occurred_at)`로 한 번만 저장한다. 응답은 받은 수·새로 넣은 수·중복 수·거절 목록이다. 파티션이 없거나 DB가 바쁘면 503(같은 배치를 다시 보내면 된다) |
| `POST /reports/query` | 리포트. 지표(이벤트 수·고유 사용자 수) × 차원(0~2) × 필터 × 기간(리포트 시간대의 날짜, 90일까지) × 단위(시간·일·주·전체)를 센다. 이벤트 수만 물으면(정시가 UTC의 정시와 같은 시간대) 시간 집계 표 + 원본 꼬리로, 사용자 수나 콜카타는 원본에서 센다(`meta.source`, 다시 세기 전인 늦은 이벤트는 `meta.stale`). 응답에 기간의 모든 묶음(빈 것 포함, UTC 오프셋, 일부만 찬 묶음)이 있다. 보관 기간 밖이거나 행이 20,000개를 넘으면 422, 시간 한도·DB가 바쁘면 503 |
| `POST /funnels/query` | 퍼널. 단계(이벤트 이름 2~6개) × 전환 기간(분, 7일까지) × 필터(모든 단계) × 나눔(진입 이벤트의 차원 0~1) × 기간(90일까지). **첫 진입 기준 전환**: 사용자의 기간 안 첫 1단계가 진입이고, 뒤 단계는 앞 단계보다 엄격히 뒤이며 진입 + 전환 기간 안이어야 한다. 응답은 단계별 사용자 수(전환율은 화면이 나눈다) |
| `POST /retention/query` | 리텐션. 날마다 무리(그날 시작 이벤트가 있는 사용자 전부) × N일째(1~30, 무리의 날 + N일에 돌아옴 이벤트가 있음, 날짜 차이로) × 필터 × 무리 기간(31일까지). 아직 다 지나지 않은 칸은 `null`이다 |
| `GET·POST /saved-reports`, `PUT·DELETE /saved-reports/:id` | 저장한 리포트(리포트·퍼널·리텐션 설정). 저장할 때 종류의 스키마로 검사한 값을 두고, 목록은 지금의 스키마에 맞는지(`valid`)와 함께 준다. 이름은 유일하다(겹치면 409) |

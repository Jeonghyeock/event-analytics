# event-analytics

마케터가 앱·웹의 행동 이벤트를 어떻게 볼지 설정해 그래프와 표로 보는 리포트 대시보드의 뒷단. 이벤트를 재전송에도 한 번만 저장하고, 리포트 설정(지표 × 차원 × 필터 × 기간 × 단위)을 안전한 SQL로 바꾸고, 수천만 건에서도 파티션과 시간 집계로 빠르게 답한다. PostgreSQL을 많은 데이터에서 운영하는 것이 목적이다.

> 0단계(뼈대: 소유자·앱 role, seat-booking의 마이그레이션 실행기, 정렬을 OS에 맡기지 않는 DB) 완료. 다음은 1단계(수집). 설계: [docs/DESIGN.md](docs/DESIGN.md) · 진행 기록: [docs/PROGRESS.md](docs/PROGRESS.md)

> Claude Code와 함께 만든다.

## 스택

TypeScript · Fastify · PostgreSQL 18 · zod · Vitest

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

`.env.example`을 `.env`로 복사하고 `DATABASE_URL`(앱)과 `DATABASE_OWNER_URL`(소유자)의 비밀번호를 채운 뒤 실행한다.

```sh
npm ci
npm run db:migrate -w @event-analytics/api   # 마이그레이션(apps/api/drizzle/)
npm test                                     # 템플릿 DB를 복제한 테스트 DB에서 돌고, 끝나면 지운다
npm run dev                                  # API: http://127.0.0.1:3002
```

## API

| 경로 | 내용 |
|---|---|
| `GET /health` | DB에 닿으면 200, 아니면 503 |

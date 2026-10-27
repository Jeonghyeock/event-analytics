# 진행 기록

단계마다 만든 것, 결과, 배운 것, 못 한 것을 남긴다. 요약은 [README](../README.md), 설계는 [DESIGN.md](DESIGN.md)에 있다.

## 0단계 — 뼈대 (완료, 2026-10-27)

- 설계를 확정했다. 사용자가 DESIGN 10장 1~11의 권장안을 그대로 골랐다. 0~8단계는 묻지 않고 진행하고, 끝난 뒤 한꺼번에 검토받는다.
- seat-booking과 같은 PostgreSQL 18.6 서버에 DB `event_analytics`와 role 둘(소유자 `event_analytics`, 앱 `event_analytics_app`)을 따로 만들었다. 비밀번호는 무작위로 만들어 `.env`에만 두었다.

| PR | 내용 |
|---|---|
| [#1](https://github.com/Jeonghyeock/event-analytics/pull/1) | npm workspaces, `apps/api`(Fastify, `GET /health`), `packages/shared`(zod), 기본 CI |
| [#2](https://github.com/Jeonghyeock/event-analytics/pull/2) | seat-booking의 마이그레이션 실행기·테스트 DB 복제·role 나누기, `0000_app_role`, builtin `C.UTF-8` DB, 앱 풀 UTC 고정, CI에 `postgres:18` |

확인한 것:
- 테스트 45개가 로컬(Windows, PostgreSQL 18.6)과 CI(`postgres:18`)에서 통과한다. 테스트가 끝나면 남는 DB는 템플릿 하나다.
- 앱 role은 DML만 한다. 표·인덱스·스키마를 만들 수 없고, 마이그레이션 기록을 읽을 수 없다. 소유자가 뒤에 만든 표와 **파티션**에는 DML 권한이 붙는다(2단계에서 날마다 만들 파티션 대비).
- 변이 시험 두 가지:
  - 풀의 `error` 듣기를 빼면, 쉬는 연결을 끊는 테스트가 "처리되지 않은 오류"로 실행을 깬다.
  - 주소의 `?options=`를 합치지 않으면, 주소로 넘긴 설정이 UTC 고정을 지우는 테스트 두 개가 실패한다.

리뷰에서 나와 고친 것:
- 풀의 쉬는 연결이 끊기면(DB 재시작, `pg_terminate_backend`) 풀이 낸 `error`를 아무도 듣지 않아 서버 프로세스가 죽었다. 리뷰가 버리는 DB로 재현했다. `buildApp`이 듣고 로그만 남긴다. seat-booking에도 같은 빈틈이 있다.
- pg는 주소에 `?options=`가 있으면 `config.options`를 통째로 덮는다. 그래서 UTC 고정이 조용히 사라졌다. 주소의 것을 꺼내 합치고 고정을 맨 뒤에 둔다(같은 설정은 뒤의 것이 이긴다).
- 서버 풀에 연결 대기 한도가 없어, DB에 닿지 않으면 `/health`가 503 대신 멈춰 있었다. 5초로 묶었다.
- 개발 DB를 손으로 옵션 없이 만들면 정렬이 CI와 달라도 테스트(복제 DB)로는 드러나지 않는다. `db:migrate`가 먼저 확인한다.
- GRANT·REVOKE 테스트가 되돌린 뒤에 ACL을 견줘 늘 통과했다. 같은 트랜잭션 안에서 견준다.

로컬과 CI에서 부딪힌 것:
- CI의 소유자 주소 검사가 `main.ts` 주석의 변수 이름에 걸렸다. 검사는 주석까지 본다. 주석을 고쳤고, 그 뒤로는 같은 grep을 로컬에서 먼저 돌린다.
- 공개 저장소 만들기를 auto mode가 막았다. 사용자가 권한을 준 뒤 만들었다.
- `npm audit`의 moderate 4건은 개발용 drizzle-kit 안의 옛 esbuild에서 나온다(seat-booking과 같다).

1·2단계 설계를 위해 미리 확인한 것(버리는 DB에서):
- 파티션 표에는 `event_id`만으로 기본 키를 걸 수 없다(`0A000`). 유일 인덱스가 파티션마다 따로 있어서, 키에 파티션 키가 들어 있어야 같은 키가 같은 파티션에 모인다.
- `CREATE TABLE … PARTITION OF`는 부모 표에 `AccessExclusiveLock`을 건다. 그동안 수집과 리포트가 모두 멈춘다. 따로 만든 표를 `ATTACH PARTITION`으로 붙이면 부모에는 `ShareUpdateExclusiveLock`만 건다(읽기·쓰기와 부딪히지 않음). 2단계에서 쓴다.
- PostgreSQL 18에는 `uuidv7()`이 있다.

### 0단계 — 설명할 수 있어야 할 것

**무엇을 가져왔고 왜 다시 만들지 않았나**

1. 가져온 것은 셋이다. 마이그레이션 실행기와 그 테스트 16개, 소유자·앱 role 나누기, 템플릿을 복제하는 테스트 DB다. 실행기는 주석 말고 그대로다.
2. 이 셋은 seat-booking에서 리뷰와 변이 시험으로 버그를 고친 결과다. 다시 만들면 같은 버그를 다시 밟는다.
   - `CREATE INDEX CONCURRENTLY`와 advisory lock이 서로 기다리는 교착
   - 잠금 대기 한도가 CONCURRENTLY를 매번 실패시켜 INVALID 인덱스만 남기는 것
   - 연결이 끊길 때 프로세스가 죽는 것
3. 이 프로젝트는 2단계부터 파티션을 만들고 떼느라 DDL이 잦다. 그래서 잠금 대기를 1초로 묶는 실행기가 처음부터 필요하다.
4. 바꾼 것은 이 저장소에만 있는 사정 때문이다.
   - advisory lock 번호. 테스트 준비는 같은 서버의 postgres DB에서 잠그므로, 번호가 같으면 두 저장소의 테스트가 서로 기다린다.
   - 새 DB의 정렬. 아래 둘째 질문이다.

**DB를 만들 때 정렬과 시간대를 왜 정해 두나**

1. PostgreSQL의 문자열 정렬은 DB를 만들 때 정하고 바꿀 수 없다. 기본값은 OS의 로캘이다. 이 PC는 `Korean_Korea.949`(Windows), CI는 `en_US.utf8`(Linux, glibc)이다. 같은 `ORDER BY country`가 두 곳에서 다른 순서를 낼 수 있다. OS 라이브러리가 바뀌면 인덱스 순서까지 어긋날 수 있다.
2. PostgreSQL 17부터 있는 builtin 공급자의 `C.UTF-8`은 OS에 기대지 않는다. 코드 포인트 순서로 정렬하고(대문자 → 소문자 → 한글), 대소문자 바꾸기는 유니코드 규칙을 따른다. 그래서 어디서나 같다. 사람이 읽기 좋은 정렬이 필요한 곳만 `COLLATE`로 따로 쓴다.
3. 시간대는 연결마다 정해지는 세션 설정이다. 기본값은 서버를 따르므로 로컬은 Asia/Seoul, CI는 UTC다. 그래서 `'2026-10-27'::timestamptz`나 `timestamptz::date`가 두 곳에서 9시간 다른 결과를 낸다.
4. 이 프로젝트는 파티션 경계와 시간 집계를 UTC로 정했다. 그래서 앱 연결은 UTC로 고정하고, 리포트의 시간대는 쿼리의 인자로 준다. 고정은 실수를 줄이는 장치일 뿐이라, 코드는 시각 글자에 늘 오프셋을 붙인다.

# event-analytics

마케터가 앱·웹의 행동 이벤트를 어떻게 볼지 설정해 그래프와 표로 보는 리포트 대시보드의 뒷단. 이벤트를 재전송에도 한 번만 저장하고, 리포트 설정(지표 × 차원 × 필터 × 기간 × 단위)을 안전한 SQL로 바꾸고, 수천만 건에서도 파티션과 시간 집계로 빠르게 답한다. PostgreSQL을 많은 데이터에서 운영하는 것이 목적이다.

> 0단계(뼈대) 진행 중. 설계: [docs/DESIGN.md](docs/DESIGN.md)

> Claude Code와 함께 만든다.

## 스택

TypeScript · Fastify · PostgreSQL 18 · zod · Vitest

## 로컬 실행

필요: Node.js 22.22 이상(24.x 권장).

```sh
npm ci
npm test
npm run dev   # API: http://127.0.0.1:3002
```

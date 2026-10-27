import { randomBytes } from "node:crypto";

// E2E의 API(DESIGN 6.7 E2E). Playwright는 준비(e2e:prepare, 소유자)와 같은 env를 주므로,
// 서버 코드가 읽는 process.env에서 소유자 주소를 지우고 띄운다. 서버는 앱 role(DATABASE_URL)로만 접속한다.
// 부모(sh·npm·tsx)의 환경과 이 프로세스의 처음 환경에는 남는다. webServer가 globalSetup보다 먼저 떠서 준비와 env를 나눌 수 없는 탓이다.
// 화면은 수집하지 않으므로 쓰기 키는 아무도 모르는 무작위 값이다(서버는 32자 미만이면 뜨지 않는다).
delete process.env.DATABASE_OWNER_URL;
process.env.INGEST_WRITE_KEY ??= randomBytes(32).toString("hex");
await import("./main.js");

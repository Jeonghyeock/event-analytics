import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig, devices } from "@playwright/test";

// E2E(DESIGN 6.7 E2E, 10장 55). 개발 서버와 겹치지 않게 다른 DB(event_analytics_e2e)와 포트(API 3102, 화면 5175)를 쓴다.
// 브라우저 쪽 주소는 모두 127.0.0.1 하나다(localhost를 IPv4·IPv6 중 어디로 푸는지가 도구마다 다르다).
const API_PORT = 3102;
const WEB_ORIGIN = "http://127.0.0.1:5175";

// 고정 데이터의 날: 한국 시각의 어제. 여기서 한 번 정해 준비(webServer.env)와 테스트(같은 process.env를 물려받는 worker)가 함께 쓴다.
// 준비와 테스트가 각자 계산하면 그 사이 한국 시각 자정을 넘을 때 어긋난다(설계 리뷰).
// 이미 있으면 두는 것은 worker가 이 파일을 다시 읽을 때 같은 값을 쓰게 하려는 장치다(밖에서 다른 날을 주는 기능이 아니다).
if (!process.env.E2E_DAY) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  process.env.E2E_DAY = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

// DB 주소는 환경 변수(CI), 없으면 저장소 .env에서 앱·소유자 주소 두 키만 읽는다(슈퍼유저 비밀번호를 webServer로 퍼뜨리지 않게).
const envFile = (() => {
  const file = new URL("../../.env", import.meta.url);
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
})();
function e2eDatabaseUrl(key: "DATABASE_URL" | "DATABASE_OWNER_URL") {
  const url = process.env[key] ?? envFile[key];
  if (!url) throw new Error(`${key}가 없습니다(.env 또는 환경 변수)`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // URL의 오류는 입력 전체(비밀번호 포함)를 담으므로 그대로 던지지 않는다(코드 리뷰)
    throw new Error(`${key}를 URL로 읽지 못했습니다`);
  }
  u.pathname = "/event_analytics_e2e";
  return u.toString();
}

// 저장소 맨 위. fileURLToPath는 드라이브 글자와 퍼센트 인코딩(공백·한글 경로)을 푼다.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: { baseURL: WEB_ORIGIN, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // API를 먼저 띄운다(DB 준비가 끝나 /health가 200이 된 뒤 화면을 띄운다). 띄울 때마다 DB를 새로 만들므로 이미 떠 있는 서버는 쓰지 않는다.
  webServer: [
    {
      // DB 준비(지우기·만들기·마이그레이션·파티션·고정 데이터)는 API를 띄우는 명령 안에서 한다. Playwright는 globalSetup보다 webServer를 먼저 띄운다.
      // 준비는 소유자, API는 앱 role로 접속한다. 두 명령이 env를 함께 받는다(Windows에는 VAR=x가 없어 여기서 준다).
      command: "npm run e2e:prepare -w @event-analytics/api && npm run e2e:serve -w @event-analytics/api",
      cwd: repoRoot,
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      // CI에서는 준비와 API의 로그를 보인다(실패하면 까닭을 볼 길이 이것뿐이다). 로컬에서는 요청마다 찍혀 시끄럽다.
      stdout: process.env.CI ? "pipe" : "ignore",
      env: {
        DATABASE_URL: e2eDatabaseUrl("DATABASE_URL"),
        DATABASE_OWNER_URL: e2eDatabaseUrl("DATABASE_OWNER_URL"),
        PORT: String(API_PORT),
        HOST: "127.0.0.1",
        E2E_DAY: process.env.E2E_DAY,
      },
    },
    {
      command: "npm run dev -w @event-analytics/web",
      cwd: repoRoot,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { WEB_HOST: "127.0.0.1", WEB_PORT: "5175", API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});

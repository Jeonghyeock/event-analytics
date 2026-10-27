import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 화면은 API와 같은 origin에 둔다(DESIGN 6.7). 개발에서는 Vite가 /api/*를 API로 넘기며 /api를 뗀다.
// 개발 화면은 5180, API는 127.0.0.1:3002다(seat-booking의 5173·3001과 겹치지 않게). E2E는 WEB_HOST, WEB_PORT, API_PROXY_TARGET으로 바꾼다.
// strictPort: 포트가 바쁘면 다음 포트로 옮기지 않고 실패한다(옮겨 가 다른 화면의 포트를 차지하지 않게).
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3002";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.WEB_HOST ?? "localhost",
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    proxy: {
      "^/api/": { target: apiTarget, rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  test: {
    environment: "jsdom",
    // E2E(Playwright) 파일을 잡지 않게 src 안의 테스트만 돈다.
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});

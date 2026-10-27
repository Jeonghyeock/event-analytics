import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLoadTemplate, RESULTS_DIR, TEMPLATE_DATABASE, TEMPLATE_INFO_FILE } from "./template.js";

// 측정 템플릿을 만든다(DESIGN 6.8, 10장 59). 원본은 소유자 주소의 DB(개발 DB)다. 원본을 쓰는 API·도구를 먼저 끈다.
//   npm run load:template -w @event-analytics/api
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
const source = new URL(ownerUrl).pathname.slice(1);

const started = performance.now();
const state = await buildLoadTemplate(ownerUrl, { source });
const seconds = Math.round((performance.now() - started) / 1000);
mkdirSync(fileURLToPath(RESULTS_DIR), { recursive: true });
writeFileSync(TEMPLATE_INFO_FILE, JSON.stringify({ template: TEMPLATE_DATABASE, source, seconds, state }, null, 2));
console.log(
  `${TEMPLATE_DATABASE}: ${source}에서 ${seconds}초, 파티션 ${state.partitions}개(${state.days.first}~${state.days.last}), ` +
    `행 약 ${Math.round(state.eventRows).toLocaleString()}, 워터마크 ${state.watermark}, 더러운 시간 ${state.dirtyHours}`,
);
console.log(`기록: ${fileURLToPath(TEMPLATE_INFO_FILE)}`);

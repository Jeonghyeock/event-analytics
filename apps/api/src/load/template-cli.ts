import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildLoadTemplate, checkSourceName, checkTemplateName, RESULTS_DIR, TEMPLATE_DATABASE, templateInfoFile } from "./template.js";

// 측정 템플릿을 만든다(DESIGN 6.8, 10장 59). 원본은 기본이 소유자 주소의 DB(개발 DB)다. 원본을 쓰는 API·도구를 먼저 끈다.
//   npm run load:template -w @event-analytics/api [-- --source <원본 DB> --template <템플릿 이름>]
// 5,000만 건은 개발 DB로 중간 템플릿을 만들고, 거기에 생성기로 더한 뒤, 그것을 원본으로 다시 만든다(load/README.md).
const { values } = parseArgs({ options: { source: { type: "string" }, template: { type: "string", default: TEMPLATE_DATABASE } } });
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) throw new Error("DATABASE_OWNER_URL이 없습니다(.env 또는 환경 변수)");
const source = checkSourceName(values.source ?? new URL(ownerUrl).pathname.slice(1));
const template = checkTemplateName(values.template);
const infoFile = templateInfoFile(template);

const started = performance.now();
const state = await buildLoadTemplate(ownerUrl, { source, template });
const seconds = Math.round((performance.now() - started) / 1000);
mkdirSync(fileURLToPath(RESULTS_DIR), { recursive: true });
writeFileSync(infoFile, JSON.stringify({ template, source, seconds, state }, null, 2));
console.log(
  `${template}: ${source}에서 ${seconds}초, 파티션 ${state.partitions}개(${state.days.first}~${state.days.last}), ` +
    `행 약 ${Math.round(state.eventRows).toLocaleString()}, 워터마크 ${state.watermark}, 더러운 시간 ${state.dirtyHours}`,
);
console.log(`기록: ${fileURLToPath(infoFile)}`);

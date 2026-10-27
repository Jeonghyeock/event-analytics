import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// 완료 기준(DESIGN 8장 6단계, 10장 55): 화면에서 설정한 리포트의 수가 고정 데이터(e2e-prepare-cli.ts)와 같다.
// 고정 데이터의 날은 playwright.config.ts가 정한 E2E_DAY(한국 시각의 어제)다. 테스트가 다시 계산하지 않는다.
const day = process.env.E2E_DAY!;

// 플랫폼별 이벤트 수. ios 7(e1 3, e4 3, e5 1), android 2(e2), web 1(e3). 값은 코드 포인트 순이다.
const platformRows = ["묶음플랫폼이벤트 수",`${day}android2`, `${day}ios7`, `${day}web1`, "합계10"];

test("리포트: 그날의 이벤트 수를 플랫폼별로 보면 고정 데이터와 같고, 저장해 다시 열어도 같다", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "리포트", exact: true })).toBeVisible();
  await page.getByLabel("시작", { exact: true }).fill(day);
  await page.getByLabel("끝", { exact: true }).fill(day);
  await page.getByLabel("차원 1").selectOption("platform");
  await page.getByRole("button", { name: "보기" }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveText(platformRows);
  // 그래프의 범례는 이벤트 수 순서다
  await expect(page.getByRole("list", { name: "계열" }).getByRole("listitem")).toHaveText(["ios", "android", "web"]);

  // 저장한다. 이름에 무작위 꼬리를 붙인다(CI의 재시도는 같은 DB를 쓴다).
  const name = `E2E 플랫폼별 ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("저장할 이름").fill(name);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(`"${name}"을(를) 저장했습니다.`);
  await expect(page).toHaveURL(/\/reports\?saved=/);

  // 다른 화면으로 갔다가 왼쪽 목록에서 다시 열면 그 설정으로 바로 세어 같은 수다
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "퍼널" }).click();
  await expect(page.getByRole("heading", { name: "퍼널" })).toBeVisible();
  await page.getByRole("navigation", { name: "저장한 리포트" }).getByRole("link", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { name: "리포트", exact: true })).toBeVisible();
  await expect(page.getByLabel("차원 1")).toHaveValue("platform");
  await expect(page.getByRole("table").getByRole("row")).toHaveText(platformRows);
  await expect(page.getByText("저장 안 된 변경")).toHaveCount(0);

  // 지우면 새 설정 화면으로 가고, "저장했습니다"가 남지 않는다(실제 브라우저에서만 드러난 순서 문제, #35 리뷰)
  await page.getByRole("button", { name: "지우기", exact: true }).click();
  await page.getByRole("button", { name: "정말 지우기" }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole("status")).toHaveText(`"${name}"을(를) 지웠습니다.`);
  await expect(page.getByText("저장했습니다")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "저장한 리포트" }).getByRole("link", { name: new RegExp(name) })).toHaveCount(0);
});

test("퍼널: 고정 데이터의 단계 수(4 → 3 → 2)와 첫 진입 기준 설명", async ({ page }) => {
  await page.goto("/funnels");
  await page.getByLabel("시작", { exact: true }).fill(day);
  await page.getByLabel("끝", { exact: true }).fill(day);
  // 단계는 그 기간의 이벤트 이름 목록에서 고른다
  await expect(page.getByLabel("1단계").getByRole("option", { name: "list_viewed" })).toBeAttached();
  await page.getByLabel("1단계").selectOption("list_viewed");
  await page.getByLabel("2단계").selectOption("seat_map_viewed");
  await page.getByRole("button", { name: "단계 더하기" }).click();
  await page.getByLabel("3단계").selectOption("paid");
  await page.getByRole("button", { name: "보기" }).click();
  // 진입(첫 list_viewed): e1·e2·e3·e4. 1시간 안의 seat_map_viewed: e1·e2·e4. 그 뒤 paid: e1·e4. e5는 진입이 없다.
  await expect(page.getByRole("table").getByRole("row")).toHaveText([
    "단계사용자 수앞 단계 대비1단계 대비",
    "1. list_viewed4100.0%",
    "2. seat_map_viewed375.0%75.0%",
    "3. paid266.7%50.0%",
  ]);
  await expect(page.getByText("첫 진입 기준 전환", { exact: true })).toBeVisible();
});

test("리텐션: 어제의 무리는 다섯 명이고, 1일째(오늘)는 아직 지나지 않아 빈칸이다", async ({ page }) => {
  await page.goto("/retention");
  await page.getByLabel("시작", { exact: true }).fill(day);
  await page.getByLabel("끝", { exact: true }).fill(day);
  await page.getByRole("button", { name: "보기" }).click();
  const row = page.getByRole("table").getByRole("row").nth(1);
  await expect(row.getByRole("rowheader")).toHaveText(day);
  // 무리 크기 5(e1~e5, 모든 이벤트). 1일째부터 7일째까지 모두 아직 지나지 않은 날이다
  await expect(row.getByRole("cell")).toHaveText(["5", "", "", "", "", "", "", ""]);
  await expect(row.getByRole("cell").nth(1)).toHaveAttribute("title", "아직 지나지 않은 날");
});

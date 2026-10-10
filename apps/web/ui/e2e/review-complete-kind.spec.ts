import { completedTask, expect, reviewTask, test } from "./fixtures";

test("审稿列表和历史页对有/无 complete_kind 的完成单都能正常显示", async ({ page, syntheticApi }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signed = { ...completedTask("aaaaaaaaaaa1", "签字通过产品"), complete_kind: "signed" };
  const rework = { ...completedTask("aaaaaaaaaaa2", "退回改稿产品"), complete_kind: "rework" };
  const legacy = completedTask("aaaaaaaaaaa3", "老记录产品");
  const unknown = { ...completedTask("aaaaaaaaaaa4", "未知方式产品"), complete_kind: "approved" };
  syntheticApi.tasks.push(signed, rework, legacy, unknown);

  await page.goto("/reviewup");
  for (const [product, state] of [["签字通过产品", "已通过"], ["退回改稿产品", "已退回"], ["老记录产品", "已提交"], ["未知方式产品", "已提交"]] as const) {
    const card = page.locator(".review-card").filter({ hasText: product });
    await expect(card.locator(".review-card-summary-state")).toHaveText(state);
  }

  await page.goto("/history");
  for (const product of ["签字通过产品", "退回改稿产品", "老记录产品", "未知方式产品"]) {
    await expect(page.getByRole("button", { name: `打开审稿记录：${product}` })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("复核单切换按钮写要去的那一版，旁边标签写当前这一版", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  task.pages_v2 = task.pages?.map((p) => ({ ...p, name: "synthetic-page-v2.svg" }));
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);

  // 有新稿时默认打开新稿。
  await expect(page.locator(".review-version-current")).toHaveText("当前：新稿");
  await page.getByRole("button", { name: "看旧稿", exact: true }).click();
  await expect(page.locator(".review-version-current")).toHaveText("当前：旧稿");
  await expect(page.getByRole("button", { name: "看新稿", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "看新稿", exact: true }).click();
  await expect(page.locator(".review-version-current")).toHaveText("当前：新稿");
});

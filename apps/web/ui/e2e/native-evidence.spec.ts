import { expect, reviewTask, test } from "./fixtures";

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wb_review_shortcuts_seen_v1", "1"));
});

for (const surface of [
  { name: "对照卡", spot: "on", scope: "review-spot" },
  { name: "右栏", spot: "off", scope: "review-dock" },
] as const) {
  test(`原稿文字和 OCR 分开展示，冲突不会自动提交人工结论（${surface.name}）`, async ({ page, syntheticApi }, info) => {
    await page.addInitScript((spot) => localStorage.setItem("wb_review_spot", spot), surface.spot);
    const task = reviewTask();
    task.hits![0].native_text_evidence = { version: 1, status: "conflict", native_text: "净含量 30ml", ocr_text: "净含量 80ml", message: "两种文字来源无法唯一对应，请对照稿面。" };
    syntheticApi.tasks.push(task);
    await page.goto(`/review/${task.id}`);
    const evidence = page.getByTestId(surface.scope).getByLabel("文字来源证据");
    await expect(evidence.getByRole("heading")).toHaveText("请确认文字来源");
    // 默认收起：原文不直接铺开。
    await expect(evidence.locator("details")).not.toHaveAttribute("open", "");
    await expect(evidence.getByText("净含量 30ml", { exact: true })).toBeHidden();
    await evidence.getByText("查看文字来源").click();
    await expect(evidence.getByText("净含量 30ml", { exact: true })).toBeVisible();
    await expect(evidence.getByText("净含量 80ml", { exact: true })).toBeVisible();
    expect(syntheticApi.calls.filter(call => call.path.endsWith("/decision"))).toHaveLength(0);
    expect(task.hits![0].decision).toBe("pending");
    await evidence.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`native-evidence-desktop-${surface.spot}.png`) });
  });
}

test("旧单不生成假来源，关稿未确认解释回退且不提供重开原生按钮", async ({ page, syntheticApi }) => {
  const task = reviewTask(); syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByLabel("文字来源证据")).toHaveCount(0);
  task.native_text = { status: "running", reason: "close_unconfirmed", message: "Illustrator 尚未确认关闭，本次继续图像识别，原生提取保持等待核实。" };
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "文字还在读取，请稍后查看。" })).toBeVisible();
  expect(syntheticApi.calls.filter(call => call.path.includes("native-text"))).toHaveLength(0);
});

// Value: protects=review panel explains that complete native coverage skipped OCR; fails_when=task ocr_meta is dropped or the native-only status copy is removed; why_new=existing evidence tests cover field cards but never the task-level no-OCR provenance banner; seam=none
test("原生覆盖完整时核对栏说明未调用 OCR", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  task.ocr_meta = { skipped: true, reason: "native_coverage", pages_ran: 0, engines: ["illustrator_native"] };
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByRole("status").filter({ hasText: "已直接读取原稿文字" })).toBeVisible();
});

test("窄屏深色长文字来源可展开阅读，未知版本不会显示成功", async ({ page, syntheticApi }, info) => {
  // <720 手机不做逐条核对（2026-10-11 已批第 16 行）；用 1024 浮层右栏验证长文字。
  await page.setViewportSize({ width: 1024, height: 844 });
  await page.addInitScript(() => localStorage.setItem("wb_review_spot", "off"));
  await page.addInitScript(() => localStorage.setItem("wb_appearance", JSON.stringify({ theme: "dark", fontPx: 20 })));
  const task = reviewTask();
  task.hits![0].native_text_evidence = { version: 1, status: "used", native_text: "生产地址与完整配方".repeat(60), ocr_text: "生产地址与配方".repeat(60), message: "已核对可见稿面及文字位置，原稿文字已参与现有核对规则。" };
  syntheticApi.tasks.push(task); await page.goto(`/review/${task.id}`);
  await page.getByTestId("review-dock").click();
  const evidence = page.getByTestId("review-dock").getByLabel("文字来源证据");
  await evidence.getByText("查看文字来源").click();
  await evidence.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("native-evidence-mobile.png") });
  task.hits![0].native_text_evidence = { version: 2, status: "used", native_text: "不能冒充成功" };
  await page.reload();
  await page.getByTestId("review-dock").click();
  await expect(page.getByTestId("review-dock").getByLabel("文字来源证据").getByRole("heading")).toHaveText("文字来源暂无法确认");
  await expect(page.getByText("不能冒充成功")).toHaveCount(0);
});

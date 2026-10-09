import { completedMockup, completedTask, expect, runningTask, test } from "./fixtures";

test("历史记录可用键盘打开审稿单", async ({ page, syntheticApi }) => {
  syntheticApi.tasks.push(completedTask("eeeeeeeeeeee", "键盘打开审稿"));
  await page.goto("/history");
  const open = page.getByRole("button", { name: "打开审稿记录：键盘打开审稿" });
  await open.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/review/eeeeeeeeeeee");
});

test("历史批删跳过进行中记录，并保留删除失败的部分结果", async ({ page, syntheticApi }) => {
  syntheticApi.tasks.push(completedTask("aaaaaaaaaaaa", "已签字审稿"), runningTask("bbbbbbbbbbbb", "正在对照审稿"));
  syntheticApi.mockups.push(completedMockup("cccccccccccc", "已出图打样"));
  syntheticApi.failDeletes.add("mockup:cccccccccccc");
  await page.goto("/history");
  await page.getByRole("button", { name: /^编\s*辑$/ }).click();
  await expect(page.getByRole("checkbox", { name: "选择 正在对照审稿" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "选择 已签字审稿" }).check();
  await page.getByRole("checkbox", { name: "选择 已出图打样" }).check();
  await page.getByRole("button", { name: "删除选中" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^删\s*除$/ }).click();
  await expect(page.getByText(/1 条未删除/)).toBeVisible();
  await expect(page.getByRole("button", { name: "打开审稿记录：已签字审稿" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "选择 已出图打样" })).toBeChecked();
});

test("窄屏批量栏和确认框保持视口居中", async ({ page, syntheticApi }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  syntheticApi.tasks.push(completedTask("dddddddddddd", "可全选审稿"));
  await page.goto("/history"); await page.getByRole("button", { name: /^编\s*辑$/ }).click();
  await page.locator(".history-bulkbar").getByRole("checkbox", { name: "全选本页" }).check();
  const box = await page.locator(".history-bulkbar").boundingBox();
  expect(Math.abs(box!.x + box!.width / 2 - 187.5)).toBeLessThan(3);
  await page.getByRole("button", { name: "删除选中" }).click();
  const dialog = await page.getByRole("dialog").boundingBox();
  expect(Math.abs(dialog!.x + dialog!.width / 2 - 187.5)).toBeLessThan(3);
});

test("只有进行中记录时不能全选删除", async ({ page, syntheticApi }) => {
  syntheticApi.tasks.push(runningTask("eeeeeeeeeeee", "正在处理中"));
  await page.goto("/history"); await page.getByRole("button", { name: /^编\s*辑$/ }).click();
  await expect(page.locator(".history-bulkbar").getByRole("checkbox", { name: "全选本页" })).toBeDisabled();
});

test("服务端分页每页十行，搜索重置第一页，不调用旧全量列表", async ({ page, syntheticApi }, info) => {
  for (let index = 1; index <= 23; index++) syntheticApi.tasks.push(completedTask(index.toString(16).padStart(12, "0"), `海葡萄批次 ${index}`));
  await page.goto("/history");
  const rows = page.locator(".ant-table-tbody > tr.ant-table-row");
  await expect(rows).toHaveCount(10);
  await page.screenshot({ path: info.outputPath("history-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "下一页" }).click(); await expect(page.getByText(/第 2 页/)).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click(); await expect(rows).toHaveCount(3);
  await page.getByLabel("搜索历史记录").fill("批次 23");
  await page.getByLabel("搜索历史记录").press("Enter");
  await expect(page.getByText(/第 1 页/)).toBeVisible(); await expect(rows).toHaveCount(1);
  expect(syntheticApi.calls.some(call => call.path === "/api/tasks" || call.path === "/api/mockups")).toBe(false);
  await page.reload();
  await expect(page.getByLabel("搜索历史记录")).toHaveValue("批次 23");
  await expect(rows).toHaveCount(1);
});

test("跨页选择保留，取消本页不清除其他页", async ({ page, syntheticApi }) => {
  for (let index = 1; index <= 12; index++) syntheticApi.tasks.push(completedTask(index.toString(16).padStart(12, "0"), `记录 ${index}`));
  await page.goto("/history"); await page.getByRole("button", { name: /^编\s*辑$/ }).click();
  await page.getByRole("checkbox", { name: "选择 记录 1", exact: true }).check();
  await page.getByRole("button", { name: "下一页" }).click();
  const select = page.locator(".history-bulkbar").getByRole("checkbox", { name: "全选本页" });
  await select.check(); await expect(page.getByText("已选 3 条")).toBeVisible();
  await select.uncheck(); await expect(page.getByText("已选 1 条")).toBeVisible();
  await page.getByRole("button", { name: "上一页" }).click();
  await expect(page.getByRole("checkbox", { name: "选择 记录 1", exact: true })).toBeChecked();
});

test("历史请求失败保留上次记录，重建索引自动继续", async ({ page, syntheticApi }) => {
  syntheticApi.tasks.push(completedTask("aaaaaaaaaaaa", "保留的历史记录"));
  await page.goto("/history");
  await expect(page.getByRole("button", { name: /打开审稿记录/ })).toBeVisible();
  let count = 0;
  await page.route("**/api/history?*", async route => {
    if (count++ < 2) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "rebuilding", code: "history_index_unavailable" }) });
    else await route.fallback();
  });
  await page.getByRole("button", { name: "刷新历史记录" }).click();
  await expect(page.getByText("正在整理历史记录，页面会自动继续加载。")).toBeVisible();
  await expect(page.getByRole("button", { name: /打开审稿记录/ })).toBeVisible();
  await expect(page.getByText("正在整理历史记录，页面会自动继续加载。")).toHaveCount(0, { timeout: 8000 });
  expect(count).toBeGreaterThanOrEqual(3);
});

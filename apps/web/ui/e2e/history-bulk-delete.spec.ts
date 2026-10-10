import { completedMockup, completedTask, expect, runningTask, test } from "./fixtures";
test.use({ timezoneId: "Asia/Shanghai" });

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
  await page.getByRole("button", { name: /管\s*理/ }).click();
  await expect(page.getByRole("checkbox", { name: "选择 正在对照审稿" })).toBeDisabled();
  await expect(page.getByRole("row").filter({ hasText: "正在对照审稿" }).getByText("处理完成后可删除")).toBeVisible();
  await page.getByRole("checkbox", { name: "选择 已签字审稿" }).check();
  await page.getByRole("checkbox", { name: "选择 已出图打样" }).check();
  await page.locator(".history-bulkbar").getByRole("button", { name: /^删\s*除$/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^删\s*除$/ }).click();
  await expect(page.getByText(/1 条未删除/)).toBeVisible();
  await expect(page.getByRole("button", { name: "打开审稿记录：已签字审稿" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "选择 已出图打样" })).toBeChecked();
});

test("本地日期快捷筛选和自定义时间跨刷新恢复，UI字段不传API", async ({ page, syntheticApi }) => {
  syntheticApi.tasks.push(completedTask("aaaaaaaaaaaa", "时间筛选合成记录"));
  await page.clock.setFixedTime(new Date("2026-01-02T16:30:00.000Z"));
  const queries: URLSearchParams[] = [];
  await page.route("**/api/history?*", async route => { queries.push(new URL(route.request().url()).searchParams); await route.fallback(); });
  await page.goto("/history");
  await page.getByRole("combobox", { name: "时间范围" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("近 7 天", { exact: true }).click();
  await expect(page.getByLabel("开始日期")).toHaveValue("2025-12-28");
  await expect(page.getByLabel("结束日期")).toHaveValue("2026-01-03");
  await page.reload();
  await expect(page.getByLabel("开始日期")).toHaveValue("2025-12-28");
  await page.getByRole("combobox", { name: "时间范围" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("自选时间", { exact: true }).click();
  await page.getByLabel("开始日期").fill("2025-12-30");
  await page.getByLabel("结束日期").fill("2026-01-02");
  await page.reload();
  await expect(page.getByLabel("开始日期")).toHaveValue("2025-12-30");
  await expect(page.getByLabel("结束日期")).toHaveValue("2026-01-02");
  await page.getByRole("combobox", { name: "时间范围" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("所有时间", { exact: true }).click();
  await expect(page.getByLabel("开始日期")).toHaveCount(0);
  await expect.poll(() => queries[queries.length - 1].has("date_from")).toBe(false);
  expect(queries.every(query => !query.has("time_mode"))).toBe(true);
  expect(queries.some(query => query.get("date_from") === "2025-12-28" && query.get("date_to") === "2026-01-03")).toBe(true);
});

test("未达10MB筛选使用虚拟状态，失败标签采用错误色", async ({ page }) => {
  let status = "";
  await page.route("**/api/history?*", async route => {
    const query = new URL(route.request().url()).searchParams;
    status = query.get("status") || "";
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [{ id: "aaaaaaaaaaaa", type: "compression", title: "未达标合成压缩", product_name: "", status: "failed", created_at: "2026-10-01T00:00:00.000Z", creator_id: "ou_e2e_synthetic", creator_name: "合成用户", names: ["target.pdf"], matched_names: [], visibility: "team" }], total: 1, next_cursor: null,
      facets: { type: { review: 0, mockup: 0, compression: 1, upload: 0 }, status: { failed: 1, unmet_target: 1 } } }) });
  });
  await page.goto("/history");
  await expect(page.locator(".ant-tag-error").getByText("失败", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "状态" }).click();
  await page.locator(".ant-select-dropdown:visible").getByText("压不到 10MB", { exact: true }).click();
  await expect.poll(() => status).toBe("unmet_target");
  await expect(page.locator(".ant-tag-error").getByText("失败", { exact: true })).toBeVisible();
  await page.reload();
  await expect.poll(() => status).toBe("unmet_target");
});

test("窄屏批量栏和确认框保持视口居中", async ({ page, syntheticApi }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  syntheticApi.tasks.push(completedTask("dddddddddddd", "可全选审稿"));
  await page.goto("/history"); await page.getByRole("button", { name: /管\s*理/ }).click();
  await page.locator(".history-bulkbar").getByRole("checkbox", { name: "全选本页" }).check();
  const box = await page.locator(".history-bulkbar").boundingBox();
  expect(Math.abs(box!.x + box!.width / 2 - 187.5)).toBeLessThan(3);
  await page.locator(".history-bulkbar").getByRole("button", { name: /^删\s*除$/ }).click();
  const dialog = await page.getByRole("dialog").boundingBox();
  expect(Math.abs(dialog!.x + dialog!.width / 2 - 187.5)).toBeLessThan(3);
});

test("只有进行中记录时不能全选删除", async ({ page, syntheticApi }) => {
  syntheticApi.tasks.push(runningTask("eeeeeeeeeeee", "正在处理中"));
  await page.goto("/history"); await page.getByRole("button", { name: /管\s*理/ }).click();
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
  await page.getByLabel("搜索历史").fill("批次 23");
  await page.getByLabel("搜索历史").press("Enter");
  await expect(page.getByText(/第 1 页/)).toBeVisible(); await expect(rows).toHaveCount(1);
  expect(syntheticApi.calls.some(call => call.path === "/api/tasks" || call.path === "/api/mockups")).toBe(false);
  await page.reload();
  await expect(page.getByLabel("搜索历史")).toHaveValue("批次 23");
  await expect(rows).toHaveCount(1);
});

test("跨页选择保留，取消本页不清除其他页", async ({ page, syntheticApi }) => {
  for (let index = 1; index <= 12; index++) syntheticApi.tasks.push(completedTask(index.toString(16).padStart(12, "0"), `记录 ${index}`));
  await page.goto("/history"); await page.getByRole("button", { name: /管\s*理/ }).click();
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
  await page.getByRole("button", { name: "刷新历史" }).click();
  await expect(page.getByText("正在加载记录…")).toBeVisible();
  await expect(page.getByRole("button", { name: /打开审稿记录/ })).toBeVisible();
  await expect(page.getByText("正在加载记录…")).toHaveCount(0, { timeout: 8000 });
  expect(count).toBeGreaterThanOrEqual(3);
});

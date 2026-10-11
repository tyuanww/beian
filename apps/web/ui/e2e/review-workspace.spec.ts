import { deflateSync } from "node:zlib";
import { expect, reviewTask, test } from "./fixtures";

// A 通铺核对页（2026-10-11 已批）：默认 1440 宽三栏常驻；快捷键条已看过。
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("ra-once")) localStorage.setItem("wb_review_shortcuts_seen_v1", "1"); });
});

const decisions = (api: { calls: Array<{ path: string; body?: unknown }> }) => api.calls.filter((item) => item.path.endsWith("/decision"));

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(width * 4 + 1, 0xff);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}


async function installWorkingFullscreen(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    let active: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => active,
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: function requestFullscreen() {
        active = this;
        queueMicrotask(() => document.dispatchEvent(new Event("fullscreenchange")));
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: function exitFullscreen() {
        active = null;
        queueMicrotask(() => document.dispatchEvent(new Event("fullscreenchange")));
        return Promise.resolve();
      },
    });
  });
}

test("三栏通铺：1440 稿件 ≥70%、右栏 320、工具条在画布下方；标有错写原因后退回走确认框", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  await installWorkingFullscreen(page);
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  await expect(dock.getByLabel("疑点列表")).toBeVisible();
  await expect(dock.getByText("Excel 应印", { exact: true })).toBeVisible();
  await expect(dock.getByText("稿上读到", { exact: true })).toBeVisible();
  await expect(dock.getByText("核对要点：")).toBeVisible();
  const ccol = (await page.locator(".review-ccol").boundingBox())!;
  const panel = (await dock.boundingBox())!;
  expect(panel.width).toBeCloseTo(320, 0);
  expect(ccol.width / 1440).toBeGreaterThanOrEqual(0.7);
  const canvas = (await page.locator(".review-ccol > .canvas").boundingBox())!;
  const tbar = (await page.locator(".review-tbar").boundingBox())!;
  expect(tbar.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
  await expect(page.locator(".shell")).toHaveClass(/is-review-flat/);
  // 已批第 39 行：主侧栏实心 #fbfafc，玻璃层不再盖在上面。
  await expect(page.locator(".shell .sidebar").first()).toHaveCSS("background-color", "rgb(251, 250, 252)");
  expect(await page.locator(".sidebar-glass").evaluateAll((els) => els.every((el) => getComputedStyle(el).display === "none"))).toBe(true);
  await expect(page.locator(".review-th")).toHaveText(/P1/);
  // visual-check #4：当前行底色 = --accent-soft #F6F1F8。
  await expect(page.getByTestId("review-dock").locator(".review-flat-list > li.is-on")).toHaveCSS("background-color", "rgb(246, 241, 248)");
  // visual-check #5：列表行分隔线 = --line #E7E2EC。
  await expect(page.getByTestId("review-dock").locator(".review-flat-list > li").first()).toHaveCSS("border-bottom-color", "rgb(231, 226, 236)");
  // visual-check #3：1440 常驻右栏 tabs 行也有「收起」，收起后右上出现「展开疑点」，再展开回到常驻。
  await page.getByRole("button", { name: "收起右栏" }).click();
  await expect(page.getByTestId("review-dock")).toHaveText(/^展开疑点 · 待确认/);
  await page.getByTestId("review-dock").click();
  await expect(page.locator(".review-sidebar:not(.is-overlay)")).toBeVisible();

  const sign = page.getByRole("button", { name: "签字", exact: true });
  await expect(sign).toBeDisabled();
  await expect(page.getByText("还有 1 条没下结论", { exact: true })).toBeVisible();
  // 签字禁用时退回不禁用；还有待确认时确认框挡住「确认退回」（服务端 /complete 要求先下完结论）。
  const rejectBtn = page.getByRole("button", { name: "退回", exact: true });
  await expect(rejectBtn).toBeEnabled();
  await rejectBtn.click();
  const pendingDialog = page.getByRole("dialog");
  await expect(pendingDialog.getByText("还有 1 条没下结论")).toBeVisible();
  await expect(pendingDialog.getByRole("button", { name: "确认退回" })).toBeDisabled();
  await pendingDialog.getByRole("button", { name: "再看看" }).click();
  await expect(pendingDialog).toBeHidden();
  await expect(page.getByLabel("写原因")).toHaveCount(0);

  await page.getByRole("button", { name: "全屏" }).click();
  await expect(page.getByRole("button", { name: "退出" })).toBeVisible();
  await dock.getByRole("button", { name: /^有错/ }).click();
  await expect.poll(() => decisions(syntheticApi).length).toBe(1);
  await expect(page.getByTestId("review-undo-toast")).toHaveText("已标为有错，撤销");
  const reason = page.getByLabel("写原因");
  await reason.fill("需要补齐中文品名");
  await reason.press("Enter");
  await expect.poll(() => decisions(syntheticApi).length).toBe(2);
  await page.getByRole("button", { name: "退出" }).click();

  await expect(sign).toBeDisabled();
  await page.getByRole("button", { name: "退回", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("退回这份稿？")).toBeVisible();
  await expect(dialog.getByText("有错的 1 条会随退回一起发出，并通知「已退回」。提交后不能撤回。")).toBeVisible();
  await expect(dialog.getByLabel("有错清单")).toContainText("中文品名");
  await expect(dialog.getByText("没写原因")).toHaveCount(0);
  await dialog.getByLabel("补充说明（选填）").fill("请设计今天改完");
  await expect(dialog.getByRole("button", { name: "再看看" })).toBeVisible();
  await dialog.getByRole("button", { name: "确认退回" }).click();
  await expect(page.locator(".ant-alert").getByText("已退回。", { exact: true })).toBeVisible();
  expect(decisions(syntheticApi).at(-1)?.body).toMatchObject({ hit_id: "hit_name", decision: "issue", note: "需要补齐中文品名" });
  expect(syntheticApi.calls.find((item) => item.path.endsWith("/complete"))?.body).toEqual({ conclusion: "请设计今天改完" });
});

test("按 1 标一致自动跳下一条并跨页；打字时快捷键不生效；位置写 n/N", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd53");
  const pageOne = task.pages?.[0];
  if (!pageOne) throw new Error("合成核对单缺少页面");
  task.pages = [pageOne, { ...pageOne, url: `${pageOne.url}#page-2`, name: "synthetic-page-2.svg", page: 2 }];
  task.hits = [
    { id: "hit_one", field: "中文品名", status: "疑点", page: 1, decision: "pending", bilingual_pair_id: "name-pair", bboxes: [{ page: 1, left: 40, top: 50, width: 120, height: 40, role: "check" }] },
    { id: "hit_two", field: "英文品名", status: "缺失", page: 1, decision: "pending", bilingual_pair_id: "name-pair", bboxes: [{ page: 1, left: 280, top: 90, width: 150, height: 45, role: "check" }] },
    { id: "hit_three", field: "净含量", status: "疑点", page: 2, decision: "pending", bboxes: [{ page: 2, left: 90, top: 180, width: 100, height: 35, role: "check" }] },
  ];
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  const pins = page.locator(".canvas-zoom .pin");
  await expect(pins).toHaveCount(1);
  await expect(pins).toHaveText("1");
  await expect(page.getByTestId("review-posn")).toHaveText("1/3");
  // 标记放在框外角，不压框。
  const pin = (await pins.boundingBox())!;
  const box = (await page.locator(".canvas-zoom .hit-box.is-on").first().boundingBox())!;
  const overlaps = pin.x < box.x + box.width && pin.x + pin.width > box.x && pin.y < box.y + box.height && pin.y + pin.height > box.y;
  expect(overlaps).toBe(false);

  await page.keyboard.press("1");
  await expect(dock.getByRole("button", { name: /英文品名/ })).toHaveAttribute("aria-current", "true");
  await expect(pins).toHaveText("2");
  await expect(page.getByTestId("review-undo-toast")).toHaveText("已标为一致，撤销");
  await page.keyboard.press("1");
  await expect(dock.getByRole("button", { name: /净含量/ })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("button", { name: "第2页，看完" })).toHaveAttribute("aria-current", "page");
  await expect(pins).toHaveText("3");
  await page.keyboard.press("2");
  await expect.poll(() => decisions(syntheticApi).length).toBe(3);
  await page.getByLabel("写原因").fill("123");
  await expect.poll(() => decisions(syntheticApi).length).toBe(3);
  await expect(page.getByRole("button", { name: "第2页，1 处有错" })).toBeVisible();
});

test("撤销把结论改回原来那个并回到该条", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd57");
  task.hits![0].decision = "issue";
  task.hits!.push({ id: "hit_b", field: "净含量", status: "疑点", page: 1, decision: "pending", bboxes: [{ page: 1, left: 300, top: 300, width: 80, height: 30, role: "check" }] });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const dock = page.getByTestId("review-dock");
  await dock.getByRole("tab", { name: /全部/ }).click();
  await dock.getByRole("button", { name: /中文品名/ }).click();
  await dock.getByRole("button", { name: /^忽略/ }).click();
  await expect(dock.getByRole("button", { name: /净含量/ })).toHaveAttribute("aria-current", "true");
  await page.getByTestId("review-undo-toast").getByRole("button", { name: "撤销" }).click();
  await expect.poll(() => decisions(syntheticApi).at(-1)?.body).toMatchObject({ hit_id: "hit_name", decision: "issue" });
  await expect(dock.getByRole("button", { name: /中文品名/ })).toHaveAttribute("aria-current", "true");
});

test("记录结论失败时保留当前疑点；断网提示「没连上网，这条没存上」且不排队", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd54");
  task.hits?.push({ id: "hit_next", field: "净含量", status: "疑点", page: 1, decision: "pending", bboxes: [{ page: 1, left: 300, top: 200, width: 80, height: 30, role: "check" }] });
  syntheticApi.tasks.push(task);
  syntheticApi.failNextDecision = true;
  await page.goto(`/review/${task.id}`);

  const current = page.getByTestId("review-dock").getByRole("button", { name: /中文品名/ });
  await expect(current).toHaveAttribute("aria-current", "true");
  await page.getByTestId("review-dock").getByRole("button", { name: /^一致/ }).click();
  await expect(page.getByText("未保存：合成记录失败", { exact: true })).toBeVisible();
  await expect(current).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".canvas-zoom .pin")).toHaveText("1");

  // 断网：请求到不了服务器（fetch 抛 TypeError）。合成路由在网络层之前，用 abort 模拟。
  await page.route("**/api/tasks/*/decision", (route) => route.abort("internetdisconnected"));
  await page.getByTestId("review-dock").getByRole("button", { name: /^一致/ }).click();
  await expect(page.getByText("未保存：没连上网，这条没存上", { exact: true })).toBeVisible();
  await expect(current).toHaveAttribute("aria-current", "true");
  await page.unroute("**/api/tasks/*/decision");
  await page.waitForTimeout(500);
  expect(decisions(syntheticApi)).toHaveLength(1);
});

test("签字确认框文案；提交失败不关框并可重试；签字后锁定", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd58");
  task.hits![0].decision = "confirm";
  syntheticApi.tasks.push(task);
  syntheticApi.failNextComplete = true;
  await page.goto(`/review/${task.id}`);
  await expect(page.getByRole("button", { name: "退回", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "签字", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("签字这份稿？")).toBeVisible();
  await expect(dialog.getByText("签字后会通知「已签字」，不能撤回。")).toBeVisible();
  await dialog.getByRole("button", { name: "确认签字" }).click();
  await expect(dialog.getByText("没提交成功，请重试")).toBeVisible();
  await dialog.getByRole("button", { name: "重试" }).click();
  await expect(page.locator(".ant-alert").getByText("已签字。", { exact: true })).toBeVisible();
  expect(syntheticApi.calls.filter((c) => c.path.endsWith("/complete")).at(-1)?.body).toEqual({ conclusion: "无改稿项" });
  await expect(page.getByRole("button", { name: "签字", exact: true })).toBeDisabled();
});

test("已被别人签字：用 completed_by 锁定只读", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd59");
  task.status = "completed";
  task.complete_kind = "signed";
  task.completed_by = "天元（魏炜）";
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByText("🔒 已被天元（魏炜）签字")).toBeVisible();
  await expect(page.getByRole("button", { name: "签字", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "退回", exact: true })).toBeDisabled();
});

test("零疑点：右栏写没发现问题，签字可点", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd50");
  task.hits = [{ ...task.hits![0], status: "一致", decision: "confirm", coverage: { hit: ["合成核对单"], miss: [], matched: 1, total: 1 } }];
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByText("✓ 没发现问题")).toBeVisible();
  await expect(page.getByRole("button", { name: "签字", exact: true })).toBeEnabled();
  await expect(page.locator(".canvas-zoom")).toHaveCSS("transform", "none");
});

test("浏览器拒绝核对全屏时显示可执行中文提示", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: () => Promise.reject(new Error("synthetic fullscreen denial")) });
  });
  await page.goto(`/review/${task.id}`);
  await page.getByRole("button", { name: "全屏" }).click();
  await expect(page.getByText("全屏打不开")).toBeVisible();
  await expect(page.getByRole("button", { name: "全屏" })).toHaveAttribute("aria-pressed", "false");
});

test("矢量失败自动切回 PNG 并提示高清没加载出来；两张都坏写稿件没加载出来 + 重试", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd48");
  task.pages = [{ url: "/synthetic/review.svg", raster_url: "/synthetic/review.png", name: "page_01.svg", page: 1, width: 600, height: 800 }];
  syntheticApi.tasks.push(task);
  await page.route("**/synthetic/review.svg", (route) => route.abort("failed"));
  let pngOk = true;
  await page.route("**/synthetic/review.png", (route) => (pngOk ? route.fulfill({ status: 200, contentType: "image/png", body: solidPng(600, 800) }) : route.abort("failed")));
  await page.goto(`/review/${task.id}`);
  const image = page.locator(".canvas-zoom img");
  await expect.poll(() => image.getAttribute("src")).toBe("/synthetic/review.png");
  await expect(page.getByText("高清没加载出来")).toBeVisible();
  pngOk = false;
  await page.reload();
  await expect(page.getByText("稿件没加载出来")).toBeVisible();
  await expect(page.getByTestId("review-dock")).toBeVisible();
  pngOk = true;
  await page.locator(".review-media-status").getByRole("button", { name: "重试" }).click();
  await expect.poll(() => image.getAttribute("src")).toBe("/synthetic/review.png");
});

test("<1440 右栏默认收起，展开为 320 浮层并平移让当前标记露出来", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd49");
  task.hits![0].bboxes = [{ page: 1, left: 380, top: 300, width: 200, height: 45, role: "check" }];
  syntheticApi.tasks.push(task);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/review/${task.id}`);
  const tab = page.getByTestId("review-dock");
  await expect(tab).toHaveText("展开疑点 · 待确认 1");
  // 已批第 40 行：1280 宽稿件列 1176px（1280 − 主侧栏 52 − 缩略图条 52）。
  expect((await page.locator(".review-ccol").boundingBox())!.width).toBeCloseTo(1176, 0);
  await tab.click();
  const aside = page.locator(".review-sidebar.is-overlay");
  await expect(aside).toBeVisible();
  expect((await aside.boundingBox())!.width).toBeCloseTo(320, 0);
  await expect.poll(async () => {
    const pin = await page.locator(".canvas-zoom .pin.is-on").boundingBox();
    const panel = await aside.boundingBox();
    return Boolean(pin && panel && pin.x + pin.width <= panel.x);
  }).toBe(true);
  await page.getByRole("button", { name: "收起右栏" }).click();
  await expect(page.getByTestId("review-dock")).toHaveText(/展开疑点/);
  for (const width of [1024, 736]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("快捷键条只在首次打开出现，按 ? 再看", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd52");
  syntheticApi.tasks.push(task);
  await page.addInitScript(() => { if (!sessionStorage.getItem("ra-once")) { sessionStorage.setItem("ra-once", "1"); localStorage.removeItem("wb_review_shortcuts_seen_v1"); } });
  await page.goto(`/review/${task.id}`);
  const keys = page.getByRole("note").filter({ hasText: "快捷键" });
  await expect(keys).toBeVisible();
  await keys.getByRole("button", { name: "知道了" }).click();
  await page.reload();
  await expect(keys).toHaveCount(0);
  await page.keyboard.press("?");
  await expect(keys).toBeVisible();
});

test("忽略悬停有说明；写原因只在选了有错后出现，刷新保留未保存原因", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd55");
  const hit = task.hits![0];
  task.hits = Array.from({ length: 24 }, (_, i) => ({ ...hit, id: `hit_${i}`, field: `字段 ${i + 1}`, decision: i % 2 ? "confirm" : "pending" }));
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const dock = page.getByTestId("review-dock");
  await expect(dock.getByRole("tab", { name: /待确认/ })).toContainText("12");
  await expect(dock.locator(".review-flat-list > li")).toHaveCount(12);
  await dock.getByRole("button", { name: /^忽略/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("机器标错了");
  await expect(page.getByLabel("写原因")).toHaveCount(0);
  await page.keyboard.press("2");
  await page.getByLabel("写原因").fill("未提交的长原因，刷新后继续");
  await page.reload();
  await dock.getByRole("tab", { name: /有错/ }).click();
  await expect(page.getByLabel("写原因")).toHaveValue("未提交的长原因，刷新后继续");
  await expect(page.getByText("先保存备注，再继续。")).toBeVisible();
});

test("手机 <720：只看稿和签字/退回，注明逐条下结论仅电脑端，不横向溢出", async ({ page, syntheticApi }, testInfo) => {
  const task = reviewTask("e5969b58cd56");
  task.hits![0].decision = "issue";
  syntheticApi.tasks.push(task);
  await page.addInitScript(() => localStorage.setItem("wb_appearance", JSON.stringify({ theme: "dark", fontPx: 20 })));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/review/${task.id}`);
  await expect(page.getByText("逐条下结论仅电脑端")).toBeVisible();
  await expect(page.locator(".review-flat-list")).toHaveCount(0);
  await expect(page.getByText(/有错 1 条/)).toBeVisible();
  const reject = page.getByRole("button", { name: "退回", exact: true });
  await expect(reject).toBeEnabled();
  expect((await reject.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("review-mobile-dark.png") });
});

test("深色主题：状态标签用 dark-tags.md 专用亮版，深底上过 AA（已批第 38 行）", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const tag = page.getByTestId("review-dock").locator(".ant-tag.t-pend").first();
  await expect(tag).toHaveCSS("color", "rgb(242, 180, 76)");
  await expect(tag).toHaveCSS("background-color", "rgb(67, 51, 46)");
  const ratio = await tag.evaluate((el) => {
    const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const st = getComputedStyle(el);
    const a = lum(rgb(st.color)); const b = lum(rgb(st.backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

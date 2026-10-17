import { PUBLIC_UPLOAD_BYTES, UPLOAD_TOO_LARGE } from "../src/uploadLimit";
import { deflateSync } from "node:zlib";
import { expect, reviewTask, test } from "./fixtures";

// A 通铺核对页（2026-10-11 已批）：默认 1440 宽三栏常驻；快捷键条已看过。
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("ra-once")) localStorage.setItem("wb_review_shortcuts_seen_v1", "1");
    localStorage.setItem("wb_review_spot", "off");
  });
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
  await expect(page.getByTestId("review-dock")).toHaveText("展开疑点 · 待确认 1");
  await page.getByTestId("review-dock").click();
  await expect(page.locator(".review-sidebar:not(.is-overlay)")).toBeVisible();

  const sign = page.getByRole("button", { name: "签字", exact: true });
  await expect(sign).toBeDisabled();
  // 与服务端 /complete 拦截同一句（按状态分开数）。
  await expect(page.getByText("仍有 1 条疑点未处理", { exact: true })).toBeVisible();
  await expect(sign).toHaveAttribute("title", "仍有 1 条疑点未处理");
  await expect(page.getByTestId("review-reject-note")).toHaveText("还有 1 条待确认，处理完才能退回");
  // 签字禁用时退回不禁用；还有待确认时确认框挡住「确认退回」（服务端 /complete 要求先下完结论）。
  const rejectBtn = page.getByRole("button", { name: "退回", exact: true });
  await expect(rejectBtn).toBeEnabled();
  await rejectBtn.click();
  const pendingDialog = page.getByRole("dialog");
  // 提示放在框顶（标题下第一段），打字前就看到。
  await expect(pendingDialog.locator(".ant-modal-body > :first-child")).toHaveText("还有 1 条待确认，处理完才能退回");
  await expect(pendingDialog.getByRole("button", { name: "确认退回" })).toBeDisabled();
  // qa #3：交不了时补充说明也禁用，避免白写；提示「还有 N 条待确认，处理完才能退回」。
  await expect(pendingDialog.getByLabel("补充说明（选填）")).toBeDisabled();
  await pendingDialog.getByRole("button", { name: "再看看" }).click();
  await expect(pendingDialog).toBeHidden();
  await expect(page.getByLabel("写原因")).toHaveCount(0);

  await page.getByRole("button", { name: "全屏" }).click();
  await expect(page.getByRole("button", { name: "退出" })).toBeVisible();
  await dock.getByRole("button", { name: /^有错/ }).click();
  await expect.poll(() => decisions(syntheticApi).length).toBe(1);
  await expect(page.getByTestId("review-undo-toast")).toHaveText("已标为有错，撤销");
  const undoBox = (await page.getByTestId("review-undo-toast").getByRole("button", { name: "撤销" }).boundingBox())!;
  expect(Math.min(undoBox.width, undoBox.height)).toBeGreaterThanOrEqual(44);
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
  // 待确认清零后位置不写「1/1」。
  await expect(page.getByTestId("review-posn")).toHaveText("全部已下结论");
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
  await expect(page.getByText("🔒 这一单已被天元（魏炜）签字")).toBeVisible();
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
  // F-004：工具条按下态 accent-soft 底 + accent 描边。
  const pressed = page.locator('.review-tbar > button[aria-pressed="true"]').first();
  if (await pressed.count()) {
    await expect(pressed).toHaveCSS("background-color", "rgb(246, 241, 248)");
    await expect(pressed).toHaveCSS("border-top-color", "rgb(128, 88, 152)");
  }
  // 「重试」点击区 ≥44（T14）。
  expect((await page.locator(".review-media-hint button").boundingBox())!.height).toBeGreaterThanOrEqual(44);
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
  await expect(page.getByTestId("review-unsaved-hint")).toHaveText("备注未保存，请先保存");
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
  // visual-check #7：底部导航「审稿台 / 历史」，签字/退回在它上方不重叠。
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("button", { name: "审稿台" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button", { name: "历史" })).toBeEnabled();
  const navBox = (await nav.boundingBox())!;
  expect(navBox.y + navBox.height).toBeCloseTo(844, 0);
  expect((await reject.boundingBox())!.y + 44).toBeLessThanOrEqual(navBox.y + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("review-mobile-dark.png") });
  await nav.getByRole("button", { name: "历史" }).click();
  await expect(page).toHaveURL(/history/);
});

test("深色主题：状态标签用 dark-tags.md 专用亮版，深底上过 AA（已批第 38 行）", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  // 走真实外观设置：页面加载后 AppearanceRoot 的 effect 会按已存外观重写 html[data-theme]，
  // 之前在 goto 之后手改 DOM 属性，满负载下会被这次重写成浅色覆盖掉（竞态，约 2/10 失败）。
  await page.addInitScript(() => localStorage.setItem("wb_appearance", JSON.stringify({ theme: "dark" })));
  await page.goto(`/review/${task.id}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
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

test("768 宽页头不折行，退回/签字靠右（design F-002）", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/review/${task.id}`);
  const top = (await page.locator(".review-top").boundingBox())!;
  expect(top.height).toBeLessThanOrEqual(64);
  const sign = (await page.getByRole("button", { name: "签字", exact: true }).boundingBox())!;
  const reject = (await page.getByRole("button", { name: "退回", exact: true }).boundingBox())!;
  expect(top.x + top.width - (sign.x + sign.width)).toBeLessThanOrEqual(24);
  expect(Math.abs(reject.y - sign.y)).toBeLessThan(2);
  // <1024 隐藏签字旁「仍有 N 条…未处理」，改为签字按钮悬停说明（同一句）。
  await expect(page.locator(".review-signhint")).toBeHidden();
  await expect(page.getByRole("button", { name: "签字", exact: true })).toHaveAttribute("title", "仍有 1 条疑点未处理");
  await expect(page.getByTestId("review-reject-note")).toHaveText("还有 1 条待确认，处理完才能退回");
  await expect(page.getByRole("button", { name: "退回", exact: true })).toHaveAttribute("title", "还有 1 条待确认，处理完才能退回");
  expect((await page.locator(".review-title").boundingBox())!.height).toBeLessThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("连点确认签字只发一次 /complete（同步防重入）", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd60");
  task.hits![0].decision = "confirm";
  syntheticApi.tasks.push(task);
  syntheticApi.completeDelayMs = 600;
  await page.goto(`/review/${task.id}`);
  await page.getByRole("button", { name: "签字", exact: true }).click();
  const ok = page.getByRole("dialog").getByRole("button", { name: "确认签字" });
  await ok.evaluate((el: HTMLElement) => { el.click(); el.click(); el.click(); });
  await expect(page.locator(".ant-alert").getByText("已签字。", { exact: true })).toBeVisible();
  expect(syntheticApi.calls.filter((c) => c.path.endsWith("/complete"))).toHaveLength(1);
});

test("提交失败按状态码映射：409 还在检查；400 重读后还有待确认 / 已被别人签字并锁页", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd61");
  task.hits![0].decision = "confirm";
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  syntheticApi.completeFailStatus = 409;
  await page.getByRole("button", { name: "签字", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认签字" }).click();
  await expect(dialog.getByText("这份稿还在检查，等一会儿再提交")).toBeVisible();
  await expect(dialog.getByText("对照还在排队")).toHaveCount(0);

  // 服务端那边又多出一条没下结论（别的窗口改的）→ 400，重读后写「还有 1 条待确认」。
  Object.assign(task.hits![0], { status: "疑点", decision: "pending" });
  await dialog.getByRole("button", { name: "重试" }).click();
  await expect(dialog.getByText("还有 1 条待确认，处理完才能签字")).toBeVisible();
  await expect(dialog.getByText("仍有")).toHaveCount(0);
  await dialog.getByRole("button", { name: "再看看" }).click();
});

test("已被别人签字：提交 400 后重读锁页并提示「这一单已被某某签字」", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd62");
  task.hits![0].decision = "confirm";
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  syntheticApi.otherCompletesNext = { by: "天元", kind: "signed" };
  await page.getByRole("button", { name: "签字", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认签字" }).click();
  // 提示（toast）和锁页横幅现在同文案，分开断言，避免 strict mode 撞两个元素。
  await expect(page.locator(".ant-message")).toContainText("这一单已被天元签字");
  await expect(page.locator(".review-lock")).toContainText("这一单已被天元签字");
  await expect(page.getByRole("button", { name: "签字", exact: true })).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("下结论/撤销时任务已被别人完成：重读后锁页，不报没存上", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd63");
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  syntheticApi.otherCompletesNext = { by: "天元", kind: "rework" };
  await page.getByTestId("review-dock").getByRole("button", { name: /^一致/ }).click();
  await expect(page.locator(".review-lock")).toContainText("已被天元退回");
  await expect(page.getByTestId("review-dock").getByRole("button", { name: /^有错/ })).toBeDisabled();
  await expect(page.getByText("没连上网，这条没存上")).toHaveCount(0);
});

test("按住数字键的自动重复不算", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd64");
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByTestId("review-dock")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", repeat: true, bubbles: true })));
  await page.waitForTimeout(300);
  expect(syntheticApi.calls.filter((c) => c.path.endsWith("/decision"))).toHaveLength(0);
});

for (const mode of [{ theme: "dark", scheme: "light" as const }, { theme: "system", scheme: "dark" as const }]) {
  test(`页头品名/位置/面包屑在深色可读（外观=${mode.theme}，系统=${mode.scheme}）`, async ({ page, syntheticApi }) => {
    const task = reviewTask("e5969b58cd6" + (mode.theme === "dark" ? "5" : "6"));
    syntheticApi.tasks.push(task);
    await page.emulateMedia({ colorScheme: mode.scheme });
    await page.addInitScript((theme) => localStorage.setItem("wb_appearance", JSON.stringify({ theme })), mode.theme);
    await page.goto(`/review/${task.id}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const ratios = await page.evaluate(() => {
      const rgb = (s: string) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bg = rgb(getComputedStyle(document.querySelector(".review-top")!).backgroundColor);
      return [".review-title", "[data-testid=review-posn]", ".review-crumb"].map((s) => {
        const el = document.querySelector(s);
        if (!el) return 99;
        const a = lum(rgb(getComputedStyle(el).color)), b = lum(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    });
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
  });
}

for (const theme of ["light", "dark"]) {
  test(`禁用的「签字」文字对比度 ≥4.5（${theme}）`, async ({ page, syntheticApi }) => {
    const task = reviewTask(theme === "light" ? "e5969b58cd67" : "e5969b58cd68");
    syntheticApi.tasks.push(task);
    await page.addInitScript((t) => localStorage.setItem("wb_appearance", JSON.stringify({ theme: t })), theme);
    await page.goto(`/review/${task.id}`);
    const sign = page.getByRole("button", { name: "签字", exact: true });
    await expect(sign).toBeDisabled();
    await expect(sign).toHaveCSS("opacity", "1");
    const ratio = await sign.evaluate((el) => {
      const rgb = (s: string) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const c = getComputedStyle(el);
      const a = lum(rgb(c.color)), b = lum(rgb(c.backgroundColor));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
}

for (const [w, h] of [[1440, 900], [1280, 800], [768, 1024], [390, 844]]) {
  test(`默认整页适配进画布，不自动放大（${w}）`, async ({ page, syntheticApi }) => {
    const task = reviewTask(`e5969b58c${w}`.slice(0, 12).padEnd(12, "0"));
    syntheticApi.tasks.push(task);
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/review/${task.id}`);
    const img = page.locator(".canvas-view img").first();
    await expect(img).toBeVisible();
    await page.waitForTimeout(400);
    const view = (await page.locator(".canvas-view").boundingBox())!;
    const box = (await img.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(view.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(view.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height + 1);
  });
}

test("「上传新稿」不在看稿工具条，只在退回后出现在页头", async ({ page, syntheticApi }) => {
  const open = reviewTask("e5969b58cd80");
  const back = reviewTask("e5969b58cd81");
  Object.assign(back, { status: "completed", board: "done", complete_kind: "rework", completed_by: "E2E 审核" });
  syntheticApi.tasks.push(open, back);
  await page.goto(`/review/${open.id}`);
  await expect(page.locator(".review-tbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "上传新稿" })).toHaveCount(0);
  await page.goto(`/review/${back.id}`);
  await expect(page.locator(".review-top").getByRole("button", { name: "上传新稿" })).toBeVisible();
  await expect(page.locator(".review-tbar").getByRole("button", { name: "上传新稿" })).toHaveCount(0);
});

test("「?」悬停说明写「快捷键」；‹ › 点击区 ≥44px", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd82");
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByRole("button", { name: "快捷键" })).toHaveAttribute("title", "快捷键");
  for (const name of ["上一条", "下一条"]) {
    const b = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
});

test.describe("已被别人完成：锁页文案 + 完成时间（固定上海时区格式，浏览器时区设成洛杉矶也不受影响）", () => {
  test.use({ timezoneId: "America/Los_Angeles" });
  const cases = [
    { id: "e5969b58cd90", now: "2026-10-11T10:30:00Z", kind: "signed", at: "2026-10-11T10:20:00Z", want: "这一单已被天元签字 18:20" },
    { id: "e5969b58cd91", now: "2026-10-11T10:30:00Z", kind: "rework", at: "2026-10-09T10:20:00Z", want: "这一单已被天元退回，等新稿 10月9日 18:20" },
    { id: "e5969b58cd92", now: "2026-10-11T10:30:00Z", kind: undefined, at: "2026-10-11T10:20:00Z", want: "这一单已被天元处理 18:20" },
    { id: "e5969b58cd93", now: "2026-10-11T10:30:00Z", kind: "signed", at: undefined, want: "这一单已被天元签字" },
    // 上海已过零点（10-12 00:30），完成在上海 10-11 23:50；洛杉矶两者同一天，若误用浏览器时区会写成「08:50」。
    { id: "e5969b58cd94", now: "2026-10-11T16:30:00Z", kind: "signed", at: "2026-10-11T15:50:00Z", want: "这一单已被天元签字 10月11日 23:50" },
    { id: "e5969b58cd95", now: "2026-10-11T10:30:00Z", kind: "signed", at: "2025-10-09T10:20:00Z", want: "这一单已被天元签字 2025年10月9日 18:20" },
  ];
  for (const c of cases) {
    test(c.want, async ({ page, syntheticApi }) => {
      await page.clock.setFixedTime(new Date(c.now));
      const task = reviewTask(c.id);
      Object.assign(task, { status: "completed", board: "done", completed_by: "天元", complete_kind: c.kind, completed_at: c.at });
      syntheticApi.tasks.push(task);
      await page.goto(`/review/${task.id}`);
      await expect(page.locator(".review-lock")).toContainText(`🔒 ${c.want}`);
      const title = await page.locator(".review-lock .ant-alert-title").innerText();
      expect(title.trim()).toBe(`🔒 ${c.want}`);
      await expect(page.getByRole("button", { name: "签字", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "上传新稿" })).toHaveCount(c.kind === "rework" ? 1 : 0);
    });
  }

  test("提交时才发现被别人退回：重读后提示并锁页，页头出现「上传新稿」", async ({ page, syntheticApi }) => {
    await page.clock.setFixedTime(new Date("2026-10-11T10:30:00Z"));
    const task = reviewTask("e5969b58cd96");
    task.hits![0].decision = "confirm";
    syntheticApi.tasks.push(task);
    await page.goto(`/review/${task.id}`);
    syntheticApi.otherCompletesNext = { by: "天元", kind: "rework", at: "2026-10-11T10:20:00Z" };
    await page.getByRole("button", { name: "签字", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认签字" }).click();
    await expect(page.locator(".ant-message")).toContainText("这一单已被天元退回，等新稿 18:20");
    await expect(page.locator(".review-lock")).toContainText("这一单已被天元退回，等新稿 18:20");
    await expect(page.locator(".review-top").getByRole("button", { name: "上传新稿" })).toBeVisible();
  });
});

for (const theme of ["light", "dark"]) {
  test(`锁页时签字/退回都按禁用样式显示且点不动（${theme}）`, async ({ page, syntheticApi }) => {
    const task = reviewTask(theme === "light" ? "e5969b58cda0" : "e5969b58cda1");
    Object.assign(task, { status: "completed", board: "done", completed_by: "天元", complete_kind: "signed" });
    syntheticApi.tasks.push(task);
    await page.addInitScript((t) => localStorage.setItem("wb_appearance", JSON.stringify({ theme: t })), theme);
    await page.goto(`/review/${task.id}`);
    await expect(page.locator(".review-lock")).toBeVisible();
    const styles: string[] = [];
    for (const name of ["签字", "退回"]) {
      const b = page.getByRole("button", { name, exact: true });
      await expect(b).toBeDisabled();
      await expect(b).toHaveCSS("opacity", "1");
      const r = await b.evaluate((el) => {
        const rgb = (s: string) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const lum = ([r, g, b]: number[]) => { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const c = getComputedStyle(el); const a = lum(rgb(c.color)), d = lum(rgb(c.backgroundColor));
        return { ratio: (Math.max(a, d) + 0.05) / (Math.min(a, d) + 0.05), key: [c.color, c.backgroundColor, c.borderTopColor, c.borderTopWidth, c.borderTopStyle, c.borderRadius, c.boxShadow, c.opacity].join("|") };
      });
      expect(r.ratio).toBeGreaterThanOrEqual(4.5);
      styles.push(r.key);
      await b.click({ force: true });
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    expect(styles[0]).toBe(styles[1]);
  });
}

test("锁页横幅：只留 🔒 一个图标，第二行写「只能查看，不能再改」", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cda2");
  Object.assign(task, { status: "completed", board: "done", completed_by: "天元", complete_kind: "signed" });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const lock = page.locator(".review-lock");
  await expect(lock.locator(".ant-alert-description")).toHaveText("只能查看，不能再改");
  await expect(lock.locator(".ant-alert-icon")).toHaveCount(0);
  await expect(lock.locator(".ant-alert-title")).toHaveText("🔒 这一单已被天元签字");
});

test("锁页：页头位置写「当前/总数」不写「全部已下结论」；右栏待确认空态写「没有待确认的了」，和列表同左内边距", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cda3");
  for (const h of task.hits!) Object.assign(h, { status: "一致", decision: undefined });
  Object.assign(task, { status: "completed", board: "done", completed_by: "天元", complete_kind: "signed" });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByTestId("review-posn")).toHaveText(`1/${task.hits!.length}`);
  const none = page.locator(".review-dock-none");
  await expect(none).toHaveText("没有待确认的了");
  await expect(none).toHaveCSS("padding-left", "16px");
  await expect(none).toHaveCSS("padding-top", "16px");
});

test("手机 390 不显示「审稿台 /」面包屑，底部导航仍有「审稿台」", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cda4");
  syntheticApi.tasks.push(task);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/review/${task.id}`);
  await expect(page.locator(".review-flat-page.is-phone")).toBeVisible();
  await expect(page.locator(".review-crumb")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "审稿台", exact: true })).toBeVisible();
});

test("退回后「上传新稿」选了超过公网上限的 PDF：直接提示，不发 /rework 请求", async ({ page, syntheticApi }, testInfo) => {
  const fs = await import("node:fs");
  const big = testInfo.outputPath("too-large.pdf");
  const fd = fs.openSync(big, "w");
  fs.ftruncateSync(fd, PUBLIC_UPLOAD_BYTES + 1); // 稀疏文件，不真占盘
  fs.closeSync(fd);
  const task = reviewTask("e5969b58cda5");
  Object.assign(task, { status: "completed", board: "done", complete_kind: "rework", completed_by: "E2E 审核" });
  syntheticApi.tasks.push(task);
  let reworkRequests = 0;
  page.on("request", (r) => { if (/\/api\/tasks\/[^/]+\/rework/.test(r.url())) reworkRequests += 1; });
  await page.goto(`/review/${task.id}`);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".review-top").getByRole("button", { name: "上传新稿" }).click();
  await (await chooser).setFiles(big);
  await expect(page.locator(".ant-message")).toContainText(UPLOAD_TOO_LARGE);
  await page.waitForTimeout(300);
  expect(reworkRequests).toBe(0);
  expect(syntheticApi.calls.filter((c) => c.path.endsWith("/rework"))).toHaveLength(0);
});

test("锁页后收起撤销提示", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cda7");
  task.hits!.push({ ...task.hits![0], id: "hit-second", field: "第二条" });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await page.getByTestId("review-dock").getByRole("button", { name: /^有错/ }).first().click();
  await expect(page.getByTestId("review-undo-toast")).toBeVisible();
  // 不靠计时：在页面里记下锁页条第一次出现那一刻撤销提示还在不在。
  // 提示自身 5 秒后自动消失、antd 退出动画约 0.3 秒（靠 animationend 删节点，忙时更久），都不该参与判定。
  await page.evaluate(() => {
    const w = window as unknown as { __undoAtLock?: boolean };
    const observer = new MutationObserver(() => {
      if (!document.querySelector(".review-lock")) return;
      w.__undoAtLock = Boolean(document.querySelector("[data-testid=review-undo-toast]"));
      observer.disconnect();
    });
    observer.observe(document.body, { subtree: true, childList: true });
  });
  syntheticApi.otherCompletesNext = { by: "天元", kind: "signed" };
  await page.getByTestId("review-dock").getByRole("button", { name: /^一致/ }).first().click();
  await expect(page.locator(".review-lock")).toBeVisible();
  // 锁页那一次渲染里提示就卸掉了：不重试、不等待。
  expect(await page.evaluate(() => (window as unknown as { __undoAtLock?: boolean }).__undoAtLock)).toBe(false);
  expect(await page.getByTestId("review-undo-toast").count()).toBe(0);
});

test("对照：每条框出范围，对照窗贴在当前框右侧，右栏只留清单", async ({ page, syntheticApi }) => {
  await page.addInitScript(() => localStorage.setItem("wb_review_spot", "on"));
  const task = reviewTask("e5969b58cdb8");
  task.hits = [
    {
      id: "hit_name", field: "中文品名", status: "疑点", excel: "合成核对单", pdf: "合成核对", page: 1, decision: "pending", excel_row_count: 1, excel_standard: "合成核对单", manuscript: "合成核对",
      bboxes: [
        { page: 1, left: 30, top: 70, width: 190, height: 44, role: "range" },
        { page: 1, left: 140, top: 80, width: 60, height: 24, role: "hit" },
      ],
    },
    {
      id: "hit_net", field: "净含量", status: "疑点", excel: "30ml", pdf: "30 ml", page: 1, decision: "pending",
      bboxes: [{ page: 1, left: 40, top: 130, width: 90, height: 28, role: "hit" }],
    },
    {
      id: "hit_note", field: "生产批号", status: "疑点", excel: "无", pdf: "", page: 1, decision: "pending", bboxes: [],
    },
  ];
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  const card = page.getByTestId("review-spot");
  await expect(page.getByRole("button", { name: "对照", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dock.getByLabel("疑点列表")).toBeVisible();
  await expect(dock.locator(".review-flat-detail")).toHaveCount(0);
  await expect(card.getByText("Excel标准", { exact: true })).toBeVisible();
  await expect(card.getByText("稿上读到", { exact: true })).toBeVisible();
  await expect(card).toContainText("合成核对单");
  // 标题字段名在前：「中文品名 · 疑点 · 待确认 1/3」。
  const spotTitle = card.getByTestId("review-spot-title");
  await expect(spotTitle).toHaveText(/^中文品名\s*·\s*疑点 · 待确认 1\/3$/);
  await expect(spotTitle).toHaveAttribute("aria-label", "中文品名 · 疑点 · 待确认 1/3");
  await expect(spotTitle.locator(".review-spot-field")).toHaveAttribute("title", "中文品名");
  // 对照只画当前这条：一个范围框 + 一个错点。
  await expect(page.locator(".hit-range")).toHaveCount(1);
  await expect.poll(async () => {
    const box = await page.locator(".hit-range.is-on").boundingBox();
    const spot = await card.boundingBox();
    if (!box || !spot) return false;
    return spot.x >= box.x + box.width - 2 && spot.y < box.y + box.height;
  }).toBe(true);

  await card.getByRole("button", { name: "下一项" }).click();
  await expect(card).toContainText("30ml");
  await expect(spotTitle).toHaveAttribute("aria-label", "净含量 · 疑点 · 待确认 2/3");
  await expect(page.locator(".hit-range")).toHaveCount(0);

  await dock.getByRole("button", { name: /生产批号/ }).click();
  await expect(card).toHaveCount(0);
  await expect(dock.getByText("Excel 应印", { exact: true })).toBeVisible();
  await expect(dock.locator(".review-evidence-location")).toHaveText("没找到位置，请看整页");

  await dock.getByRole("button", { name: /中文品名/ }).click();
  await card.getByRole("button", { name: /^有错/ }).click();
  await expect.poll(() => decisions(syntheticApi).length).toBe(1);
  await expect(page.getByTestId("review-undo-toast")).toHaveText("已标为有错，撤销");
});

test("对照：标题字段名过长时截断，悬停能看全名", async ({ page, syntheticApi }) => {
  await page.addInitScript(() => localStorage.setItem("wb_review_spot", "on"));
  const task = reviewTask("e5969b58cdb9");
  const longName = "中文品名（含英文名称及规格型号说明，用于备案核对的超长字段名称示例）";
  task.hits = [{
    id: "hit_long", field: longName, status: "疑点", excel: "合成核对单", pdf: "合成核对", page: 1, decision: "pending",
    bboxes: [{ page: 1, left: 40, top: 80, width: 90, height: 28, role: "hit" }],
  }];
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const title = page.getByTestId("review-spot").getByTestId("review-spot-title");
  const field = title.locator(".review-spot-field");
  await expect(field).toHaveAttribute("title", longName);
  await expect(title).toHaveAttribute("aria-label", `${longName} · 疑点 · 待确认 1/1`);
  await expect(title.locator(".review-spot-rest")).toBeVisible();
  await expect.poll(() => field.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("待人工确认单独一组：不混进待确认列表，审核人能展开看到", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cdc1");
  task.verbatim_check = true;
  task.hits!.push({ ...task.hits![0], id: "hit_held", field: "认不准的字", status: "待人工确认", evidence: "OCR 没读全，需要人眼确认" });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const dock = page.getByTestId("review-dock");
  await expect(page.getByTestId("review-held-line")).toHaveText("另有 1 处待人工确认");
  await expect(dock.getByLabel("疑点列表")).toContainText("中文品名");
  await expect(dock.getByLabel("疑点列表")).not.toContainText("认不准的字");
  const bar = dock.getByTestId("review-held-bar");
  await expect(bar).toHaveText("待人工确认 1");
  await bar.click();
  const group = dock.getByTestId("review-held-group");
  await expect(group).toBeVisible();
  await expect(group).toContainText("认不准的字");
  await expect(group).not.toContainText("中文品名");
});

test("超页：后端回 job_error_code=page_over 时显示黄色提醒", async ({ page, syntheticApi }, info) => {
  const task = reviewTask("e5969b58cd60");
  task.status = "compare_failed";
  task.board = "failed";
  task.job_status = "failed";
  task.job_error = "这一单页数超过可核对页数";
  task.job_error_code = "page_over";
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const alert = page.locator(".ant-alert").filter({ hasText: "稿件超过 1 页，暂不支持核对，请联系管理员" });
  await expect(alert).toBeVisible();
  await expect(alert).toHaveClass(/ant-alert-warning/);
  await page.screenshot({ path: info.outputPath("page-over-warning.png") });
});

test("超页：报错文案像超页但没有 page_over 码时不显示超页提醒", async ({ page, syntheticApi }, info) => {
  const task = reviewTask("e5969b58cd61");
  task.status = "compare_failed";
  task.board = "failed";
  task.job_status = "failed";
  task.job_error = "稿件超过 1 页，暂不支持核对，请联系管理员";
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.locator(".ant-alert-error").first()).toBeVisible();
  await expect(page.locator(".ant-alert-warning")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("page-over-no-code-error.png") });
});

test("失败单：顶部不显示结论进度，只显示失败原因", async ({ page, syntheticApi }, info) => {
  const task = reviewTask("e5969b58cd62");
  task.status = "compare_failed";
  task.board = "failed";
  task.job_status = "failed";
  task.job_error = "稿件超过 1 页，暂不支持核对，请联系管理员";
  task.job_error_code = "page_over";
  task.hits = [];
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.locator(".ant-alert").filter({ hasText: "稿件超过 1 页，暂不支持核对，请联系管理员" })).toBeVisible();
  await expect(page.getByTestId("review-posn")).toHaveCount(0);
  await expect(page.getByText("全部已下结论")).toHaveCount(0);
  await expect(page.locator(".review-th").first()).toContainText("P1");
  await expect(page.locator(".review-th-w")).toHaveCount(0);
  await expect(page.getByText(/这单还剩 \d+ 条待确认/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复制修改清单" })).toHaveCount(0);
  await expect(page.getByText("检查未完成，暂时没有结果")).toBeVisible();
  await expect(page.locator(".ant-alert").getByText("重新上传这一单")).toBeVisible();
  await page.screenshot({ path: info.outputPath("failed-no-progress.png") });
});

test("复核失败但条目还在：失败条照常显示，进度、翻页、剩余条数和修改清单都保留", async ({ page, syntheticApi }, info) => {
  const task = reviewTask("e5969b58cd63");
  task.job_kind = "rework";
  task.status = "pending_review";
  task.job_status = "failed";
  task.job_error = "对照中断";
  syntheticApi.tasks.push(task);
  expect(task.hits?.length).toBeGreaterThan(0);
  await page.goto(`/review/${task.id}`);
  const reworkAlert = page.locator(".ant-alert-error").filter({ hasText: "复核出了问题，下面是上一轮的结果，可以重新上传这一单" });
  await expect(reworkAlert).toBeVisible();
  await expect(page.getByTestId("review-posn")).toBeVisible();
  await expect(page.getByRole("button", { name: "上一条" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一条" })).toBeVisible();
  await expect(page.getByText(/这单还剩 \d+ 条待确认/)).toBeVisible();
  await expect(page.getByRole("button", { name: "复制修改清单" })).toBeVisible();
  // 合成登录是管理员：服务端 /rework 对管理员不看归属，失败条里给「重新上传这一单」。
  await expect(reworkAlert.getByRole("button", { name: "重新上传这一单" })).toBeVisible();
  await expect(page.locator("button.review-sign")).toHaveCount(0);
  await expect(page.locator("button.review-reject")).toHaveCount(0);
  await expect(page.getByTestId("review-reject-note")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("rework-failed.png") });
});

test("compare_failed 带上一轮条目（reclaimTask 边角单）：进度、翻页、条目和修改清单照常显示", async ({ page, syntheticApi }, info) => {
  const task = reviewTask("e5969b58cd64");
  task.status = "compare_failed";
  task.board = "failed";
  task.job_kind = "compare";
  task.job_status = "failed";
  task.job_error = "对照中断";
  task.error = "对照中断";
  syntheticApi.tasks.push(task);
  expect(task.hits?.length).toBeGreaterThan(0);
  await page.goto(`/review/${task.id}`);
  const alert = page.locator(".ant-alert-error").first();
  await expect(alert.locator(".ant-alert-title")).toHaveText("检查中断了，下面是上一轮的结果，可以重新上传这一单");
  await expect(alert.getByRole("button", { name: "重新上传这一单" })).toBeVisible();
  await expect(page.getByTestId("review-posn")).toBeVisible();
  await expect(page.getByRole("button", { name: "上一条" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一条" })).toBeVisible();
  await expect(page.locator(".review-th-w").first()).toBeVisible();
  await expect(page.locator(".review-dock-panel").getByText("中文品名").first()).toBeVisible();
  await expect(page.locator(".review-dock-none")).toHaveCount(0);
  await expect(page.getByText(/这单还剩 \d+ 条待确认/)).toBeVisible();
  await expect(page.getByRole("button", { name: "复制修改清单" })).toBeVisible();
  await expect(page.getByText("全部已下结论")).toHaveCount(0);
  await expect(page.locator("button.review-sign")).toHaveCount(0);
  await expect(page.locator("button.review-reject")).toHaveCount(0);
  await expect(page.getByTestId("review-reject-note")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("compare-failed-with-hits.png") });
});

test("签字/退回按钮定位器在正常待审单上能找到（失败单断言不存在的对照）", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd65");
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.locator("button.review-sign")).toHaveCount(1);
  await expect(page.locator("button.review-reject")).toHaveCount(1);
  await expect(page.getByTestId("review-reject-note")).toHaveText(/还有 \d+ 条待确认，处理完才能退回/);
});

test("复核超页且条目还在：黄条写明这次复核没做，条里给重新上传，条目和进度保留", async ({ page, syntheticApi }, info) => {
  const task = reviewTask("e5969b58cd66");
  task.job_kind = "rework";
  task.status = "pending_review";
  task.job_status = "failed";
  task.job_error = "这一单页数超过可核对页数";
  task.job_error_code = "page_over";
  syntheticApi.tasks.push(task);
  expect(task.hits?.length).toBeGreaterThan(0);
  await page.goto(`/review/${task.id}`);
  const alert = page.locator(".ant-alert-warning").filter({ hasText: "稿件超过 1 页，这次复核没做，下面是上一轮的结果，可以重新上传这一单" });
  await expect(alert).toBeVisible();
  await expect(page.locator(".ant-alert-error")).toHaveCount(0);
  await expect(alert.getByRole("button", { name: "重新上传这一单" })).toBeVisible();
  await expect(page.getByTestId("review-posn")).toBeVisible();
  await expect(page.locator(".review-th-w").first()).toBeVisible();
  await expect(page.locator(".review-dock-panel").getByText("中文品名").first()).toBeVisible();
  await expect(page.getByText(/这单还剩 \d+ 条待确认/)).toBeVisible();
  await expect(page.getByRole("button", { name: "复制修改清单" })).toBeVisible();
  await expect(page.getByTestId("review-reject-note")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("rework-page-over.png") });
});

import { deflateSync } from "node:zlib";
import { expect, reviewTask, test } from "./fixtures";

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


async function expectCurrentBoxInCanvas(page: import("@playwright/test").Page) {
  await expect.poll(async () => {
    const view = await page.locator(".canvas-view").boundingBox();
    const box = await page.locator(".canvas-zoom .hit-box.is-on").first().boundingBox();
    const tools = await page.locator(".canvas-tools").boundingBox();
    const covered = Boolean(box && tools && box.x < tools.x + tools.width && box.x + box.width > tools.x && box.y < tools.y + tools.height && box.y + box.height > tools.y);
    return Boolean(view && box && !covered && box.x >= view.x && box.y >= view.y && box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height);
  }).toBe(true);
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

test("右栏与画布同屏，全屏后仍在核对页内，处理疑点后可签字", async ({
  page,
  syntheticApi,
}) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  await installWorkingFullscreen(page);
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  await expect(dock).toBeVisible();
  expect(await dock.evaluate((node) => Boolean(node.closest(".review-workspace")))).toBe(true);
  await expect(dock.getByLabel("疑点列表")).toBeVisible();
  await expect(dock.getByText("Excel 应印", { exact: true })).toBeVisible();
  await expect(dock.getByText("稿上读到", { exact: true })).toBeVisible();
  const canvas = await page.locator(".review-workspace > .canvas").boundingBox();
  const sidebar = await dock.boundingBox();
  expect(sidebar!.x).toBeGreaterThanOrEqual(canvas!.x + canvas!.width);
  const room = (await page.locator(".review-workspace").boundingBox())!;
  expect(sidebar!.width).toBe(Math.min(448, room.width - 488));
  await expect.poll(() => page.locator(".canvas-zoom").evaluate((node) => getComputedStyle(node).transform))
    .not.toBe("none");
  expect(
    await dock.locator(".review-evidence-grid").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length),
  ).toBe(2);

  await page.getByRole("button", { name: "全屏核对" }).click();
  await expect(page.getByRole("button", { name: "退出全屏" })).toBeVisible();
  expect(await dock.evaluate((node) => Boolean(node.closest(".review-page.is-fullscreen")))).toBe(true);
  await page.getByLabel("核对结论").click();
  const decisionPopup = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await expect(decisionPopup).toBeVisible();
  expect(
    await decisionPopup.evaluate((node) => Boolean(node.closest(".review-page.is-fullscreen"))),
  ).toBe(true);
  await decisionPopup.getByText("有错", { exact: true }).click();
  await expect.poll(() => syntheticApi.calls.filter((item) => item.path.endsWith("/decision")).length).toBe(1);

  const noteInput = page.getByPlaceholder("补充说明，会进改稿清单");
  await noteInput.fill("需要补齐中文品名");
  await noteInput.press("Enter");
  await expect.poll(() => syntheticApi.calls.filter((item) => item.path.endsWith("/decision")).length).toBe(2);

  await page.getByRole("button", { name: "退出全屏" }).click();
  await expect(page.getByRole("button", { name: "全屏核对" })).toBeVisible();
  expect(await dock.evaluate((node) => Boolean(node.closest(".review-workspace")))).toBe(true);

  await page.getByRole("textbox", { name: "结论", exact: true }).fill("中文品名需要设计改稿");
  await page.getByRole("button", { name: "签字并待设计改稿" }).click();

  await expect(page.getByText("已签字，不是系统过审")).toBeVisible();
  const decisionCalls = syntheticApi.calls.filter((item) => item.path.endsWith("/decision"));
  const decisionCall = decisionCalls.at(-1);
  const completeCall = syntheticApi.calls.find((item) => item.path.endsWith("/complete"));
  expect(decisionCall?.body).toMatchObject({
    hit_id: "hit_name",
    decision: "issue",
    note: "需要补齐中文品名",
  });
  expect(completeCall?.body).toEqual({ conclusion: "中文品名需要设计改稿" });
});

test("同页只亮当前疑点，确认后依次前进并跨页定位", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd53");
  const pageOne = task.pages?.[0];
  if (!pageOne) throw new Error("合成核对单缺少页面");
  task.pages = [pageOne, { ...pageOne, url: `${pageOne.url}#page-2`, name: "synthetic-page-2.svg", page: 2 }];
  task.hits = [
    {
      id: "hit_one",
      field: "中文品名",
      status: "疑点",
      page: 1,
      decision: "pending",
      bilingual_pair_id: "name-pair",
      bboxes: [{ page: 1, left: 40, top: 50, width: 120, height: 40, role: "check" }],
    },
    {
      id: "hit_two",
      field: "英文品名",
      status: "缺失",
      page: 1,
      decision: "pending",
      bilingual_pair_id: "name-pair",
      bboxes: [{ page: 1, left: 280, top: 90, width: 150, height: 45, role: "check" }],
    },
    {
      id: "hit_three",
      field: "净含量",
      status: "疑点",
      page: 2,
      decision: "pending",
      bboxes: [{ page: 2, left: 90, top: 180, width: 100, height: 35, role: "check" }],
    },
  ];
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  const canvasPins = page.locator(".canvas-zoom .pin");
  const canvasBoxes = page.locator(".canvas-zoom .hit-box");
  await expect(canvasPins).toHaveCount(1);
  await expect(canvasBoxes).toHaveCount(1);
  await expect(canvasPins).toHaveText("1");

  await page.getByLabel("核对结论").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText("一致", { exact: true }).click();
  await expect(dock.getByRole("button", { name: /英文品名/ })).toHaveAttribute("aria-current", "true");
  await expect(canvasPins).toHaveCount(1);
  await expect(canvasPins).toHaveText("2");

  await page.getByLabel("核对结论").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText("一致", { exact: true }).click();
  await expect(dock.getByRole("button", { name: /净含量/ })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("button", { name: "第 2 页" })).toHaveClass(/btn-primary/);
  await expect(canvasPins).toHaveCount(1);
  await expect(canvasPins).toHaveText("3");
});

test("记录结论失败时保留当前疑点和页面", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd54");
  task.hits?.push({
    id: "hit_next",
    field: "净含量",
    status: "疑点",
    page: 1,
    decision: "pending",
    bboxes: [{ page: 1, left: 300, top: 200, width: 80, height: 30, role: "check" }],
  });
  syntheticApi.tasks.push(task);
  syntheticApi.failNextDecision = true;
  await page.goto(`/review/${task.id}`);

  const current = page.getByTestId("review-dock").getByRole("button", { name: /中文品名/ });
  await expect(current).toHaveAttribute("aria-current", "true");
  await page.getByLabel("核对结论").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText("一致", { exact: true }).click();
  await expect(page.getByText("未保存：合成记录失败", { exact: true })).toBeVisible();
  await expect(current).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".canvas-zoom .pin")).toHaveText("1");
});

test("浏览器拒绝核对全屏时显示可执行中文提示", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new Error("synthetic fullscreen denial")),
    });
  });
  await page.goto(`/review/${task.id}`);

  await page.getByRole("button", { name: "全屏核对" }).click();
  await expect(page.getByText("全屏打不开")).toBeVisible();
  await expect(page.getByRole("button", { name: "全屏核对" })).toHaveAttribute("aria-pressed", "false");
  expect(await page.getByTestId("review-dock").evaluate((node) => Boolean(node.closest(".review-workspace")))).toBe(true);
});

test("一致字段没有疑点时只显示 Excel 应印与稿上读到两列", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd50");
  const hit = task.hits?.[0];
  if (!hit) throw new Error("合成核对单缺少字段");
  task.hits = [{
    ...hit,
    status: "一致",
    decision: "confirm",
    coverage: { hit: ["合成核对单"], miss: [], matched: 1, total: 1 },
  }];
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);

  const grid = page.getByTestId("review-dock").locator(".review-evidence-grid");
  await expect(grid.getByText("疑点 / 错误点", { exact: true })).toHaveCount(0);
  await expect(grid.getByText("Excel 应印", { exact: true })).toBeVisible();
  await expect(grid.getByText("稿上读到", { exact: true })).toBeVisible();
  expect(await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(2);
  await expect(page.locator(".canvas-zoom")).toHaveCSS("transform", "none");
});

test("矢量核对页加载失败时自动切回高清 PNG", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd48");
  task.pages = [
    {
      url: "/synthetic/review.svg",
      raster_url: "/synthetic/review.png",
      name: "page_01.svg",
      page: 1,
      width: 600,
      height: 800,
    },
  ];
  syntheticApi.tasks.push(task);
  await page.route("**/synthetic/review.svg", (route) => route.abort("failed"));
  await page.route("**/synthetic/review.png", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: solidPng(600, 800),
    }),
  );

  await page.goto(`/review/${task.id}`);

  const image = page.locator(".canvas-zoom img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.getAttribute("src")).toBe("/synthetic/review.png");
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(600);
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalHeight)).toBeGreaterThanOrEqual(800);
});

test("右栏拖动与键盘调宽，刷新恢复，窄屏不覆盖桌面偏好", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd49");
  syntheticApi.tasks.push(task);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/review/${task.id}`);
  const dock = page.getByTestId("review-dock");
  const separator = page.getByRole("separator", { name: "调整右侧核对栏宽度" });
  await expect(separator).toHaveAttribute("aria-valuenow", "448");
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + 4, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x - 28, handle.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "480");
  await separator.focus();
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "496");
  await page.reload();
  await expect(separator).toHaveAttribute("aria-valuenow", "496");
  await expectCurrentBoxInCanvas(page);
  expect((await page.locator(".canvas-zoom .pin").boundingBox())!.width).toBeCloseTo(28, 0);
  for (const width of [320, 390, 736, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".sidebar")).toHaveClass(/is-collapsed/);
    await expect.poll(async () => {
      const workspace = page.locator(".review-workspace");
      const room = (await workspace.boundingBox())!;
      const canvas = (await page.locator(".review-workspace > .canvas").boundingBox())!;
      const panel = (await dock.boundingBox())!;
      return room.width < 808 ? panel.y >= canvas.y + canvas.height : panel.x >= canvas.x + canvas.width;
    }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectCurrentBoxInCanvas(page);
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(separator).toHaveAttribute("aria-valuenow", "496");
});

test("收起核对栏不遮挡画布，隐藏内容不进入键盘导航，刷新记住折叠", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd52");
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const dock = page.getByTestId("review-dock");
  await dock.getByRole("button", { name: "收起", exact: true }).click();
  await expect(dock).toHaveClass(/is-shut/);
  await expect(page.getByLabel("核对结论")).toBeHidden();
  await page.reload();
  await expect(dock).toHaveClass(/is-shut/);
  await dock.getByRole("button", { name: "展开核对栏" }).click();
  await expect(page.getByLabel("核对结论")).toBeVisible();
  await expect(page.locator(".canvas-zoom .pin")).toHaveCount(1);
});

test("24项疑点支持待确认筛选、目录、跨项与刷新恢复当前字段及未保存备注", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd55");
  const hit = task.hits![0];
  task.hits = Array.from({ length: 24 }, (_, i) => ({ ...hit, id: `hit_${i}`, field: `字段 ${i + 1}`, decision: i % 2 ? "confirm" : "pending" }));
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  const dock = page.getByTestId("review-dock");
  await dock.getByLabel("仅看待确认").check();
  await expect(dock.locator(".review-issue-directory .hit-card")).toHaveCount(12);
  await dock.getByRole("button", { name: "下一待确认", exact: true }).click();
  await expect(dock.locator(".review-current-title")).toHaveText("字段 3");
  await page.getByLabel("人工备注").fill("未提交的长备注，刷新后继续");
  await page.reload();
  await expect(dock.locator(".review-current-title")).toHaveText("字段 3");
  await expect(page.getByLabel("人工备注")).toHaveValue("未提交的长备注，刷新后继续");
  expect(syntheticApi.calls.filter((call) => call.path.endsWith("/decision"))).toHaveLength(0);
  await page.getByLabel("核对结论").click();
  await page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").getByText("有错", { exact: true }).click();
  await expect(page.getByText("备注已与服务器同步")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("人工备注")).toHaveValue("未提交的长备注，刷新后继续");
});

test("大字号和深色下长文本可核对，保存失败的备注刷新仍在", async ({ page, syntheticApi }, testInfo) => {
  const task = reviewTask("e5969b58cd56");
  task.hits![0].field = "生产企业地址与备案信息";
  task.hits![0].excel = "上海市某区某路一百二十三号研发中心三层，生产企业与委托方信息需要逐项核对。".repeat(8);
  task.hits![0].decision = "issue";
  syntheticApi.tasks.push(task);
  await page.addInitScript(() => localStorage.setItem("wb_appearance", JSON.stringify({ theme: "dark", fontPx: 28 })));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/review/${task.id}`);
  await expect(page.getByTestId("review-dock")).toBeVisible();
  const note = page.getByLabel("人工备注");
  await note.fill("保存失败也不能丢失的备注");
  syntheticApi.failNextDecision = true;
  await note.press("Enter");
  await expect(page.getByText("未保存：合成记录失败", { exact: true })).toBeVisible();
  await page.reload();
  await expect(note).toHaveValue("保存失败也不能丢失的备注");
  await expect(page.getByText("备注尚未保存到服务器", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "结论", exact: true }).fill("不能丢备注");
  await expect(page.getByRole("button", { name: "签字并待设计改稿", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "上传改稿 PDF", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "保存备注", exact: true }).click();
  await expect(page.getByText("备注已与服务器同步", { exact: true })).toBeVisible();
  await page.getByTestId("review-dock").locator(".review-sidebar-body").evaluate((node) => { node.scrollTop = 0; });
  await expectCurrentBoxInCanvas(page);
  await expect(page.getByRole("button", { name: "签字并待设计改稿", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("review-desktop-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".review-workspace")).toHaveClass(/is-stacked/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId("review-dock").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("review-mobile-dark.png") });
});

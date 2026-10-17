import type { Page } from "@playwright/test";
import { REVIEW_COPY } from "../src/copy/labels";
import { expect, reviewTask, test, type SyntheticTask } from "./fixtures";

// 复核失败按 B（老板 2026-10-17）：红条、黄条、检查中断条（方案 A）里给自己的单「重新上传这一单」，走现有 POST /api/tasks/:tid/rework。
// 合成登录换成审核员（reviewer，perms 含 create），open_id 与单子的 owner 相同 = 自己的单。
test.use({ viewport: { width: 1280, height: 800 } });

const ME = "ou_e2e_reviewer";

async function asReviewer(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("wb_review_shortcuts_seen_v1", "1");
    localStorage.setItem("wb_review_spot", "off");
  });
  // 后注册的路由优先：审核员，perms 与服务端 reviewer 一致。
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      logged_in: true, display_name: "E2E 审核员", avatar_url: null, open_id: ME, role: "reviewer",
      perms: ["read", "create", "decide", "complete", "delete", "export", "archive", "ai_review", "confirm_structure"],
    }),
  }));
}

type Bar = { name: string; id: string; alert: string; title: string; readOnly: string; patch: Partial<SyntheticTask> };
const BARS: Bar[] = [
  {
    name: "红条：复核失败", id: "e5969b58ce01", alert: ".ant-alert-error", title: REVIEW_COPY.reworkFailed, readOnly: REVIEW_COPY.reworkFailedReadOnly,
    patch: { status: "pending_review", job_kind: "rework", job_status: "failed", job_error: "对照中断" },
  },
  {
    name: "黄条：复核超页", id: "e5969b58ce02", alert: ".ant-alert-warning", title: REVIEW_COPY.reworkPageOver, readOnly: REVIEW_COPY.reworkPageOverReadOnly,
    patch: { status: "pending_review", job_kind: "rework", job_status: "failed", job_error: "这一单页数超过可核对页数", job_error_code: "page_over" },
  },
  {
    name: "检查中断带上一轮条目", id: "e5969b58ce03", alert: ".ant-alert-error", title: REVIEW_COPY.compareFailedWithHits, readOnly: REVIEW_COPY.compareFailedWithHitsReadOnly,
    patch: { status: "compare_failed", board: "failed", job_kind: "compare", job_status: "failed", job_error: "对照中断", error: "对照中断" },
  },
];

for (const [name, id, hits] of [
  ["只剩工艺说明条目", "e5969b58ce04", [{ id: "s0", field: "工艺说明", status: "疑点", decision: "pending" }]],
  ["没有条目", "e5969b58ce05", []],
] as const) {
  test(`检查中断${name}：服务端会回 400，不给重新上传；正文请回首页新建一单，「回首页」只跳路由不调接口`, async ({ page, syntheticApi }) => {
    await asReviewer(page);
    const task = failedTask({ ...BARS[2], id }, ME);
    task.hits = [...hits];
    syntheticApi.tasks.push(task);
    const writes: string[] = [];
    page.on("request", (r) => { if (r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.goto(`/review/${task.id}`);
    const bar = page.locator(".ant-alert-error").filter({ hasText: REVIEW_COPY.compareFailedNoHits });
    await expect(bar).toBeVisible();
    await expect(page.getByRole("button", { name: REVIEW_COPY.reupload })).toHaveCount(0);
    await expect(page.getByText(REVIEW_COPY.reupload, { exact: true })).toHaveCount(0);
    await expect(page.locator("button.review-sign")).toHaveCount(0);
    await expect(page.locator("button.review-reject")).toHaveCount(0);
    const before = writes.length;
    await bar.getByRole("link", { name: REVIEW_COPY.backHome }).click();
    await expect(page).toHaveURL(/\/reviewup$/u);
    expect(writes.slice(before)).toEqual([]);
  });
}

function failedTask(bar: Bar, owner: string): SyntheticTask {
  const task = reviewTask(bar.id);
  Object.assign(task, bar.patch, { owner });
  return task;
}

for (const bar of BARS) {
  test(`${bar.name}：自己的单在失败条里有「重新上传这一单」，选 PDF 发 /rework 后进入复核等待；签字退回不显示`, async ({ page, syntheticApi }, info) => {
    await asReviewer(page);
    const task = failedTask(bar, ME);
    syntheticApi.tasks.push(task);
    const posted: string[] = [];
    await page.route(`**/api/tasks/${task.id}/rework`, async (route) => {
      posted.push(route.request().headers()["content-type"] || "");
      // 同服务端：入队后单子进复核等待；之后轮询读到的也是这个状态。
      Object.assign(task, { status: "comparing", board: "comparing", job_kind: "rework", job_status: "queued", job_error: undefined, job_error_code: undefined, error: undefined });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(task) });
    });
    await page.goto(`/review/${task.id}`);
    const alert = page.locator(bar.alert).filter({ hasText: bar.title });
    await expect(alert.locator(".ant-alert-title")).toHaveText(bar.title);
    await expect(alert).not.toContainText("请联系管理员");
    // 签字退回都做不了：右上和页头不叫人去处理；疑点列表的待确认数照常。
    await expect(page.locator("#review-sign-hint")).toHaveCount(0);
    await expect(page.getByTestId("review-reject-note")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /展开疑点 · 待确认 \d+/u })).toBeVisible();
    await expect(page.locator("button.review-sign")).toHaveCount(0);
    await expect(page.locator("button.review-reject")).toHaveCount(0);
    const pdf = info.outputPath("new.pdf");
    (await import("node:fs")).writeFileSync(pdf, "%PDF-1.4\n%合成\n");
    const chooser = page.waitForEvent("filechooser");
    await alert.getByRole("button", { name: REVIEW_COPY.reupload }).click();
    await (await chooser).setFiles(pdf);
    await expect(page.locator(".wait-card")).toBeVisible();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatch(/^multipart\/form-data/);
  });

  test(`${bar.name}：别人的单不显示「重新上传这一单」，签字退回也不显示`, async ({ page, syntheticApi }) => {
    await asReviewer(page);
    const task = failedTask(bar, "ou_someone_else");
    syntheticApi.tasks.push(task);
    await page.goto(`/review/${task.id}`);
    // 不给按钮就不写句尾的「可以重新上传这一单」。
    await expect(page.locator(bar.alert).locator(".ant-alert-title")).toHaveText(bar.readOnly);
    await expect(page.getByRole("button", { name: REVIEW_COPY.reupload })).toHaveCount(0);
    await expect(page.locator("#review-sign-hint")).toHaveCount(0);
    await expect(page.getByTestId("review-reject-note")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /展开疑点 · 待确认 \d+/u })).toBeVisible();
    await expect(page.locator("button.review-sign")).toHaveCount(0);
    await expect(page.locator("button.review-reject")).toHaveCount(0);
  });
}

test("管理员看别人的红条单：服务端 /rework 对管理员不看归属，照样给「重新上传这一单」并带句尾", async ({ page, syntheticApi }) => {
  await page.addInitScript(() => {
    localStorage.setItem("wb_review_shortcuts_seen_v1", "1");
    localStorage.setItem("wb_review_spot", "off");
  });
  const task = failedTask(BARS[0], "ou_someone_else");
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.locator(BARS[0].alert).locator(".ant-alert-title")).toHaveText(BARS[0].title);
  await expect(page.getByRole("button", { name: REVIEW_COPY.reupload })).toBeVisible();
  await expect(page.locator("#review-sign-hint")).toHaveCount(0);
});

test("审核员看自己正常待审单（签字灰、退回可点）：右上和页头照常写「仍有 …未处理」", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const task = reviewTask("e5969b58ce06");
  Object.assign(task, { owner: ME, status: "in_review", hits: [{ id: "p0", field: "中文品名", status: "疑点", decision: "pending" }] });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.locator("#review-sign-hint")).toHaveText("仍有 1 条疑点未处理");
  await expect(page.getByTestId("review-reject-note")).toHaveText("仍有 1 条疑点未处理");
  await expect(page.locator("button.review-sign")).toBeDisabled();
  await expect(page.locator("button.review-reject")).toBeEnabled();
});

test("审核员看别人的正常待审单：服务端 /complete 会 403，签字退回都不在，右上和页头不叫人去处理", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const task = reviewTask("e5969b58ce07");
  Object.assign(task, { owner: "ou_someone_else", status: "in_review", hits: [{ id: "p0", field: "中文品名", status: "疑点", decision: "pending" }] });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByTestId("review-root")).toBeVisible();
  await expect(page.locator("button.review-sign")).toHaveCount(0);
  await expect(page.locator("button.review-reject")).toHaveCount(0);
  await expect(page.locator("#review-sign-hint")).toHaveCount(0);
  await expect(page.getByTestId("review-reject-note")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /展开疑点 · 待确认 1/u })).toBeVisible();
});

test("管理员看别人的正常待审单：能签能退，右上和页头照常写「仍有 …未处理」", async ({ page, syntheticApi }) => {
  await page.addInitScript(() => {
    localStorage.setItem("wb_review_shortcuts_seen_v1", "1");
    localStorage.setItem("wb_review_spot", "off");
  });
  const task = reviewTask("e5969b58ce08");
  Object.assign(task, { owner: "ou_someone_else", status: "in_review", hits: [{ id: "p0", field: "中文品名", status: "疑点", decision: "pending" }] });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.locator("#review-sign-hint")).toHaveText("仍有 1 条疑点未处理");
  await expect(page.getByTestId("review-reject-note")).toHaveText("仍有 1 条疑点未处理");
  await expect(page.locator("button.review-reject")).toBeEnabled();
});

test("复核失败且没有剩余条目：显示「检查未完成，暂时没有结果」和「重新上传这一单」，签字退回不显示", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const task = reviewTask("e5969b58ce04");
  Object.assign(task, { owner: ME, status: "pending_review", job_kind: "rework", job_status: "failed", job_error: "对照中断", hits: [] });
  syntheticApi.tasks.push(task);
  // 1440 右栏常驻，空态「检查未完成，暂时没有结果」在右栏里。
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/review/${task.id}`);
  await expect(page.getByText("检查未完成，暂时没有结果")).toBeVisible();
  await expect(page.locator(".ant-alert").getByRole("button", { name: REVIEW_COPY.reupload })).toBeVisible();
  await expect(page.locator("button.review-sign")).toHaveCount(0);
  await expect(page.locator("button.review-reject")).toHaveCount(0);
});

test("复核认字失败（job_error_code: ocr_failed）、没有剩余条目：自己的单有按钮，句尾留「再不行请联系管理员」退路；别人的单是原句", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const ocr = { status: "pending_review", job_kind: "rework", job_status: "failed", job_error: "认字组件没装上，没有结果", job_error_code: "ocr_failed" as const, hits: [] };
  const own = reviewTask("e5969b58ce09");
  Object.assign(own, ocr, { owner: ME });
  const others = reviewTask("e5969b58ce0a");
  Object.assign(others, ocr, { owner: "ou_someone_else" });
  syntheticApi.tasks.push(own, others);
  await page.goto(`/review/${own.id}`);
  // 产品哥定稿：认字失败重新上传未必能好，有按钮时特意留「请联系管理员」作退路（只对这一句放开）。
  const bar = page.locator(".ant-alert-error").filter({ hasText: REVIEW_COPY.ocrFailedReupload });
  await expect(bar.locator(".ant-alert-title")).toHaveText("认字出了问题，可以重新上传这一单，再不行请联系管理员");
  await expect(bar.getByRole("button", { name: REVIEW_COPY.reupload })).toBeVisible();
  await page.goto(`/review/${others.id}`);
  await expect(page.locator(".ant-alert-error .ant-alert-title").first()).toHaveText("认字出了问题，请联系管理员");
  await expect(page.getByRole("button", { name: REVIEW_COPY.reupload })).toHaveCount(0);
});

test("复核认字失败、带上一轮条目：仍显示复核失败红条「复核出了问题…」", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const task = failedTask({ ...BARS[0], id: "e5969b58ce0c", patch: { ...BARS[0].patch, job_error: "认字组件没装上，没有结果", job_error_code: "ocr_failed" } }, ME);
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.locator(".ant-alert-error .ant-alert-title").first()).toHaveText(REVIEW_COPY.reworkFailed);
  await expect(page.getByRole("button", { name: REVIEW_COPY.reupload })).toBeVisible();
});

test("首轮认字失败、没有上一轮结果：页面是原句「认字出了问题，请联系管理员」，不出「下面是上一轮的结果」", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const task = reviewTask("e5969b58ce0b");
  Object.assign(task, { owner: ME, status: "compare_failed", board: "failed", job_kind: "compare", job_status: "failed", job_error: "认字组件没装上，没有结果", job_error_code: "ocr_failed", error: "认字组件没装上，没有结果", hits: [] });
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);
  await expect(page.locator(".ant-alert-error .ant-alert-title").first()).toHaveText(REVIEW_COPY.ocrFailed);
  await expect(page.getByTestId("review-root")).not.toContainText("下面是上一轮的结果");
});

test("服务端拒绝 /rework（如 409 对红还在排队或正在跑）：照常提示服务端的话，单子留在失败页", async ({ page, syntheticApi }, info) => {
  await asReviewer(page);
  const task = failedTask(BARS[0], ME);
  syntheticApi.tasks.push(task);
  await page.route(`**/api/tasks/${task.id}/rework`, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: "对红还在排队或正在跑" }) }));
  await page.goto(`/review/${task.id}`);
  const pdf = info.outputPath("new.pdf");
  (await import("node:fs")).writeFileSync(pdf, "%PDF-1.4\n%合成\n");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: REVIEW_COPY.reupload }).click();
  await (await chooser).setFiles(pdf);
  await expect(page.locator(".ant-message")).toContainText("对红还在排队或正在跑");
  await expect(page.locator(".wait-card")).toHaveCount(0);
});

for (const [code, raw, readOnly, own] of [
  ["result_truncated", "这一单结果没写完，没有结果", "这一单结果太多，没能写完，请联系管理员", "这一单结果太多，没能写完"],
  ["private_data_failed", "私有数据解析失败", "稿件里的 Illustrator 私有数据读不出来，请联系管理员", "稿件里的 Illustrator 私有数据读不出来"],
] as const) {
  test(`复核失败 ${code}、没有剩余条目：别人的单是产品定稿整句，自己的单有按钮只留前半句`, async ({ page, syntheticApi }) => {
    await asReviewer(page);
    const base = { status: "pending_review", job_kind: "rework", job_status: "failed", job_error: raw, job_error_code: code, hits: [] };
    const mine = reviewTask(code === "result_truncated" ? "e5969b58ce0d" : "e5969b58ce0e");
    Object.assign(mine, base, { owner: ME });
    const theirs = reviewTask(code === "result_truncated" ? "e5969b58ce0f" : "e5969b58ce10");
    Object.assign(theirs, base, { owner: "ou_someone_else" });
    syntheticApi.tasks.push(mine, theirs);
    await page.goto(`/review/${theirs.id}`);
    await expect(page.locator(".ant-alert-error .ant-alert-title").first()).toHaveText(readOnly);
    await expect(page.getByRole("button", { name: REVIEW_COPY.reupload })).toHaveCount(0);
    await page.goto(`/review/${mine.id}`);
    const bar = page.locator(".ant-alert-error").filter({ has: page.getByRole("button", { name: REVIEW_COPY.reupload }) });
    await expect(bar.locator(".ant-alert-title")).toHaveText(own);
    await expect(bar).not.toContainText("请联系管理员");
  });
}

test("复核超页、没有剩余条目（Q9）：自己的单标题「稿件超过 1 页，请改成 1 页后重新上传这一单」+按钮；别人的单只有「稿件超过 1 页」", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const base = { status: "pending_review", job_kind: "rework", job_status: "failed", job_error: "稿件超过 1 页", job_error_code: "page_over" as const, hits: [] };
  const mine = reviewTask("e5969b58ce11");
  Object.assign(mine, base, { owner: ME });
  const theirs = reviewTask("e5969b58ce12");
  Object.assign(theirs, base, { owner: "ou_someone_else" });
  syntheticApi.tasks.push(mine, theirs);
  await page.goto(`/review/${mine.id}`);
  const bar = page.locator(".ant-alert-warning");
  await expect(bar.locator(".ant-alert-title")).toHaveText("稿件超过 1 页，请改成 1 页后重新上传这一单");
  await expect(bar.getByRole("button", { name: REVIEW_COPY.reupload })).toBeVisible();
  await expect(bar).not.toContainText(/请联系管理员|回首页|下面是上一轮的结果/u);
  await page.goto(`/review/${theirs.id}`);
  await expect(page.locator(".ant-alert-warning .ant-alert-title")).toHaveText("稿件超过 1 页");
  await expect(page.locator(".ant-alert-warning")).not.toContainText(/请联系管理员|回首页/u);
  await expect(page.getByRole("button", { name: REVIEW_COPY.reupload })).toHaveCount(0);
});

test("首次对照就超页、没有条目：自己的单标题「稿件超过 1 页」+正文请回首页新建+「回首页」；别人的单只有标题", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const base = { status: "compare_failed", board: "failed", job_kind: "compare", job_status: "failed", job_error: "稿件超过 1 页", job_error_code: "page_over" as const, hits: [] };
  const mine = reviewTask("e5969b58ce13");
  Object.assign(mine, base, { owner: ME });
  const theirs = reviewTask("e5969b58ce14");
  Object.assign(theirs, base, { owner: "ou_someone_else" });
  syntheticApi.tasks.push(mine, theirs);
  await page.goto(`/review/${mine.id}`);
  const bar = page.locator(".ant-alert-warning");
  await expect(bar.locator(".ant-alert-title")).toHaveText("稿件超过 1 页");
  await expect(bar.locator(".ant-alert-description")).toHaveText(REVIEW_COPY.compareFailedNoHits);
  await expect(bar.getByRole("link", { name: REVIEW_COPY.backHome })).toBeVisible();
  await expect(bar).not.toContainText(/请联系管理员|请改成/u);
  await expect(page.getByRole("button", { name: REVIEW_COPY.reupload })).toHaveCount(0);
  await page.goto(`/review/${theirs.id}`);
  await expect(page.locator(".ant-alert-warning .ant-alert-title")).toHaveText("稿件超过 1 页");
  await expect(page.locator(".ant-alert-warning .ant-alert-description")).toHaveCount(0);
  await expect(page.locator(".ant-alert-warning")).not.toContainText(/请联系管理员|回首页|重新上传/u);
  await expect(page.getByTestId("review-back-home")).toHaveCount(0);
});

test("逐字单整单待人工确认：自己的单有勾选框，审核员看别人的单签字退回和勾选框都不在", async ({ page, syntheticApi }) => {
  await asReviewer(page);
  const base = { status: "in_review", verbatim_check: true, verbatim_warning: "认字精度下降", hits: [{ id: "h0", field: "中文品名", status: "待人工确认", decision: "pending" }] };
  const mine = reviewTask("e5969b58ce15");
  Object.assign(mine, base, { owner: ME });
  const theirs = reviewTask("e5969b58ce16");
  Object.assign(theirs, base, { owner: "ou_someone_else" });
  syntheticApi.tasks.push(mine, theirs);
  await page.goto(`/review/${mine.id}`);
  await expect(page.getByTestId("review-order-held")).toBeVisible();
  await page.goto(`/review/${theirs.id}`);
  await expect(page.getByTestId("review-root")).toBeVisible();
  await expect(page.locator("button.review-sign")).toHaveCount(0);
  await expect(page.getByTestId("review-order-held")).toHaveCount(0);
});

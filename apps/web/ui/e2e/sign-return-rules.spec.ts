import {
  SIGN_RETURN_DISPUTED,
  SIGN_RETURN_RULES,
  signReturnHitExtras,
  type SignReturnExpect,
  type SignReturnInput,
  type SignReturnSide,
} from "../../server/src/signReturnRules.ts";
import { REVIEW_COPY } from "../src/copy/labels";
import { expect, reviewTask, test, type SyntheticApi } from "./fixtures";
import type { Page } from "@playwright/test";

// 按前后端共用的签字/退回规则表渲染核对页：hidden 行断言按钮不存在，其余行断言按钮在、可点与否、
// 确认框能不能提交。表里同时有「失败单按钮不在」和「正常单按钮在」的对照行。
// 合成登录默认是 admin；viewer 行把 /api/auth/me 换成只读账号（perms 不含 complete），核对页隐藏两个按钮。
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("wb_review_shortcuts_seen_v1", "1");
    localStorage.setItem("wb_review_spot", "off");
  });
});

const ME = "E2E（合成用户）";

function seed(api: SyntheticApi, n: number, input: SignReturnInput): string {
  const id = `e5969b58d${n.toString(16).padStart(3, "0")}`;
  const task = reviewTask(id);
  Object.assign(task, {
    status: input.status,
    board: input.status === "completed" ? "done" : input.status === "compare_failed" ? "failed" : input.status === "comparing" ? "comparing" : "review",
    ...(input.job ? { job_kind: input.job.kind, job_status: input.job.status } : {}),
    ...(input.job?.status === "failed" ? { job_error: "对照中断" } : {}),
    ...(input.status === "compare_failed" ? { error: "对照中断" } : {}),
    ...(input.verbatimCheck ? { verbatim_check: true } : {}),
    ...(input.verbatimWarning ? { verbatim_warning: "稿件未保留 Illustrator 编辑数据" } : {}),
    ...(input.status === "completed" ? { completed_by: input.completedByOther ? "别人" : ME, complete_kind: "signed" } : {}),
    hits: input.hits.map((hit, i) => ({
      id: `h${i}`,
      field: hit.field ?? "中文品名",
      status: hit.status,
      ...(hit.decision === undefined ? {} : { decision: hit.decision }),
      ...signReturnHitExtras(hit),
      excel: "合成核对单",
      pdf: "合成核对",
      page: 1,
      bboxes: [{ page: 1, left: 40, top: 50 + i * 60, width: 220, height: 45, role: "check" }],
    })),
  });
  api.tasks.push(task);
  return id;
}

async function expectSide(page: Page, cls: "review-sign" | "review-reject", side: SignReturnSide) {
  const button = page.locator(`button.${cls}`);
  if (side.button === "hidden") {
    await expect(button).toHaveCount(0);
    return;
  }
  await expect(button).toHaveCount(1);
  if (side.button === "disabled") {
    await expect(button).toBeDisabled();
    return;
  }
  await expect(button).toBeEnabled();
  await button.click();
  const ok = page.getByRole("button", { name: cls === "review-sign" ? REVIEW_COPY.signConfirm : REVIEW_COPY.rejectConfirm });
  if (side.submits) await expect(ok).toBeEnabled();
  else await expect(ok).toBeDisabled();
  await page.getByRole("button", { name: REVIEW_COPY.cancel }).click();
  await expect(ok).toHaveCount(0);
}

async function expectRow(page: Page, api: SyntheticApi, n: number, input: SignReturnInput, want: SignReturnExpect) {
  if (input.role === "viewer") {
    // 后注册的路由优先：只读账号，perms 与服务端 viewer 一致（不含 complete）。
    await page.route("**/api/auth/me", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ logged_in: true, display_name: ME, avatar_url: null, open_id: "ou_e2e_synthetic", role: "viewer", perms: ["read", "export", "confirm_structure"] }),
    }));
  }
  await page.goto(`/review/${seed(api, n, input)}`);
  // 先确认页面已经画出来，「按钮不在」才有意义。
  if (input.job?.status === "queued" || input.job?.status === "running") await expect(page.locator(".wait-card")).toBeVisible();
  else await expect(page.getByTestId("review-root")).toBeVisible();
  if (input.orderHeldConfirm) await page.getByRole("checkbox", { name: REVIEW_COPY.orderHeldConfirm }).check();
  await expectSide(page, "review-sign", want.sign);
  await expectSide(page, "review-reject", want.ret);
}

SIGN_RETURN_RULES.forEach((row, n) => {
  test(`签字/退回规则表：${row.name}`, async ({ page, syntheticApi }) => {
    await expectRow(page, syntheticApi, n, row.input, row.expect);
  });
});

SIGN_RETURN_DISPUTED.forEach((row, n) => {
  test(`签字/退回待决（前端现状）：${row.name}`, async ({ page, syntheticApi }) => {
    await expectRow(page, syntheticApi, 0x100 + n, row.input, row.ui);
  });
});

// 签字灰态旁 / 悬停的「仍有 N 条…未处理」与服务端 /complete 拦截同一句（逐字对照见 src/pages/signCopy.contract.test.ts）。
const SIGN_COPY_ROWS: ReadonlyArray<{ name: string; input: SignReturnInput; text: string }> = [
  {
    name: "只有认字存疑（状态本是一致）",
    input: { role: "reviewer", status: "in_review", hits: [{ status: "一致", coverageMiss: ["CAPSULE MIST"] }] },
    text: "仍有 1 条认字存疑未处理",
  },
  {
    name: "待人工确认与认字存疑分开数",
    input: { role: "reviewer", status: "in_review", hits: [{ status: "待人工确认" }, { status: "一致", coverageMiss: ["CAPSULE MIST"] }, { status: "待人工确认" }] },
    text: "仍有 2 条待人工确认、1 条认字存疑未处理",
  },
  {
    name: "疑点与缺失分开数",
    input: { role: "reviewer", status: "in_review", hits: [{ status: "疑点", decision: "pending" }, { status: "缺失" }, { status: "疑点" }] },
    text: "仍有 2 条疑点、1 条缺失未处理",
  },
];

SIGN_COPY_ROWS.forEach((row, n) => {
  test(`签字拦截文案：${row.name}`, async ({ page, syntheticApi }) => {
    await page.goto(`/review/${seed(syntheticApi, 0x200 + n, row.input)}`);
    const sign = page.locator("button.review-sign");
    await expect(sign).toBeDisabled();
    await expect(page.locator("#review-sign-hint")).toHaveText(row.text);
    await expect(sign).toHaveAttribute("title", row.text);
  });
});

test("只读账号（viewer）：页头不出「仍有 …未处理」和退回那行，进度和待确认数照常", async ({ page, syntheticApi }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ logged_in: true, display_name: ME, avatar_url: null, open_id: "ou_e2e_synthetic", role: "viewer", perms: ["read", "export", "confirm_structure"] }),
  }));
  await page.goto(`/review/${seed(syntheticApi, 0x300, { role: "viewer", status: "in_review", hits: [{ status: "疑点", decision: "pending" }] })}`);
  await expect(page.getByTestId("review-root")).toBeVisible();
  await expect(page.getByTestId("review-posn")).toHaveText("1/1");
  await expect(page.locator(".review-flat-tabs, .review-sidebar").first()).toContainText("待确认");
  await expect(page.locator("#review-sign-hint")).toHaveCount(0);
  await expect(page.getByTestId("review-reject-note")).toHaveCount(0);
  await expect(page.locator("button.review-sign")).toHaveCount(0);
  await expect(page.locator("button.review-reject")).toHaveCount(0);
});

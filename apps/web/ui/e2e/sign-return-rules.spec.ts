import {
  SIGN_RETURN_DISPUTED,
  SIGN_RETURN_RULES,
  type SignReturnExpect,
  type SignReturnInput,
  type SignReturnSide,
} from "../../server/src/signReturnRules.ts";
import { REVIEW_COPY } from "../src/copy/labels";
import { expect, reviewTask, test, type SyntheticApi } from "./fixtures";
import type { Page } from "@playwright/test";

// 按前后端共用的签字/退回规则表渲染核对页：hidden 行断言按钮不存在，其余行断言按钮在、可点与否、
// 确认框能不能提交。表里同时有「失败单按钮不在」和「正常单按钮在」的对照行。
// 核对页不看角色（合成登录固定是 admin），viewer 待决行按前端现状断言。
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

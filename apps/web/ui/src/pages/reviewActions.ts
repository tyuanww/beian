/**
 * 核对页签字 / 退回按钮的显示与可点，以及确认框能不能提交。ReviewPage 只用这里的结果渲染，
 * 规则和服务端 `/complete`（`apps/web/server/src/completeGate.ts`）的对照表在
 * `apps/web/server/src/signReturnRules.ts`，前端由 `signReturnRules.contract.test.ts` 逐行对照。
 */
import type { FieldHit, TaskDetail } from "../api";
import { needsOrderHeldConfirm, signAllowedForOrderHeld } from "./orderHeldConfirm";
import { skipPackSheetField } from "./reviewDock";
import { submitGate, type SubmitGate } from "./reviewFlat";
import { reviewHits } from "./reviewVersion";
import { shouldShowWaitCard } from "./waitCard";

type SubmitButton = "hidden" | "disabled" | "enabled";

export function isReviewableStatus(status?: string): boolean {
  return status === "pending_review" || status === "in_review";
}

/** 失败单：`compare_failed` 或作业失败（含复核失败、单子回到对红前状态）。签字/退回按钮都不在。 */
export function isFailedJob(task: Pick<TaskDetail, "status" | "job_status"> | null | undefined): boolean {
  return task?.status === "compare_failed" || task?.job_status === "failed";
}

/** 核对页上参与签字/退回的条目：当前版本的 hits，去掉确认单底部工艺表。 */
export function reviewPageHits(task: TaskDetail | null, useV2: boolean): FieldHit[] {
  return reviewHits(task, useV2).filter((h) => !skipPackSheetField(h.field));
}

export function reviewGate(task: TaskDetail | null, hits: FieldHit[], locked: boolean): SubmitGate {
  return submitGate(hits, isReviewableStatus(task?.status), locked, task?.verbatim_check === true);
}

/** 确认框里「确认签字 / 确认退回」挡住的条件：还有待确认。 */
export function submitDialogBlocked(pending: number): boolean {
  return pending > 0;
}

export type SubmitButtonsInput = {
  locked: boolean;
  orderHeldConfirm: boolean;
  busy: boolean;
  hasUnsavedNotes: boolean;
};

export type SubmitButtons = {
  sign: SubmitButton;
  reject: SubmitButton;
  /** 按钮可点且确认框不挡：真的会发 /complete。 */
  signSubmits: boolean;
  rejectSubmits: boolean;
};

const HIDDEN: SubmitButtons = { sign: "hidden", reject: "hidden", signSubmits: false, rejectSubmits: false };

export function reviewSubmitButtons(task: TaskDetail | null, hits: FieldHit[], opts: SubmitButtonsInput): SubmitButtons {
  // 等待卡（排队/对照中）整页换掉，失败单不渲染两个按钮。
  if (!task || shouldShowWaitCard(task) || isFailedJob(task)) return HIDDEN;
  const gate = reviewGate(task, hits, opts.locked);
  const orderHeldOk = signAllowedForOrderHeld(needsOrderHeldConfirm(task, hits), opts.orderHeldConfirm);
  const held = opts.busy || opts.hasUnsavedNotes;
  const sign: SubmitButton = gate.canSign && orderHeldOk && !held ? "enabled" : "disabled";
  const reject: SubmitButton = gate.canReject && !held ? "enabled" : "disabled";
  const open = !submitDialogBlocked(gate.pending);
  return { sign, reject, signSubmits: sign === "enabled" && open, rejectSubmits: reject === "enabled" && open };
}

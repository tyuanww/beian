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

/**
 * 这一单现在能不能走 /rework：照服务端 `tasks.ts` 的 `isReworkableTask` 原样对齐（改了那边这里一起改；
 * `reworkable.contract.test.ts` 把两边逐例对照）。
 * 已有新稿（pages_v2）不行；待审 / 审核中可以；检查中断（产品 10/17 方案 A：对照失败、还留着上一轮有效条目）可以；
 * 已完成只有退回（rework）的可以。
 */
export type ReworkableFields = Pick<TaskDetail, "status" | "complete_kind" | "pages_v2" | "job_kind" | "job_status" | "verbatim_check" | "hits" | "hits_v2">;

export function isReworkableTask(task: ReworkableFields | null): boolean {
  if (!task) return false;
  if (Array.isArray(task.pages_v2) && task.pages_v2.length > 0) return false;
  if (task.status === "pending_review" || task.status === "in_review") return true;
  if (task.status === "compare_failed") return task.job_kind === "compare" && task.job_status === "failed" && activeHitCount(task) > 0;
  return task.status === "completed" && task.complete_kind === "rework";
}

/**
 * 有效条目数，同服务端 `tasks.ts` `activeHits`：认字单 `hits_v2` 是数组就看它（空也算），否则看 `hits`；
 * 其他单 `hits_v2` 非空看 `hits_v2`，否则看 `hits`；都跳过工艺表字段（`skipPackSheetField`，同服务端 `sheetSkip.ts`）。
 */
function activeHitCount(task: Pick<TaskDetail, "verbatim_check" | "hits" | "hits_v2">): number {
  const hits = task.verbatim_check === true
    ? (Array.isArray(task.hits_v2) ? task.hits_v2 : Array.isArray(task.hits) ? task.hits : [])
    : (Array.isArray(task.hits_v2) && task.hits_v2.length > 0 ? task.hits_v2 : task.hits || []);
  return hits.filter((hit) => !skipPackSheetField(hit.field)).length;
}

/** 当前登录人：与服务端 `/rework` 的 `need(c, "create")` + `assertCanAccessTask` 用同一组字段（`/api/auth/me`）。 */
export type ReuploadViewer = {
  /** `me.perms` 含 `create`（admin、reviewer 有；viewer 没有）。 */
  canCreate: boolean;
  /** `isAdmin(me)`：服务端 `canAccessOwner` 对管理员一律放行。 */
  admin: boolean;
  /** `me.open_id`。 */
  openId: string | null;
  /** `me.display_name`。 */
  displayName: string | null;
};

/**
 * 失败单（`isFailedJob`）的失败条里给不给「重新上传这一单」（老板 2026-10-17 复核失败按 B）：
 * 带上一轮条目的三种失败条（复核失败红条、复核超页黄条、检查中断条），以及复核（对红）失败且没有剩余条目的单。
 * 首次检查失败且没有条目的单不在这里（那是要新建一单，不走 /rework）。
 * 服务端会回 400「当前状态不可对红」的单（`isReworkableTask` 为假，如检查中断但只剩工艺表条目的）不给按钮。
 * 只照服务端 `/rework` 的权限：有 create，且是管理员或这单的 `owner` 等于自己的 open_id / 显示名
 * （同服务端 `canAccessOwner`）。
 */
export function canReuploadFailed(task: (ReworkableFields & Pick<TaskDetail, "owner">) | null, hits: readonly FieldHit[], viewer: ReuploadViewer): boolean {
  if (!task || !isFailedJob(task) || !isReworkableTask(task)) return false;
  if (hits.length === 0 && task.job_kind !== "rework") return false;
  if (!viewer.canCreate) return false;
  if (viewer.admin) return true;
  const owner = String(task.owner || "").trim();
  if (!owner) return false;
  return owner === String(viewer.openId || "").trim() || owner === String(viewer.displayName || "").trim();
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
  /** 无 complete 权限（viewer）时签字/退回都不渲染；缺省 true。 */
  canComplete?: boolean;
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
  // viewer 无 complete：隐藏签字/退回，避免点了才 403（产品 2026-10-17）。
  if (opts.canComplete === false) return HIDDEN;
  const gate = reviewGate(task, hits, opts.locked);
  const orderHeldOk = signAllowedForOrderHeld(needsOrderHeldConfirm(task, hits), opts.orderHeldConfirm);
  const held = opts.busy || opts.hasUnsavedNotes;
  const sign: SubmitButton = gate.canSign && orderHeldOk && !held ? "enabled" : "disabled";
  const reject: SubmitButton = gate.canReject && !held ? "enabled" : "disabled";
  const open = !submitDialogBlocked(gate.pending);
  return { sign, reject, signSubmits: sign === "enabled" && open, rejectSubmits: reject === "enabled" && open };
}

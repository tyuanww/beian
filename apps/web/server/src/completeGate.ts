import { skipPackSheetField } from "./sheetSkip.js";
import { activeHits, hitNeedsDecision, isHitDecision, isReviewableStatus, isValidHitReviewState, type Hit, type Task } from "./tasks.js";

export type CompleteGate =
  | { ok: true; kind: "signed" | "rework" }
  | { ok: false; status: 400 | 409; message: string };

function isOpenHeld(hit: Hit): boolean {
  return hit.status === "待人工确认" && !isHitDecision(hit.decision);
}

/**
 * `/complete`（签字 / 退回同一个入口）在写盘前的全部拦截，顺序与原路由一致；权限 `need(c, "complete")`
 * 和结论非空仍在路由里。有「有错」→ 退回（rework），没有 → 签字（signed）。
 * 前后端共用规则表见 `signReturnRules.ts`，服务端由 `signReturnRules.test.ts` 逐行对照本函数。
 */
export function completeGate(task: Task, orderHeldConfirm: unknown): CompleteGate {
  if (task.job_status === "queued" || task.job_status === "running") {
    return { ok: false, status: 409, message: "对照还在排队或正在跑，不能签字" };
  }
  // 不看 job_status=failed：复核失败回到待审、带上一轮条目的单照 main 收签字/退回（8/20 设计
  // review-job-module.md「对红失败仍可签字」）。是否改成不可签待老板定，见 signReturnRules.ts 待决行。
  if (!isReviewableStatus(task.status)) {
    return { ok: false, status: 400, message: "当前状态不可签字" };
  }
  const hits = activeHits(task).filter((h) => !skipPackSheetField(h.field));
  const invalid = hits.filter((h) => !isValidHitReviewState(h));
  if (invalid.length) {
    return { ok: false, status: 400, message: `有 ${invalid.length} 条审核数据状态异常，请重新对照` };
  }
  // 非逐字单：未决「待人工确认」也算待确认（与前端 submitGate 在 !verbatim_check 时把 held 计入 pending 一致）。
  // 逐字单仍走下面的整单确认勾选，不在这里挡。
  const pending = hits.filter((h) => hitNeedsDecision(h) || (task.verbatim_check !== true && isOpenHeld(h)));
  if (pending.length) {
    const words = [...new Set(pending.map((hit) => String(hit.status || "未决")))].join("、");
    return { ok: false, status: 400, message: `仍有 ${pending.length} 条${words}未处理` };
  }
  const openHeld = task.verbatim_check === true
    ? hits.filter(isOpenHeld).length
    : 0;
  const issues = hits.filter((h) => h.decision === "issue");
  // 退回（有 issue）不要求整单确认；只有签字才要 order_held_confirm。
  if (!issues.length && task.verbatim_warning && openHeld > 0 && orderHeldConfirm !== true) {
    return { ok: false, status: 400, message: "整单待人工确认，签字即认可" };
  }
  return { ok: true, kind: issues.length ? "rework" : "signed" };
}

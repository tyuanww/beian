import { skipPackSheetField } from "./sheetSkip.js";
import { activeHits, isHitDecision, isReviewableStatus, isValidHitReviewState, pendingWord, type Hit, type Task } from "./tasks.js";
import { hitStatusCode, REVIEW_CODE_STATUS, reviewDetail, type CompleteCode, type PendingItem, type ReviewParams } from "./reviewCodes.js";

export type CompleteGate =
  | { ok: true; kind: "signed" | "rework" }
  | { ok: false; status: 400 | 409; message: string; code: CompleteCode; params?: ReviewParams };

/** 拒绝结果：状态码和原文都从码表取（`reviewCodes.ts`），和 `/complete` 返回体一一对应。 */
function reject(code: CompleteCode, params?: ReviewParams): CompleteGate {
  const status = REVIEW_CODE_STATUS[code] as 400 | 409;
  return { ok: false, status, message: reviewDetail(code, params) ?? "", code, ...(params ? { params } : {}) };
}

/** 拦截文案里的词 → `params.items` 的一项（顺序按首次出现，与原文一致）。 */
function pendingItems(words: readonly string[]): PendingItem[] {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts].map(([word, count]): PendingItem => {
    if (word === "认字存疑") return { kind: "reading_doubt", count };
    if (word === "待人工确认") return { kind: "held", count };
    const status = hitStatusCode(word);
    // pendingWord 只给真错 ∪ {疑点、缺失} ∪ 空格类，全在英文枚举里（reviewCodes.test.ts 防漂移）。
    if (!status) throw new Error(`pending word without status code: ${word}`);
    return { kind: "status", status, count };
  });
}

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
    return reject("complete_job_running");
  }
  if (!isReviewableStatus(task.status)) {
    return reject("complete_status_not_reviewable");
  }
  // 老板 10/17 定 B：对红（复核）失败的单（不论还剩不剩条目），签字退回都拦；出路是重新上传走 /rework。
  // 只限对红失败；对照失败等其他失败按 main 不受影响。原文沿用「当前状态不可签字」，码单独一个。
  if (task.job_kind === "rework" && task.job_status === "failed") {
    return reject("complete_rework_failed");
  }
  const hits = activeHits(task).filter((h) => !skipPackSheetField(h.field));
  const invalid = hits.filter((h) => !isValidHitReviewState(h));
  if (invalid.length) {
    return reject("complete_hits_invalid", { count: invalid.length });
  }
  // 非逐字单：未决「待人工确认」也算待确认（与前端 submitGate 在 !verbatim_check 时把 held 计入 pending 一致）。
  // 逐字单仍走下面的整单确认勾选，不在这里挡。
  const words = hits
    .map((h) => pendingWord(h) ?? (task.verbatim_check !== true && isOpenHeld(h) ? "待人工确认" : null))
    .filter((word): word is string => word !== null);
  if (words.length) {
    // 按词分开数，词序按首次出现，「、」连接：「仍有 2 条待人工确认、1 条认字存疑未处理」（pendingDetail）。
    return reject("complete_hits_pending", { items: pendingItems(words) });
  }
  const openHeld = task.verbatim_check === true
    ? hits.filter(isOpenHeld).length
    : 0;
  const issues = hits.filter((h) => h.decision === "issue");
  // 退回（有 issue）不要求整单确认；只有签字才要 order_held_confirm。
  if (!issues.length && task.verbatim_warning && openHeld > 0 && orderHeldConfirm !== true) {
    return reject("complete_order_held_unconfirmed", { count: openHeld });
  }
  return { ok: true, kind: issues.length ? "rework" : "signed" };
}

/**
 * 待确认口径：哪些条目算「要人看」（核对页 isReviewIssue）、没下结论时拦截文案写什么词（pendingWord）。
 * 前后端共用（加码 §6）。只依赖同样零依赖的 `readingDoubt.ts`，前端可直接 import。
 *
 * 状态集合写死（不读 JSON，保持零依赖），`reviewIssue.test.ts` 对 `verbatim_statuses.json` 防漂移。
 * 不再有任何状态正则（原前端 `/不清|误/` 在已知状态里一个都不命中，删掉不改行为）。
 *
 * - 未决 / 已决的「待人工确认」都不在这里：逐字单走整单确认，非逐字单由 `completeGate` 单独计「待人工确认」。
 * - 「缺空格」（加码 Q2）：没下结论（decision 缺失、null、pending）一律要结论，不再看核对要点有没有内容。
 */
import { hasReadingDoubt, type ReadingDoubtHit } from "./readingDoubt.js";

/** 真错 ∪ {疑点、缺失}：按状态本身就要结论（= verbatim_statuses.json true_errors + 疑点、缺失）。 */
export const BLOCKING_STATUSES: readonly string[] = ["错字", "漏字", "多字", "稿件有但确认单没有", "疑点", "缺失"];
/** 空格类（= verbatim_statuses.json space_errors）：标了 pending 才要结论；「缺空格」另见 Q2。 */
export const SPACE_STATUSES: readonly string[] = ["多空格", "缺空格"];
const HELD = "待人工确认";
const SPACE_MISSING = "缺空格";
const DECISIONS = ["confirm", "issue", "ignore"];

export type ReviewIssueHit = ReadingDoubtHit;

function isDecided(decision: unknown): boolean {
  return typeof decision === "string" && DECISIONS.includes(decision);
}

/** 核对页把这一条放进「要看」列表（不论下没下结论）。 */
export function isReviewIssue(hit: ReviewIssueHit): boolean {
  const status = String(hit.status || "");
  if (status === HELD) return false;
  if (hit.decision === "issue") return true;
  if (BLOCKING_STATUSES.includes(status) || status === SPACE_MISSING) return true;
  if (SPACE_STATUSES.includes(status) && hit.decision === "pending") return true;
  return hasReadingDoubt(hit);
}

/**
 * 没下结论时拦截文案里的词；不用拦为 null。顺序决定词：按状态要结论的写状态本身，只因认字存疑的写
 * 「认字存疑」；「缺空格」没下结论、也不认字存疑时写「缺空格」（Q2 新增，排在认字存疑之后，已有文案不变）。
 */
export function pendingWord(hit: ReviewIssueHit): string | null {
  if (isDecided(hit.decision)) return null;
  const status = String(hit.status || "");
  if (status === HELD) return null;
  if (BLOCKING_STATUSES.includes(status)) return status;
  if (SPACE_STATUSES.includes(status) && hit.decision === "pending") return status;
  if (hasReadingDoubt(hit)) return "认字存疑";
  return status === SPACE_MISSING ? status : null;
}

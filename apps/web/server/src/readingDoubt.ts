/**
 * 「认字存疑」：条目粗状态可能写「一致」，但结构化字段说明稿上还有字没读全，要人下结论才能签字。
 * 前后端共用。本文件不 import 任何东西（同 `feishuLoginError.ts`），前端
 * `apps/web/ui/src/pages/reviewEvidence.ts` 的 `isReviewIssue` 直接引用；服务端 `hitNeedsDecision` 可复用。
 *
 * 只看结构化字段，不看说明文字（`evidence` / `note`）：
 * - `coverage.miss` 里有非空词：任何状态都算存疑；
 * - 条目本身已被标记（`decision: "issue"`，或状态是待人工 / 不清 / 疑 / 缺 / 误一类）时，
 *   `sequence_diff.only_in_excel` 有非空片段，或 `doubt_bucket` 是 OCR 小字 / 大号图形字，也算存疑。
 */
export const READING_DOUBT_BUCKETS = ["ocr_smallprint", "ocr_graphic"] as const;

export type ReadingDoubtHit = {
  status?: string;
  decision?: string;
  doubt_bucket?: string;
  coverage?: { miss?: unknown } | null;
  sequence_diff?: { only_in_excel?: unknown } | null;
};

function hasNonBlank(list: unknown): boolean {
  return Array.isArray(list) && list.some((item) => String(item ?? "").trim().length > 0);
}

/** 条目已被标记要人看：结论是有错，或状态属于待人工 / 不清 / 疑 / 缺 / 误一类（按状态值，不按说明文字）。 */
export function isFlaggedReviewHit(hit: ReadingDoubtHit): boolean {
  return hit.decision === "issue" || /待人工|不清|疑|缺|误/u.test(String(hit.status || ""));
}

/** 认字存疑（结构化）：见文件头。 */
export function hasReadingDoubt(hit: ReadingDoubtHit): boolean {
  if (hasNonBlank(hit.coverage?.miss)) return true;
  if (!isFlaggedReviewHit(hit)) return false;
  if (hasNonBlank(hit.sequence_diff?.only_in_excel)) return true;
  return (READING_DOUBT_BUCKETS as readonly string[]).includes(String(hit.doubt_bucket || ""));
}

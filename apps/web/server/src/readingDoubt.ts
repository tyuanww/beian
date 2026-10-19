/**
 * 「认字存疑」：条目粗状态可能写「一致」，但结构化字段说明稿上还有字没读全，要人下结论才能签字。
 * 前后端共用。本文件不 import 任何东西（同 `feishuLoginError.ts`）。
 * `hasReadingDoubt` 给定稿拦截；`isFlaggedReviewHit` 给 `hitText.ts`。
 * 核对页是否算疑点在 `reviewIssue.ts` 的 `isReviewIssue`，不在本文件。
 *
 * 只看结构化字段，不看说明文字（`evidence` / `note`）：
 * - `coverage.miss` 里有非空词：任何状态都算存疑；
 * - 条目本身已被标记（`decision: "issue"`，或状态在 `FLAGGED_STATUSES` 里）时，
 *   `sequence_diff.only_in_excel` 有非空片段，或 `doubt_bucket` 是 OCR 小字 / 大号图形字，也算存疑。
 */
const READING_DOUBT_BUCKETS = ["ocr_smallprint", "ocr_graphic"] as const;

/**
 * 「已标记」的条目状态：明确集合，不按字面匹配。状态是有限集（服务端 `tasks.ts` 的 `HIT_STATUSES` =
 * 「一致 / 疑点 / 缺失 / 跳过」+ `verbatim_statuses.json` 的 `statuses`）；为保持零依赖这里写死，
 * `readingDoubt.test.ts` 断言它都在已知集合里、且与原来的「待人工 / 不清 / 疑 / 缺 / 误」口径逐个相同，防漂移。
 * 不在已知集合里的状态，服务端 `/complete` 先回 400「审核数据状态异常」，前端 `hasInvalidHitStatus` 也拦。
 */
const FLAGGED_STATUSES: readonly string[] = ["疑点", "缺失", "缺空格", "待人工确认"];

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

/** 条目已被标记要人看：结论是有错，或状态在 `FLAGGED_STATUSES` 里（按状态值，不按说明文字）。 */
export function isFlaggedReviewHit(hit: ReadingDoubtHit): boolean {
  return hit.decision === "issue" || FLAGGED_STATUSES.includes(String(hit.status || ""));
}

/** 认字存疑（结构化）：见文件头。 */
export function hasReadingDoubt(hit: ReadingDoubtHit): boolean {
  if (hasNonBlank(hit.coverage?.miss)) return true;
  if (!isFlaggedReviewHit(hit)) return false;
  if (hasNonBlank(hit.sequence_diff?.only_in_excel)) return true;
  return (READING_DOUBT_BUCKETS as readonly string[]).includes(String(hit.doubt_bucket || ""));
}

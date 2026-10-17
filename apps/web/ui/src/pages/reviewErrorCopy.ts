import { REVIEW_COPY } from "../copy/labels";
import { customerCopy } from "./customerCopy";

/** 后端超页错误码（任务字段 job_error_code）。只认码，不看文案。 */
const PAGE_OVER_CODE = "page_over";
const OCR_FAILED = /认字|\bOCR\b|文字识别/iu;

function isPageOver(code?: string): boolean {
  return code === PAGE_OVER_CODE;
}

/** 核对页给审稿员看的任务报错。超页按错误码、认字失败换成定稿口径，其余仍走 customerCopy。 */
/** 失败但保留上一轮条目的单子：复核失败，或首次核对被中断回收（compare）。 */
export type FailedWithHitsKind = "rework" | "compare";

/**
 * `canReupload`：失败条里有没有「重新上传这一单」按钮（与按钮同一个 `canReuploadFailed` 结果）。
 * 有按钮：句尾写重新上传，且同一条里不出「请联系管理员」；没有按钮：不写重新上传。
 */
export function reviewErrorCopy(raw: string, code?: string, failedWithHits?: FailedWithHitsKind, canReupload = false): string {
  // 超页（按码）：带上一轮条目的（复核或检查中断都一样），或这条有重新上传按钮，用黄条定稿文案。
  if (isPageOver(code) && (failedWithHits || canReupload)) return canReupload ? REVIEW_COPY.reworkPageOver : REVIEW_COPY.reworkPageOverReadOnly;
  if (failedWithHits === "rework") return canReupload ? REVIEW_COPY.reworkFailed : REVIEW_COPY.reworkFailedReadOnly;
  if (failedWithHits === "compare") return canReupload ? REVIEW_COPY.compareFailedWithHits : REVIEW_COPY.compareFailedWithHitsReadOnly;
  if (isPageOver(code)) return REVIEW_COPY.pageOver;
  const text = String(raw || "");
  // error-text-match-allow -- 待后端错误码，见 TODOS.md「前端按报错文案判断状态」
  if (OCR_FAILED.test(text)) return canReupload ? REVIEW_COPY.ocrFailedReupload : REVIEW_COPY.ocrFailed;
  return customerCopy(text);
}

/** 超页是产品限制，不是机器报错：用 warning 级 Alert；其余报错仍用 error。 */
export function reviewErrorType(code?: string): "warning" | "error" {
  return isPageOver(code) ? "warning" : "error";
}

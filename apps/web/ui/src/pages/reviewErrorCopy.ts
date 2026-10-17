import { REVIEW_COPY } from "../copy/labels";
import { customerCopy } from "./customerCopy";

/** 后端超页错误码（任务字段 job_error_code）。只认码，不看文案。 */
const PAGE_OVER_CODE = "page_over";
const OCR_FAILED = /认字|\bOCR\b|文字识别/iu;

function isPageOver(code?: string): boolean {
  return code === PAGE_OVER_CODE;
}

/** 核对页给审稿员看的任务报错。超页按错误码、认字失败换成定稿口径，其余仍走 customerCopy。 */
export function reviewErrorCopy(raw: string, code?: string, reworkFailedWithHits = false): string {
  if (reworkFailedWithHits) return isPageOver(code) ? REVIEW_COPY.reworkPageOver : REVIEW_COPY.reworkFailed;
  if (isPageOver(code)) return REVIEW_COPY.pageOver;
  const text = String(raw || "");
  if (OCR_FAILED.test(text)) return REVIEW_COPY.ocrFailed;
  return customerCopy(text);
}

/** 超页是产品限制，不是机器报错：用 warning 级 Alert；其余报错仍用 error。 */
export function reviewErrorType(code?: string): "warning" | "error" {
  return isPageOver(code) ? "warning" : "error";
}

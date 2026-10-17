import { REVIEW_COPY } from "../copy/labels";
import { customerCopy } from "./customerCopy";

// 后端真实文案如「稿件超过 1 页，暂不支持核对，请联系管理员」（publicJobError → job_error，不带 code）。
const PAGE_OVER = /page_over|页数超过可核对页数|超页|超过\s*\d+\s*页|暂不支持核对/u;
const OCR_FAILED = /认字|\bOCR\b|文字识别/iu;

/** 核对页给审稿员看的任务报错。超页、认字失败换成定稿口径，其余仍走 customerCopy。 */
export function reviewErrorCopy(raw: string): string {
  const text = String(raw || "");
  if (PAGE_OVER.test(text)) return REVIEW_COPY.pageOver;
  if (OCR_FAILED.test(text)) return REVIEW_COPY.ocrFailed;
  return customerCopy(text);
}

/** 超页是产品限制，不是机器报错：用 warning 级 Alert；其余报错仍用 error。 */
export function reviewErrorType(raw: string): "warning" | "error" {
  return PAGE_OVER.test(String(raw || "")) ? "warning" : "error";
}

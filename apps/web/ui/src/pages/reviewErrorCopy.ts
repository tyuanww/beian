import { REVIEW_COPY } from "../copy/labels";
import { customerCopy } from "./customerCopy";

const PAGE_OVER = /page_over|页数超过可核对页数|超页/u;
const OCR_FAILED = /认字|\bOCR\b|文字识别/iu;

/** 核对页给审稿员看的任务报错。超页、认字失败换成定稿口径，其余仍走 customerCopy。 */
export function reviewErrorCopy(raw: string): string {
  const text = String(raw || "");
  if (PAGE_OVER.test(text)) return REVIEW_COPY.pageOver;
  if (OCR_FAILED.test(text)) return REVIEW_COPY.ocrFailed;
  return customerCopy(text);
}

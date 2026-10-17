import { REVIEW_COPY } from "../copy/labels";
import type { JobErrorCode } from "../../../server/src/reviewCodes.ts";
import { customerCopy } from "./customerCopy";

/**
 * 任务字段 job_error_code（共享码表 `reviewCodes.ts` 的 `JOB_ERROR_CODES`）。只认码，不看 job_error 原文：
 * 原文可能改字（超页已改成只存前半句），判断不能跟着变。
 */
type CodeCopy = { reupload: string; readOnly: string };
const JOB_CODE_COPY: Readonly<Partial<Record<JobErrorCode, CodeCopy>>> = {
  // 产品哥 10/17 20:11 定稿：有按钮的句子特意留「再不行请联系管理员」退路（只对这一句放开）。
  ocr_failed: { reupload: REVIEW_COPY.ocrFailedReupload, readOnly: REVIEW_COPY.ocrFailed },
  result_truncated: { reupload: REVIEW_COPY.resultTruncatedReupload, readOnly: REVIEW_COPY.resultTruncated },
  private_data_failed: { reupload: REVIEW_COPY.privateDataFailedReupload, readOnly: REVIEW_COPY.privateDataFailed },
};

function isPageOver(code?: string): boolean {
  return code === "page_over";
}

/** 失败但保留上一轮条目的单子：复核失败，或首次核对被中断回收（compare）。 */
export type FailedWithHitsKind = "rework" | "compare";

/**
 * 核对页给审稿员看的任务报错。全部按 job_error_code 选句，其余仍走 customerCopy，不做文字匹配。
 *
 * `canReupload`：失败条里有没有「重新上传这一单」按钮（与按钮同一个 `canReuploadFailed` 结果）。
 * 有按钮：句尾写重新上传，且同一条里不出「请联系管理员」——认字失败（`ocr_failed`）例外（`ocrFailedReupload`，
 * 产品哥特意留「再不行请联系管理员」退路）；没有按钮：不写重新上传。
 * 带上一轮条目的失败（复核失败 / 检查中断）先返回：照 B 定稿走红条 / 检查中断句，没有单独的认字版本，
 * 所以「下面是上一轮的结果」只会出现在真有上一轮条目的单上。
 */
export function reviewErrorCopy(raw: string, code?: string, failedWithHits?: FailedWithHitsKind, canReupload = false): string {
  // 超页（按码）带上一轮条目的（复核或检查中断都一样）：黄条定稿文案，后半句跟着按钮。
  if (isPageOver(code) && failedWithHits) return canReupload ? REVIEW_COPY.reworkPageOver : REVIEW_COPY.reworkPageOverReadOnly;
  if (failedWithHits === "rework") return canReupload ? REVIEW_COPY.reworkFailed : REVIEW_COPY.reworkFailedReadOnly;
  if (failedWithHits === "compare") return canReupload ? REVIEW_COPY.compareFailedWithHits : REVIEW_COPY.compareFailedWithHitsReadOnly;
  // 超页没有上一轮条目：服务端原文只有前半句，有按钮才拼「，请改成 N 页后重新上传这一单」（Q9）；不写「下面是上一轮的结果」。
  if (isPageOver(code)) return canReupload ? REVIEW_COPY.pageOverReupload : REVIEW_COPY.pageOver;
  const byCode = code ? JOB_CODE_COPY[code as JobErrorCode] : undefined;
  if (byCode) return canReupload ? byCode.reupload : byCode.readOnly;
  return customerCopy(String(raw || ""));
}

/** 超页是产品限制，不是机器报错：用 warning 级 Alert；其余报错仍用 error。 */
export function reviewErrorType(code?: string): "warning" | "error" {
  return isPageOver(code) ? "warning" : "error";
}

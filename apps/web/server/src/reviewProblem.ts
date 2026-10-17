import { REVIEW_CODE_STATUS, reviewDetail, type ReviewCode, type ReviewParams } from "./reviewCodes.js";

/**
 * 审稿接口带码的拒绝：返回体 `{ detail, code, params? }`（`app.onError` 输出）。
 * 状态码和原文都从 `reviewCodes.ts` 码表取，调用处只给码；原文由调用处给的码（码表登记为 null）必须传 `detail`。
 */
export class ReviewProblem extends Error {
  readonly status: 400 | 404 | 409;

  constructor(
    readonly code: ReviewCode,
    readonly params?: ReviewParams,
    detail?: string,
  ) {
    const text = detail ?? reviewDetail(code, params);
    if (text == null) throw new Error(`review code ${code} needs an explicit detail`);
    super(text);
    this.status = REVIEW_CODE_STATUS[code];
  }
}

export function reviewProblemBody(err: ReviewProblem): { detail: string; code: ReviewCode; params?: ReviewParams } {
  return { detail: err.message, code: err.code, ...(err.params ? { params: err.params } : {}) };
}

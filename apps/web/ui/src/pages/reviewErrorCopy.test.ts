import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVIEW_COPY } from "../copy/labels.js";
import { reviewErrorCopy, reviewErrorType } from "./reviewErrorCopy.js";

describe("reviewer-visible labels", () => {
  it("uses the agreed wording", () => {
    assert.equal(REVIEW_COPY.heldUnread, "认字存疑");
    assert.equal(REVIEW_COPY.spotTitle, "对照卡");
    assert.equal(REVIEW_COPY.ocrFailed, "认字出了问题，请联系管理员");
    assert.equal(REVIEW_COPY.pageOver, "稿件超过 1 页，暂不支持核对，请联系管理员");
    assert.doesNotMatch(REVIEW_COPY.pageOver, /拆分/u);
  });
});

describe("reviewErrorCopy", () => {
  it("hides OCR internals behind one sentence", () => {
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果"), REVIEW_COPY.ocrFailed);
    assert.equal(reviewErrorCopy("百度 OCR 超时"), REVIEW_COPY.ocrFailed);
    assert.equal(reviewErrorCopy("认字出了问题，请联系管理员"), REVIEW_COPY.ocrFailed);
  });

  it("rework failures that keep the last round's hits get the agreed sentence", () => {
    assert.equal(REVIEW_COPY.reworkFailed, "复核出了问题，下面是上一轮的结果，请联系管理员");
    assert.equal(reviewErrorCopy("对照中断", undefined, true), REVIEW_COPY.reworkFailed);
    assert.notEqual(reviewErrorCopy("对照中断"), REVIEW_COPY.reworkFailed);
  });

  it("rework page_over with last round's hits gets its own sentence and a warning", () => {
    assert.equal(REVIEW_COPY.reworkPageOver, "稿件超过 1 页，这次复核没做，下面是上一轮的结果，请联系管理员");
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over", true), REVIEW_COPY.reworkPageOver);
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over"), REVIEW_COPY.pageOver);
    assert.equal(reviewErrorType("page_over"), "warning");
  });

  it("leaves other errors to customerCopy", () => {
    assert.equal(reviewErrorCopy("对照失败"), "检查失败");
    assert.equal(reviewErrorCopy(""), "");
  });
});

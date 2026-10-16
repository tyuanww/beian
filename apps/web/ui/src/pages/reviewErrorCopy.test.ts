import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVIEW_COPY } from "../copy/labels.js";
import { reviewErrorCopy } from "./reviewErrorCopy.js";

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
  it("maps the backend page_over sentence to the product wording", () => {
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数"), REVIEW_COPY.pageOver);
    assert.equal(reviewErrorCopy("page_over_rendered"), REVIEW_COPY.pageOver);
  });

  it("hides OCR internals behind one sentence", () => {
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果"), REVIEW_COPY.ocrFailed);
    assert.equal(reviewErrorCopy("百度 OCR 超时"), REVIEW_COPY.ocrFailed);
    assert.equal(reviewErrorCopy("认字出了问题，请联系管理员"), REVIEW_COPY.ocrFailed);
  });

  it("leaves other errors to customerCopy", () => {
    assert.equal(reviewErrorCopy("对照失败"), "检查失败");
    assert.equal(reviewErrorCopy(""), "");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVIEW_COPY } from "../copy/labels.js";
import { reviewErrorCopy, reviewErrorType } from "./reviewErrorCopy.js";

describe("reviewer-visible labels", () => {
  it("uses the agreed wording", () => {
    assert.equal(REVIEW_COPY.heldUnread, "认字存疑");
    assert.equal(REVIEW_COPY.spotTitle, "对照卡");
    assert.equal(REVIEW_COPY.ocrFailed, "认字出了问题，请联系管理员");
    assert.equal(REVIEW_COPY.pageOver, "稿件超过 1 页");
    assert.equal(REVIEW_COPY.pageOverReupload, "稿件超过 1 页，请改成 1 页后重新上传这一单");
    assert.doesNotMatch(REVIEW_COPY.pageOver, /拆分|请联系管理员|回首页/u);
    assert.doesNotMatch(REVIEW_COPY.pageOverReupload, /拆分|请联系管理员|回首页/u);
  });
});

describe("reviewErrorCopy", () => {
  it("认字失败按码（job_error_code === \"ocr_failed\"）出定稿句，不看原文", () => {
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", "ocr_failed"), REVIEW_COPY.ocrFailed);
    assert.equal(reviewErrorCopy("百度 OCR 超时", "ocr_failed"), REVIEW_COPY.ocrFailed);
    assert.equal(reviewErrorCopy("", "ocr_failed"), REVIEW_COPY.ocrFailed);
    // 没有码就不再按文字认认字失败（删掉了 OCR_FAILED 正则）：原文走 customerCopy。
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果"), "认字组件没装上，没有结果");
    assert.equal(reviewErrorCopy("百度 OCR 超时"), "文字识别 超时");
  });

  it("result_truncated / private_data_failed 按码出产品定稿句（没按钮）", () => {
    assert.equal(REVIEW_COPY.resultTruncated, "这一单结果太多，没能写完，请联系管理员");
    assert.equal(REVIEW_COPY.privateDataFailed, "稿件里的 Illustrator 私有数据读不出来，请联系管理员");
    assert.equal(reviewErrorCopy("这一单结果没写完，没有结果", "result_truncated"), "这一单结果太多，没能写完，请联系管理员");
    assert.equal(reviewErrorCopy("私有数据解析失败", "private_data_failed"), "稿件里的 Illustrator 私有数据读不出来，请联系管理员");
    assert.equal(reviewErrorType("result_truncated"), "error");
    assert.equal(reviewErrorType("private_data_failed"), "error");
    assert.equal(reviewErrorType("ocr_failed"), "error");
  });

  it("result_truncated / private_data_failed 有没有按钮都用 §2.3 整句（带请联系管理员）", () => {
    assert.equal(reviewErrorCopy("这一单结果没写完，没有结果", "result_truncated", undefined, true), "这一单结果太多，没能写完，请联系管理员");
    assert.equal(reviewErrorCopy("私有数据解析失败", "private_data_failed", undefined, true), "稿件里的 Illustrator 私有数据读不出来，请联系管理员");
  });

  it("rework failures that keep the last round's hits get the agreed sentence", () => {
    assert.equal(REVIEW_COPY.reworkFailed, "复核出了问题，下面是上一轮的结果，可以重新上传这一单");
    assert.equal(reviewErrorCopy("对照中断", undefined, "rework", true), REVIEW_COPY.reworkFailed);
    assert.notEqual(reviewErrorCopy("对照中断"), REVIEW_COPY.reworkFailed);
  });

  it("rework page_over with last round's hits gets its own sentence and a warning", () => {
    assert.equal(REVIEW_COPY.reworkPageOver, "稿件超过 1 页，这次复核没做，下面是上一轮的结果。请改成 1 页后重新上传这一单");
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over", "rework", true), REVIEW_COPY.reworkPageOver);
    // 旧单 job_error 原文还带「请联系管理员」：黄条只看 job_error_code，不拼原文。
    assert.equal(reviewErrorCopy("稿件超过 1 页，暂不支持核对，请联系管理员", "page_over", "rework", true), REVIEW_COPY.reworkPageOver);
    assert.doesNotMatch(REVIEW_COPY.reworkPageOver, /请联系管理员/u);
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over"), REVIEW_COPY.pageOver);
    assert.equal(reviewErrorType("page_over"), "warning");
  });

  it("超页没有上一轮条目（Q9）：服务端前半句原样不拼，前端按有没有按钮选句；页数读 REVIEW_PAGE_LIMIT", () => {
    for (const raw of ["稿件超过 1 页", "稿件超过 1 页，暂不支持核对，请联系管理员", "这一单页数超过可核对页数", ""]) {
      assert.equal(reviewErrorCopy(raw, "page_over", undefined, true), "稿件超过 1 页，请改成 1 页后重新上传这一单", raw);
      assert.equal(reviewErrorCopy(raw, "page_over", undefined, false), "稿件超过 1 页", raw);
      assert.doesNotMatch(reviewErrorCopy(raw, "page_over", undefined, true), /下面是上一轮的结果|请联系管理员/u, raw);
    }
    assert.equal(reviewErrorType("page_over"), "warning");
    // 页数常量：两句都从同一个上限拼。
    const n = /稿件超过 (\d+) 页/u.exec(REVIEW_COPY.pageOver)?.[1];
    assert.equal(REVIEW_COPY.pageOverReupload, `稿件超过 ${n} 页，请改成 ${n} 页后重新上传这一单`);
  });

  it("an interrupted compare that kept the last round's hits gets its own sentence", () => {
    assert.equal(REVIEW_COPY.compareFailedWithHits, "检查中断了，下面是上一轮的结果，可以重新上传这一单");
    assert.equal(reviewErrorCopy("对照中断", undefined, "compare", true), REVIEW_COPY.compareFailedWithHits);
    assert.equal(reviewErrorCopy("对照中断", undefined, "rework", true), REVIEW_COPY.reworkFailed);
  });

  it("检查中断又带 page_over 码（找茬哥）：按黄条定稿，后半句跟着按钮；不出「请联系管理员」", () => {
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over", "compare", true), REVIEW_COPY.reworkPageOver);
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over", "compare", false), REVIEW_COPY.reworkPageOverReadOnly);
  });

  it("同一条里有重新上传按钮时：ocr_failed 无上一轮用 ocrFailedReupload；result_truncated / private_data_failed 用 §2.3 整句；其余分支不出「请联系管理员」", () => {
    // ocrFailedReupload：产品哥 2026-10-17 定稿，没有剩余条目的认字失败单留「再不行请联系管理员」。
    // result_truncated / private_data_failed：产品哥 10/17 拍回 §2.3 整句，有没有按钮都带「请联系管理员」。
    // 其他分支（复核失败红条、检查中断、超页黄条）仍锁住不出「请联系管理员」。
    const raws = ["认字组件没装上，没有结果", "认字出了问题，请联系管理员", "对照中断", "对照失败", "这一单页数超过可核对页数", "私有数据解析失败，请联系管理员", ""];
    const codes = [undefined, "page_over", "ocr_failed", "result_truncated", "private_data_failed"] as const;
    let opened = 0;
    for (const raw of raws) {
      for (const code of codes) {
        for (const kind of [undefined, "rework", "compare"] as const) {
          const text = reviewErrorCopy(raw, code, kind, true);
          const label = `${raw} ${code} ${kind}`;
          if (code === "ocr_failed" && kind === undefined) {
            opened += 1;
            assert.equal(text, REVIEW_COPY.ocrFailedReupload, label);
          } else if ((code === "result_truncated" || code === "private_data_failed") && kind === undefined) {
            assert.match(text, /请联系管理员/u, label);
            assert.notEqual(text, REVIEW_COPY.ocrFailedReupload, label);
          } else {
            assert.notEqual(text, REVIEW_COPY.ocrFailedReupload, label);
            if (code !== undefined || !/请联系管理员/u.test(raw)) assert.doesNotMatch(text, /请联系管理员/u, label);
          }
        }
      }
    }
    assert.equal(opened, raws.length, "放开的只有 ocr_failed + 没有上一轮条目 这一格");
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over"), REVIEW_COPY.pageOver);
    assert.equal(reviewErrorCopy("认字组件没装上", "ocr_failed"), REVIEW_COPY.ocrFailed);
  });

  it("认字失败两句逐字：有按钮带「再不行请联系管理员」退路，没按钮是原句", () => {
    assert.equal(REVIEW_COPY.ocrFailedReupload, "认字出了问题，可以重新上传这一单，再不行请联系管理员");
    assert.equal(REVIEW_COPY.ocrFailed, "认字出了问题，请联系管理员");
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", "ocr_failed", undefined, true), "认字出了问题，可以重新上传这一单，再不行请联系管理员");
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", "ocr_failed", undefined, false), "认字出了问题，请联系管理员");
  });

  it("复核认字失败但带上一轮条目：仍是复核失败红条那句，不走认字失败的句子", () => {
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", "ocr_failed", "rework", true), REVIEW_COPY.reworkFailed);
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", "ocr_failed", "rework", false), REVIEW_COPY.reworkFailedReadOnly);
    assert.equal(REVIEW_COPY.reworkFailed, "复核出了问题，下面是上一轮的结果，可以重新上传这一单");
    assert.equal(REVIEW_COPY.reworkFailedReadOnly, "复核出了问题，下面是上一轮的结果");
  });

  it("首轮认字失败（没有上一轮结果）：原句「认字出了问题，请联系管理员」，不出「下面是上一轮的结果」", () => {
    for (const raw of ["认字出了问题，请联系管理员", "认字组件没装上，没有结果", "百度 OCR 超时", ""]) {
      for (const canReupload of [false, true]) {
        const text = reviewErrorCopy(raw, "ocr_failed", undefined, canReupload);
        assert.doesNotMatch(text, /下面是上一轮的结果/u, raw);
      }
      assert.equal(reviewErrorCopy(raw, "ocr_failed", undefined, false), REVIEW_COPY.ocrFailed, raw);
    }
    assert.doesNotMatch(REVIEW_COPY.ocrFailedReupload, /下面是上一轮的结果/u, "没有剩余条目：也不写上一轮");
  });

  it("leaves other errors to customerCopy", () => {
    assert.equal(reviewErrorCopy("对照失败"), "检查失败");
    assert.equal(reviewErrorCopy(""), "");
  });
});

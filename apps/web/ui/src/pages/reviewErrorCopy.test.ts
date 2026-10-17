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
    assert.equal(REVIEW_COPY.reworkFailed, "复核出了问题，下面是上一轮的结果，可以重新上传这一单");
    assert.equal(reviewErrorCopy("对照中断", undefined, "rework", true), REVIEW_COPY.reworkFailed);
    assert.notEqual(reviewErrorCopy("对照中断"), REVIEW_COPY.reworkFailed);
  });

  it("rework page_over with last round's hits gets its own sentence and a warning", () => {
    assert.equal(REVIEW_COPY.reworkPageOver, "稿件超过 1 页，这次复核没做，下面是上一轮的结果。请改成 1 页后重新上传这一单");
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over", "rework", true), REVIEW_COPY.reworkPageOver);
    // 服务端 job_error 原文还带「请联系管理员」：黄条只看 job_error_code，不拼原文。
    assert.equal(reviewErrorCopy("稿件超过 1 页，暂不支持核对，请联系管理员", "page_over", "rework", true), REVIEW_COPY.reworkPageOver);
    assert.doesNotMatch(REVIEW_COPY.reworkPageOver, /请联系管理员/u);
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over"), REVIEW_COPY.pageOver);
    assert.equal(reviewErrorType("page_over"), "warning");
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

  it("同一条里有重新上传按钮时，除没有剩余条目的认字失败外任何分支都不出「请联系管理员」", () => {
    // 只对 ocrFailedReupload 这一句放开：产品哥 2026-10-17 定稿，没有剩余条目的认字失败单在重新上传后面特意留
    // 「再不行请联系管理员」作退路——认字失败重新上传未必能好（可能是认字服务本身的问题），得给审稿员一条找人的路。
    // 其他分支（复核失败红条含认字失败、检查中断、超页黄条、其他报错）仍锁住：有按钮就不叫人联系管理员。
    const raws = ["认字组件没装上，没有结果", "认字出了问题，请联系管理员", "对照中断", "对照失败", "这一单页数超过可核对页数", ""];
    const ocrRaws = new Set(["认字组件没装上，没有结果", "认字出了问题，请联系管理员"]);
    let opened = 0;
    for (const raw of raws) {
      for (const code of [undefined, "page_over"]) {
        for (const kind of [undefined, "rework", "compare"] as const) {
          const text = reviewErrorCopy(raw, code, kind, true);
          const label = `${raw} ${code} ${kind}`;
          // 走到 ocrFailedReupload 的只有：认字原文、没有 page_over 码、没有带上一轮条目（超页码和带条目的失败条优先）。
          if (ocrRaws.has(raw) && code === undefined && kind === undefined) {
            opened += 1;
            assert.equal(text, REVIEW_COPY.ocrFailedReupload, label);
          } else {
            assert.notEqual(text, REVIEW_COPY.ocrFailedReupload, label);
            assert.doesNotMatch(text, /请联系管理员/u, label);
          }
        }
      }
    }
    assert.equal(opened, ocrRaws.size, "放开的只有 ocrFailedReupload 这一句");
    // 没有剩余条目但有按钮（复核失败）：超页走黄条，认字失败换成带退路的句子。
    assert.equal(reviewErrorCopy("稿件超过 1 页，暂不支持核对，请联系管理员", "page_over", undefined, true), REVIEW_COPY.reworkPageOver);
    assert.equal(reviewErrorCopy("认字组件没装上", undefined, undefined, true), REVIEW_COPY.ocrFailedReupload);
    // 没有按钮：原样（首次检查失败、无条目对照失败另有「回首页」）。
    assert.equal(reviewErrorCopy("这一单页数超过可核对页数", "page_over"), REVIEW_COPY.pageOver);
    assert.equal(reviewErrorCopy("认字组件没装上"), REVIEW_COPY.ocrFailed);
  });

  it("认字失败两句逐字：有按钮带「再不行请联系管理员」退路，没按钮是原句", () => {
    assert.equal(REVIEW_COPY.ocrFailedReupload, "认字出了问题，可以重新上传这一单，再不行请联系管理员");
    assert.equal(REVIEW_COPY.ocrFailed, "认字出了问题，请联系管理员");
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", undefined, undefined, true), "认字出了问题，可以重新上传这一单，再不行请联系管理员");
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", undefined, undefined, false), "认字出了问题，请联系管理员");
  });

  it("复核认字失败但带上一轮条目：仍是复核失败红条那句，不走认字失败的句子", () => {
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", undefined, "rework", true), REVIEW_COPY.reworkFailed);
    assert.equal(reviewErrorCopy("认字组件没装上，没有结果", undefined, "rework", false), REVIEW_COPY.reworkFailedReadOnly);
  });

  it("预检失败、首轮认字失败（没有上一轮结果）：原句「认字出了问题，请联系管理员」，不出「下面是上一轮的结果」", () => {
    // 预检失败：服务端 workers.ts VERBATIM_PROBE_FALLBACK 原句；首轮认字失败：组件 / 服务原文。都没有上一轮条目，也没有按钮。
    for (const raw of ["认字出了问题，请联系管理员", "认字组件没装上，没有结果", "百度 OCR 超时"]) {
      const text = reviewErrorCopy(raw, undefined, undefined, false);
      assert.equal(text, REVIEW_COPY.ocrFailed, raw);
      assert.doesNotMatch(text, /下面是上一轮的结果/u, raw);
    }
    assert.doesNotMatch(REVIEW_COPY.ocrFailedReupload, /下面是上一轮的结果/u, "没有剩余条目：也不写上一轮");
  });

  it("leaves other errors to customerCopy", () => {
    assert.equal(reviewErrorCopy("对照失败"), "检查失败");
    assert.equal(reviewErrorCopy(""), "");
  });
});

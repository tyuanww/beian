import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasReadingDoubt } from "./readingDoubt.js";
import { VERBATIM_STATUSES, isValidHitReviewState } from "./tasks.js";

// 已知状态全集：同 tasks.ts HIT_STATUSES（VERBATIM_STATUSES 已由 verbatim-contract.test.ts 锁到 verbatim_statuses.json）。
const KNOWN = ["一致", "疑点", "缺失", "跳过", ...VERBATIM_STATUSES.statuses];
const FLAGGED = ["疑点", "缺失", "缺空格", "待人工确认"];

describe("hasReadingDoubt（认字存疑，前后端共用）", () => {
  it("「已标记」状态是明确集合：都在已知状态里，且与旧的字面口径逐个相同（防漂移）", () => {
    for (const status of FLAGGED) assert.equal(isValidHitReviewState({ status }), true, status);
    assert.deepEqual(KNOWN.filter((s) => /待人工|不清|疑|缺|误/u.test(s)), FLAGGED);
    for (const status of KNOWN) {
      // 只有已标记条目才看 doubt_bucket / sequence_diff。
      assert.equal(hasReadingDoubt({ status, doubt_bucket: "ocr_graphic" }), FLAGGED.includes(status), status);
      assert.equal(hasReadingDoubt({ status, sequence_diff: { only_in_excel: ["香柠檬"] } }), FLAGGED.includes(status), status);
    }
  });

  it("不在已知集合的状态不靠字面算已标记（这类单子由「审核数据状态异常」先拦）", () => {
    assert.equal(hasReadingDoubt({ status: "看不清", doubt_bucket: "ocr_graphic" }), false);
    assert.equal(hasReadingDoubt({ status: "疑似误读", sequence_diff: { only_in_excel: ["x"] } }), false);
  });

  it("coverage.miss 有非空词时任何状态都算；有错结论也算已标记", () => {
    assert.equal(hasReadingDoubt({ status: "一致", coverage: { miss: ["CAPSULE MIST"] } }), true);
    assert.equal(hasReadingDoubt({ status: "一致", coverage: { miss: ["", "  "] } }), false);
    assert.equal(hasReadingDoubt({ status: "一致", decision: "issue", doubt_bucket: "ocr_smallprint" }), true);
  });
});

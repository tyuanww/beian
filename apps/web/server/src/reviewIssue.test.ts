import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BLOCKING_STATUSES, isReviewIssue, pendingWord, SPACE_STATUSES } from "./reviewIssue.js";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-review-issue-");
const { VERBATIM_STATUSES } = await import("./tasks.js");
const KNOWN = ["一致", "疑点", "缺失", "跳过", ...VERBATIM_STATUSES.statuses];

describe("待确认口径 reviewIssue.ts（前后端共用）", () => {
  it("状态集合防漂移：真错 ∪ {疑点、缺失}、空格类与 verbatim_statuses.json 一致", () => {
    assert.deepEqual(new Set(BLOCKING_STATUSES), new Set([...VERBATIM_STATUSES.true_errors, "疑点", "缺失"]));
    assert.deepEqual(new Set(SPACE_STATUSES), new Set(VERBATIM_STATUSES.space_errors));
    for (const s of [...BLOCKING_STATUSES, ...SPACE_STATUSES]) assert.ok(KNOWN.includes(s), s);
  });

  it("原前端正则 /不清|误/ 在已知状态里一个都不命中：删掉不改行为", () => {
    for (const status of KNOWN) assert.doesNotMatch(status, /不清|误/u, status);
  });

  it("缺空格没下结论一律要结论（Q2），不看核对要点；下了结论就不拦", () => {
    for (const decision of [undefined, null, "pending"]) {
      const hit = { status: "缺空格", decision: decision as string | undefined };
      assert.equal(pendingWord(hit), "缺空格", String(decision));
      assert.equal(isReviewIssue(hit), true);
    }
    for (const decision of ["confirm", "ignore", "issue"]) assert.equal(pendingWord({ status: "缺空格", decision }), null, decision);
    assert.equal(pendingWord({ status: "缺空格", evidence: "稿件「香柠檬精油」少一个空格" } as never), "缺空格");
  });

  it("已有文案不变：缺空格认字存疑仍写「认字存疑」，多空格没标 pending 不拦", () => {
    assert.equal(pendingWord({ status: "缺空格", sequence_diff: { only_in_excel: ["香柠檬"] } }), "认字存疑");
    assert.equal(pendingWord({ status: "多空格" }), null);
    assert.equal(pendingWord({ status: "多空格", decision: "pending" }), "多空格");
    assert.equal(pendingWord({ status: "疑点" }), "疑点");
    assert.equal(pendingWord({ status: "一致", coverage: { miss: ["CAPSULE MIST"] } }), "认字存疑");
    assert.equal(pendingWord({ status: "一致" }), null);
  });

  it("待人工确认不在这里算（逐字单走整单确认，非逐字单 completeGate 另计）", () => {
    assert.equal(pendingWord({ status: "待人工确认" }), null);
    assert.equal(isReviewIssue({ status: "待人工确认", decision: "issue" }), false);
  });

  it("isReviewIssue：有错一律算；下过结论的疑点 / 缺空格仍在要看列表里", () => {
    assert.equal(isReviewIssue({ status: "一致", decision: "issue" }), true);
    assert.equal(isReviewIssue({ status: "疑点", decision: "confirm" }), true);
    assert.equal(isReviewIssue({ status: "缺空格", decision: "ignore" }), true);
    assert.equal(isReviewIssue({ status: "多空格", decision: "confirm" }), false);
    assert.equal(isReviewIssue({ status: "一致" }), false);
  });
});

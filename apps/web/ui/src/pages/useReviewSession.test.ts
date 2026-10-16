import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { phoneDraftPlan } from "./useReviewSession.js";

describe("phoneDraftPlan", () => {
  it("keeps drafts: first open on phone (null → phone) never drops anything by itself", () => {
    // 旧单测把 null→phone 写成应丢，是错的。现在切到手机只出计划，不自动丢。
    const plan = phoneDraftPlan([{ id: "a", decision: "issue", note: "" }], { a: "刚写的" });
    assert.deepEqual(plan, { save: [{ id: "a", decision: "issue", note: "刚写的" }], drop: [] });
  });

  it("skips drafts that equal the saved note", () => {
    assert.deepEqual(phoneDraftPlan([{ id: "a", decision: "issue", note: "已存" }], { a: "已存" }), { save: [], drop: [] });
  });

  it("only offers to drop drafts that have no decision to save under", () => {
    const plan = phoneDraftPlan(
      [{ id: "a" }, { id: "b", decision: "pending" }, { id: "c", decision: "ignore", note: "x" }, { decision: "issue" }],
      { a: "没结论", b: "也没", c: "改了" },
    );
    assert.deepEqual(plan.drop, ["a", "b"]);
    assert.deepEqual(plan.save, [{ id: "c", decision: "ignore", note: "改了" }]);
  });
});

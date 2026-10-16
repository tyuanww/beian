import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { allowedDecisions, isDecisionAllowed, isHeldStatus } from "./reviewDecisions.js";

describe("allowedDecisions", () => {
  it("待人工确认 cannot confirm, matching the server /decision rule", () => {
    assert.deepEqual(allowedDecisions({ status: "待人工确认" }), ["issue", "ignore"]);
    assert.equal(isDecisionAllowed({ status: "待人工确认" }, "confirm"), false);
    assert.equal(isDecisionAllowed({ status: "待人工确认" }, "issue"), true);
    assert.equal(isDecisionAllowed({ status: "待人工确认" }, "ignore"), true);
  });

  it("other statuses allow all three verdicts, never pending", () => {
    for (const status of ["疑点", "缺失", "一致", undefined]) {
      assert.deepEqual(allowedDecisions({ status }), ["confirm", "issue", "ignore"]);
      assert.equal(isDecisionAllowed({ status }, "pending"), false);
    }
    assert.deepEqual(allowedDecisions(undefined), ["confirm", "issue", "ignore"]);
    assert.equal(isHeldStatus({ status: "疑点" }), false);
  });

  it("every entry point uses the shared rule instead of its own status check", () => {
    const dir = new URL(".", import.meta.url);
    for (const file of ["ReviewHitDetail.tsx", "ReviewDockPanel.tsx", "ReviewPage.tsx"]) {
      const src = readFileSync(new URL(file, dir), "utf8");
      assert.doesNotMatch(src, /status === "待人工确认" && (decision|verdict) ===/u, file);
    }
    const page = readFileSync(new URL("ReviewPage.tsx", dir), "utf8");
    const decideBody = page.slice(page.indexOf("function decide("), page.indexOf("function showUndo("));
    assert.match(decideBody, /isDecisionAllowed\(hit, decision\)/u);
    assert.match(readFileSync(new URL("ReviewHitDetail.tsx", dir), "utf8"), /allowedDecisions\(hit\)\.map/u);
  });
});

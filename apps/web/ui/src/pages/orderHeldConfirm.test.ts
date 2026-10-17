import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { completePayload, needsOrderHeldConfirm, showOrderHeldCheckbox, signAllowedForOrderHeld } from "./orderHeldConfirm.js";
import type { FieldHit } from "../api.js";

const held = (id: string, decision: FieldHit["decision"] = "pending"): FieldHit => ({
  id, field: "品名", status: "待人工确认", decision, page: 1,
});

describe("needsOrderHeldConfirm", () => {
  it("matches the server: verbatim_warning + open 待人工确认", () => {
    assert.equal(needsOrderHeldConfirm({ verbatim_check: true, verbatim_warning: "精度下降" }, [held("a")]), true);
    assert.equal(needsOrderHeldConfirm({ verbatim_check: true, verbatim_warning: "精度下降" }, [held("a", "issue")]), false);
    assert.equal(needsOrderHeldConfirm({ verbatim_check: true }, [held("a")]), false);
    assert.equal(needsOrderHeldConfirm({ verbatim_check: false, verbatim_warning: "x" }, [held("a")]), false);
    assert.equal(needsOrderHeldConfirm(null, [held("a")]), false);
  });

  it("sign stays off until the checkbox is checked", () => {
    assert.equal(signAllowedForOrderHeld(true, false), false);
    assert.equal(signAllowedForOrderHeld(true, true), true);
    assert.equal(signAllowedForOrderHeld(false, false), true);
  });

  it("complete payload only sends order_held_confirm when checked", () => {
    assert.deepEqual(completePayload("无改稿项", true), { conclusion: "无改稿项", order_held_confirm: true });
    assert.deepEqual(completePayload("无改稿项", false), { conclusion: "无改稿项" });
  });

  it("ReviewPage wires the checkbox and api.complete accepts the field", () => {
    const page = readFileSync(new URL("./ReviewPage.tsx", import.meta.url), "utf8");
    assert.match(page, /needsOrderHeldConfirm\(/u);
    assert.match(page, /orderHeldConfirm/u);
    assert.match(page, /REVIEW_COPY\.orderHeldConfirm/u);
    assert.match(page, /completePayload\(/u);
    const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
    assert.match(api, /order_held_confirm\?: boolean/u);
  });
});

describe("整单确认勾选框看 canCompleteThis（这单自己能签字），不只看 canComplete", () => {
  it("要整单确认、不是失败单、自己能签字才显示", () => {
    assert.equal(showOrderHeldCheckbox(true, false, true), true);
    assert.equal(showOrderHeldCheckbox(true, false, false), false, "审核员看别人的单 / viewer");
    assert.equal(showOrderHeldCheckbox(true, true, true), false, "失败单");
    assert.equal(showOrderHeldCheckbox(false, false, true), false);
  });
  it("ReviewPage 用 canCompleteThis 调它", () => {
    const src = readFileSync(new URL("./ReviewPage.tsx", import.meta.url), "utf8");
    assert.match(src, /showOrderHeldCheckbox\(orderHeldNeeded, failedJob, canCompleteThis\)/u);
    assert.doesNotMatch(src, /orderHeldNeeded && !failedJob && canComplete\b/u);
  });
});

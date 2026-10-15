import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { phoneDiscardOnEnter, spotPhoneDiscardId } from "./useReviewSession.js";

describe("spotPhoneDiscardId", () => {
  it("drops only the active card draft when the phone layout hides the card", () => {
    assert.equal(spotPhoneDiscardId("phone", true, "a", "刚写的", ""), "a");
    assert.equal(spotPhoneDiscardId("phone", true, "a", "已存", "已存"), null);
    assert.equal(spotPhoneDiscardId("wide", true, "a", "刚写的", ""), null);
    assert.equal(spotPhoneDiscardId("phone", false, "a", "右栏草稿", ""), null);
    assert.equal(spotPhoneDiscardId("phone", true, undefined, "刚写的", ""), null);
  });

  it("drops the current draft only when entering phone", () => {
    assert.equal(phoneDiscardOnEnter(null, "phone", true, "a", "刚写的", ""), "a");
    assert.equal(phoneDiscardOnEnter("wide", "phone", true, "a", "刚写的", ""), "a");
    assert.equal(phoneDiscardOnEnter("phone", "phone", true, "b", "另一条", ""), null);
    assert.equal(phoneDiscardOnEnter("wide", "overlay", true, "a", "刚写的", ""), null);
    assert.equal(phoneDiscardOnEnter("wide", "phone", false, "a", "右栏草稿", ""), null);
    assert.equal(phoneDiscardOnEnter("phone", "wide", true, "a", "刚写的", ""), null);
  });
});

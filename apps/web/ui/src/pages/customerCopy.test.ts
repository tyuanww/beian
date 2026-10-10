import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { customerCopy } from "./customerCopy.js";

describe("customerCopy", () => {
  it("names the two review passes 检查 / 复核 for users", () => {
    assert.equal(customerCopy("对照失败"), "检查失败");
    assert.equal(customerCopy("对红中"), "复核中");
    assert.equal(customerCopy("对照阶段超时"), "检查阶段超时");
    assert.equal(customerCopy("对红结果已保存"), "复核结果已保存");
  });

  it("keeps the existing 已签字 → 已提交 wording", () => {
    assert.equal(customerCopy("已签字"), "已提交");
  });
});

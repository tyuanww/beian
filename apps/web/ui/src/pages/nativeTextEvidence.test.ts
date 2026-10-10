import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nativeEvidenceView } from "./nativeTextEvidence.js";

describe("native text evidence display", () => {
  it("leaves old records without evidence unchanged", () => {
    assert.equal(nativeEvidenceView(undefined), null);
    assert.equal(nativeEvidenceView(null), null);
  });
  it("preserves different readings without choosing a winner or changing a conclusion", () => {
    const input = { version: 1, status: "conflict", native_text: "净含量 30ml", ocr_text: "净含量 80ml", message: "两种读法不一致，请对照稿面。" };
    const before = structuredClone(input);
    const view = nativeEvidenceView(input)!;
    assert.equal(view.nativeText, input.native_text);
    assert.equal(view.ocrText, input.ocr_text);
    assert.match(view.title, /请确认文字来源/);
    assert.deepEqual(input, before);
    assert.equal("decision" in view, false);
  });
  it("does not equate used native evidence with business approval", () => {
    const view = nativeEvidenceView({ version: 1, status: "used", native_text: "30ml", ocr_text: "3Oml", message: "已核实可见文字的对应关系。" })!;
    assert.equal(view.title, "已参考原稿文字");
    assert.doesNotMatch(view.title, /一致|过审/);
  });
  it("keeps the native-only evidence readable when OCR is intentionally absent", () => {
    const view = nativeEvidenceView({ version: 1, status: "used", native_text: "Native Product", ocr_text: null, message: "原稿文字已直接参与核对规则。" })!;
    assert.equal(view.nativeText, "Native Product");
    assert.equal(view.ocrText, null);
    assert.equal(view.title, "已参考原稿文字");
  });
  it("does not display untrusted candidates from unknown or malformed contracts", () => {
    for (const value of [[], { version: 2 }, { version: 1, status: "used", native_text: null, ocr_text: null, message: "成功" }, { version: 1, status: "not_used", native_text: "x".repeat(8193), ocr_text: null, message: "不可用" }]) {
      const view = nativeEvidenceView(value)!;
      assert.equal(view.nativeText, null);
      assert.match(view.title, /暂无法确认/);
    }
  });
});

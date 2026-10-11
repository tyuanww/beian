import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUBLIC_UPLOAD_BYTES, UPLOAD_TOO_LARGE, bytesTooLarge } from "./uploadLimit.js";

describe("bytesTooLarge", () => {
  it("lets a 40MB pair through", () => {
    assert.equal(bytesTooLarge(20 * 1024 * 1024, 20 * 1024 * 1024), false);
  });

  it("blocks Excel+PDF that together exceed 100MB", () => {
    assert.equal(bytesTooLarge(60 * 1024 * 1024, 50 * 1024 * 1024), true);
    assert.equal(bytesTooLarge(PUBLIC_UPLOAD_BYTES), false);
    assert.equal(bytesTooLarge(PUBLIC_UPLOAD_BYTES + 1), true);
  });
});

describe("UPLOAD_TOO_LARGE", () => {
  it("用产品哥定稿文案，数字取自公网上限常量", () => {
    assert.equal(UPLOAD_TOO_LARGE, `文件太大，请压到 ${PUBLIC_UPLOAD_BYTES / 1024 / 1024}MB 以内再传（多份合计）`);
    assert.equal(UPLOAD_TOO_LARGE, "文件太大，请压到 100MB 以内再传（多份合计）");
  });
});

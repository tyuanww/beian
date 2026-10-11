import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUBLIC_UPLOAD_BYTES, UPLOAD_TOO_LARGE, bytesTooLarge, currentUploadLimitBytes, setUploadLimitFromMe, uploadLimitBytes, uploadTooLargeText } from "./uploadLimit.js";

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

describe("uploadLimitBytes", () => {
  const MB = 1024 * 1024;
  it("没有 upload_limit_bytes（或不是正数）时用公网 100MB", () => {
    assert.equal(uploadLimitBytes(null), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({}), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: 0 }), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: -5 }), PUBLIC_UPLOAD_BYTES);
  });
  it("更小的值照用，预检和文案（MB 向下取整）都跟着变", () => {
    const small = 30.7 * MB;
    assert.equal(uploadLimitBytes({ upload_limit_bytes: small }), small);
    setUploadLimitFromMe({ upload_limit_bytes: small });
    try {
      assert.equal(currentUploadLimitBytes(), small);
      assert.equal(bytesTooLarge(31 * MB), true);
      assert.equal(bytesTooLarge(30 * MB), false);
      assert.equal(uploadTooLargeText(), "文件太大，请压到 30MB 以内再传（多份合计）");
    } finally {
      setUploadLimitFromMe(null);
    }
  });
  it("比 100MB 大的值收回到 100MB", () => {
    assert.equal(uploadLimitBytes({ upload_limit_bytes: 500 * MB }), PUBLIC_UPLOAD_BYTES);
    setUploadLimitFromMe({ upload_limit_bytes: 500 * MB });
    try {
      assert.equal(bytesTooLarge(PUBLIC_UPLOAD_BYTES + 1), true);
      assert.equal(uploadTooLargeText(), UPLOAD_TOO_LARGE);
    } finally {
      setUploadLimitFromMe(null);
    }
  });
});

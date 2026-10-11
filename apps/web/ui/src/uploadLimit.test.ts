import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resetUploadLimit, PUBLIC_UPLOAD_BYTES, UPLOAD_TOO_LARGE, uploadLimitMb, bytesTooLarge, currentUploadLimitBytes, setUploadLimitFromMe, uploadLimitBytes, uploadTooLargeText } from "./uploadLimit.js";

describe("bytesTooLarge", () => {
  it("lets a 40MB pair through", () => {
    assert.equal(bytesTooLarge(20 * 1000 * 1000, 20 * 1000 * 1000), false);
  });

  it("blocks Excel+PDF that together exceed 100MB", () => {
    assert.equal(bytesTooLarge(60 * 1000 * 1000, 50 * 1000 * 1000), true);
    assert.equal(bytesTooLarge(PUBLIC_UPLOAD_BYTES), false);
    assert.equal(bytesTooLarge(PUBLIC_UPLOAD_BYTES + 1), true);
  });
});

describe("UPLOAD_TOO_LARGE", () => {
  it("用产品哥定稿文案，数字取自公网上限常量", () => {
    assert.equal(UPLOAD_TOO_LARGE, `文件太大，请压到 ${Math.floor(PUBLIC_UPLOAD_BYTES / 1e6)}MB 以内再传（多份合计）`);
    assert.equal(UPLOAD_TOO_LARGE, "文件太大，请压到 99MB 以内再传（多份合计）");
  });
});

describe("uploadLimitBytes", () => {
  const MB = 1000 * 1000;
  it("没有 upload_limit_bytes（或不是正数）时用公网 99MB", () => {
    assert.equal(uploadLimitBytes(null), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({}), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: 0 }), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: -5 }), PUBLIC_UPLOAD_BYTES);
  });
  it("只认 number 类型、有限、>0：字符串/NaN/Infinity/null 都回退", () => {
    assert.equal(uploadLimitBytes({ upload_limit_bytes: "5000000" }), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: Number.NaN }), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: Number.POSITIVE_INFINITY }), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: null }), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: true }), PUBLIC_UPLOAD_BYTES);
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
  it("比 99MB 大的值收回到 99MB", () => {
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

describe("十进制回退上限与 MB 显示", () => {
  it("回退上限 = 100e6 − 1e6 字节", () => {
    assert.equal(PUBLIC_UPLOAD_BYTES, 99_000_000);
    assert.equal(uploadLimitBytes({ upload_limit_bytes: 100 * 1024 * 1024 }), 99_000_000);
  });
  it("MB = floor(字节/1e6)，最小显示 1", () => {
    assert.equal(uploadLimitMb(99_999_999), 99);
    assert.equal(uploadLimitMb(1_000_000), 1);
    assert.equal(uploadLimitMb(999_999), 1);
    assert.equal(uploadLimitMb(1), 1);
    assert.equal(uploadTooLargeText(500_000), "文件太大，请压到 1MB 以内再传（多份合计）");
  });
});

describe("resetUploadLimit", () => {
  it("换账号/退出/me 失败后回到回退上限", () => {
    setUploadLimitFromMe({ upload_limit_bytes: 5_000_000 });
    assert.equal(currentUploadLimitBytes(), 5_000_000);
    resetUploadLimit();
    assert.equal(currentUploadLimitBytes(), PUBLIC_UPLOAD_BYTES);
    assert.equal(uploadTooLargeText(), UPLOAD_TOO_LARGE);
  });
});

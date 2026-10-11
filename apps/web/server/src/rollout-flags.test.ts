/** 锁住 rolloutFlags 默认值：WebP 旁路对外返回默认关，回填默认关（上限 0）。改值必须同时改本测试并经 owner 批准。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-rollout-flags-");

const flags = await import("./rolloutFlags.js");
const variant = await import("./glbWebpVariant.js");

describe("rolloutFlags defaults", () => {
  it("GLB_WEBP_VARIANT is off", () => {
    assert.equal(flags.GLB_WEBP_VARIANT, false);
    assert.equal(variant.glbWebpVariantEnabled(), false);
  });

  it("backfill is off: limit 0, single-file cap 32MB", () => {
    assert.equal(flags.GLB_WEBP_BACKFILL_LIMIT, 0);
    assert.equal(flags.GLB_WEBP_BACKFILL_MAX_BYTES, 32 * 1024 * 1024);
    assert.ok(Number.isInteger(flags.GLB_WEBP_BACKFILL_MAX_RSS_MB) && flags.GLB_WEBP_BACKFILL_MAX_RSS_MB > 0);
  });

  it("exports nothing else", () => {
    assert.deepEqual(Object.keys(flags).sort(), ["GLB_WEBP_BACKFILL_LIMIT", "GLB_WEBP_BACKFILL_MAX_BYTES", "GLB_WEBP_BACKFILL_MAX_RSS_MB", "GLB_WEBP_VARIANT"]);
  });
});

/** 锁住 rolloutFlags 默认值：WebP 旁路对外返回默认关，回填默认关（上限 0）。改值必须同时改本测试并经 owner 批准。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  // Value: protects=boot deletes webp variants only while the flag is on; fails_when=cleanupGlbWebpVariantsOnBoot moves outside the if; why_new=flag default test does not read the boot call; seam=none; no_claim=does not boot the server
  it("boot variant cleanup stays inside the flag", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = src.indexOf("const staleGlbTemps = cleanupStaleGlbWebpTemps");
    const end = src.indexOf("reclaimOnBoot()", start);
    const block = src.slice(start, end);
    assert.match(block, /if \(glbWebpVariantEnabled\(\)\) \{\s*const staleVariants = cleanupGlbWebpVariantsOnBoot/);
    const outside = block.replace(/if \(glbWebpVariantEnabled\(\)\) \{[\s\S]*?\n    \}/, "");
    assert.equal(outside.includes("cleanupGlbWebpVariantsOnBoot"), false);
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

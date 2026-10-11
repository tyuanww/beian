import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-variant-texfmt-");

const { DATA_DIR } = await import("./config.js");
const { buildPngTexturedGlbForProbe } = await import("./glbWebp.js");
const variant = await import("./glbWebpVariant.js");
const { GLB_WEBP_VARIANT } = await import("./rolloutFlags.js");
const { loadMockup, publicMockup, saveMockup } = await import("./mockup.js");

const OWNER = "籽烨";

function jobDir(id: string): string {
  return join(DATA_DIR, "mockups", id);
}

async function seedJob(id: string, name = "box.glb"): Promise<{ path: string; glb: Buffer }> {
  mkdirSync(jobDir(id), { recursive: true });
  const glb = Buffer.from(await buildPngTexturedGlbForProbe(128));
  const path = join(jobDir(id), name);
  writeFileSync(path, glb);
  saveMockup({ id, status: "done", created_at: "2026-10-11T00:00:00Z", files: [{ key: "glb", path, name }], owner: OWNER, job_kind: "mockup", job_status: "succeeded" });
  return { path, glb };
}

async function seedWithVariant(id: string) {
  const seeded = await seedJob(id);
  const result = await variant.writeGlbWebpVariant(id, seeded.path);
  assert.equal(result.status, "converted");
  const paths = variant.glbWebpVariantPaths(id, seeded.path)!;
  return { ...seeded, paths, variantBytes: readFileSync(paths.variant) };
}

async function withFlag<T>(value: boolean, fn: () => Promise<T>): Promise<T> {
  variant.setGlbWebpVariantEnabledForTest(value);
  try {
    return await fn();
  } finally {
    variant.setGlbWebpVariantEnabledForTest(GLB_WEBP_VARIANT);
  }
}


describe("texture_format follows the verified webp variant", () => {
  it("flag off: reports the original's format (png)", async () => {
    await seedWithVariant("de44de44de44");
    assert.equal(publicMockup(loadMockup("de44de44de44")!).files[0].texture_format, "png");
  });

  it("flag on: verified variant reports webp", async () => {
    await seedWithVariant("de44de44de45");
    await withFlag(true, async () => {
      assert.equal(publicMockup(loadMockup("de44de44de45")!).files[0].texture_format, "webp");
    });
  });

  it("flag on: mid-replacement (variant changed, meta old) reports png", async () => {
    const { paths, variantBytes } = await seedWithVariant("de44de44de47");
    writeFileSync(`${paths.variant}.next`, Buffer.concat([variantBytes, Buffer.from("x")]));
    renameSync(`${paths.variant}.next`, paths.variant);
    await withFlag(true, async () => {
      assert.equal(publicMockup(loadMockup("de44de44de47")!).files[0].texture_format, "png");
    });
  });
});

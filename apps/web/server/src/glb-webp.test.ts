import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-");

const {
  buildPngTexturedGlbForProbe,
  compressGlbTexturesToWebp,
  glbTextureFormat,
  readGlbJson,
  resetGlbTextureFormatCacheForTest,
} = await import("./glbWebp.js");
const { enqueue, resetJobsTestHooks, setJobsTestHooks } = await import("./jobs.js");
const { loadMockup, publicMockup, publicMockupSummary, saveMockup } = await import("./mockup.js");

const dir = makeTestTempDir("beian-glb-webp-unit-");

describe("glb webp post-step", () => {
  it("converts PNG textures to EXT_texture_webp and reports webp", async () => {
    const path = join(dir, "a.glb");
    writeFileSync(path, await buildPngTexturedGlbForProbe(128));
    assert.equal(glbTextureFormat(path), "png");
    const result = await compressGlbTexturesToWebp(path);
    assert.equal(result.status, "converted");
    const json = readGlbJson(path)!;
    assert.ok((json.extensionsUsed as string[]).includes("EXT_texture_webp"));
    const images = json.images as { mimeType?: string }[];
    assert.ok(images.every((img) => img.mimeType === "image/webp"));
    assert.equal(glbTextureFormat(path), "webp");
    const again = await compressGlbTexturesToWebp(path);
    assert.deepEqual(again.status === "skipped" && again.reason, "already_webp");
  });

  it("keeps the original PNG GLB byte-for-byte when conversion throws", async () => {
    const path = join(dir, "b.glb");
    const original = Buffer.from(await buildPngTexturedGlbForProbe(32));
    writeFileSync(path, original);
    const result = await compressGlbTexturesToWebp(path, { convert: async () => { throw new Error("boom"); } });
    assert.equal(result.status, "failed");
    assert.ok(readFileSync(path).equals(original));
    assert.equal(glbTextureFormat(path), "png");
  });

  it("rejects non-GLB input without touching it and omits texture_format", async () => {
    const path = join(dir, "c.glb");
    writeFileSync(path, "not a glb");
    const result = await compressGlbTexturesToWebp(path);
    assert.deepEqual(result, { status: "failed", reason: "not_glb" });
    assert.equal(readFileSync(path, "utf8"), "not a glb");
    assert.equal(glbTextureFormat(path), undefined);
    assert.equal(glbTextureFormat(join(dir, "missing.glb")), undefined);
  });

  it("caches the parse by path+size+mtime", async () => {
    resetGlbTextureFormatCacheForTest();
    const path = join(dir, "d.glb");
    writeFileSync(path, await buildPngTexturedGlbForProbe(16));
    assert.equal(glbTextureFormat(path), "png");
    await compressGlbTexturesToWebp(path);
    assert.equal(glbTextureFormat(path), "webp");
  });
});

async function runFreshMockup(id: string, compressGlb?: (path: string) => Promise<never>) {
  const root = join(process.env.WB_DATA_DIR || "", "mockups", id);
  const glb = Buffer.from(await buildPngTexturedGlbForProbe(128));
  setJobsTestHooks({
    runPack: async () => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "box.glb"), glb);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
    ...(compressGlb ? { compressGlb } : {}),
  });
  saveMockup({ id, status: "queued", created_at: "2026-10-11T00:00:00.000Z", files: [], job_kind: "mockup", job_status: "queued" });
  try {
    enqueue({ kind: "mockup", id });
    for (let i = 0; i < 300 && loadMockup(id)?.job_status !== "succeeded" && loadMockup(id)?.job_status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    resetJobsTestHooks();
  }
  return { job: loadMockup(id)!, root, glb };
}

describe("mockup pipeline + API texture_format", () => {
  it("fresh mockup GLB is converted and API reports texture_format=webp", async () => {
    const { job, root } = await runFreshMockup("abcdef000001");
    assert.equal(job.job_status, "succeeded");
    assert.equal(glbTextureFormat(join(root, "box.glb")), "webp");
    const detail = publicMockup(job).files.find((f) => f.key === "glb");
    assert.deepEqual(detail, { key: "glb", name: "box.glb", texture_format: "webp" });
    const summary = publicMockupSummary(job).files.find((f) => f.key === "glb");
    assert.equal(summary?.texture_format, "webp");
    assert.equal(publicMockup(job).files.some((f) => f.key !== "glb" && "texture_format" in f), false);
  });

  it("conversion failure keeps PNG GLB, mockup still succeeds, texture_format=png", async () => {
    const { job, root, glb } = await runFreshMockup("abcdef000002", async () => { throw new Error("converter down"); });
    assert.equal(job.job_status, "succeeded");
    assert.ok(readFileSync(join(root, "box.glb")).equals(glb));
    assert.equal(publicMockup(job).files.find((f) => f.key === "glb")?.texture_format, "png");
  });
});

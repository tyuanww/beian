import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-");

const {
  buildPngTexturedGlbForProbe,
  compressGlbTexturesToWebp,
  convertGlbBytesToWebp,
  glbTextureFormat,
  glbTextureFormatParseCountForTest,
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

  it("caches the parse by path+size+mtime: repeat reads do not re-parse, a changed file does", async () => {
    resetGlbTextureFormatCacheForTest();
    const path = join(dir, "d.glb");
    writeFileSync(path, await buildPngTexturedGlbForProbe(16));
    utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    for (let i = 0; i < 5; i++) assert.equal(glbTextureFormat(path), "png");
    assert.equal(glbTextureFormatParseCountForTest(), 1);
    const result = await compressGlbTexturesToWebp(path);
    assert.equal(result.status, "converted");
    for (let i = 0; i < 5; i++) assert.equal(glbTextureFormat(path), "webp");
    assert.equal(glbTextureFormatParseCountForTest(), 2);
  });

  it("re-reads the written temp file and keeps the original when structure counts differ", async () => {
    const { NodeIO } = await import("@gltf-transform/core");
    const path = join(dir, "e.glb");
    const original = Buffer.from(await buildPngTexturedGlbForProbe(256));
    writeFileSync(path, original);
    // Converter drops a material/texture but still emits a smaller WebP GLB.
    const dropping = async (input: Uint8Array) => {
      const real = await convertGlbBytesToWebp(input);
      const io = new NodeIO().registerExtensions((await import("@gltf-transform/extensions")).ALL_EXTENSIONS);
      const doc = await io.readBinary(real.bytes);
      for (const prim of doc.getRoot().listMeshes()[0].listPrimitives()) prim.dispose();
      return { bytes: await io.writeBinary(doc), textures: real.textures };
    };
    const result = await compressGlbTexturesToWebp(path, { convert: dropping });
    assert.deepEqual(result, { status: "failed", reason: "output_structure_mismatch" });
    assert.ok(readFileSync(path).equals(original));
  });

  it("keeps the original when the written output cannot be fully re-read", async () => {
    const path = join(dir, "f.glb");
    const original = Buffer.from(await buildPngTexturedGlbForProbe(256));
    writeFileSync(path, original);
    const truncated = async (input: Uint8Array) => {
      const real = await convertGlbBytesToWebp(input);
      // Header + JSON stay valid (still says EXT_texture_webp) but the BIN chunk is truncated.
      const bytes = Buffer.from(real.bytes.subarray(0, real.bytes.length - 512));
      bytes.writeUInt32LE(bytes.length, 8);
      return { bytes, textures: real.textures };
    };
    const result = await compressGlbTexturesToWebp(path, { convert: truncated });
    assert.equal(result.status, "failed");
    assert.ok(readFileSync(path).equals(original));
  });

  it("encodes every texture through our sharp (not ndarray-pixels)", async () => {
    const sharp = (await import("sharp")).default;
    let calls = 0;
    const spy = ((...args: Parameters<typeof sharp>) => {
      calls += 1;
      return sharp(...args);
    }) as typeof sharp;
    const { textures } = await convertGlbBytesToWebp(await buildPngTexturedGlbForProbe(64), 90, spy);
    assert.equal(textures, 1);
    assert.equal(calls, textures);
  });

  it("pins @gltf-transform/functions: encoder present => sharp path only, ndarray-pixels never used", () => {
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(dirname(require.resolve("@gltf-transform/functions")));
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string };
    assert.equal(pkg.version, "4.5.1", "bump requires re-verifying the encoder branch below");
    const src = readFileSync(join(pkgDir, "dist", "index.js"), "utf8");
    const body = src.slice(src.indexOf("async function compressTexture("), src.indexOf("async function _encodeWithNdarrayPixels("));
    assert.match(body, /const dstImage = encoder \? await _encodeWithSharp\(/);
    const sharpFn = body.slice(body.indexOf("async function _encodeWithSharp("));
    assert.doesNotMatch(sharpFn, /getPixels|savePixels/);
    assert.match(sharpFn, /instance\.resize\(/);
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

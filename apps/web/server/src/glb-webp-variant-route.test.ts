import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-variant-route-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");
const { buildPngTexturedGlbForProbe } = await import("./glbWebp.js");
const variant = await import("./glbWebpVariant.js");
const { GLB_WEBP_VARIANT } = await import("./rolloutFlags.js");
const {  saveMockup } = await import("./mockup.js");

const sha = (buf: Buffer | Uint8Array) => createHash("sha256").update(buf).digest("hex");
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

function headers(extra: Record<string, string> = {}) {
  const sess = issueSessionForTest(OWNER, "reviewer", "ou_glb_variant");
  return { authorization: `Bearer ${sess.token}`, ...extra };
}

async function withFlag<T>(value: boolean, fn: () => Promise<T>): Promise<T> {
  variant.setGlbWebpVariantEnabledForTest(value);
  try {
    return await fn();
  } finally {
    variant.setGlbWebpVariantEnabledForTest(GLB_WEBP_VARIANT);
  }
}

describe("glb file route serves the webp variant", () => {
  it("flag off: original bytes, mtime ETag", async () => {
    const { glb } = await seedWithVariant("dd44dd44dd44");
    const res = await app.request("/api/mockups/dd44dd44dd44/files/glb", { headers: headers() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("etag") || "", /^W\//);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), glb);
  });

  it("flag on: variant bytes, sha ETag, immutable only for matching ?v, 304 keeps headers", async () => {
    const { variantBytes } = await seedWithVariant("dd44dd44dd45");
    await withFlag(true, async () => {
      const vsha = sha(variantBytes);
      const plain = await app.request("/api/mockups/dd44dd44dd45/files/glb", { headers: headers() });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers.get("etag"), `"sha256-${vsha}"`);
      assert.equal(plain.headers.get("cache-control"), "private, no-cache");
      assert.equal(plain.headers.get("content-type"), "model/gltf-binary");
      assert.equal(plain.headers.get("content-length"), String(variantBytes.length));
      assert.deepEqual(Buffer.from(await plain.arrayBuffer()), variantBytes);
      const pinned = await app.request(`/api/mockups/dd44dd44dd45/files/glb?v=${vsha.slice(0, 16)}`, { headers: headers() });
      assert.equal(pinned.headers.get("cache-control"), "private, max-age=31536000, immutable");
      await pinned.arrayBuffer();
      const wrong = await app.request("/api/mockups/dd44dd44dd45/files/glb?v=0000000000000000", { headers: headers() });
      assert.equal(wrong.status, 200);
      assert.equal(wrong.headers.get("cache-control"), "private, no-cache");
      await wrong.arrayBuffer();
      const notModified = await app.request(`/api/mockups/dd44dd44dd45/files/glb?v=${vsha.slice(0, 16)}`, { headers: headers({ "if-none-match": `"sha256-${vsha}"` }) });
      assert.equal(notModified.status, 304);
      assert.equal(notModified.headers.get("etag"), `"sha256-${vsha}"`);
      assert.equal(notModified.headers.get("cache-control"), "private, max-age=31536000, immutable");
      const head = await app.request("/api/mockups/dd44dd44dd45/files/glb", { method: "HEAD", headers: headers() });
      assert.equal(head.headers.get("content-length"), String(variantBytes.length));
      assert.equal(await head.text(), "");
    });
  });

  it("flag on: download=1 and variant=original return the original with the original ETag", async () => {
    const { glb } = await seedWithVariant("dd44dd44dd46");
    await withFlag(true, async () => {
      const dl = await app.request("/api/mockups/dd44dd44dd46/files/glb?download=1", { headers: headers() });
      assert.equal(dl.headers.get("cache-control"), "private, no-store");
      assert.match(dl.headers.get("etag") || "", /^W\//);
      assert.deepEqual(Buffer.from(await dl.arrayBuffer()), glb);
      const orig = await app.request("/api/mockups/dd44dd44dd46/files/glb?variant=original", { headers: headers() });
      assert.match(orig.headers.get("etag") || "", /^W\//);
      assert.deepEqual(Buffer.from(await orig.arrayBuffer()), glb);
    });
  });

  it("flag on: mid-replacement (new variant, old meta) serves the original, never immutable", async () => {
    const { glb, paths, variantBytes } = await seedWithVariant("dd44dd44dd47");
    writeFileSync(`${paths.variant}.next`, Buffer.concat([variantBytes, Buffer.from("x")]));
    renameSync(`${paths.variant}.next`, paths.variant);
    await withFlag(true, async () => {
      const res = await app.request(`/api/mockups/dd44dd44dd47/files/glb?v=${sha(variantBytes).slice(0, 16)}`, { headers: headers() });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("etag") || "", /^W\//);
      assert.equal(res.headers.get("cache-control"), "private, no-cache");
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), glb);
    });
  });

  it("flag on: after a completed replacement the new variant is served", async () => {
    const { path } = await seedWithVariant("dd44dd44dd48");
    const again = await variant.writeGlbWebpVariant("dd44dd44dd48", path, { quality: 70 });
    assert.equal(again.status, "converted");
    const paths = variant.glbWebpVariantPaths("dd44dd44dd48", path)!;
    const next = readFileSync(paths.variant);
    await withFlag(true, async () => {
      const res = await app.request("/api/mockups/dd44dd44dd48/files/glb", { headers: headers() });
      assert.equal(res.headers.get("etag"), `"sha256-${sha(next)}"`);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), next);
    });
  });
});


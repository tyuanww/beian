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

  it("flag on: download=1 keeps the legacy original ETag; variant=original returns the original with its sha ETag", async () => {
    const { glb } = await seedWithVariant("dd44dd44dd46");
    await withFlag(true, async () => {
      const dl = await app.request("/api/mockups/dd44dd44dd46/files/glb?download=1", { headers: headers() });
      assert.equal(dl.headers.get("cache-control"), "private, no-store");
      assert.match(dl.headers.get("etag") || "", /^W\//);
      assert.deepEqual(Buffer.from(await dl.arrayBuffer()), glb);
      const orig = await app.request("/api/mockups/dd44dd44dd46/files/glb?variant=original", { headers: headers() });
      assert.equal(orig.headers.get("etag"), `"sha256-${sha(glb)}"`);
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
      assert.equal(res.headers.get("etag"), `"sha256-${sha(glb)}"`);
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

describe("glb_version / glb_original_version and ?variant=original (flag on)", () => {
  const v16 = (buf: Buffer) => sha(buf).slice(0, 16);
  const IMMUTABLE = "private, max-age=31536000, immutable";
  const NO_CACHE = "private, no-cache";
  const fieldsOf = async (id: string) => {
    const { loadMockup, publicMockup, publicMockupSummary } = await import("./mockup.js");
    const job = loadMockup(id)!;
    const detail = publicMockup(job).files.find((f) => f.key === "glb") as Record<string, unknown>;
    const summary = publicMockupSummary(job).files.find((f) => f.key === "glb") as Record<string, unknown>;
    return { detail, summary };
  };
  const get = async (url: string, extra: Record<string, string> = {}) => {
    const res = await app.request(url, { headers: headers(extra) });
    return { res, body: Buffer.from(await res.arrayBuffer()) };
  };

  it("versions equal the sha256 prefix of what each endpoint actually returns", async () => {
    const { glb, variantBytes } = await seedWithVariant("df55df55df50");
    await withFlag(true, async () => {
      const { detail, summary } = await fieldsOf("df55df55df50");
      const def = await get("/api/mockups/df55df55df50/files/glb");
      const orig = await get("/api/mockups/df55df55df50/files/glb?variant=original");
      assert.deepEqual(def.body, variantBytes);
      assert.deepEqual(orig.body, glb);
      assert.equal(detail.glb_version, v16(def.body));
      assert.equal(detail.glb_original_version, v16(orig.body));
      assert.match(String(detail.glb_version), /^[0-9a-f]{16}$/);
      assert.notEqual(detail.glb_version, detail.glb_original_version);
      assert.equal(detail.texture_format, "webp");
      assert.equal(summary.glb_version, detail.glb_version);
      assert.equal(summary.glb_original_version, detail.glb_original_version);
      assert.equal(def.res.headers.get("etag"), `"sha256-${sha(variantBytes)}"`);
      assert.equal(orig.res.headers.get("etag"), `"sha256-${sha(glb)}"`);
    });
  });

  for (const endpoint of ["default", "original"] as const) {
    it(`${endpoint} endpoint: ?v match → immutable, mismatch → no-cache, missing → no-cache`, async () => {
      const id = endpoint === "default" ? "df55df55df51" : "df55df55df52";
      await seedWithVariant(id);
      await withFlag(true, async () => {
        const { detail } = await fieldsOf(id);
        const version = String(endpoint === "default" ? detail.glb_version : detail.glb_original_version);
        const base = `/api/mockups/${id}/files/glb${endpoint === "original" ? "?variant=original&" : "?"}`;
        const match = await get(`${base}v=${version}`);
        assert.equal(match.res.status, 200);
        assert.equal(match.res.headers.get("cache-control"), IMMUTABLE);
        assert.equal(v16(match.body), version);
        const mismatch = await get(`${base}v=${"0".repeat(16)}`);
        assert.equal(mismatch.res.status, 200);
        assert.equal(mismatch.res.headers.get("cache-control"), NO_CACHE);
        assert.equal(v16(mismatch.body), version, "mismatch still returns current content");
        const missing = await get(base.slice(0, -1));
        assert.equal(missing.res.headers.get("cache-control"), NO_CACHE);
        assert.equal(v16(missing.body), version);
        const etag = match.res.headers.get("etag")!;
        const notModified = await app.request(`${base}v=${version}`, { headers: headers({ "if-none-match": etag }) });
        assert.equal(notModified.status, 304);
        assert.equal(notModified.headers.get("etag"), etag);
        assert.equal(notModified.headers.get("cache-control"), IMMUTABLE);
      });
    });
  }

  it("no verified variant: both versions are the original's and the default endpoint serves it", async () => {
    const { glb } = await seedJob("df55df55df53");
    await withFlag(true, async () => {
      const { detail } = await fieldsOf("df55df55df53");
      assert.equal(detail.glb_version, v16(glb));
      assert.equal(detail.glb_original_version, v16(glb));
      assert.equal(detail.texture_format, "png");
      const def = await get(`/api/mockups/df55df55df53/files/glb?v=${v16(glb)}`);
      assert.deepEqual(def.body, glb);
      assert.equal(def.res.headers.get("cache-control"), IMMUTABLE);
    });
  });

  it("flag off: no version fields; ?variant=original is the original with the legacy no-cache headers", async () => {
    const { glb } = await seedWithVariant("df55df55df54");
    const { detail } = await fieldsOf("df55df55df54");
    assert.equal("glb_version" in detail, false);
    assert.equal("glb_original_version" in detail, false);
    const orig = await get(`/api/mockups/df55df55df54/files/glb?variant=original&v=${v16(glb)}`);
    assert.deepEqual(orig.body, glb);
    assert.match(orig.res.headers.get("etag") || "", /^W\//);
    assert.equal(orig.res.headers.get("cache-control"), NO_CACHE);
  });

  it("download=1 stays the original attachment with no-store even with ?v", async () => {
    const { glb } = await seedWithVariant("df55df55df55");
    await withFlag(true, async () => {
      const dl = await get(`/api/mockups/df55df55df55/files/glb?download=1&v=${v16(glb)}`);
      assert.deepEqual(dl.body, glb);
      assert.equal(dl.res.headers.get("cache-control"), "private, no-store");
      assert.match(dl.res.headers.get("content-disposition") || "", /^attachment;/);
    });
  });

  it("both endpoints share the existing auth and 404 behaviour", async () => {
    await seedWithVariant("df55df55df56");
    await withFlag(true, async () => {
      for (const q of ["", "?variant=original"]) {
        const anon = await app.request(`/api/mockups/df55df55df56/files/glb${q}`);
        assert.equal(anon.status, 401, `anon ${q}`);
        const missing = await app.request(`/api/mockups/df55df55df5f/files/glb${q}`, { headers: headers() });
        assert.equal(missing.status, 404, `missing ${q}`);
        const text = await missing.text();
        assert.equal(text.includes(DATA_DIR), false, "error body must not leak local paths");
      }
    });
  });
});

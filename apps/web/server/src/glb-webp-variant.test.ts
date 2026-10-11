import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-variant-");

const { DATA_DIR } = await import("./config.js");
const { buildPngTexturedGlbForProbe, readGlbJson } = await import("./glbWebp.js");
const variant = await import("./glbWebpVariant.js");
const { GLB_WEBP_VARIANT } = await import("./rolloutFlags.js");
const { collectOutputs, loadMockup, publicMockup, saveMockup } = await import("./mockup.js");
const { enqueue, resetJobsTestHooks, setJobsTestHooks } = await import("./jobs.js");

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


describe("rollout flag", () => {
  it("GLB_WEBP_VARIANT defaults to off and the module does not read env", () => {
    assert.equal(GLB_WEBP_VARIANT, false);
    assert.equal(variant.glbWebpVariantEnabled(), false);
    assert.doesNotMatch(readFileSync(new URL("./rolloutFlags.ts", import.meta.url), "utf8"), /process\.env/);
  });
});

describe("variant storage stays invisible to job scans", () => {
  it("collectOutputs ignores .webp-variant and .webpv/.json files even in the job root", async () => {
    const { paths } = await seedWithVariant("aa11aa11aa11");
    const before = collectOutputs(paths.jobDir);
    assert.deepEqual(before.map((f) => f.key), ["glb"]);
    assert.equal(before[0].name, "box.glb");
    writeFileSync(join(paths.jobDir, "box.glb.webpv"), "x");
    writeFileSync(join(paths.jobDir, "box.glb.webpv.json"), "{}");
    assert.deepEqual(collectOutputs(paths.jobDir), before);
  });

  it("public JSON files never list variant files", async () => {
    const { paths } = await seedWithVariant("aa11aa11aa12");
    const names = publicMockup(loadMockup("aa11aa11aa12")!).files.map((f) => f.name);
    assert.deepEqual(names, ["box.glb"]);
    assert.ok(existsSync(paths.variant));
  });
});

describe("write order and meta", () => {
  it("writes variant then meta, leaves the original untouched, meta carries both hashes", async () => {
    const { path, glb, paths, variantBytes } = await seedWithVariant("bb22bb22bb22");
    assert.deepEqual(readFileSync(path), glb);
    const meta = variant.readGlbWebpVariantMeta(paths.meta)!;
    assert.equal(meta.schema, "glb-webp-variant/2");
    assert.match(meta.variant.file, /^box\.glb\.[0-9a-f]{16}\.webpv$/);
    assert.deepEqual(meta.source, { name: "box.glb", sha256: sha(glb), bytes: glb.length });
    assert.deepEqual(meta.variant, { file: `box.glb.${sha(variantBytes).slice(0, 16)}.webpv`, sha256: sha(variantBytes), bytes: variantBytes.length });
    assert.equal(meta.quality, 90);
    assert.ok(((readGlbJson(paths.variant)!.extensionsUsed) as string[]).includes("EXT_texture_webp"));
    assert.deepEqual(readdirSync(paths.dir).sort(), [basename(paths.variant), "box.glb.webpv.json"].sort());
  });

  it("a drop during conversion discards the result (no meta, no variant)", async () => {
    const { path } = await seedJob("bb22bb22bb23");
    const result = await variant.writeGlbWebpVariant("bb22bb22bb23", path, {
      convert: async (input, quality) => {
        variant.dropGlbWebpVariant("bb22bb22bb23");
        const { convertGlbBytesToWebp } = await import("./glbWebp.js");
        return convertGlbBytesToWebp(input, quality);
      },
    });
    assert.equal(result.status, "skipped");
    assert.deepEqual(readdirSync(variant.glbWebpVariantDir("bb22bb22bb23")), []);
  });

  it("dropGlbWebpVariant deletes meta before the variant and tolerates ENOENT", async () => {
    const { paths } = await seedWithVariant("bb22bb22bb24");
    const order: string[] = [];
    variant.setGlbWebpVariantUnlinkForTest((p) => { order.push(p); unlinkSync(p); });
    try {
      variant.dropGlbWebpVariant("bb22bb22bb24");
      variant.dropGlbWebpVariant("bb22bb22bb24");
      variant.dropGlbWebpVariant("nosuchjob000");
    } finally {
      variant.setGlbWebpVariantUnlinkForTest(null);
    }
    assert.deepEqual(order, [paths.meta, paths.variant]);
    assert.deepEqual(readdirSync(paths.dir), []);
  });
});

describe("verification and hash cache", () => {
  it("serves the variant only when meta, source hash and variant hash all match", async () => {
    const { path, paths, variantBytes } = await seedWithVariant("cc33cc33cc33");
    const ok = variant.openGlbForServe("cc33cc33cc33", path);
    closeSync(ok.fd);
    assert.equal(ok.kind, "variant");
    assert.equal(ok.kind === "variant" && ok.sha256, sha(variantBytes));
    // tampered variant
    const tampered = Buffer.from(variantBytes);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(paths.variant, tampered);
    const bad = variant.openGlbForServe("cc33cc33cc33", path);
    closeSync(bad.fd);
    assert.equal(bad.kind === "original" && bad.reason, "variant_hash_mismatch");
    writeFileSync(paths.variant, variantBytes);
    // meta missing
    renameSync(paths.meta, `${paths.meta}.off`);
    const noMeta = variant.openGlbForServe("cc33cc33cc33", path);
    closeSync(noMeta.fd);
    assert.equal(noMeta.kind === "original" && noMeta.reason, "no_meta");
    renameSync(`${paths.meta}.off`, paths.meta);
  });

  it("source rewritten (even same size) falls back to the original", async () => {
    const { path, glb } = await seedWithVariant("cc33cc33cc34");
    const changed = Buffer.from(glb);
    changed[changed.length - 1] ^= 0x01;
    writeFileSync(path, changed);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    const opened = variant.openGlbForServe("cc33cc33cc34", path);
    closeSync(opened.fd);
    assert.equal(opened.kind === "original" && opened.reason, "source_hash_mismatch");
  });

  it("caches by dev+ino+mtimeNs+size and recomputes after an in-place overwrite", async () => {
    const { path, glb } = await seedWithVariant("cc33cc33cc35");
    variant.resetGlbWebpVariantCacheForTest();
    const first = variant.openGlbForServe("cc33cc33cc35", path);
    closeSync(first.fd);
    assert.equal(variant.glbWebpVariantHashComputeCountForTest(), 2);
    const second = variant.openGlbForServe("cc33cc33cc35", path);
    closeSync(second.fd);
    assert.equal(variant.glbWebpVariantHashComputeCountForTest(), 2);
    writeFileSync(path, glb);
    utimesSync(path, new Date(), new Date(Date.now() + 7000));
    const third = variant.openGlbForServe("cc33cc33cc35", path);
    closeSync(third.fd);
    assert.equal(third.kind, "variant");
    assert.equal(variant.glbWebpVariantHashComputeCountForTest(), 3);
  });

  it("an already-open old variant fd keeps reading the old bytes after unlink + rename", async () => {
    const { path, paths, variantBytes } = await seedWithVariant("cc33cc33cc36");
    const opened = variant.openGlbForServe("cc33cc33cc36", path);
    assert.equal(opened.kind, "variant");
    unlinkSync(paths.variant);
    writeFileSync(`${paths.variant}.new`, Buffer.from("replacement"));
    renameSync(`${paths.variant}.new`, paths.variant);
    const buf = Buffer.alloc(opened.bytes);
    readSync(opened.fd, buf, 0, opened.bytes, 0);
    closeSync(opened.fd);
    assert.equal(sha(buf), sha(variantBytes));
  });
});

describe("boot cleanup", () => {
  it("removes tmp files, orphans and pairs whose source is gone; keeps complete pairs", async () => {
    const keep = await seedWithVariant("ee55ee55ee50");
    writeFileSync(join(keep.paths.dir, ".box.glb.webpv.123-456.tmp"), "x");
    writeFileSync(join(keep.paths.dir, ".box.glb.webpv.json.123-456.tmp"), "x");
    writeFileSync(join(keep.paths.dir, "orphan.glb.webpv"), "x");
    writeFileSync(join(keep.paths.dir, "lonely.glb.webpv.json"), "{}");
    const gone = await seedWithVariant("ee55ee55ee51");
    unlinkSync(gone.path);
    const removed = variant.cleanupGlbWebpVariantsOnBoot();
    assert.ok(removed >= 6, `removed=${removed}`);
    writeFileSync(join(keep.paths.dir, "box.glb.webpv"), "legacy");
    writeFileSync(join(keep.paths.dir, "box.glb.0123456789abcdef.webpv"), "stale");
    writeFileSync(join(keep.paths.dir, ".box.glb.1-2.staging.webpv"), "x");
    const removedLater = variant.cleanupGlbWebpVariantsOnBoot();
    assert.equal(removedLater, 3);
    assert.deepEqual(readdirSync(keep.paths.dir).sort(), [basename(keep.paths.variant), "box.glb.webpv.json"].sort());
    assert.deepEqual(readdirSync(gone.paths.dir), []);
  });
});

describe("entry drops the variant before Blender writes", () => {
  it("claimMockup (new render / in-place rerender) removes meta then variant before runPack", async () => {
    const id = "ff66ff66ff66";
    const { paths, glb } = await seedWithVariant(id);
    let seenAtRunPack: string[] | null = null;
    setJobsTestHooks({
      runPack: async () => {
        seenAtRunPack = readdirSync(paths.dir);
        writeFileSync(join(jobDir(id), "box.glb"), glb);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
      compressGlb: async () => ({ status: "skipped", reason: "no_textures", beforeBytes: 0 }),
    });
    const job = loadMockup(id)!;
    saveMockup({ ...job, status: "queued", job_status: "queued" });
    try {
      enqueue({ kind: "mockup", id });
      for (let i = 0; i < 300 && seenAtRunPack === null; i++) await new Promise((r) => setTimeout(r, 10));
      for (let i = 0; i < 300 && !["succeeded", "failed"].includes(loadMockup(id)?.job_status || ""); i++) await new Promise((r) => setTimeout(r, 10));
    } finally {
      resetJobsTestHooks();
    }
    assert.deepEqual(seenAtRunPack, []);
  });
});

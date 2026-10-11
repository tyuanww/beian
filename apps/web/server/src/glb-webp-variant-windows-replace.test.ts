/**
 * 找茬哥追加的 Windows 替换语义（quality.yml windows-2022 job 实跑；POSIX 上用注入模拟 EPERM/EBUSY）：
 * 1) 元数据一次性读完即关；元数据改名覆盖失败（有人打开着）时写入返回 failed、不抛错，旧元数据不损坏，服务照旧。
 * 2) 清旧哈希文件删除失败跳过、下次再删、不中断；绝不删元数据当前指向的文件。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-variant-winreplace-");

const { DATA_DIR } = await import("./config.js");
const { buildPngTexturedGlbForProbe } = await import("./glbWebp.js");
const variant = await import("./glbWebpVariant.js");

const sha = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");
const locked = (code: string) => Object.assign(new Error(`${code}: resource busy or locked`), { code });

function readAll(fd: number, bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const n = readSync(fd, buf, offset, bytes - offset, offset);
    if (n <= 0) break;
    offset += n;
  }
  return buf.subarray(0, offset);
}

async function seed(id: string) {
  const jobDir = join(DATA_DIR, "mockups", id);
  mkdirSync(jobDir, { recursive: true });
  const glbPath = join(jobDir, "box.glb");
  writeFileSync(glbPath, await buildPngTexturedGlbForProbe(128));
  assert.equal((await variant.writeGlbWebpVariant(id, glbPath)).status, "converted");
  return { glbPath, paths: variant.glbWebpVariantPaths(id, glbPath)! };
}

function servedSha(id: string, glbPath: string): { kind: string; sha256: string } {
  const opened = variant.openGlbForServe(id, glbPath);
  try {
    assert.equal(sha(readAll(opened.fd, opened.bytes)), opened.sha256, "served bytes match the reported sha");
    return { kind: opened.kind, sha256: opened.sha256 };
  } finally {
    closeSync(opened.fd);
  }
}

describe("meta update while the meta file is open", () => {
  it("meta is read in one shot and closed: serving leaves no handle on it", () => {
    const src = readFileSync(new URL("./glbWebpVariant.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // Windows checkout 是 CRLF
    const body = src.slice(src.indexOf("export function readGlbWebpVariantMeta"), src.indexOf("\n}\n", src.indexOf("export function readGlbWebpVariantMeta")));
    assert.match(body, /readFileSync\(path, "utf8"\)/);
    assert.doesNotMatch(body, /openSync|createReadStream/);
  });

  it("rename over an open meta fails → write returns failed without throwing, old meta intact, serving unchanged", async () => {
    const id = "ad13ad13ad01";
    const { glbPath, paths } = await seed(id);
    const before = readFileSync(paths.meta, "utf8");
    const servedBefore = servedSha(id, glbPath);
    assert.equal(servedBefore.kind, "variant");
    const metaFd = openSync(paths.meta, "r"); // 有人正读元数据；POSIX 上注入 EPERM，Windows 上两者都加（真实 + 注入），结果确定。
    variant.setGlbWebpVariantRenameForTest((from, to) => {
      if (to === paths.meta) throw locked("EPERM");
      renameSync(from, to);
    });
    try {
      const result = await variant.writeGlbWebpVariant(id, glbPath, { quality: 70 });
      assert.equal(result.status, "failed");
      assert.match(String((result as { reason?: string }).reason), /^meta_update_failed: (EPERM|EACCES|EBUSY)$/);
    } finally {
      closeSync(metaFd);
      variant.setGlbWebpVariantRenameForTest(null);
    }
    assert.equal(readFileSync(paths.meta, "utf8"), before, "old meta not corrupted");
    assert.deepEqual(servedSha(id, glbPath), servedBefore, "still serves the old verified variant");
    const dir = readdirSync(paths.dir);
    assert.deepEqual(dir.filter((n) => n.endsWith(".tmp")), [], "meta tmp removed");
    assert.deepEqual(dir.filter((n) => n.endsWith(".webpv")), [basename(paths.variant)], "the unreferenced new variant was removed, the referenced one kept");
    assert.equal((await variant.writeGlbWebpVariant(id, glbPath, { quality: 70 })).status, "converted", "next write succeeds once the meta is closed");
    assert.notEqual(servedSha(id, glbPath).sha256, servedBefore.sha256);
  });

  it("source changed and meta update failed → falls back to the original, no error", async () => {
    const id = "ad13ad13ad02";
    const { glbPath, paths } = await seed(id);
    writeFileSync(glbPath, await buildPngTexturedGlbForProbe(256));
    variant.setGlbWebpVariantRenameForTest((from, to) => {
      if (to === paths.meta) throw locked("EPERM");
      renameSync(from, to);
    });
    try {
      assert.equal((await variant.writeGlbWebpVariant(id, glbPath)).status, "failed");
    } finally {
      variant.setGlbWebpVariantRenameForTest(null);
    }
    const served = servedSha(id, glbPath);
    assert.equal(served.kind, "original");
    assert.equal(served.sha256, sha(readFileSync(glbPath)));
  });
});

describe("stale hashed variant cleanup", () => {
  it("EPERM/EBUSY on a stale file is skipped, the write still succeeds, and the next write removes it", async () => {
    const id = "ad13ad13ad03";
    const { glbPath, paths } = await seed(id);
    const stale = paths.variant;
    const legacy = join(paths.dir, "box.glb.webpv");
    writeFileSync(legacy, "legacy unhashed variant");
    let attempts = 0;
    variant.setGlbWebpVariantUnlinkForTest((path) => {
      if (path === stale || path === legacy) {
        attempts += 1;
        throw locked(attempts % 2 ? "EBUSY" : "EPERM");
      }
      unlinkSync(path);
    });
    try {
      assert.equal((await variant.writeGlbWebpVariant(id, glbPath, { quality: 70 })).status, "converted");
    } finally {
      variant.setGlbWebpVariantUnlinkForTest(null);
    }
    assert.ok(attempts >= 2, "cleanup was attempted");
    assert.ok(existsSync(stale) && existsSync(legacy), "locked files left for later");
    const current = variant.glbWebpVariantPaths(id, glbPath)!.variant;
    assert.notEqual(current, stale);
    assert.equal(servedSha(id, glbPath).kind, "variant");
    assert.equal((await variant.writeGlbWebpVariant(id, glbPath, { quality: 70 })).status, "converted");
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(legacy), false);
    assert.ok(existsSync(current));
  });

  it("never deletes the file the meta currently points to (same-content rewrite, write-time sweep, boot cleanup)", async () => {
    const id = "ad13ad13ad04";
    const { glbPath, paths } = await seed(id);
    const current = paths.variant;
    const deleted: string[] = [];
    variant.setGlbWebpVariantUnlinkForTest((path) => {
      deleted.push(path);
      unlinkSync(path);
    });
    try {
      assert.equal((await variant.writeGlbWebpVariant(id, glbPath)).status, "converted", "same content → same hashed name");
      assert.equal(variant.glbWebpVariantPaths(id, glbPath)!.variant, current);
      variant.cleanupGlbWebpVariantsOnBoot();
    } finally {
      variant.setGlbWebpVariantUnlinkForTest(null);
    }
    assert.equal(deleted.includes(current), false, `deleted: ${deleted.map((p) => basename(p)).join(", ")}`);
    assert.ok(existsSync(current));
    assert.equal(servedSha(id, glbPath).kind, "variant");
  });
});

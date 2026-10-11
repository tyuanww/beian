/**
 * 替换旁路时正在读旧版本的请求（方案 v2.1 §3）。在 quality.yml 的 windows-2022 job 实跑（Node 20），
 * Mac/Linux 的 L0 里同样运行。底层：Windows 上删除/覆盖被打开的文件报 EPERM，POSIX 上成功。
 * 真实写入路径：旁路按内容哈希命名，替换写新文件名、元数据原子指向新文件，旧文件删不掉就留给后续清理；
 * 旧句柄读完整旧内容，新请求拿到新内容。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-glb-webp-variant-winfs-");

const { DATA_DIR } = await import("./config.js");
const { buildPngTexturedGlbForProbe } = await import("./glbWebp.js");
const variant = await import("./glbWebpVariant.js");

const sha = (buf: Uint8Array) => createHash("sha256").update(buf).digest("hex");

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

const WIN = process.platform === "win32";
const LOCKED = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * windows-2022（Node 20）实测：改名覆盖被打开的文件报 EPERM（CI 38156418007）；删除被打开的文件成功
 * （Node 用 POSIX 删除语义），旧句柄仍读旧内容（CI 38159537915）。POSIX 两者都成功。
 */
function expectPlatform(action: () => void, fd: number, oldBytes: Buffer): boolean {
  if (WIN) {
    assert.throws(action, (error: NodeJS.ErrnoException) => LOCKED.has(String(error.code)));
    return false;
  }
  action();
  assert.equal(sha(readAll(fd, oldBytes.length)), sha(oldBytes));
  return true;
}

describe("rename-while-open (platform semantics)", () => {
  it("unlink of an open file succeeds on both and the old fd keeps reading the old bytes", () => {
    const dir = makeTestTempDir("beian-winfs-unlink-");
    const path = join(dir, "box.glb.webpv");
    const oldBytes = Buffer.alloc(256 * 1024, 1);
    writeFileSync(path, oldBytes);
    const fd = openSync(path, "r");
    try {
      unlinkSync(path);
      assert.equal(sha(readAll(fd, oldBytes.length)), sha(oldBytes));
    } finally {
      closeSync(fd);
    }
  });

  it("rename over an open file: POSIX succeeds, Windows refuses", () => {
    const dir = makeTestTempDir("beian-winfs-replace-");
    const path = join(dir, "box.glb.webpv");
    const oldBytes = Buffer.alloc(128 * 1024, 3);
    writeFileSync(path, oldBytes);
    writeFileSync(`${path}.tmp`, Buffer.alloc(10, 4));
    const fd = openSync(path, "r");
    try {
      if (expectPlatform(() => renameSync(`${path}.tmp`, path), fd, oldBytes)) assert.equal(readFileSync(path).length, 10);
    } finally {
      closeSync(fd);
    }
  });

  it("real write path: replacing a variant while a request holds the old fd (content-hashed names)", async () => {
    const id = "ac12ac12ac01";
    const jobDir = join(DATA_DIR, "mockups", id);
    mkdirSync(jobDir, { recursive: true });
    const glbPath = join(jobDir, "box.glb");
    writeFileSync(glbPath, await buildPngTexturedGlbForProbe(128));
    assert.equal((await variant.writeGlbWebpVariant(id, glbPath)).status, "converted");
    const oldPath = variant.glbWebpVariantPaths(id, glbPath)!.variant;
    const held = variant.openGlbForServe(id, glbPath);
    assert.equal(held.kind, "variant");
    const oldSha = held.kind === "variant" ? held.sha256 : "";
    const oldBytes = readFileSync(oldPath);
    // POSIX 上模拟 Windows：被打开的旧旁路 unlink/rename 报 EPERM。Windows 上就是真实行为。
    let open = true;
    if (!WIN) {
      variant.setGlbWebpVariantUnlinkForTest((path) => {
        if (open && path === oldPath) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        unlinkSync(path);
      });
    }
    try {
      const again = await variant.writeGlbWebpVariant(id, glbPath, { quality: 70 });
      assert.equal(again.status, "converted", `replacement failed while old fd open: ${JSON.stringify(again)}`);
      const full = readAll(held.fd, held.bytes);
      assert.equal(full.length, oldBytes.length);
      assert.equal(sha(full), oldSha, "old fd must keep reading the complete old variant");
      const fresh = variant.openGlbForServe(id, glbPath);
      try {
        assert.equal(fresh.kind, "variant");
        assert.notEqual(fresh.sha256, oldSha, "new request gets the new variant");
        assert.equal(sha(readAll(fresh.fd, fresh.bytes)), fresh.sha256);
      } finally {
        closeSync(fresh.fd);
      }
      const newPath = variant.glbWebpVariantPaths(id, glbPath)!.variant;
      assert.notEqual(newPath, oldPath, "new variant is written under a new content-hashed name");
      assert.match(newPath, /box\.glb\.[0-9a-f]{16}\.webpv$/);
      // POSIX 上注入的 EPERM 让旧文件留下；Windows 上删除打开的文件实际会成功，旧文件可能已删。
      if (!WIN) assert.ok(existsSync(oldPath), "old file is still held open, left for later cleanup");
    } finally {
      open = false;
      closeSync(held.fd);
      variant.setGlbWebpVariantUnlinkForTest(null);
    }
    // 后续清理：下次写入清掉残留旧文件；启动清理也会清。
    assert.equal((await variant.writeGlbWebpVariant(id, glbPath, { quality: 70 })).status, "converted");
    assert.equal(existsSync(oldPath), false, "stale variant removed by the next write");
    const vdir = variant.glbWebpVariantDir(id);
    writeFileSync(join(vdir, "box.glb.0123456789abcdef.webpv"), Buffer.from("stale"));
    variant.cleanupGlbWebpVariantsOnBoot();
    const left = readdirSync(vdir).filter((n) => n.endsWith(".webpv"));
    assert.deepEqual(left, [basename(variant.glbWebpVariantPaths(id, glbPath)!.variant)], "boot cleanup keeps only the meta-referenced variant");
    const after = variant.openGlbForServe(id, glbPath);
    closeSync(after.fd); // 句柄不关的话 Windows 上删除会挂起，文件仍列在目录里
    assert.equal(after.kind, "variant");
    variant.dropGlbWebpVariant(id);
    assert.deepEqual(readdirSync(vdir), [], "drop removes every hashed variant and the meta");
  });
});

describe("windows-2022 CI wiring", () => {
  it("quality.yml windows job runs these fs tests on hosted Windows (not the Hangzhou runner)", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const workflow = readFileSync(join(repo, ".github/workflows/quality.yml"), "utf8");
    const windowsJob = workflow.slice(workflow.indexOf("runs-on: windows-2022"), workflow.indexOf("\n  quality:"));
    assert.ok(windowsJob.length > 0);
    assert.match(windowsJob, /tsx\.cmd"\) --test "src\\glb-webp-variant-rename-open\.test\.ts" "src\\glb-webp-variant-fsync\.test\.ts" "src\\glb-webp-variant-windows-replace\.test\.ts"/);
    assert.doesNotMatch(windowsJob, /self-hosted/);
  });
});

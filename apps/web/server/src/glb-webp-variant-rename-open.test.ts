/**
 * 替换旁路时正在读旧版本的请求（方案 v2.1 §3）。在 quality.yml 的 windows-2022 job 实跑（Node 20），
 * Mac/Linux 的 L0 里同样运行。验证：已打开的旧句柄在 unlink/rename 之后仍读出完整旧内容；
 * 新请求看到新文件；走真实写入路径（writeGlbWebpVariant）替换时也成立。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

describe("rename-while-open (platform semantics)", () => {
  it("unlink then rename onto the same name while the old file is open", () => {
    const dir = makeTestTempDir("beian-winfs-unlink-");
    const path = join(dir, "box.glb.webpv");
    const oldBytes = Buffer.alloc(256 * 1024, 1);
    writeFileSync(path, oldBytes);
    const fd = openSync(path, "r");
    try {
      unlinkSync(path);
      writeFileSync(`${path}.tmp`, Buffer.alloc(1000, 2));
      renameSync(`${path}.tmp`, path);
      assert.equal(sha(readAll(fd, oldBytes.length)), sha(oldBytes));
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(path).length, 1000);
  });

  it("rename over an existing file while it is open", () => {
    const dir = makeTestTempDir("beian-winfs-replace-");
    const path = join(dir, "box.glb.webpv");
    const oldBytes = Buffer.alloc(128 * 1024, 3);
    writeFileSync(path, oldBytes);
    const fd = openSync(path, "r");
    try {
      writeFileSync(`${path}.tmp`, Buffer.alloc(10, 4));
      renameSync(`${path}.tmp`, path);
      assert.equal(sha(readAll(fd, oldBytes.length)), sha(oldBytes));
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(path).length, 10);
  });

  it("real write path: replacing a variant while a request holds the old fd", async () => {
    const id = "ac12ac12ac01";
    const jobDir = join(DATA_DIR, "mockups", id);
    mkdirSync(jobDir, { recursive: true });
    const glbPath = join(jobDir, "box.glb");
    writeFileSync(glbPath, await buildPngTexturedGlbForProbe(128));
    assert.equal((await variant.writeGlbWebpVariant(id, glbPath)).status, "converted");
    const held = variant.openGlbForServe(id, glbPath);
    assert.equal(held.kind, "variant");
    const oldSha = held.kind === "variant" ? held.sha256 : "";
    try {
      const again = await variant.writeGlbWebpVariant(id, glbPath, { quality: 70 });
      assert.equal(again.status, "converted", `replacement failed while old fd open: ${JSON.stringify(again)}`);
      assert.equal(sha(readAll(held.fd, held.bytes)), oldSha, "old fd must keep reading the complete old variant");
    } finally {
      closeSync(held.fd);
    }
    const fresh = variant.openGlbForServe(id, glbPath);
    closeSync(fresh.fd);
    assert.equal(fresh.kind, "variant");
    assert.notEqual(fresh.kind === "variant" && fresh.sha256, oldSha);
  });
});

describe("windows-2022 CI wiring", () => {
  it("quality.yml windows job runs these fs tests on hosted Windows (not the Hangzhou runner)", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const workflow = readFileSync(join(repo, ".github/workflows/quality.yml"), "utf8");
    const windowsJob = workflow.slice(workflow.indexOf("runs-on: windows-2022"), workflow.indexOf("\n  quality:"));
    assert.ok(windowsJob.length > 0);
    assert.match(windowsJob, /tsx\.cmd"\) --test "src\\glb-webp-variant-rename-open\.test\.ts" "src\\glb-webp-variant-fsync\.test\.ts"/);
    assert.doesNotMatch(windowsJob, /self-hosted/);
  });
});

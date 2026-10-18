import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-compression-recover-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { compressionPolicyFingerprint } = await import("./compressionPolicy.js");
const { setCompressionCapabilityForTest } = await import("./compressionProbe.js");
const { setCompressionExecutorForTest } = await import("./compressionExecute.js");
const { compressionDownloadActivity, compressionQueueSnapshot, compressionSettled, recoverCompressionBeforeReceipts, recoverCompressionJobs, setCompressionCommandLookupForTest, setCompressionLookupCostForTest } = await import("./compressionRuntime.js");
const {
  compressionBatchDir,
  compressionStoreSnapshot,
  createQueuedCompression,
  freezeCompressionSources,
  newCompressionId,
  readCompressionBatch,
  readCompressionReceiptPointer,
  removeCompressionLease,
  saveCompressionBatch,
  setCompressionRenameHookForTest,
  writeCompressionLease,
  writeCompressionReceiptPointer,
} = await import("./compressionStore.js");
const { additionalSourceUsage } = await import("./sourceQuota.js");
const { loadReceipt, stageBuffers } = await import("./uploads.js");
const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");

function ready() {
  return {
    budget: "enforced" as const,
    mechanism: "test",
    toolsReady: true,
    missing: [] as string[],
    diskFreeBytes: 8 * 1024 * 1024 * 1024,
    toolGeneration: "test-gen",
    policyFingerprint: compressionPolicyFingerprint(),
    versions: { sharp: "0-test", qpdf: "qpdf-test", java: "java-test", pdfbox: "pdfbox-test" },
  };
}

beforeEach(async () => {
  await compressionSettled();
  // Each scenario owns its fences; an unknown writer must block unrelated work.
  rmSync(join(DATA_DIR, "compressions"), { recursive: true, force: true });
  setCompressionCapabilityForTest(ready());
  setCompressionExecutorForTest(async () => ({ status: "passthrough", reason: null, publish: "copy_source" }));
  setCompressionRenameHookForTest(null);
  setCompressionCommandLookupForTest(null);
  setCompressionLookupCostForTest(0);
});

async function startedBatch(owner: string): Promise<string> {
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(owner)]);
  const receipt = stageBuffers(owner, [{ field: "asset1", name: "a.jpg", buf }]);
  const response = await app.request("/api/compressions/start", {
    method: "POST",
    headers: {
      authorization: `Bearer ${issueSessionForTest("魏炜", "reviewer", owner).token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ receipt: receipt.id }),
  });
  assert.equal(response.status, 202);
  const body = await response.json() as { id: string };
  await compressionSettled();
  return body.id;
}

describe("compression recovery", () => {
  it("keeps the previous manifest when rename fails", async () => {
    const id = await startedBatch("ou_rename");
    const before = readCompressionBatch(id);
    assert.ok(before);
    setCompressionRenameHookForTest(() => {
      throw Object.assign(new Error("rename failed"), { code: "EPERM" });
    });
    before.revision += 1;
    assert.throws(() => saveCompressionBatch(before));
    const after = readCompressionBatch(id);
    assert.equal(after?.revision, before.revision - 1);
    assert.equal(readFileSync(join(compressionBatchDir(id), "batch.json"), "utf8").includes(`"revision":${after?.revision}`), true);
  });

  it("drops a pointer that has no manifest and preserves one that does", () => {
    const owner = "ou_pointer";
    const receipt = stageBuffers(owner, [{ field: "asset1", name: "a.jpg", buf: Buffer.from([0xff, 0xd8, 0xff, 1]) }]);
    writeCompressionReceiptPointer(owner, receipt.id, "abcabcabcabc");
    const removed = recoverCompressionBeforeReceipts();
    assert.ok(removed.pointers >= 1);
    assert.ok(loadReceipt(receipt.id, owner));
    const id = newCompressionId();
    const frozen = freezeCompressionSources(id, [{
      id: "asset1",
      name: "a.jpg",
      media_type: "image/jpeg",
      path: receipt.files[0].path,
    }]);
    createQueuedCompression({
      id,
      title: "kept",
      ownerId: owner,
      createdBy: "魏炜",
      receiptId: receipt.id,
      files: frozen,
      policyFingerprint: compressionPolicyFingerprint(),
      toolGeneration: "test-gen",
    });
    writeCompressionReceiptPointer(owner, receipt.id, id);
    recoverCompressionBeforeReceipts();
    assert.equal(readCompressionBatch(id)?.title, "kept");
  });

  it("does not requeue an unconfirmed or unmatched executor", async () => {
    const id = await startedBatch("ou_fence");
    const batch = readCompressionBatch(id);
    assert.ok(batch);
    batch.writer = { token: "unconfirmed-token", pid: null, state: "spawn_unconfirmed", started_at: batch.created_at };
    batch.files[0].status = "queued";
    batch.revision += 1;
    const attempt = batch.attempt;
    saveCompressionBatch(batch);
    recoverCompressionJobs();
    const unconfirmed = readCompressionBatch(id);
    assert.equal(unconfirmed?.attempt, attempt);
    assert.equal(unconfirmed?.writer.state, "spawn_unconfirmed");
    assert.ok(compressionQueueSnapshot().unknown >= 1);
    assert.ok(compressionQueueSnapshot().running >= 1);
    unconfirmed!.writer = { token: "not-on-command-line", pid: process.pid, state: "running", started_at: batch.created_at };
    unconfirmed!.revision += 1;
    saveCompressionBatch(unconfirmed!);
    recoverCompressionJobs();
    const foreign = readCompressionBatch(id);
    assert.equal(foreign?.writer.state, "running");
    assert.equal(foreign?.attempt, attempt);
    assert.ok(compressionQueueSnapshot().unknown >= 1);
  });

  it("requeues a dead writer when an older close file names another pid", async () => {
    const id = await startedBatch("ou_stale_close");
    const batch = readCompressionBatch(id);
    assert.ok(batch);
    const processToken = "ab".repeat(16);
    const attempt = batch.attempt;
    batch.writer = {
      token: "stale-token",
      pid: 2_147_483_646,
      state: "running",
      started_at: batch.created_at,
      process_token: processToken,
    };
    batch.files[0].status = "running";
    batch.files[0].output_bytes = null;
    batch.revision += 1;
    saveCompressionBatch(batch);
    writeFileSync(join(compressionBatchDir(id), "executor-close.json"), JSON.stringify({
      schema: "compression-close/1",
      token: processToken,
      closed: true,
      pid: 18556,
    }));
    recoverCompressionJobs();
    await compressionSettled();
    const after = readCompressionBatch(id);
    assert.equal(after?.writer.state, "idle");
    assert.equal(after?.attempt, attempt + 1);
    assert.notEqual(after?.files[0].status, "running");
  });

  it("does not count a live writer as unknown when its command line carries the token", async () => {
    const id = await startedBatch("ou_owned_command");
    const batch = readCompressionBatch(id);
    assert.ok(batch);
    const processToken = "cd".repeat(16);
    batch.writer = {
      token: "owned-token",
      pid: process.pid,
      state: "running",
      started_at: batch.created_at,
      process_token: processToken,
    };
    batch.files[0].status = "running";
    batch.revision += 1;
    saveCompressionBatch(batch);
    try {
      setCompressionCommandLookupForTest(() => null);
      const hidden = compressionQueueSnapshot();
      setCompressionCommandLookupForTest((pid) => pid === process.pid ? `node --compression-token ${processToken}` : "");
      const shown = compressionQueueSnapshot();
      assert.equal(hidden.unknown, shown.unknown + 1);
      assert.equal(hidden.labels.includes(`compression:${id}:running+unknown`), true);
      assert.equal(shown.labels.includes(`compression:${id}:running`), true);
      recoverCompressionJobs();
      const kept = readCompressionBatch(id);
      assert.equal(kept?.writer.state, "running");
      assert.equal(kept?.attempt, batch.attempt);
    } finally {
      setCompressionCommandLookupForTest(null);
      setCompressionLookupCostForTest(0);
    }
  });

  it("does not look up a command line for an empty compression token", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const batchId = "a1b2c3d4e5f6";
    const token = "ef".repeat(16);
    let calls = 0;
    setCompressionCommandLookupForTest(() => {
      calls += 1;
      return "node --compression-token should-not-run";
    });
    try {
      assert.ok(child.pid);
      writeCompressionLease({
        token,
        owner_id: "ou_empty_token",
        batch_id: batchId,
        started_at: new Date().toISOString(),
        progress_at: new Date().toISOString(),
        pid: child.pid,
      });
      const activity = compressionDownloadActivity();
      assert.equal(calls, 0);
      assert.equal(activity.running, 1);
      assert.deepEqual(activity.labels, [`compression:${batchId}:download`]);
    } finally {
      setCompressionCommandLookupForTest(null);
      removeCompressionLease(batchId, token);
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });

  it("stops command lookups after the drain snapshot budget is spent", async () => {
    const first = await startedBatch("ou_budget_a");
    const second = await startedBatch("ou_budget_b");
    const tokenA = "11".repeat(16);
    const tokenB = "22".repeat(16);
    for (const [id, processToken] of [[first, tokenA], [second, tokenB]] as const) {
      const batch = readCompressionBatch(id);
      assert.ok(batch);
      batch.writer = {
        token: "budget-token",
        pid: process.pid,
        state: "running",
        started_at: batch.created_at,
        process_token: processToken,
      };
      batch.files[0].status = "running";
      batch.revision += 1;
      saveCompressionBatch(batch);
    }
    let calls = 0;
    setCompressionLookupCostForTest(2_000);
    setCompressionCommandLookupForTest((pid) => {
      calls += 1;
      return pid === process.pid ? `node --compression-token ${tokenA} --compression-token ${tokenB}` : "";
    });
    try {
      const snap = compressionQueueSnapshot();
      assert.equal(calls, 1);
      const named = snap.labels.filter((label) => label.startsWith("compression:") && label.includes("unknown"));
      assert.equal(named.length, 1);
    } finally {
      setCompressionCommandLookupForTest(null);
      setCompressionLookupCostForTest(0);
    }
  });

  it("requeues only after the recorded pid is confirmed gone", async () => {
    const id = await startedBatch("ou_dead");
    const batch = readCompressionBatch(id);
    assert.ok(batch);
    const retries = batch.files[0].manual_retries;
    batch.writer = { token: "dead-token", pid: 2_147_483_646, state: "running", started_at: batch.created_at };
    batch.files[0].status = "running";
    batch.files[0].output_bytes = null;
    batch.revision += 1;
    const attempt = batch.attempt;
    saveCompressionBatch(batch);
    recoverCompressionJobs();
    await compressionSettled();
    const after = readCompressionBatch(id);
    assert.equal(after?.attempt, attempt + 1);
    assert.equal(after?.files[0].manual_retries, retries);
    assert.equal(after?.writer.state, "idle");
    assert.equal(after?.files[0].status, "passthrough");
  });

  it("counts an unreadable batch toward the source quota and keeps the manifest", async () => {
    const dir = join(DATA_DIR, "compressions", "abcdefabcdef");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "batch.json"), "{");
    const owner = "ou_corrupt";
    const receipt = stageBuffers(owner, [{ field: "asset1", name: "bad.jpg", buf: Buffer.from([0xff, 0xd8, 0xff, 2]) }]);
    writeCompressionReceiptPointer(owner, receipt.id, "abcdefabcdef");
    const usage = additionalSourceUsage(owner);
    assert.ok(usage.ownerCount >= 1);
    assert.ok(usage.ownerBytes >= 100 * 1024 * 1024);
    assert.ok(compressionQueueSnapshot().unknown >= 1);
    recoverCompressionBeforeReceipts();
    assert.equal(existsSync(join(dir, "batch.json")), true);
    assert.equal(readCompressionReceiptPointer(owner, receipt.id)?.batch_id, "abcdefabcdef");
    const headers = { authorization: `Bearer ${issueSessionForTest("魏炜", "reviewer", owner).token}` };
    const listed = await app.request("/api/compressions", { headers });
    assert.equal(listed.status, 503);
    assert.equal((await listed.json() as { code: string }).code, "compression_record_unreadable");
    const detail = await app.request("/api/compressions/abcdefabcdef", { headers });
    assert.equal(detail.status, 503);
    assert.equal((await detail.json() as { code: string }).code, "compression_record_unreadable");
    const admin = await app.request("/api/compressions", {
      headers: { authorization: `Bearer ${issueSessionForTest("管理员", "admin", "ou_admin").token}` },
    });
    assert.equal(admin.status, 200);
    assert.deepEqual((await admin.json() as { unreadable_ids?: string[] }).unreadable_ids, ["abcdefabcdef"]);
    const healthy = await startedBatch("ou_healthy_after_corrupt");
    assert.ok(readCompressionBatch(healthy));
  });

  it("isolates a batch written with an unknown policy version", async () => {
    const id = await startedBatch("ou_unknown_policy");
    const batch = readCompressionBatch(id);
    assert.ok(batch);
    writeFileSync(join(compressionBatchDir(id), "batch.json"), JSON.stringify({ ...batch, policy_version: "compression-policy-v0" }));
    assert.equal(readCompressionBatch(id), null);
    assert.deepEqual(compressionStoreSnapshot().unreadable_ids, [id]);
  });

  it("isolates a batch that exceeds the file cardinality envelope", async () => {
    const id = await startedBatch("ou_too_many_files");
    const batch = readCompressionBatch(id);
    assert.ok(batch);
    writeFileSync(join(compressionBatchDir(id), "batch.json"), JSON.stringify({ ...batch, files: Array.from({ length: 21 }, () => batch.files[0]) }));
    assert.equal(readCompressionBatch(id), null);
    assert.deepEqual(compressionStoreSnapshot().unreadable_ids, [id]);
  });

  it("isolates an idle batch with a stale executor identity", async () => {
    const id = await startedBatch("ou_stale_writer");
    const batch = readCompressionBatch(id);
    assert.ok(batch);
    writeFileSync(join(compressionBatchDir(id), "batch.json"), JSON.stringify({
      ...batch,
      writer: { token: "", pid: null, state: "idle", started_at: null, process_token: "deadbeefdeadbeefdeadbeefdeadbeef" },
    }));
    assert.equal(readCompressionBatch(id), null);
    assert.deepEqual(compressionStoreSnapshot().unreadable_ids, [id]);
  });

  it("ignores a late result after the writer token changes", async () => {
    const owner = "ou_late";
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("late")]);
    const receipt = stageBuffers(owner, [{ field: "asset1", name: "late.jpg", buf }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setCompressionExecutorForTest(async () => {
      await gate;
      return { status: "passthrough", reason: null, publish: "copy_source" };
    });
    const response = await app.request("/api/compressions/start", {
      method: "POST",
      headers: {
        authorization: `Bearer ${issueSessionForTest("魏炜", "reviewer", owner).token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ receipt: receipt.id }),
    });
    assert.equal(response.status, 202);
    const id = (await response.json() as { id: string }).id;
    let current = readCompressionBatch(id);
    for (let attempt = 0; attempt < 50 && current?.writer.state !== "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = readCompressionBatch(id);
    }
    assert.equal(current?.writer.state, "running");
    current!.writer.token = "ffffffffffffffffffffffffffffffff";
    current!.revision += 1;
    saveCompressionBatch(current!);
    release();
    await compressionSettled();
    const after = readCompressionBatch(id);
    assert.equal(after?.files[0].status, "running");
    assert.equal(after?.files[0].output_bytes, null);
  });
});

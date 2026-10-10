import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-compression-lifecycle-");
const store = await import("./compressionStore.js");
const runtime = await import("./compressionRuntime.js");
const { setCompressionExecutorForTest } = await import("./compressionExecute.js");
const { setCompressionCapabilityForTest } = await import("./compressionProbe.js");
const { compressionPolicyFingerprint, COMPRESSION_DOWNLOAD_MAX_MS } = await import("./compressionPolicy.js");
const { compressionZipStream } = await import("./compressionZip.js");
const source = join(process.env.WB_DATA_DIR, "synthetic.jpg");
writeFileSync(source, Buffer.from([255,216,255,1]));
const passthrough = async () => ({ status: "passthrough" as const, reason: null, publish: "copy_source" as const });
beforeEach(async () => {
  await runtime.compressionSettled();
  rmSync(store.compressionRoot(), { recursive: true, force: true });
  runtime.setCompressionClockForTest(null);
  setCompressionExecutorForTest(passthrough);
  setCompressionCapabilityForTest({ budget: "enforced", mechanism: "synthetic", toolsReady: true, missing: [], diskFreeBytes: 8e9,
    toolGeneration: "synthetic", policyFingerprint: compressionPolicyFingerprint(), versions: { sharp: "test", qpdf: "test", java: "test", pdfbox: "test" } });
});
function batch() {
  const id = store.newCompressionId();
  return store.createQueuedCompression({ id, title: "Synthetic", ownerId: "synthetic", createdBy: "Synthetic", receiptId: "abcdefabcdef",
    files: store.freezeCompressionSources(id, [{ id: "asset1", name: "检测报告.jpg", media_type: "image/jpeg", path: source }]),
    policyFingerprint: compressionPolicyFingerprint(), toolGeneration: "synthetic" });
}
async function completed() { const b = batch(); runtime.pumpCompressionQueue(); await runtime.compressionSettled(); return b.id; }

it("a legacy running writer with no PID stays fenced and blocks other batches", async () => {
  const old = batch(); old.files[0].status = "running";
  old.writer = { token: "a".repeat(32), pid: null, state: "running", started_at: old.created_at };
  store.saveCompressionBatch(old);
  const waiting = batch();
  runtime.recoverCompressionJobs(); await runtime.compressionSettled();
  assert.equal(store.readCompressionBatch(old.id)?.attempt, 1);
  assert.equal(store.readCompressionBatch(waiting.id)?.files[0].status, "queued");
  assert.equal(runtime.compressionQueueSnapshot().unknown, 1);
});

it("new executor identity and exact tree-close proof gate recovery, even if its PID disappeared", async () => {
  let proof: { token: string; closePath: string } | undefined;
  const pid = 2147483646;
  setCompressionExecutorForTest(async request => {
    assert.ok(request.processObserver);
    proof = request.processObserver.begin();
    const before = store.readCompressionBatch(request.batchId)!;
    assert.equal(before.writer.state, "spawn_unconfirmed");
    assert.equal(before.writer.process_token, proof.token);
    request.processObserver.spawned(pid);
    assert.equal(store.readCompressionBatch(request.batchId)?.writer.pid, pid);
    return { status: "failed", reason: "interrupted", publish: "none" };
  });
  const b = batch(); runtime.pumpCompressionQueue(); await runtime.compressionSettled();
  assert.equal(store.readCompressionBatch(b.id)?.writer.state, "running");
  setCompressionExecutorForTest(passthrough);
  for (const token of [undefined, "f".repeat(32)]) {
    if (token) writeFileSync(proof!.closePath, JSON.stringify({ schema: "compression-close/1", token, pid, closed: true }));
    runtime.recoverCompressionJobs(); await runtime.compressionSettled();
    assert.equal(store.readCompressionBatch(b.id)?.attempt, 1);
  }
  writeFileSync(proof!.closePath, JSON.stringify({ schema: "compression-close/1", token: proof!.token, pid, closed: true }));
  runtime.recoverCompressionJobs(); await runtime.compressionSettled();
  assert.equal(store.readCompressionBatch(b.id)?.attempt, 2);
  assert.equal(store.readCompressionBatch(b.id)?.files[0].status, "passthrough");
});

it("confirmed no-spawn failure clears the fence, but not an unknown spawn", async () => {
  setCompressionExecutorForTest(async request => {
    request.processObserver!.begin(); request.processObserver!.notSpawned();
    return { status: "failed", reason: "dependency_missing", publish: "none" };
  });
  const b = batch(); runtime.pumpCompressionQueue(); await runtime.compressionSettled();
  assert.equal(store.readCompressionBatch(b.id)?.writer.state, "idle");
  assert.equal(store.readCompressionBatch(b.id)?.files[0].reason, "dependency_missing");
});

it("active ZIP downloads retain their files beyond two minutes, then delete after EOF", async () => {
  const id = await completed();
  const path = store.compressionOutputPath(id, "asset1");
  let clock = Date.now(); runtime.setCompressionClockForTest(() => clock);
  const reader = runtime.compressionDownloadStream(id, "synthetic", compressionZipStream(Array.from({ length: 4 }, (_, n) => ({ name: `检测报告${n}.jpg`, path })))).getReader();
  assert.equal(runtime.deleteCompressionBatch(id).status, 202);
  for (let n = 0; n < 6; n++) {
    clock += 25000; assert.equal((await reader.read()).done, false);
    runtime.sweepCompressionLeases();
    assert.equal(runtime.compressionActiveLeases().length, 1); assert.equal(existsSync(path), true);
  }
  while (!(await reader.read()).done) { /* drain synthetic bytes */ }
  assert.equal(runtime.compressionActiveLeases().length, 0); assert.equal(existsSync(path), false);
});

for (const mode of ["idle", "maximum", "cancel"] as const) it(`download ${mode} closes the source before releasing deletion`, async () => {
  const id = await completed(); const path = store.compressionOutputPath(id, "asset1");
  let clock = Date.now(); runtime.setCompressionClockForTest(() => clock);
  let finishDestroy: (() => void) | undefined;
  const source = new Readable({ read() {}, destroy(error, callback) { finishDestroy = () => callback(error); } });
  const reader = runtime.compressionDownloadStream(id, "synthetic", source).getReader();
  assert.equal(runtime.deleteCompressionBatch(id).status, 202);
  let cancelled: Promise<void> | undefined;
  if (mode === "cancel") cancelled = reader.cancel();
  else {
    if (mode === "maximum") {
      // Renew actual reads while remaining below the idle deadline each time.
      for (let i = 0; i < 10; i++) { clock += 80000; source.push(Buffer.from("x")); await reader.read(); runtime.sweepCompressionLeases(); }
      clock += COMPRESSION_DOWNLOAD_MAX_MS - 800000 + 1;
    } else clock += 120001;
    runtime.sweepCompressionLeases();
    await assert.rejects(reader.read(), /下载超时/);
  }
  assert.equal(source.destroyed, true); assert.equal(existsSync(path), true);
  assert.equal(runtime.compressionActiveLeases().length, 1);
  finishDestroy!(); await new Promise(resolve => setImmediate(resolve)); await cancelled;
  assert.equal(runtime.compressionActiveLeases().length, 0); assert.equal(existsSync(path), false);
});

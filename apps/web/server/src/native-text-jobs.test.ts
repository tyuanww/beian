import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-native-text-jobs-");
const { DATA_DIR } = await import("./config.js");
const { loadTask, saveTask, deleteTask } = await import("./tasks.js");
const { enqueue, tryStart, resetJobsTestHooks, setJobsTestHooks, queueSnapshot, publicTask, setJobsLiveForTest } = await import("./jobs.js");
const { nativePublic, recoverNativeRequests, prepareNativeRequests } = await import("./nativeTextJobs.js");
const id = "aabbccddeeff";
const success = { code: 0, stdout: JSON.stringify({ status: "pending_review", hits: [] }), stderr: "", timedOut: false };
function seed(tid = id) {
  const dir = join(DATA_DIR, "uploads", tid); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "artwork.pdf"), "%PDF-1.7 /AIPrivateData synthetic");
  saveTask({ id: tid, title: "synthetic", type: "pack", status: "comparing", job_kind: "compare", job_status: "queued", created_at: new Date().toISOString() });
}
async function eventually(check: () => boolean) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.ok(check());
}
function nativeFiles(configPath: string, includeClose = true) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const identity = { protocol: config.protocol, request_kind: config.request_kind, attempt_id: config.attempt_id, source_sha256: config.source_sha256 };
  writeFileSync(config.result_json, JSON.stringify({ ...identity, success: true, extractor_version: "native-text/1", candidates: [] }));
  if (includeClose) writeFileSync(config.close_json, JSON.stringify({ ...identity, document_closed: true, bridge_exited: true, inflight: false, lock_returnable: true }));
  return config;
}
afterEach(() => { resetJobsTestHooks(); for (const folder of ["tasks", "uploads"]) rmSync(join(DATA_DIR, folder), { recursive: true, force: true }); });

it("holds no OCR slot during native extraction and passes only the current closed attempt", async () => {
  seed(); let release!: () => void; let entered = false; let nativeDir: string | undefined;
  setJobsTestHooks({ illustratorHostReady: true,
    runNativeText: async opts => { entered = true; nativeFiles(opts.configPath); await new Promise<void>(r => { release = r; }); return success; },
    runCompare: async opts => { nativeDir = opts.nativeDir; return success; }, notify: async () => ({ ok: false, error: "test" }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => entered);
  assert.equal(queueSnapshot().ocr.running, 0); assert.equal(queueSnapshot().illustrator.running, 1);
  release(); await eventually(() => loadTask(id).job_status === "succeeded");
  assert.ok(nativeDir?.includes(".native-")); assert.equal(queueSnapshot().illustrator.running, 0);
  const body = JSON.stringify(publicTask(loadTask(id)));
  assert.equal(body.includes("source_sha256"), false); assert.equal(body.includes(DATA_DIR), false); assert.equal(body.includes("native_text_request"), false);
});

it("result JSON alone falls back to OCR but keeps drain fenced and prevents a second native", async () => {
  seed(); let calls = 0;
  setJobsTestHooks({ illustratorHostReady: true,
    runNativeText: async opts => { calls++; nativeFiles(opts.configPath, false); return success; },
    runCompare: async opts => { assert.equal(opts.nativeDir, undefined); assert.equal(opts.nativeAttempted, true); return success; }, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => loadTask(id).job_status === "succeeded");
  assert.equal(loadTask(id).native_text_request?.reason, "close_unconfirmed");
  assert.equal(queueSnapshot().illustrator.running, 1);
  assert.throws(() => deleteTask(id), /不能删/);
  seed("aabbccddee00"); tryStart();
  assert.equal(calls, 1); assert.equal(queueSnapshot().illustrator.queued, 1);
  recoverNativeRequests(); tryStart(); assert.equal(calls, 1);
});

it("maps an untrusted persisted native reason to the stable public fallback", () => {
  const task = {
    id,
    native_text_request: {
      version: "native-text/1",
      id: "0123456789abcdef0123456789abcdef",
      source_name: "artwork.pdf",
      source_sha256: "a".repeat(64),
      created_at: new Date().toISOString(),
      status: "fallback",
      reason: "/private/path/" + "x".repeat(10000),
    },
  } as never;
  assert.deepEqual(nativePublic(task), {
    status: "fallback",
    reason: "native_failed",
    message: "原稿文字未能可靠提取，本次继续图像识别。",
  });
});

it("queue deadline only falls back before native dispatch", async () => {
  seed(); setJobsLiveForTest("illustrator", "some-other-job");
  let calls = 0;
  setJobsTestHooks({ illustratorHostReady: true, runNativeText: async () => { calls++; return success; }, runCompare: async () => success, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  prepareNativeRequests(true, Date.now() - 121000); tryStart();
  await eventually(() => loadTask(id).job_status === "succeeded");
  assert.equal(loadTask(id).native_text_request?.reason, "native_busy"); assert.equal(calls, 0);
});

it("source changes and missing host never yield a native evidence path", async () => {
  seed(); prepareNativeRequests(true);
  writeFileSync(join(DATA_DIR, "uploads", id, "artwork.pdf"), "%PDF changed");
  let calls = 0;
  setJobsTestHooks({ illustratorHostReady: true, runNativeText: async () => { calls++; return success; }, runCompare: async opts => { assert.equal(opts.nativeDir, undefined); return success; }, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => loadTask(id).job_status === "succeeded");
  assert.equal(calls, 0); assert.equal(loadTask(id).native_text_request?.reason, "source_changed");
});

it("recovery does not accept a late result or clear an unknown executor", () => {
  seed(); prepareNativeRequests(true); const task = loadTask(id); task.native_text_request!.status = "running"; saveTask(task);
  recoverNativeRequests();
  assert.equal(loadTask(id).native_text_request?.status, "running");
  assert.equal(loadTask(id).native_text_request?.reason, "close_unconfirmed");
  assert.equal(queueSnapshot().illustrator.running, 1);
});

it("late polling leaves an active native extractor fenced but untouched", () => {
  seed(); prepareNativeRequests(true); const task = loadTask(id); task.native_text_request!.status = "running";
  task.native_text_request!.pid = process.pid; saveTask(task);
  recoverNativeRequests("late");
  assert.equal(loadTask(id).native_text_request?.reason, undefined);
  assert.equal(loadTask(id).native_text_request?.status, "running");
});

it("unavailable host falls back once without dispatch", async () => {
  seed(); let calls = 0;
  setJobsTestHooks({ illustratorHostReady: false, runNativeText: async () => { calls++; return success; }, runCompare: async opts => { assert.equal(opts.nativeDir, undefined); return success; }, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => loadTask(id).job_status === "succeeded");
  assert.equal(calls, 0); assert.equal(loadTask(id).native_text_request?.reason, "native_offline");
});

it("keeps the attempted-native marker when a retry discards the fallback request", async () => {
  seed(); prepareNativeRequests(false);
  writeFileSync(join(DATA_DIR, "uploads", id, "artwork.pdf"), "%PDF no illustrator metadata");
  setJobsTestHooks({ illustratorHostReady: false,
    runCompare: async opts => { assert.equal(opts.nativeDir, undefined); assert.equal(opts.nativeAttempted, true); return success; },
    notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  enqueue({ kind: "compare", id });
  await eventually(() => loadTask(id).job_status === "succeeded");
  assert.equal(loadTask(id).native_text_attempted, undefined);
});

it("a late closed result releases only proven recovery, never replaces chosen OCR evidence", async () => {
  seed();
  setJobsTestHooks({ illustratorHostReady: true,
    runNativeText: async opts => { opts.onSpawn?.(999999991); nativeFiles(opts.configPath); return { ...success, timedOut: true }; },
    runCompare: async opts => { assert.equal(opts.nativeDir, undefined); return { ...success, stdout: JSON.stringify({ status: "pending_review", hits: [{ field: "sentinel", decision: "pending" }] }) }; },
    notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => loadTask(id).job_status === "succeeded");
  const oldHits = loadTask(id).hits;
  recoverNativeRequests();
  assert.equal(loadTask(id).native_text_request?.status, "fallback");
  assert.deepEqual(loadTask(id).hits, oldHits);
});

it("an older packaging request and native review share one FIFO Illustrator slot", async () => {
  const { saveMockup } = await import("./mockup.js");
  const order: string[] = []; let release!: () => void;
  saveMockup({ id: "bb00bb00bb00", owner: "test", status: "queued", job_kind: "mockup", job_status: "queued", created_at: "2020-01-01T00:00:00Z", source_path: "synthetic.ai", files: [] });
  seed();
  setJobsTestHooks({ illustratorHostReady: true,
    runRaster: async () => { order.push("packaging"); await new Promise<void>(r => { release = r; }); return { ok: false, message: "synthetic stop" }; },
    runNativeText: async opts => { order.push("native"); nativeFiles(opts.configPath); return success; },
    runCompare: async () => success, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); assert.deepEqual(order, ["packaging"]);
  release(); await eventually(() => loadTask(id).job_status === "succeeded");
  assert.deepEqual(order, ["packaging", "native"]);
  rmSync(join(DATA_DIR, "mockups"), { recursive: true, force: true });
});

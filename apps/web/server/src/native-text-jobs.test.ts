import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-native-text-jobs-");
const { DATA_DIR } = await import("./config.js");
const { loadTask, saveTask, deleteTask } = await import("./tasks.js");
const { enqueue, tryStart, resetJobsTestHooks, setJobsTestHooks, queueSnapshot, publicTask, setJobsLiveForTest } = await import("./jobs.js");
const { nativePublic, recoverNativeRequests, prepareNativeRequests, adminRecoverNativeRequest, adminRecoveryMessage } = await import("./nativeTextJobs.js");
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

it("watchdog save_timeout falls back to OCR with a public reason and one Feishu alert", async () => {
  seed(); const alerts: string[] = [];
  setJobsTestHooks({ illustratorHostReady: true,
    runNativeText: async opts => {
      const config = JSON.parse(readFileSync(opts.configPath, "utf8"));
      writeFileSync(config.close_json, JSON.stringify({ protocol: config.protocol, request_kind: config.request_kind, attempt_id: config.attempt_id, source_sha256: config.source_sha256, document_closed: true, bridge_exited: true, inflight: false, lock_returnable: true }));
      return { code: 4, stdout: JSON.stringify({ ok: false, reason: "save_timeout", attempt_id: config.attempt_id, close_confirmed: true, request_kind: "native_text" }), stderr: "", timedOut: false };
    },
    watchdogAlert: async (task, event, kind) => { alerts.push(`${task.id}:${event}:${kind}`); },
    runCompare: async opts => { assert.equal(opts.nativeDir, undefined); assert.equal(opts.nativeAttempted, true); return success; }, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => loadTask(id).job_status === "succeeded");
  assert.equal(loadTask(id).native_text_request?.status, "fallback");
  assert.deepEqual(nativePublic(loadTask(id)), { status: "fallback", reason: "save_timeout", message: "Illustrator 保存长时间无进展，已自动重启，本次继续图像识别。" });
  assert.deepEqual(alerts, [`${id}:save_timeout:compare`]);
  assert.equal(queueSnapshot().illustrator.running, 0);
});

it("a non-watchdog worker reason stays native_failed and sends no watchdog alert", async () => {
  seed(); let alerts = 0;
  setJobsTestHooks({ illustratorHostReady: true,
    runNativeText: async opts => { nativeFiles(opts.configPath); return { ...success, code: 4, stdout: JSON.stringify({ ok: false, reason: "export_failed" }) }; },
    watchdogAlert: async () => { alerts++; },
    runCompare: async () => success, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => loadTask(id).job_status === "succeeded");
  assert.equal(loadTask(id).native_text_request?.reason, "native_failed"); assert.equal(alerts, 0);
});

it("source change during a stalled save stays fenced (no OCR fallback) with a distinct reason and alert", async () => {
  seed(); const alerts: string[] = []; let compares = 0;
  setJobsTestHooks({ illustratorHostReady: true,
    runNativeText: async opts => {
      const config = JSON.parse(readFileSync(opts.configPath, "utf8"));
      return { code: 8, stdout: JSON.stringify({ ok: false, reason: "save_source_changed", attempt_id: config.attempt_id, close_confirmed: false, request_kind: "native_text" }), stderr: "", timedOut: false };
    },
    watchdogAlert: async (_task, event) => { alerts.push(event); },
    runCompare: async () => { compares++; return success; }, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => loadTask(id).native_text_request?.reason === "save_source_changed");
  await new Promise(r => setTimeout(r, 50)); tryStart();
  const req = loadTask(id).native_text_request!;
  assert.equal(req.status, "running"); assert.equal(compares, 0);
  assert.deepEqual(nativePublic(loadTask(id)), { status: "running", reason: "save_source_changed", message: "Illustrator 保存卡住期间原稿可能被改动，已暂停，等待人工核实。" });
  assert.deepEqual(alerts, ["save_source_changed"]);
  assert.equal(queueSnapshot().illustrator.running, 1);
  recoverNativeRequests(); assert.equal(loadTask(id).native_text_request?.reason, "save_source_changed");
});

it("restart cap from the agent alerts once and keeps the attempt fenced", async () => {
  seed(); const alerts: string[] = [];
  setJobsTestHooks({ illustratorHostReady: true,
    runNativeText: async () => ({ code: 6, stdout: JSON.stringify({ ok: false, reason: "watchdog_restart_cap" }), stderr: "", timedOut: false }),
    watchdogAlert: async (_task, event) => { alerts.push(event); },
    runCompare: async () => success, notify: async () => ({ ok: false }) as never, bookkeeping: () => ({ compare_ok: true, recorded: false }) });
  tryStart(); await eventually(() => loadTask(id).native_text_request?.reason === "close_unconfirmed");
  assert.deepEqual(alerts, ["watchdog_restart_cap"]);
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

function stuck(pid: number | undefined) {
  seed(); prepareNativeRequests(true); const task = loadTask(id); const req = task.native_text_request!;
  req.status = "running"; req.reason = "close_unconfirmed"; if (pid) req.pid = pid; else delete req.pid;
  task.job_status = "succeeded"; task.status = "pending_review"; saveTask(task); return req.id;
}
const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

it("admin recovery releases a host-restart fence only for the exact attempt with a proven-gone worker", () => {
  const attempt = stuck(exitedPid());
  assert.equal(queueSnapshot().illustrator.running, 1);
  recoverNativeRequests("late");
  assert.equal(loadTask(id).native_text_request?.status, "running");
  assert.equal(adminRecoverNativeRequest(id, "0".repeat(32)), "attempt_mismatch");
  assert.equal(loadTask(id).native_text_request?.status, "running");
  assert.equal(adminRecoverNativeRequest(id, attempt), "recovered");
  const after = loadTask(id);
  assert.equal(after.native_text_request?.status, "fallback");
  assert.equal(after.native_text_request?.reason, "native_failed");
  assert.equal(after.job_status, "succeeded");
  assert.equal(queueSnapshot().illustrator.running, 0);
  assert.equal(adminRecoverNativeRequest(id, attempt), "not_stuck");
});

it("admin recovery refuses a live or unrecorded executor", () => {
  const live = stuck(process.pid);
  assert.equal(adminRecoverNativeRequest(id, live), "worker_not_proven_gone");
  assert.equal(loadTask(id).native_text_request?.status, "running");
  const unrecorded = stuck(undefined);
  assert.equal(adminRecoverNativeRequest(id, unrecorded), "worker_not_proven_gone");
  assert.equal(loadTask(id).native_text_request?.status, "running");
});

it("admin recovery leaves an active native extraction alone", () => {
  seed(); prepareNativeRequests(true); const task = loadTask(id); task.native_text_request!.status = "running";
  task.native_text_request!.pid = exitedPid(); saveTask(task);
  assert.equal(adminRecoverNativeRequest(id, task.native_text_request!.id), "not_stuck");
  assert.equal(loadTask(id).native_text_request?.status, "running");
});

it("admin recovery aborts when a review submission lands during the worker check", () => {
  const attempt = stuck(4242);
  const outcome = adminRecoverNativeRequest(id, attempt, () => {
    const t = loadTask(id); t.status = "completed"; (t as Record<string, unknown>).review_conclusion = "concurrent"; saveTask(t);
    return "missing";
  });
  assert.equal(outcome, "changed_during_check");
  const after = loadTask(id) as Record<string, unknown> & ReturnType<typeof loadTask>;
  assert.equal(after.status, "completed");
  assert.equal(after.review_conclusion, "concurrent");
  assert.equal(after.native_text_request?.status, "running");
  assert.equal(adminRecoverNativeRequest(id, attempt, () => "missing"), "recovered");
  const retried = loadTask(id) as Record<string, unknown> & ReturnType<typeof loadTask>;
  assert.equal(retried.review_conclusion, "concurrent");
  assert.equal(retried.native_text_request?.status, "fallback");
});

it("admin recovery does not overwrite a request that changed during the worker check", () => {
  const attempt = stuck(4243);
  const outcome = adminRecoverNativeRequest(id, attempt, () => {
    const t = loadTask(id); delete t.native_text_request; saveTask(t); return "missing";
  });
  assert.equal(outcome, "changed_during_check");
  assert.equal(loadTask(id).native_text_request, undefined);
});

it("admin recovery messages distinguish an unwritten abort from a post-write conflict", () => {
  assert.equal(adminRecoveryMessage("changed_during_check"), "核对期间任务变了，未写入；停掉 8787 后重试");
  assert.equal(adminRecoveryMessage("overwritten_concurrently"), "已写入，但写后检测到并发修改，请人工核对这条任务");
  assert.equal(adminRecoveryMessage("recovered"), undefined);
});

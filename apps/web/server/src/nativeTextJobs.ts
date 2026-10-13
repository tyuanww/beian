import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { illustratorBin } from "./settings.js";
import { loadAllTasks, loadTask, loadTaskWithRevision, saveTask, type Task } from "./tasks.js";
import { notifyIllustratorWatchdog, watchdogEventFromStdout, type WatchdogEvent } from "./notify.js";
import { inspectWorkerProcess, runNativeText } from "./workers.js";

export type NativeRequest = {
  version: "native-text/1"; id: string; source_name: string; source_sha256: string;
  created_at: string; status: "queued" | "running" | "ready" | "fallback";
  reason?: NativeReason; pid?: number;
};
const COPY: Record<string, string> = {
  native_busy: "原稿文字提取排队较久，本次继续图像识别。",
  native_offline: "原稿文字提取暂不可用，本次继续图像识别。",
  source_changed: "稿件已变化，旧文字证据不参与本次核对。",
  close_unconfirmed: "Illustrator 尚未确认关闭，本次继续图像识别，原生提取保持等待核实。",
  native_failed: "原稿文字未能可靠提取，本次继续图像识别。",
  save_timeout: "Illustrator 保存长时间无进展，已自动重启，本次继续图像识别。",
  save_source_changed: "Illustrator 保存卡住期间原稿可能被改动，已暂停，等待人工核实。",
};
/** Fenced reasons: the attempt is not proven closed; await human/admin recovery. */
function awaitingClose(reason: unknown): boolean { return reason === "close_unconfirmed" || reason === "save_source_changed"; }
export type WatchdogAlert = (task: Task, event: WatchdogEvent) => Promise<unknown>;
export type NativeReason = keyof typeof COPY;
const NATIVE_REASONS = new Set(Object.keys(COPY));
function safeReason(reason: unknown): NativeReason | undefined {
  return typeof reason === "string" && NATIVE_REASONS.has(reason) ? reason as NativeReason : undefined;
}
export function nativeRequest(task: Task): NativeRequest | undefined { return task.native_text_request; }
const taskRoot = (task: Task) => join(DATA_DIR, "uploads", task.id);
const root = (task: Task, req: NativeRequest) => join(taskRoot(task), `.native-${req.id}`);
function source(task: Task) { return task.job_kind === "rework" ? "artwork_v2.pdf" : "artwork.pdf"; }
function bytes(path: string, limit = 100 * 1024 * 1024): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("source_changed");
  return readFileSync(path);
}
function hash(path: string): string { return createHash("sha256").update(bytes(path)).digest("hex"); }
function fallback(task: Task, reason: NativeReason) {
  const req = nativeRequest(task)!;
  req.status = "fallback"; req.reason = reason;
  saveTask(task);
}
/** Called only by jobs' single dispatcher; no HTTP route writes these states. */
export function prepareNativeRequests(hostReady: boolean, now = Date.now()) {
  for (const task of loadAllTasks()) {
    if (task.job_status !== "queued" || !["compare", "rework"].includes(task.job_kind || "")) continue;
    if (task.verbatim_check === true) continue;
    const existing = nativeRequest(task);
    if (existing?.status === "running") continue;
    if (existing?.source_name === source(task) && existing.version === "native-text/1") {
      if (existing.status === "queued" && now - Date.parse(existing.created_at) >= 120_000) fallback(task, "native_busy");
      continue;
    }
    const path = join(taskRoot(task), source(task));
    if (!existsSync(path)) continue;
    try {
      const data = bytes(path);
      // Metadata is only a routing hint, never evidence that the text is valid.
      if (!/AIPrivateData|AIPDFPrivateData|\/Illustrator|Adobe Illustrator/.test(data.toString("latin1"))) continue;
      task.native_text_request = { version: "native-text/1", id: randomBytes(16).toString("hex"),
        source_name: source(task), source_sha256: createHash("sha256").update(data).digest("hex"),
        created_at: new Date(now).toISOString(), status: hostReady ? "queued" : "fallback",
        ...(hostReady ? {} : { reason: "native_offline" }) };
      if (hostReady) { task.job_stage = "native_text"; task.job_stage_label = "核实原稿文字"; delete task.job_eta_s; }
      saveTask(task);
    } catch { /* Existing review handling reports unreadable input. */ }
  }
}
/** A new review run may reuse only the same source and extractor version. */
export function prepareNativeRun(task: Task) {
  const req = nativeRequest(task);
  if (!req || task.job_status !== "queued" || req.status === "queued" || req.status === "running") return;
  try {
    if (req.status === "ready" && req.version === "native-text/1" && req.source_sha256 === hash(join(taskRoot(task), source(task))) && req.source_name === source(task)) return;
  } catch { /* The new review's ordinary input check will explain missing data. */ }
  // Preserve the fact that a native attempt happened even when its private
  // request record is discarded before the OCR retry is queued.
  task.native_text_attempted = true;
  delete task.native_text_request;
  saveTask(task);
}
export function nativeBlocksOcr(task: Task) {
  const req = nativeRequest(task);
  // close_unconfirmed lets OCR continue while Illustrator stays fenced;
  // save_source_changed blocks OCR too until a human has checked the source.
  return req?.status === "queued" || (req?.status === "running" && req.reason !== "close_unconfirmed");
}
export function nativeQueue() {
  const tasks = loadAllTasks();
  return { running: tasks.filter(t => nativeRequest(t)?.status === "running"),
    queued: tasks.filter(t => nativeRequest(t)?.status === "queued").sort((a, b) => nativeRequest(a)!.created_at.localeCompare(nativeRequest(b)!.created_at) || a.id.localeCompare(b.id)) };
}
export function nativePublic(task: Task) {
  const req = nativeRequest(task);
  if (!req) return undefined;
  const reason = req.reason ? safeReason(req.reason) || "native_failed" : undefined;
  return { status: req.status, ...(reason ? { reason, message: COPY[reason] } : {}) };
}
function json(path: string) { return JSON.parse(bytes(path, 8 * 1024 * 1024).toString("utf8")) as Record<string, unknown>; }
function closed(task: Task, req: NativeRequest): boolean {
  try {
    const value = json(join(root(task, req), "close.json"));
    return value.protocol === "beian.illustrator.export/2" && value.request_kind === "native_text"
      && value.attempt_id === req.id && value.source_sha256 === req.source_sha256
      && value.document_closed === true && value.bridge_exited === true && value.inflight === false && value.lock_returnable === true;
  } catch { return false; }
}
function workerGone(task: Task, req: NativeRequest, inspect: typeof inspectWorkerProcess = inspectWorkerProcess): boolean {
  if (!req.pid) return false;
  try {
    return inspect(req.pid, { kind: "native_text", id: task.id, executionId: req.id }) === "missing";
  } catch {
    return false;
  }
}
export function recoverNativeRequests(mode: "boot" | "late" = "boot") {
  for (const task of nativeQueue().running) {
    const req = nativeRequest(task)!;
    // A later close can release the fence only with proven executor exit. It
    // must not retrofit late evidence into the already selected OCR fallback.
    const gone = workerGone(task, req);
    // During normal polling, an active request without a close fence is still
    // doing useful work. Only inspect it after timeout/boot recovery has
    // already recorded a fence, or after its executor is proven gone.
    if (mode === "late" && !req.reason && !gone) continue;
    if (gone && closed(task, req)) fallback(task, "native_failed");
    // Re-saving an unchanged fence would race an out-of-process admin
    // recovery (read-before, write-after) and silently restore the fence.
    else if (!awaitingClose(req.reason)) { req.reason = "close_unconfirmed"; saveTask(task); }
  }
}
export type AdminNativeRecovery = "recovered" | "not_stuck" | "attempt_mismatch" | "worker_not_proven_gone" | "changed_during_check";
/** Administrator-confirmed exit for running + close_unconfirmed. When the
 * host was restarted mid-attempt, close evidence can never arrive, so normal
 * recovery keeps the fence forever. The administrator confirms Illustrator has
 * no customer documents open; this still requires the exact attempt id and the
 * recorded executor to be proven gone, and writes the same state as a proven
 * close (fallback/native_failed). It never touches OCR results or the copy. */
/** Operator-facing text for the admin CLI; outcomes without a message need none. */
export function adminRecoveryMessage(outcome: string): string | undefined {
  if (outcome === "changed_during_check") return "核对期间任务变了，未写入；停掉 8787 后重试";
  if (outcome === "overwritten_concurrently") return "已写入，但写后检测到并发修改，请人工核对这条任务";
  return undefined;
}
export function adminRecoverNativeRequest(
  taskId: string, attemptId: string, inspect: typeof inspectWorkerProcess = inspectWorkerProcess,
): AdminNativeRecovery {
  const stuck = (req: NativeRequest | undefined) => !!req && req.status === "running" && awaitingClose(req.reason);
  const before = loadTaskWithRevision(taskId);
  const req = nativeRequest(before.task);
  if (!stuck(req)) return "not_stuck";
  if (req!.id !== attemptId) return "attempt_mismatch";
  // Process inspection can take seconds (ps / PowerShell). Never write back the
  // snapshot read before it: reviews, completion or rework may land meanwhile.
  if (!workerGone(before.task, req!, inspect)) return "worker_not_proven_gone";
  // Re-read, compare and write in one synchronous run (no await). Any change to
  // the file during the check aborts without writing; the admin retries.
  const fresh = loadTaskWithRevision(taskId);
  if (fresh.revision !== before.revision) return "changed_during_check";
  const current = nativeRequest(fresh.task);
  if (!stuck(current) || current!.id !== attemptId) return "attempt_mismatch";
  fallback(fresh.task, "native_failed");
  return "recovered";
}
export function nativeDirectory(task: Task): string | undefined {
  const req = nativeRequest(task);
  if (req?.status !== "ready" || req.source_name !== source(task)) return;
  try {
    if (hash(join(taskRoot(task), source(task))) === req.source_sha256 && closed(task, req)) return root(task, req);
  } catch { /* No stale evidence is passed to OCR. */ }
  return;
}
export function startNative(task: Task, run: typeof runNativeText, finished: () => void, alert: WatchdogAlert = (t, e) => notifyIllustratorWatchdog(t, e, "compare")) {
  const req = nativeRequest(task)!;
  req.status = "running";
  saveTask(task); // Persist intent before touching the shared application.
  void execute(task, req, run, alert).finally(finished);
}
async function execute(task: Task, req: NativeRequest, run: typeof runNativeText, alert: WatchdogAlert) {
  let dispatched = false;
  try {
    const directory = root(task, req);
    if (hash(join(taskRoot(task), req.source_name)) !== req.source_sha256) { fallback(task, "source_changed"); return; }
    mkdirSync(directory, { recursive: false });
    const copy = join(directory, "source.pdf");
    copyFileSync(join(taskRoot(task), req.source_name), copy);
    if (hash(copy) !== req.source_sha256) { fallback(task, "source_changed"); return; }
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ protocol: "beian.illustrator.export/2", request_kind: "native_text",
      application: illustratorBin() || (process.platform === "darwin" ? "/Applications/Adobe Illustrator 2026/Adobe Illustrator.app" : ""),
      source_ai: copy, source_sha256: req.source_sha256, attempt_id: req.id,
      print_pdf: join(directory, "print.pdf"), result_json: join(directory, "result.json"), close_json: join(directory, "close.json"), debug_log: join(directory, "debug.log") }));
    dispatched = true;
    const result = await run({ executionId: req.id, configPath, onSpawn: pid => {
      const current = loadTask(task.id);
      if (nativeRequest(current)?.id !== req.id) throw new Error("native_attempt_changed");
      nativeRequest(current)!.pid = pid; saveTask(current);
    } });
    const current = loadTask(task.id), active = nativeRequest(current);
    if (active?.id !== req.id || active.status !== "running") return;
    const event = result.code !== 0 ? watchdogEventFromStdout(result.stdout) : undefined;
    if (event) void alert(current, event).catch(() => undefined);
    if (result.timedOut || !closed(current, active)) {
      // Source hash changed during a stalled save: never fall back to OCR.
      active.reason = event === "save_source_changed" ? "save_source_changed" : "close_unconfirmed";
      saveTask(current); return;
    }
    if (event === "save_timeout") {
      // Agent watchdog ended the identity-matched stalled Illustrator and proved close.
      fallback(current, "save_timeout");
      return;
    }
    if (active.reason === "close_unconfirmed" || current.job_status !== "queued") { fallback(current, "native_failed"); return; }
    if (hash(join(taskRoot(current), active.source_name)) !== active.source_sha256 || hash(copy) !== active.source_sha256) { fallback(current, "source_changed"); return; }
    const payload = json(join(directory, "result.json"));
    if (result.code !== 0 || payload.success !== true || payload.extractor_version !== "native-text/1" || payload.attempt_id !== req.id || payload.source_sha256 !== req.source_sha256) { fallback(current, "native_failed"); return; }
    active.status = "ready"; delete active.reason; saveTask(current);
  } catch {
    const current = loadTask(task.id);
    if (nativeRequest(current)?.id !== req.id) return;
    if (dispatched && !closed(current, req)) { nativeRequest(current)!.reason = "close_unconfirmed"; saveTask(current); }
    else fallback(current, "native_failed");
  }
}

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { assessCapability } from "./compressionProbe.js";
import { executeCompressionFile, type CompressionExecuteResult } from "./compressionExecute.js";
import {
  compressionProblem,
  evaluateCompressionRetry,
  isDownloadableCompressionStatus,
  publicCompressionFile,
  type PublicCompressionBatch,
} from "./compressionModel.js";
import {
  COMPRESSION_DOWNLOAD_IDLE_MS,
  COMPRESSION_DOWNLOAD_MAX_MS,
  COMPRESSION_DOWNLOADS_GLOBAL,
  COMPRESSION_DOWNLOADS_PER_OWNER,
  COMPRESSION_MAX_AUTO_REQUEUES,
  PDF_MAX_MS,
  PDF_TARGET_BYTES,
  compressionFileKey,
  compressionFileReady,
  compressionPolicySnapshot,
} from "./compressionPolicy.js";
import {
  compressionBatchDir,
  compressionHasTombstone,
  compressionManifestExists,
  compressionOutputPath,
  compressionProcessClosePath,
  compressionProcessClosed,
  compressionRoot,
  compressionSourcePath,
  compressionStoreSnapshot,
  discardCompressionOutput,
  hashFile,
  publishCompressionBytes,
  readCompressionBatch,
  readCompressionLeases,
  readCompressionReceiptPointer,
  removeCompressionLease,
  removeCompressionReceiptPointer,
  removeCompressionWorkdir,
  saveCompressionBatch,
  syncCompressionFile,
  writeCompressionLease,
  writeCompressionTombstone,
  type CompressionBatchRecord,
  type CompressionFileRecord,
  type CompressionLease,
} from "./compressionStore.js";
import { isTid, nowIso, type Viewer } from "./tasks.js";

const inflight = new Map<string, string>();
const COMPRESSION_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COMPRESSION_TOMBSTONE_SWEEP_MS = 5 * 60 * 1000;
let chain: Promise<void> = Promise.resolve();
let activeId: string | null = null;
let nowFn = (): number => Date.now();
let attemptTimeoutMs: number | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let lastTombstoneSweep = 0;
const downloads = new Map<string, { progress: number; stop: () => void }>();

export function setCompressionClockForTest(next: (() => number) | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩时钟测试钩子只能在 VITEST 使用");
  nowFn = next || (() => Date.now());
}

export function setCompressionAttemptTimeoutForTest(ms: number | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩时限测试钩子只能在 VITEST 使用");
  attemptTimeoutMs = ms;
}

export function compressionActiveLeases(): CompressionLease[] {
  sweepCompressionLeases();
  return readCompressionLeases();
}

const COMMAND_CACHE_MS = 2_000;
const COMMAND_LOOKUP_BUDGET_MS = 2_000;
const commandCache = new Map<number, { at: number; value: string | null }>();
let commandLookupForTest: ((pid: number) => string | null) | null = null;
let lookupBudgetLeft: number | null = null;
let lookupCostForTest = 0;

export function setCompressionCommandLookupForTest(next: ((pid: number) => string | null) | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩进程命令测试钩子只能在 VITEST 使用");
  commandLookupForTest = next;
  commandCache.clear();
}

export function setCompressionLookupCostForTest(ms: number): void {
  if (process.env.VITEST !== "1") throw new Error("压缩进程命令测试钩子只能在 VITEST 使用");
  lookupCostForTest = ms;
}

function withCommandLookupBudget<T>(fn: () => T): T {
  const previous = lookupBudgetLeft;
  lookupBudgetLeft = COMMAND_LOOKUP_BUDGET_MS;
  try {
    return fn();
  } finally {
    lookupBudgetLeft = previous;
  }
}

function unixCommandLine(pid: number, timeout: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function windowsCommandLine(pid: number, timeout: number): string | null {
  try {
    return execFileSync(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `[string](Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
}

function readProcessCommand(pid: number): string | null {
  if (commandLookupForTest) {
    if (lookupBudgetLeft !== null && lookupBudgetLeft <= 0) return null;
    if (lookupBudgetLeft !== null) lookupBudgetLeft -= lookupCostForTest;
    return commandLookupForTest(pid);
  }
  const now = nowFn();
  const cached = commandCache.get(pid);
  if (cached && now - cached.at < COMMAND_CACHE_MS) return cached.value;
  if (lookupBudgetLeft !== null && lookupBudgetLeft <= 0) return null;
  const timeout = lookupBudgetLeft === null ? 5_000 : Math.max(1, Math.min(5_000, lookupBudgetLeft));
  const started = Date.now();
  const value = process.platform === "win32" ? windowsCommandLine(pid, timeout) : unixCommandLine(pid, timeout);
  if (lookupBudgetLeft !== null) lookupBudgetLeft -= Date.now() - started;
  commandCache.set(pid, { at: now, value });
  return value;
}

function processLiveness(pid: number | null, token: string): "missing" | "owned" | "unknown" {
  if (!pid || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
    return code === "ESRCH" ? "missing" : "unknown";
  }
  // An empty token can never match, so the drain request must not spend its lookup budget here.
  if (!token) return "unknown";
  const command = readProcessCommand(pid);
  if (command == null) return "unknown";
  if (command.includes("--compression-token") && command.includes(token)) return "owned";
  return "unknown";
}

function writerLiveness(batch: CompressionBatchRecord): "idle" | "owned" | "missing" | "unknown" {
  if (batch.writer.state === "idle") return "idle";
  if (batch.writer.token && inflight.get(batch.id) === batch.writer.token) return "owned";
  if (batch.writer.process_token) {
    if (compressionProcessClosed(batch.id, batch.writer.process_token, batch.writer.pid)) return "missing";
    // A gone recorded pid stays missing when an older close file names a different pid.
    const live = processLiveness(batch.writer.pid, batch.writer.process_token);
    if (live === "missing" || live === "owned") return live;
    return "unknown";
  }
  if (batch.writer.state === "spawn_unconfirmed") return "unknown";
  return processLiveness(batch.writer.pid, batch.writer.token);
}

export function compressionQueueSnapshot(): { running: number; queued: number; unknown: number; labels: string[] } {
  return withCommandLookupBudget(() => compressionQueueSnapshotWithinBudget());
}

function compressionQueueSnapshotWithinBudget(): { running: number; queued: number; unknown: number; labels: string[] } {
  let running = 0;
  let queued = 0;
  let unknown = 0;
  const labels: string[] = [];
  try {
    const snapshot = compressionStoreSnapshot();
    unknown += snapshot.unreadable;
    for (const id of snapshot.unreadable_ids) labels.push(`compression:${id}:unreadable`);
    if (snapshot.unreadable > snapshot.unreadable_ids.length) labels.push("compression:directory_unreadable");
    for (const batch of snapshot.batches) {
      const reasons: string[] = [];
      const live = writerLiveness(batch);
      if (batch.writer.state === "running" || batch.writer.state === "spawn_unconfirmed" || batch.status === "running") {
        running += 1;
        reasons.push("running");
      } else if (batch.status === "queued") {
        queued += 1;
        reasons.push("queued");
      }
      if (live === "unknown") {
        unknown += 1;
        reasons.push("unknown");
      }
      if (reasons.length) labels.push(`compression:${batch.id}:${reasons.join("+")}`);
    }
  } catch (err) {
    console.warn(`compression snapshot failed: ${err instanceof Error ? err.message : err}`);
    unknown += 1;
    labels.push("compression:snapshot_failed");
  }
  return { running, queued, unknown, labels };
}

export function compressionDownloadActivity(): { running: number; queued: number; unknown: number; labels: string[] } {
  try {
    const leases = compressionActiveLeases();
    return {
      running: leases.length,
      queued: 0,
      unknown: 0,
      labels: leases.map((lease) => `compression:${lease.batch_id}:download`),
    };
  } catch (err) {
    console.warn(`compression download snapshot failed: ${err instanceof Error ? err.message : err}`);
    return { running: 0, queued: 0, unknown: 1, labels: ["compression:leases_unreadable"] };
  }
}

function queueAhead(batch: CompressionBatchRecord, all: CompressionBatchRecord[]): number {
  if (batch.status !== "queued") return 0;
  const older = all.filter((item) =>
    item.id !== batch.id &&
    item.status === "queued" &&
    (item.created_at < batch.created_at || (item.created_at === batch.created_at && item.id < batch.id)),
  ).length;
  const running = all.some((item) => item.writer.state !== "idle" || item.status === "running") ? 1 : 0;
  return older + running;
}

export function toPublicCompression(
  batch: CompressionBatchRecord,
  viewer: Viewer,
  all: CompressionBatchRecord[] = compressionStoreSnapshot().batches,
): PublicCompressionBatch {
  const capability = assessCapability();
  const manage = viewer.admin || viewer.id === batch.owner_id;
  const fence = writerLiveness(batch) === "unknown";
  return {
    id: batch.id,
    title: batch.title,
    created_at: batch.created_at,
    status: batch.status,
    revision: batch.revision,
    owner: batch.created_by,
    creator_id: batch.owner_id,
    queue_ahead: queueAhead(batch, all),
    policy_version: batch.policy_version,
    files: batch.files.map((file) => {
      const decision = evaluateCompressionRetry(file, nowFn(), {
        policyFingerprint: capability.policyFingerprint,
        toolGeneration: capability.toolGeneration,
        ready: compressionFileReady(file.media_type, capability),
        executorFence: fence,
      });
      return publicCompressionFile({
        id: file.id,
        name: file.name,
        media_type: file.media_type,
        status: file.status,
        input_bytes: file.input_bytes,
        output_bytes: file.output_bytes,
        reason: file.reason,
        key: compressionFileKey(file.id),
        can_retry: manage && decision.ok,
      });
    }),
  };
}

function idleWriter(): CompressionBatchRecord["writer"] {
  return { token: "", pid: null, state: "idle", started_at: null };
}

function reloadOwned(id: string, token: string): CompressionBatchRecord | null {
  const batch = readCompressionBatch(id);
  if (!batch || batch.writer.token !== token || compressionHasTombstone(id) || batch.delete_state !== "none") return null;
  return batch;
}

function applyResult(batchId: string, token: string, fileId: string, result: CompressionExecuteResult): void {
  const batch = reloadOwned(batchId, token);
  if (!batch) return;
  const file = batch.files.find((item) => item.id === fileId);
  if (!file || isDownloadableCompressionStatus(file.status)) return;
  const published = publishResult(batch.id, file, result);
  file.status = published.status;
  file.reason = published.reason;
  file.output_bytes = published.outputBytes;
  batch.revision += 1;
  saveCompressionBatch(batch);
}

function publishResult(
  batchId: string,
  file: CompressionFileRecord,
  result: CompressionExecuteResult,
): { status: CompressionFileRecord["status"]; reason: string | null; outputBytes: number | null } {
  const reject = (status: CompressionFileRecord["status"], reason: string) => {
    discardCompressionOutput(batchId, file.id);
    return { status, reason, outputBytes: null as number | null };
  };
  try {
    if (result.publish === "copy_source") {
      const bytes = publishCompressionBytes(batchId, file.id, "copy");
      if (hashFile(compressionOutputPath(batchId, file.id)) !== file.sha256) return reject("failed", "content_invalid");
      return { status: "passthrough", reason: null, outputBytes: bytes };
    }
    if (result.publish === "output") {
      const output = compressionOutputPath(batchId, file.id);
      if (!existsSync(output)) return reject("failed", "content_invalid");
      const size = readSize(output);
      if (size == null || size <= 0) return reject("failed", "content_invalid");
      if (file.media_type === "application/pdf" && size >= PDF_TARGET_BYTES) return reject("unmet_target", "unmet_target");
      if (file.media_type !== "application/pdf" && size >= file.input_bytes) {
        const copied = publishCompressionBytes(batchId, file.id, "copy");
        if (hashFile(output) !== file.sha256) return reject("failed", "content_invalid");
        return { status: "passthrough", reason: null, outputBytes: copied };
      }
      if (result.status !== "succeeded") return reject(result.status === "passthrough" ? "failed" : result.status, result.reason || "content_invalid");
      syncCompressionFile(output);
      return { status: "succeeded", reason: null, outputBytes: size };
    }
  } catch (err) {
    console.warn(`compression publish failed: ${err instanceof Error ? err.message : err}`);
    return reject("failed", "interrupted");
  }
  discardCompressionOutput(batchId, file.id);
  const status = result.status === "queued" || result.status === "running" || result.status === "succeeded" || result.status === "passthrough"
    ? "failed"
    : result.status;
  return { status, reason: result.reason || "interrupted", outputBytes: null };
}

function readSize(path: string): number | null {
  try {
    const size = statSync(path).size;
    return Number.isSafeInteger(size) ? size : null;
  } catch {
    return null;
  }
}

async function runBatch(batchId: string): Promise<void> {
  const existing = readCompressionBatch(batchId);
  if (!existing || existing.writer.state !== "idle" || existing.delete_state !== "none" || compressionHasTombstone(batchId)) return;
  if (!existing.files.some((file) => file.status === "queued" || file.status === "running")) return;
  const token = randomBytes(16).toString("hex");
  existing.writer = { token, pid: null, state: "spawn_unconfirmed", started_at: nowIso() };
  existing.revision += 1;
  saveCompressionBatch(existing);
  inflight.set(batchId, token);
  try {
    const marked = reloadOwned(batchId, token);
    if (!marked) return;
    marked.writer.state = "running";
    marked.revision += 1;
    saveCompressionBatch(marked);
    for (const fileId of marked.files.map((file) => file.id)) {
      const current = reloadOwned(batchId, token);
      const file = current?.files.find((item) => item.id === fileId);
      if (!current || !file || (file.status !== "queued" && file.status !== "running")) continue;
      const capability = assessCapability();
      file.tool_generation = capability.toolGeneration;
      file.status = "running";
      current.revision += 1;
      saveCompressionBatch(current);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs ?? file.policy_snapshot?.pdf_max_ms ?? PDF_MAX_MS);
      let result: CompressionExecuteResult;
      try {
        result = await executeCompressionFile({
          batchId,
          file,
          sourcePath: compressionSourcePath(batchId, file.id),
          outputPath: compressionOutputPath(batchId, file.id),
          token,
          signal: controller.signal,
          capability,
          processObserver: {
            begin() {
              const owned = reloadOwned(batchId, token);
              if (!owned) throw new Error("压缩执行器已失去归属");
              const processToken = randomBytes(16).toString("hex");
              owned.writer = { ...owned.writer, pid: null, state: "spawn_unconfirmed", process_token: processToken };
              owned.revision += 1;
              saveCompressionBatch(owned);
              return { token: processToken, closePath: compressionProcessClosePath(batchId) };
            },
            spawned(pid) {
              const owned = reloadOwned(batchId, token);
              if (!owned) throw new Error("压缩执行器已失去归属");
              owned.writer.pid = pid;
              owned.writer.state = "running";
              owned.revision += 1;
              saveCompressionBatch(owned);
            },
            closed() {
              const owned = reloadOwned(batchId, token);
              return Boolean(owned && (!owned.writer.process_token || compressionProcessClosed(batchId, owned.writer.process_token, owned.writer.pid)));
            },
            notSpawned() {
              const owned = reloadOwned(batchId, token);
              if (!owned) return;
              delete owned.writer.process_token;
              owned.writer.state = "running";
              owned.revision += 1;
              saveCompressionBatch(owned);
            },
          },
        });
      } catch (err) {
        console.warn(`compression execute failed: ${err instanceof Error ? err.message : err}`);
        result = { status: "failed", reason: "interrupted", publish: "none" };
      } finally {
        clearTimeout(timer);
      }
      const owned = reloadOwned(batchId, token);
      if (owned?.writer.process_token && !compressionProcessClosed(batchId, owned.writer.process_token, owned.writer.pid)) return;
      if (controller.signal.aborted) result = { status: "failed", reason: "timed_out", publish: "none" };
      applyResult(batchId, token, file.id, result);
    }
  } finally {
    if (inflight.get(batchId) === token) inflight.delete(batchId);
    const done = readCompressionBatch(batchId);
    if (done && done.writer.token === token && !compressionHasTombstone(batchId) &&
        (!done.writer.process_token || compressionProcessClosed(batchId, done.writer.process_token, done.writer.pid))) {
      done.writer = idleWriter();
      done.revision += 1;
      saveCompressionBatch(done);
    }
    scheduleCompressionRecovery();
  }
}

async function pumpOnce(): Promise<void> {
  if (activeId) return;
  const snapshot = compressionStoreSnapshot();
  // A recovered or unknown writer still occupies the single process-tree budget.
  // An unreadable batch is accounted for in quotas and exposed to admins for
  // quarantine, but it must not freeze healthy batches behind it.
  if (snapshot.batches.some((batch) => batch.writer.state !== "idle")) return;
  const next = snapshot.batches
    .filter((batch) =>
      batch.writer.state === "idle" &&
      batch.delete_state === "none" &&
      !compressionHasTombstone(batch.id) &&
      batch.files.some((file) => file.status === "queued" || file.status === "running"),
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
  if (!next) return;
  activeId = next.id;
  try {
    await runBatch(next.id);
  } finally {
    activeId = null;
  }
  await pumpOnce();
}

export function pumpCompressionQueue(): void {
  chain = chain.then(() => pumpOnce()).catch((err) => {
    console.warn(`compression pump failed: ${err instanceof Error ? err.message : err}`);
  });
}

export function compressionSettled(): Promise<void> {
  return chain;
}

function requeueMissing(batch: CompressionBatchRecord): void {
  const running = batch.files.filter((file) => file.status === "running");
  if (!running.length && batch.writer.state === "idle") return;
  if (batch.auto_requeues >= COMPRESSION_MAX_AUTO_REQUEUES) {
    for (const file of batch.files) {
      if (file.status !== "running" && file.status !== "queued") continue;
      file.status = "failed";
      file.reason = "interrupted";
      file.output_bytes = null;
      discardCompressionOutput(batch.id, file.id);
    }
  } else {
    batch.auto_requeues += 1;
    batch.attempt += 1;
    for (const file of batch.files) {
      if (file.status !== "running") continue;
      file.status = "queued";
      file.reason = null;
      file.output_bytes = null;
    }
  }
  batch.writer = idleWriter();
  batch.revision += 1;
  saveCompressionBatch(batch);
}

export function recoverCompressionBeforeReceipts(): { pointers: number; orphans: number } {
  const result = { pointers: 0, orphans: 0 };
  const root = compressionRoot();
  const index = join(root, "receipt-index");
  let pointers: string[] = [];
  try {
    pointers = readdirSync(index);
  } catch {
    pointers = [];
  }
  for (const name of pointers) {
    const path = join(index, name);
    let batchId = "";
    let owner = "";
    let receiptId = "";
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { owner?: string; receipt_id?: string; batch_id?: string };
      owner = String(parsed.owner || "");
      receiptId = String(parsed.receipt_id || "");
      batchId = String(parsed.batch_id || "");
    } catch {
      try {
        unlinkSync(path);
      } catch {
        /* 下次启动再清 */
      }
      result.pointers += 1;
      continue;
    }
    const manifest = isTid(batchId) && compressionManifestExists(batchId);
    if (!manifest || (owner && receiptId && readCompressionReceiptPointer(owner, receiptId)?.batch_id !== batchId)) {
      if (owner && receiptId) removeCompressionReceiptPointer(owner, receiptId);
      else {
        try {
          unlinkSync(path);
        } catch {
          /* 保留到下次 */
        }
      }
      result.pointers += 1;
    }
  }
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!isTid(name) || compressionHasTombstone(name) || compressionManifestExists(name)) continue;
    removeCompressionWorkdir(name);
    result.orphans += 1;
  }
  return result;
}

export function recoverCompressionJobs(): void {
  recoverCompressionBeforeReceipts();
  sweepCompressionLeases();
  for (const batch of compressionStoreSnapshot().batches) {
    if (batch.delete_state === "deleting") finishCompressionDelete(batch.id);
    const live = writerLiveness(batch);
    if (live === "idle" || live === "owned" || live === "unknown") continue;
    requeueMissing(batch);
  }
  for (const name of safeNames()) {
    if (compressionHasTombstone(name)) finishCompressionDelete(name);
  }
  pruneOldCompressionTombstones();
  pumpCompressionQueue();
  scheduleCompressionRecovery();
}

function scheduleCompressionRecovery(): void {
  if (recoveryTimer || !compressionStoreSnapshot().batches.some((batch) => batch.writer.state !== "idle" && !inflight.has(batch.id))) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    try { recoverCompressionJobs(); }
    catch { console.warn("compression recovery failed; existing executor fences retained"); scheduleCompressionRecovery(); }
  }, 5000);
  recoveryTimer.unref();
}

function safeNames(): string[] {
  try {
    return readdirSync(compressionRoot()).filter((name) => isTid(name));
  } catch {
    return [];
  }
}

export function retryCompressionBatch(
  id: string,
  expectedRevision: number,
  fileIds?: string[],
): { replay: boolean; batch: CompressionBatchRecord } {
  if (!isTid(id)) throw compressionProblem("compression_not_found");
  const batch = readCompressionBatch(id);
  if (!batch || compressionHasTombstone(id)) throw compressionProblem("compression_not_found");
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw compressionProblem("compression_query_invalid");
  const requested = (fileIds && fileIds.length ? fileIds : batch.files.filter((file) =>
    file.status === "unmet_target" || file.status === "unsupported" || file.status === "failed").map((file) => file.id)
  ).slice();
  if (!requested.length || requested.some((fileId) => !batch.files.some((file) => file.id === fileId))) {
    throw compressionProblem("compression_retry_rejected", requested.length ? "file_unknown" : "not_retryable");
  }
  const filesKey = requested.slice().sort().join(",");
  const prior = batch.retry_log.find((item) => item.expected_revision === expectedRevision && item.files_key === filesKey);
  if (prior) return { replay: true, batch };
  if (batch.revision !== expectedRevision) throw compressionProblem("compression_revision_conflict");
  if (batch.status === "queued" || batch.status === "running" || batch.writer.state !== "idle") {
    throw compressionProblem("compression_retry_rejected", "not_retryable");
  }
  const selected = requested.map((fileId) => batch.files.find((file) => file.id === fileId)!);
  if (selected.some((file) => isDownloadableCompressionStatus(file.status))) {
    throw compressionProblem("compression_retry_rejected", "not_retryable");
  }
  const capability = assessCapability();
  for (const file of selected) {
    const decision = evaluateCompressionRetry(file, nowFn(), {
      policyFingerprint: capability.policyFingerprint,
      toolGeneration: capability.toolGeneration,
      ready: compressionFileReady(file.media_type, capability),
      executorFence: writerLiveness(batch) === "unknown",
    });
    if (!decision.ok) throw compressionProblem("compression_retry_rejected", decision.reason);
  }
  const when = new Date(nowFn()).toISOString();
  for (const file of selected) {
    discardCompressionOutput(batch.id, file.id);
    file.status = "queued";
    file.reason = null;
    file.output_bytes = null;
    file.manual_retries += 1;
    file.last_retry_at = when;
    file.policy_fingerprint = capability.policyFingerprint;
    file.tool_generation = capability.toolGeneration;
    file.policy_snapshot = compressionPolicySnapshot();
  }
  batch.policy_fingerprint = capability.policyFingerprint;
  batch.attempt += 1;
  batch.retry_log.push({ expected_revision: expectedRevision, files_key: filesKey, attempt: batch.attempt });
  batch.writer = idleWriter();
  batch.revision += 1;
  saveCompressionBatch(batch);
  pumpCompressionQueue();
  return { replay: false, batch: readCompressionBatch(id) || batch };
}

function batchLeaseCount(id: string): number {
  return compressionActiveLeases().filter((lease) => lease.batch_id === id).length;
}

function finishCompressionDelete(id: string): void {
  if (!isTid(id) || !compressionHasTombstone(id) || batchLeaseCount(id) > 0) return;
  const dir = compressionBatchDir(id);
  for (const name of ["source", "out", "batch.json"]) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
  rmSync(join(compressionRoot(), "leases", id), { recursive: true, force: true });
}

/** Keep delete idempotency for a bounded retention window, then remove the
 * empty batch directory so long-lived workspaces do not leak one inode per
 * deleted compression forever. */
function pruneOldCompressionTombstones(): void {
  const now = Date.now();
  if (now - lastTombstoneSweep < COMPRESSION_TOMBSTONE_SWEEP_MS) return;
  lastTombstoneSweep = now;
  for (const id of safeNames()) {
    if (!compressionHasTombstone(id) || compressionManifestExists(id) || batchLeaseCount(id) > 0) continue;
    try {
      const marker = statSync(join(compressionBatchDir(id), "tombstone.json"));
      if (now - marker.mtimeMs >= COMPRESSION_TOMBSTONE_RETENTION_MS) {
        rmSync(compressionBatchDir(id), { recursive: true, force: true });
      }
    } catch {
      /* A concurrent cleanup wins; the next sweep will reconsider it. */
    }
  }
}

export function deleteCompressionBatch(id: string): { status: 200 | 202; body: { ok: true; status?: "deleting"; already_deleted?: true } } {
  if (!isTid(id)) throw compressionProblem("compression_not_found");
  const batch = readCompressionBatch(id);
  if (compressionHasTombstone(id) && !batch) return { status: 200, body: { ok: true, already_deleted: true } };
  if (!batch) throw compressionProblem("compression_not_found");
  if (batch.status === "queued" || batch.status === "running" || batch.writer.state !== "idle") {
    throw compressionProblem("compression_not_terminal");
  }
  batch.delete_state = "deleting";
  batch.revision += 1;
  saveCompressionBatch(batch);
  writeCompressionTombstone(id, batch.owner_id);
  if (batchLeaseCount(id) > 0) return { status: 202, body: { ok: true, status: "deleting" } };
  finishCompressionDelete(id);
  pruneOldCompressionTombstones();
  return { status: 200, body: { ok: true } };
}

export function sweepCompressionLeases(now = nowFn()): void {
  for (const lease of readCompressionLeases()) {
    const started = Date.parse(lease.started_at);
    const download = downloads.get(lease.token);
    const progress = download?.progress ?? Date.parse(lease.progress_at);
    const foreign = lease.pid !== process.pid;
    const idle = !Number.isFinite(progress) || now - progress > COMPRESSION_DOWNLOAD_IDLE_MS;
    const expired = !Number.isFinite(started) || now - started > COMPRESSION_DOWNLOAD_MAX_MS;
    if (!foreign && !idle && !expired) continue;
    if (foreign && processLiveness(lease.pid, "") !== "missing") continue;
    if (download) { download.stop(); continue; }
    removeCompressionLease(lease.batch_id, lease.token);
    finishCompressionDelete(lease.batch_id);
  }
}

function acquireCompressionLease(batchId: string, ownerId: string): CompressionLease {
  sweepCompressionLeases();
  const batch = readCompressionBatch(batchId);
  if (!batch || batch.delete_state !== "none" || compressionHasTombstone(batchId)) {
    throw compressionProblem("compression_file_missing");
  }
  const leases = readCompressionLeases();
  if (leases.filter((lease) => lease.owner_id === ownerId).length >= COMPRESSION_DOWNLOADS_PER_OWNER) {
    throw compressionProblem("compression_download_busy");
  }
  if (leases.length >= COMPRESSION_DOWNLOADS_GLOBAL) throw compressionProblem("compression_download_busy");
  const now = new Date(nowFn()).toISOString();
  const lease: CompressionLease = {
    token: randomBytes(16).toString("hex"),
    owner_id: ownerId,
    batch_id: batchId,
    started_at: now,
    progress_at: now,
    pid: process.pid,
  };
  writeCompressionLease(lease);
  return lease;
}

function releaseCompressionLease(lease: CompressionLease): void {
  removeCompressionLease(lease.batch_id, lease.token);
  finishCompressionDelete(lease.batch_id);
}

/** Backpressure follows the HTTP reader; neither prefetch nor an open socket renews a lease. */
export function compressionDownloadStream(batchId: string, ownerId: string, source: Readable): ReadableStream<Uint8Array> {
  let lease: CompressionLease;
  try { lease = acquireCompressionLease(batchId, ownerId); }
  catch (error) { source.destroy(); throw error; }
  const iterator = source[Symbol.asyncIterator]();
  let released = false;
  let stopping = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let savedAt = nowFn();
  const finish = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    downloads.delete(lease.token);
    try { releaseCompressionLease(lease); }
    catch { console.warn("compression download closed; pending file cleanup will be retried"); }
  };
  const stop = (error?: Error) => {
    if (stopping || released) return;
    stopping = true;
    if (error) controller.error(error);
    source.destroy();
    if (source.closed) finish();
  };
  const closed = new Promise<void>((resolve) => source.once("close", () => { if (stopping) finish(); resolve(); }));
  source.once("error", () => { /* iterator.next propagates the read error to the HTTP reader. */ });
  downloads.set(lease.token, { progress: savedAt, stop: () => stop(new Error("下载超时，请重新下载。")) });
  const timer = setInterval(() => {
    try { sweepCompressionLeases(); }
    catch { console.warn("compression lease cleanup failed; downloads remain protected"); }
  }, 1000);
  timer.unref();
  return new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull() {
      try {
        const next = await iterator.next();
        if (stopping) return;
        if (next.done) { finish(); controller.close(); return; }
        const now = nowFn();
        downloads.get(lease.token)!.progress = now;
        if (now - savedAt >= 1000) {
          lease.progress_at = new Date(now).toISOString();
          writeCompressionLease(lease);
          savedAt = now;
        }
        controller.enqueue(next.value);
      } catch (error) {
        stop(error instanceof Error ? error : new Error("下载失败"));
      }
    },
    async cancel() { stop(); if (!source.closed) await closed; },
  }, { highWaterMark: 0 });
}

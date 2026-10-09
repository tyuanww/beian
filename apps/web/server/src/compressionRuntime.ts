import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { assessCapability, type CompressionCapability } from "./compressionProbe.js";
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
  COMPRESSION_REQUIRED_FREE_BYTES,
  PDF_MAX_MS,
  PDF_TARGET_BYTES,
  compressionFileKey,
} from "./compressionPolicy.js";
import {
  compressionBatchDir,
  compressionHasTombstone,
  compressionManifestExists,
  compressionOutputPath,
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
  writeCompressionLease,
  writeCompressionTombstone,
  type CompressionBatchRecord,
  type CompressionFileRecord,
  type CompressionLease,
} from "./compressionStore.js";
import { isTid, nowIso, type Viewer } from "./tasks.js";

const inflight = new Map<string, string>();
let chain: Promise<void> = Promise.resolve();
let activeId: string | null = null;
let nowFn = (): number => Date.now();
let attemptTimeoutMs = PDF_MAX_MS;

export function setCompressionClockForTest(next: (() => number) | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩时钟测试钩子只能在 VITEST 使用");
  nowFn = next || (() => Date.now());
}

export function setCompressionAttemptTimeoutForTest(ms: number | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩时限测试钩子只能在 VITEST 使用");
  attemptTimeoutMs = ms ?? PDF_MAX_MS;
}

export function compressionActiveLeases(): CompressionLease[] {
  sweepCompressionLeases();
  return readCompressionLeases();
}

function processLiveness(pid: number | null, token: string): "missing" | "owned" | "unknown" {
  if (!pid || pid <= 0) return "missing";
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
    return code === "ESRCH" ? "missing" : "unknown";
  }
  if (process.platform === "win32") return "unknown";
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (token && command.includes("--compression-token") && command.includes(token)) return "owned";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function writerLiveness(batch: CompressionBatchRecord): "idle" | "owned" | "missing" | "unknown" {
  if (batch.writer.state === "idle") return "idle";
  if (batch.writer.token && inflight.get(batch.id) === batch.writer.token) return "owned";
  if (batch.writer.state === "spawn_unconfirmed") return "unknown";
  return processLiveness(batch.writer.pid, batch.writer.token);
}

export function compressionQueueSnapshot(): { running: number; queued: number; unknown: number } {
  let running = 0;
  let queued = 0;
  let unknown = 0;
  try {
    const snapshot = compressionStoreSnapshot();
    unknown += snapshot.unreadable;
    for (const batch of snapshot.batches) {
      const live = writerLiveness(batch);
      if (live === "unknown") unknown += 1;
      if (batch.writer.state === "running" || batch.writer.state === "spawn_unconfirmed" || batch.status === "running") {
        running += 1;
      } else if (batch.status === "queued") queued += 1;
    }
  } catch (err) {
    console.warn(`compression snapshot failed: ${err instanceof Error ? err.message : err}`);
    unknown += 1;
  }
  return { running, queued, unknown };
}

export function compressionDownloadActivity(): { running: number; queued: number } {
  return { running: compressionActiveLeases().length, queued: 0 };
}

function capabilityReady(capability: CompressionCapability): boolean {
  return capability.budget === "enforced" &&
    capability.toolsReady &&
    capability.missing.length === 0 &&
    capability.diskFreeBytes >= COMPRESSION_REQUIRED_FREE_BYTES;
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

export function toPublicCompression(batch: CompressionBatchRecord, viewer: Viewer): PublicCompressionBatch {
  const all = compressionStoreSnapshot().batches;
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
        ready: capabilityReady(capability),
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
      file.status = "running";
      current.revision += 1;
      saveCompressionBatch(current);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      let result: CompressionExecuteResult;
      try {
        result = await executeCompressionFile({
          batchId,
          file,
          sourcePath: compressionSourcePath(batchId, file.id),
          outputPath: compressionOutputPath(batchId, file.id),
          token,
          signal: controller.signal,
          capability: assessCapability(),
        });
      } catch (err) {
        console.warn(`compression execute failed: ${err instanceof Error ? err.message : err}`);
        result = { status: "failed", reason: "interrupted", publish: "none" };
      } finally {
        clearTimeout(timer);
      }
      if (controller.signal.aborted) result = { status: "failed", reason: "timed_out", publish: "none" };
      applyResult(batchId, token, file.id, result);
    }
  } finally {
    if (inflight.get(batchId) === token) inflight.delete(batchId);
    const done = readCompressionBatch(batchId);
    if (done && done.writer.token === token && !compressionHasTombstone(batchId)) {
      done.writer = idleWriter();
      done.revision += 1;
      saveCompressionBatch(done);
    }
  }
}

async function pumpOnce(): Promise<void> {
  if (activeId) return;
  const next = compressionStoreSnapshot().batches
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
  pumpCompressionQueue();
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
      ready: capabilityReady(capability),
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
  }
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
  return { status: 200, body: { ok: true } };
}

export function sweepCompressionLeases(now = nowFn()): void {
  for (const lease of readCompressionLeases()) {
    const started = Date.parse(lease.started_at);
    const progress = Date.parse(lease.progress_at);
    const foreign = lease.pid !== process.pid;
    const idle = !Number.isFinite(progress) || now - progress > COMPRESSION_DOWNLOAD_IDLE_MS;
    const expired = !Number.isFinite(started) || now - started > COMPRESSION_DOWNLOAD_MAX_MS;
    if (!foreign && !idle && !expired) continue;
    removeCompressionLease(lease.batch_id, lease.token);
    finishCompressionDelete(lease.batch_id);
  }
}

export function acquireCompressionLease(batchId: string, ownerId: string): CompressionLease {
  sweepCompressionLeases();
  const leases = readCompressionLeases();
  if (leases.filter((lease) => lease.owner_id === ownerId).length >= COMPRESSION_DOWNLOADS_PER_OWNER) {
    throw compressionProblem("compression_download_busy");
  }
  if (leases.length >= COMPRESSION_DOWNLOADS_GLOBAL) throw compressionProblem("compression_download_busy");
  const now = nowIso();
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

export function releaseCompressionLease(lease: CompressionLease): void {
  removeCompressionLease(lease.batch_id, lease.token);
  finishCompressionDelete(lease.batch_id);
}

export function noteCompressionResultForTest(
  batchId: string,
  token: string,
  fileId: string,
  result: CompressionExecuteResult,
): void {
  if (process.env.VITEST !== "1") throw new Error("压缩结果测试钩子只能在 VITEST 使用");
  applyResult(batchId, token, fileId, result);
}

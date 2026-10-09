import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DATA_DIR } from "./config.js";
import {
  COMPRESSION_MAX_FILE_BYTES,
  COMPRESSION_POLICY_VERSION,
  compressionFileKey,
  compressionPolicyFingerprint,
  isCompressionAssetField,
  type CompressionMediaType,
} from "./compressionPolicy.js";
import {
  rollupCompressionStatus,
  type CompressionBatchStatus,
  type CompressionFileStatus,
} from "./compressionModel.js";
import { registerSourceUsageProvider, type SourceUsage } from "./sourceQuota.js";
import { noteHistoryCompression } from "./historyIndex.js";
import { isTid, newTid, nowIso } from "./tasks.js";

export type CompressionWriterState = "idle" | "spawn_unconfirmed" | "running";

export type CompressionWriter = {
  token: string;
  pid: number | null;
  state: CompressionWriterState;
  started_at: string | null;
  process_token?: string;
};

export function compressionProcessClosePath(id: string): string {
  return join(compressionBatchDir(id), "executor-close.json");
}

export function compressionProcessClosed(id: string, token: string, pid: number | null): boolean {
  if (!/^[a-f0-9]{32}$/.test(token)) return false;
  try {
    const path = compressionProcessClosePath(id);
    if (statSync(path).size > 2048) return false;
    const record = JSON.parse(readFileSync(path, "utf8"));
    return record.schema === "compression-close/1" && record.token === token && record.closed === true &&
      Number.isInteger(record.pid) && record.pid > 0 && (pid === null || record.pid === pid);
  } catch { return false; }
}

export type CompressionFileRecord = {
  id: string;
  name: string;
  media_type: CompressionMediaType;
  status: CompressionFileStatus;
  input_bytes: number;
  output_bytes: number | null;
  reason: string | null;
  sha256: string;
  manual_retries: number;
  last_retry_at: string | null;
  policy_fingerprint: string;
  tool_generation: string;
};

export type CompressionRetryLog = {
  expected_revision: number;
  files_key: string;
  attempt: number;
};

export type CompressionBatchRecord = {
  schema_version: 1;
  id: string;
  title: string;
  created_at: string;
  status: CompressionBatchStatus;
  revision: number;
  owner_id: string;
  created_by: string;
  source_receipt: string;
  attempt: number;
  auto_requeues: number;
  policy_fingerprint: string;
  policy_version: typeof COMPRESSION_POLICY_VERSION;
  files: CompressionFileRecord[];
  writer: CompressionWriter;
  retry_log: CompressionRetryLog[];
  delete_state: "none" | "deleting";
};

export type CompressionLease = {
  token: string;
  owner_id: string;
  batch_id: string;
  started_at: string;
  progress_at: string;
  pid: number;
};

const MEDIA = new Set<CompressionMediaType>(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const FILE_STATUS = new Set<CompressionFileStatus>([
  "queued", "running", "succeeded", "passthrough", "unmet_target", "unsupported", "failed",
]);

let renameHook: ((from: string, to: string) => void) | null = null;

export function setCompressionRenameHookForTest(hook: ((from: string, to: string) => void) | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩原子写测试钩子只能在 VITEST 使用");
  renameHook = hook;
}

export function compressionRoot(): string {
  const root = join(DATA_DIR, "compressions");
  mkdirSync(root, { recursive: true });
  return root;
}

export function compressionBatchDir(id: string): string {
  if (!isTid(id)) throw new Error("无效压缩批次");
  return join(compressionRoot(), id);
}

function pointerDir(): string {
  const dir = join(compressionRoot(), "receipt-index");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function leaseRoot(): string {
  const dir = join(compressionRoot(), "leases");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function compressionPointerKey(owner: string, receiptId: string): string {
  return createHash("sha256").update(`${owner}\0${receiptId}`).digest("hex");
}

function pointerPath(owner: string, receiptId: string): string {
  return join(pointerDir(), compressionPointerKey(owner, receiptId));
}

function batchJsonPath(id: string): string {
  return join(compressionBatchDir(id), "batch.json");
}

export function compressionTombstonePath(id: string): string {
  return join(compressionBatchDir(id), "tombstone.json");
}

export function compressionSourcePath(id: string, fileId: string): string {
  if (!isCompressionAssetField(fileId)) throw new Error("无效压缩原件");
  return join(compressionBatchDir(id), "source", fileId);
}

export function compressionOutputPath(id: string, fileId: string): string {
  if (!isCompressionAssetField(fileId)) throw new Error("无效压缩结果");
  return join(compressionBatchDir(id), "out", compressionFileKey(fileId));
}

function atomicWriteJson(dest: string, value: unknown): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${basename(dest)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(JSON.stringify(value)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    (renameHook || renameSync)(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 旧目标保持不变 */
    }
    throw err;
  }
}

export function hashFile(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function idleWriter(): CompressionWriter {
  return { token: "", pid: null, state: "idle", started_at: null };
}

function fileShapeOk(file: CompressionFileRecord): boolean {
  return Boolean(
    file &&
      isCompressionAssetField(file.id) &&
      typeof file.name === "string" &&
      MEDIA.has(file.media_type) &&
      FILE_STATUS.has(file.status) &&
      Number.isSafeInteger(file.input_bytes) &&
      file.input_bytes >= 0 &&
      (file.output_bytes === null || (Number.isSafeInteger(file.output_bytes) && file.output_bytes >= 0)) &&
      (file.reason === null || typeof file.reason === "string") &&
      /^[a-f0-9]{64}$/.test(file.sha256 || "") &&
      Number.isInteger(file.manual_retries) &&
      file.manual_retries >= 0 &&
      (file.last_retry_at === null || typeof file.last_retry_at === "string") &&
      typeof file.policy_fingerprint === "string" &&
      typeof file.tool_generation === "string",
  );
}

export function compressionBatchShapeOk(batch: CompressionBatchRecord): boolean {
  return Boolean(
    batch &&
      batch.schema_version === 1 &&
      isTid(batch.id) &&
      typeof batch.title === "string" &&
      typeof batch.created_at === "string" &&
      typeof batch.owner_id === "string" &&
      batch.owner_id.trim() &&
      typeof batch.created_by === "string" &&
      isTid(batch.source_receipt) &&
      Number.isInteger(batch.revision) &&
      batch.revision >= 1 &&
      Number.isInteger(batch.attempt) &&
      batch.attempt >= 1 &&
      Number.isInteger(batch.auto_requeues) &&
      batch.auto_requeues >= 0 &&
      typeof batch.policy_fingerprint === "string" &&
      batch.policy_version === COMPRESSION_POLICY_VERSION &&
      Array.isArray(batch.files) &&
      batch.files.length > 0 &&
      batch.files.every((file) => fileShapeOk(file)) &&
      batch.writer &&
      (batch.writer.state === "idle" || batch.writer.state === "spawn_unconfirmed" || batch.writer.state === "running") &&
      (batch.delete_state === "none" || batch.delete_state === "deleting") &&
      Array.isArray(batch.retry_log),
  );
}

export function compressionManifestExists(id: string): boolean {
  return isTid(id) && existsSync(batchJsonPath(id));
}

export function readCompressionBatch(id: string): CompressionBatchRecord | null {
  if (!compressionManifestExists(id)) return null;
  try {
    const batch = JSON.parse(readFileSync(batchJsonPath(id), "utf8")) as CompressionBatchRecord;
    if (!compressionBatchShapeOk(batch) || batch.id !== id) return null;
    return batch;
  } catch {
    return null;
  }
}

export function compressionHasTombstone(id: string): boolean {
  return isTid(id) && existsSync(compressionTombstonePath(id));
}

export type CompressionStoreSnapshot = {
  batches: CompressionBatchRecord[];
  unreadable: number;
};

export function compressionStoreSnapshot(): CompressionStoreSnapshot {
  const root = compressionRoot();
  const batches: CompressionBatchRecord[] = [];
  let unreadable = 0;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return { batches, unreadable: 1 };
  }
  for (const name of names) {
    if (!isTid(name)) continue;
    if (compressionHasTombstone(name)) continue;
    if (!compressionManifestExists(name)) continue;
    const batch = readCompressionBatch(name);
    if (!batch) {
      unreadable += 1;
      continue;
    }
    batches.push(batch);
  }
  return { batches, unreadable };
}

export function saveCompressionBatch(batch: CompressionBatchRecord): void {
  if (!compressionBatchShapeOk(batch)) throw new Error("压缩批次不能保存");
  batch.status = rollupCompressionStatus(batch.files);
  atomicWriteJson(batchJsonPath(batch.id), batch);
  try { noteHistoryCompression(batch); } catch { /* 摘要失败不回滚压缩记录 */ }
}

export function newCompressionId(): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = newTid();
    if (!existsSync(compressionBatchDir(id))) return id;
  }
  throw new Error("压缩编号冲突，请重试");
}

export type FrozenCompressionFile = {
  id: string;
  name: string;
  media_type: CompressionMediaType;
  bytes: number;
  sha256: string;
};

export function freezeCompressionSources(
  id: string,
  files: Array<{ id: string; name: string; media_type: CompressionMediaType; path: string }>,
): FrozenCompressionFile[] {
  const frozen: FrozenCompressionFile[] = [];
  for (const file of files) {
    const dest = compressionSourcePath(id, file.id);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file.path, dest);
    const bytes = statSync(dest).size;
    if (bytes <= 0 || bytes > COMPRESSION_MAX_FILE_BYTES) throw new Error("压缩原件大小不正确");
    frozen.push({
      id: file.id,
      name: file.name,
      media_type: file.media_type,
      bytes,
      sha256: hashFile(dest),
    });
  }
  return frozen;
}

export function createQueuedCompression(input: {
  id: string;
  title: string;
  ownerId: string;
  createdBy: string;
  receiptId: string;
  files: FrozenCompressionFile[];
  policyFingerprint: string;
  toolGeneration: string;
}): CompressionBatchRecord {
  const created = nowIso();
  const batch: CompressionBatchRecord = {
    schema_version: 1,
    id: input.id,
    title: input.title,
    created_at: created,
    status: "queued",
    revision: 1,
    owner_id: input.ownerId,
    created_by: input.createdBy,
    source_receipt: input.receiptId,
    attempt: 1,
    auto_requeues: 0,
    policy_fingerprint: input.policyFingerprint,
    policy_version: COMPRESSION_POLICY_VERSION,
    files: input.files.map((file) => ({
      id: file.id,
      name: file.name,
      media_type: file.media_type,
      status: "queued",
      input_bytes: file.bytes,
      output_bytes: null,
      reason: null,
      sha256: file.sha256,
      manual_retries: 0,
      last_retry_at: null,
      policy_fingerprint: input.policyFingerprint,
      tool_generation: input.toolGeneration,
    })),
    writer: idleWriter(),
    retry_log: [],
    delete_state: "none",
  };
  saveCompressionBatch(batch);
  return batch;
}

export function writeCompressionReceiptPointer(owner: string, receiptId: string, batchId: string): void {
  if (!isTid(receiptId) || !isTid(batchId)) throw new Error("压缩回执指针不正确");
  const path = pointerPath(owner, receiptId);
  if (existsSync(path)) {
    const existing = readCompressionReceiptPointer(owner, receiptId);
    if (existing?.batch_id === batchId) return;
    throw Object.assign(new Error("压缩回执指针已存在"), { code: "EEXIST" });
  }
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(JSON.stringify({ owner, receipt_id: receiptId, batch_id: batchId })));
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      /* 独占创建失败时不留下半截指针 */
    }
    throw err;
  }
  closeSync(fd);
}

export function readCompressionReceiptPointer(
  owner: string,
  receiptId: string,
): { owner: string; receipt_id: string; batch_id: string } | null {
  const path = pointerPath(owner, receiptId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      owner?: string;
      receipt_id?: string;
      batch_id?: string;
    };
    if (parsed.owner !== owner || parsed.receipt_id !== receiptId || !parsed.batch_id || !isTid(parsed.batch_id)) {
      return null;
    }
    return { owner, receipt_id: receiptId, batch_id: parsed.batch_id };
  } catch {
    return null;
  }
}

export function removeCompressionReceiptPointer(owner: string, receiptId: string): void {
  try {
    unlinkSync(pointerPath(owner, receiptId));
  } catch {
    /* 已经没有指针 */
  }
}

export function findCompressionByReceipt(owner: string, receiptId: string): CompressionBatchRecord | null {
  const pointer = readCompressionReceiptPointer(owner, receiptId);
  if (pointer) {
    const batch = readCompressionBatch(pointer.batch_id);
    if (batch && batch.owner_id === owner && batch.source_receipt === receiptId && !compressionHasTombstone(batch.id)) {
      return batch;
    }
  }
  for (const batch of compressionStoreSnapshot().batches) {
    if (batch.owner_id === owner && batch.source_receipt === receiptId) return batch;
  }
  return null;
}

export function compressionReceiptPersisted(receiptId: string, owner: string): boolean {
  if (findCompressionByReceipt(owner, receiptId)) return true;
  const pointer = readCompressionReceiptPointer(owner, receiptId);
  return Boolean(pointer && compressionManifestExists(pointer.batch_id));
}

export function removeCompressionWorkdir(id: string): void {
  if (!isTid(id)) return;
  rmSync(compressionBatchDir(id), { recursive: true, force: true });
}

export function writeCompressionTombstone(id: string, ownerId: string): void {
  atomicWriteJson(compressionTombstonePath(id), { id, owner_id: ownerId, deleted_at: nowIso() });
}

export function publishCompressionBytes(id: string, fileId: string, source: "copy" | string): number {
  const dest = compressionOutputPath(id, fileId);
  mkdirSync(dirname(dest), { recursive: true });
  const from = source === "copy" ? compressionSourcePath(id, fileId) : source;
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  copyFileSync(from, tmp);
  const bytes = statSync(tmp).size;
  try {
    (renameHook || renameSync)(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 已发布的旧结果保持不变 */
    }
    throw err;
  }
  return bytes;
}

export function discardCompressionOutput(id: string, fileId: string): void {
  try {
    unlinkSync(compressionOutputPath(id, fileId));
  } catch {
    /* 没有结果可删 */
  }
}

function leasePath(batchId: string, token: string): string {
  return join(leaseRoot(), batchId, `${token}.json`);
}

export function writeCompressionLease(lease: CompressionLease): void {
  if (!isTid(lease.batch_id) || !/^[a-f0-9]{32}$/.test(lease.token)) throw new Error("下载租约不正确");
  atomicWriteJson(leasePath(lease.batch_id, lease.token), lease);
}

export function readCompressionLeases(): CompressionLease[] {
  const root = leaseRoot();
  const found: CompressionLease[] = [];
  let batches: string[] = [];
  try {
    batches = readdirSync(root);
  } catch {
    return found;
  }
  for (const batchId of batches) {
    if (!isTid(batchId)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(join(root, batchId));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const lease = JSON.parse(readFileSync(join(root, batchId, name), "utf8")) as CompressionLease;
        if (lease.batch_id === batchId && lease.token && lease.owner_id && lease.pid) found.push(lease);
      } catch {
        /* 损坏租约在清扫时删除 */
      }
    }
  }
  return found;
}

export function removeCompressionLease(batchId: string, token: string): void {
  try {
    unlinkSync(leasePath(batchId, token));
  } catch {
    /* 租约已经结束 */
  }
}

export function defaultCompressionFingerprint(): string {
  return compressionPolicyFingerprint();
}

function usageOf(owner: string): { global: SourceUsage; owner: SourceUsage } {
  const snapshot = compressionStoreSnapshot();
  const blockedBytes = snapshot.unreadable * COMPRESSION_MAX_FILE_BYTES;
  const global: SourceUsage = { count: snapshot.unreadable, bytes: blockedBytes };
  const mine: SourceUsage = { count: snapshot.unreadable, bytes: blockedBytes };
  for (const batch of snapshot.batches) {
    if (batch.status !== "queued" && batch.status !== "running") continue;
    const bytes = batch.files.reduce((sum, file) => sum + file.input_bytes, 0);
    global.count += 1;
    global.bytes += bytes;
    if (batch.owner_id === owner) {
      mine.count += 1;
      mine.bytes += bytes;
    }
  }
  return { global, owner: mine };
}

registerSourceUsageProvider(() => {
  let cachedOwner = "";
  let cached = usageOf("");
  return {
    global: cached.global,
    owner(owner: string) {
      if (owner !== cachedOwner) {
        cachedOwner = owner;
        cached = usageOf(owner);
      }
      return cached.owner;
    },
  };
});

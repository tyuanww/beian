import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { legacyGenerationReadBusy, openRenderGenerationFile } from "./jobs.js";
import { fileOf, mockupJobDir, readMockupFromDisk, type MockupJob } from "./mockup.js";
import { studioLegacyVersion, studioStillPng, studioStillSelection } from "./studioStillDelivery.js";

const ID = /^[a-f0-9]{64}$/;
const STAGE_FILE = /^([a-f0-9]{64})\.(?:json|png)\.tmp$/;
const OUTPUT_FILE = /^([a-f0-9]{64})\.([a-f0-9]{64})\.png$/;
const MAX_EXPORTS_PER_JOB = 16;
const MAX_QUEUED_EXPORTS = 8;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PNG_BYTES = 128 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW || 0;

type Selection = ReturnType<typeof studioStillSelection>;
type FrozenSelection = Omit<Selection, "generationId" | "legacyVersion"> & {
  source: { kind: "generation" | "legacy"; value: string };
};
type BaseRecord = { id: string; owner: string; name: string; createdAt: string; updatedAt: string; selection: FrozenSelection };
type ImageRecord = { sha256: string; bytes: number; mtimeMs: number };
type RecordOnDisk = BaseRecord & ({ status: "ready"; image: ImageRecord } | { status: "preparing" | "failed" });

export class StudioDownloadError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 503, readonly reason: string, message: string) {
    super(message);
  }
}

function invalid() {
  return new StudioDownloadError(400, "payload_invalid", "成片下载参数无效");
}

function missing() {
  return new StudioDownloadError(404, "studio_download_missing", "没有这份成片下载");
}

function changed() {
  return new StudioDownloadError(409, "current_changed", "当前版本已变化，请刷新后重试");
}

function unavailable() {
  return new StudioDownloadError(503, "studio_download_unavailable", "成片暂时无法下载，请重试");
}

function freezeSelection(job: MockupJob, input: Selection): FrozenSelection {
  const { generationId, legacyVersion: requestedLegacy, ...appearance } = input;
  const pinned = generationId ?? (requestedLegacy === undefined ? job.current_render_generation_id : undefined);
  const value = pinned ?? requestedLegacy ?? studioLegacyVersion(job);
  if (!value) throw changed();
  return { ...appearance, source: { kind: pinned ? "generation" : "legacy", value } };
}

function checkLegacySource(job: MockupJob, selection: FrozenSelection): void {
  if (selection.source.kind !== "legacy") return;
  if (job.current_render_generation_id || studioLegacyVersion(job) !== selection.source.value) throw changed();
  if (legacyGenerationReadBusy(job)) {
    throw new StudioDownloadError(409, "mutation_busy", "这单正在更新，请稍后再试");
  }
}

function selectionFromFields(body: Record<string, unknown>): Selection {
  const query = new URLSearchParams();
  for (const key of ["backdrop", "layer", "generation_id", "generation"]) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value || value.length > 128) throw invalid();
    query.set(key, value);
  }
  for (const key of ["product_light", "background_light"]) {
    const value = body[key];
    if (typeof value !== "string" && typeof value !== "number") throw invalid();
    query.set(key, String(value));
  }
  if (typeof body.file_key !== "string") throw invalid();
  try { return studioStillSelection(body.file_key, query); }
  catch { throw invalid(); }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function readDate(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function recordId(jobId: string, owner: string, selection: FrozenSelection) {
  const { key, backdrop, layer, productLight, backgroundLight, source } = selection;
  return createHash("sha256").update(JSON.stringify([
    "studio-download/1", jobId, owner, source.kind, source.value, key, backdrop, layer,
    productLight, backgroundLight,
  ])).digest("hex");
}

function fields(selection: FrozenSelection) {
  return {
    file_key: selection.key, backdrop: selection.backdrop, layer: selection.layer,
    product_light: selection.productLight, background_light: selection.backgroundLight,
  };
}

function attachmentName(value: unknown, key: FrozenSelection["key"]): string {
  if (typeof value === "string" && value.length <= 255 && /^[^/\\\x00-\x1f\x7f]+\.png$/i.test(value)) return value;
  return key === "white_a" ? "front_right.png" : "back_left.png";
}

function parseRecord(jobId: string, id: string, value: unknown): RecordOnDisk {
  const raw = asObject(value);
  const createdAt = readDate(raw?.created_at);
  const updatedAt = readDate(raw?.updated_at);
  if (!raw || raw.schema !== "studio-download/1" || typeof raw.owner !== "string" || !raw.owner
      || !createdAt || !updatedAt || (raw.generation_id === undefined) === (raw.generation === undefined)) {
    throw unavailable();
  }
  const { generationId, legacyVersion: legacy, ...appearance } = selectionFromFields(raw);
  const source = generationId ? { kind: "generation" as const, value: generationId }
    : legacy ? { kind: "legacy" as const, value: legacy } : null;
  if (!source) throw unavailable();
  const selection = { ...appearance, source };
  if (recordId(jobId, raw.owner, selection) !== id) throw unavailable();
  const base = { id, owner: raw.owner, name: attachmentName(raw.name, selection.key), createdAt, updatedAt, selection };
  if (raw.status === "preparing" || raw.status === "failed") return { ...base, status: raw.status };
  const image = asObject(raw.image);
  if (raw.status === "ready" && image && typeof image.sha256 === "string" && ID.test(image.sha256)
      && typeof image.bytes === "number" && Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= MAX_PNG_BYTES
      && typeof image.mtimeMs === "number" && Number.isFinite(image.mtimeMs)) {
    return { ...base, status: "ready", image: { sha256: image.sha256, bytes: image.bytes, mtimeMs: image.mtimeMs } };
  }
  throw unavailable();
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function unlinkIfPossible(path: string) {
  try { unlinkSync(path); return true; }
  catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    return false;
  }
}

function directory(jobId: string, create: boolean): string | null {
  const root = mockupJobDir(jobId);
  const dir = join(root, ".studio-downloads");
  try {
    if (!lstatSync(dirname(root)).isDirectory() || !lstatSync(root).isDirectory()) throw unavailable();
    if (create) {
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    }
    if (!lstatSync(dir).isDirectory()) throw unavailable();
    return dir;
  } catch (error) {
    if (errorCode(error) === "ENOENT" && !create) return null;
    throw error;
  }
}

function openRegularFile(path: string, maxBytes: number) {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) throw unavailable();
  const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.nlink !== 1
        || st.size !== before.size || st.mtimeMs !== before.mtimeMs) throw unavailable();
    return { fd, st };
  } catch (error) { closeSync(fd); throw error; }
}

function readRecord(jobId: string, dir: string, id: string): RecordOnDisk | null {
  try {
    const { fd } = openRegularFile(join(dir, `${id}.json`), 4096);
    try { return parseRecord(jobId, id, JSON.parse(readFileSync(fd, "utf8"))); }
    finally { closeSync(fd); }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw unavailable();
  }
}

function flushDirectory(dir: string) {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); }
    finally { closeSync(fd); }
  } catch { /* Visibility already committed. Directory flush is best effort. */ }
}

function writeRecord(dir: string, record: RecordOnDisk) {
  const { id, owner, name, createdAt, updatedAt, selection, status } = record;
  const dest = join(dir, `${id}.json`);
  const temp = `${dest}.tmp`;
  const input = {
    schema: "studio-download/1", owner, name, created_at: createdAt, updated_at: updatedAt, status,
    ...fields(selection),
    [selection.source.kind === "generation" ? "generation_id" : "generation"]: selection.source.value,
    ...(record.status === "ready" ? { image: record.image } : {}),
  };
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(input)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, dest);
    flushDirectory(dir);
  } finally { unlinkIfPossible(temp); }
}

function pngPath(dir: string, id: string, sha256: string) {
  return join(dir, `${id}.${sha256}.png`);
}

function publicRecord(jobId: string, record: RecordOnDisk) {
  return {
    id: record.id, status: record.status, created_at: record.createdAt,
    ...fields(record.selection), generation: record.selection.source.value,
    ...(record.status === "ready" ? { download_url: `/api/mockups/${jobId}/studio-downloads/${record.id}/file` } : {}),
  };
}

// 8787 is the single writer. The map reserves a slot before any async work,
// and the worker closes its exclusive file before publishing it in place.
const scheduled = new Set<string>();
const readers = new Map<string, number>();
let queue = Promise.resolve();

function cleanupStages(dir: string, names: string[]) {
  for (const name of names) {
    const match = STAGE_FILE.exec(name);
    if (match && !scheduled.has(match[1])) unlinkIfPossible(join(dir, name));
  }
}

function imageRecord(dir: string, id: string, digest: string): ImageRecord {
  const { fd, st } = openRegularFile(pngPath(dir, id, digest), MAX_PNG_BYTES);
  closeSync(fd);
  return { sha256: digest, bytes: st.size, mtimeMs: st.mtimeMs };
}

function reconcileImage(dir: string, record: RecordOnDisk, names: string[]): RecordOnDisk {
  if (record.status === "ready" || scheduled.has(record.id)) return record;
  const image = names.map(name => OUTPUT_FILE.exec(name)).find(match => match?.[1] === record.id);
  if (!image) return record;
  // The PNG name contains the SHA-256 computed before its atomic publication.
  // Recover a process exit between that rename and the metadata rename.
  const recovered = imageRecord(dir, record.id, image[2]);
  const ready = { ...record, status: "ready" as const, image: recovered, updatedAt: new Date(recovered.mtimeMs).toISOString() };
  try { writeRecord(dir, ready); } catch { /* The immutable PNG remains available. */ }
  return ready;
}

function expired(record: RecordOnDisk) {
  return Date.now() - Date.parse(record.updatedAt) >= RETENTION_MS;
}

function dropExpired(dir: string, record: RecordOnDisk) {
  if (scheduled.has(record.id) || readers.has(record.id)) return false;
  if (record.status === "ready" && !unlinkIfPossible(pngPath(dir, record.id, record.image.sha256))) return false;
  return unlinkIfPossible(join(dir, `${record.id}.json`));
}

function recordsIn(jobId: string, dir: string) {
  const names = readdirSync(dir);
  cleanupStages(dir, names);
  const records: RecordOnDisk[] = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    if (!name.endsWith(".json") || !ID.test(id)) continue;
    const record = readRecord(jobId, dir, id);
    if (!record) continue;
    const current = reconcileImage(dir, record, names);
    if (!expired(current) || !dropExpired(dir, current)) records.push(current);
  }
  return records;
}

async function publishImage(dir: string, id: string, bytes: Buffer, beforePublish: () => void) {
  if (!bytes.length || bytes.length > MAX_PNG_BYTES) throw unavailable();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stage = join(dir, `${id}.png.tmp`);
  const fd = await open(stage, "wx", 0o600);
  try {
    try { await fd.writeFile(bytes); await fd.sync(); }
    finally { await fd.close(); }
    beforePublish();
    const dest = pngPath(dir, id, sha256);
    // No writer crosses this publication point twice. No mkdir on retry if the
    // mockup was deleted while encoding or writing its staging file.
    try { return imageRecord(dir, id, sha256); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    renameSync(stage, dest);
    flushDirectory(dir);
    return imageRecord(dir, id, sha256);
  } finally { unlinkIfPossible(stage); }
}

async function render(jobId: string, dir: string, record: RecordOnDisk) {
  const job = readMockupFromDisk(jobId);
  if (!job || directory(jobId, false) !== dir) return;
  try {
    const { source, ...appearance } = record.selection;
    checkLegacySource(job, record.selection);
    const file = await studioStillPng(job, {
      ...appearance,
      ...(source.kind === "generation" ? { generationId: source.value } : { legacyVersion: source.value }),
    }, openRenderGenerationFile);
    const image = await publishImage(dir, record.id, file.bytes, () => {
      const latest = readMockupFromDisk(jobId);
      if (!latest || directory(jobId, false) !== dir) throw missing();
      if (readRecord(jobId, dir, record.id)?.status !== "preparing") throw unavailable();
      checkLegacySource(latest, record.selection);
    });
    writeRecord(dir, { ...record, status: "ready", image, updatedAt: new Date().toISOString() });
  } catch (error) {
    // If PNG publication already succeeded, the status reader will recover it.
    if (!readMockupFromDisk(jobId)) return;
    console.warn("studio download failed", { jobId, exportId: record.id,
      cause: error instanceof StudioDownloadError ? error.reason : errorCode(error) ?? "compose_or_persist_failed",
      fix: "retry the same frozen selection" });
    try { writeRecord(dir, { ...record, status: "failed", updatedAt: new Date().toISOString() }); }
    catch { /* A preparing record can resume when the owner returns. */ }
  }
}

function schedule(jobId: string, dir: string, record: RecordOnDisk) {
  if (scheduled.has(record.id) || scheduled.size >= MAX_QUEUED_EXPORTS) return;
  scheduled.add(record.id);
  queue = queue.then(async () => {
    // Send the creation response before hashing, decoding or composing images.
    await new Promise<void>(resolve => setImmediate(resolve));
    await render(jobId, dir, record);
  }).catch(() => {
    console.warn("studio download worker could not open its job directory", { jobId, exportId: record.id });
  }).finally(() => scheduled.delete(record.id));
}

export function startStudioDownload(jobId: string, owner: string, body: Record<string, unknown>) {
  const job = readMockupFromDisk(jobId);
  if (!job) throw missing();
  const selection = freezeSelection(job, selectionFromFields(body));
  const id = recordId(job.id, owner, selection);
  let dir = directory(job.id, false);
  const records = dir ? recordsIn(job.id, dir) : [];
  const existing = records.find(record => record.id === id && record.owner === owner);
  if (existing && expired(existing)) {
    throw new StudioDownloadError(429, "studio_download_busy", "这份成片正在清理，请稍后重试");
  }
  if (existing && existing.status !== "failed") {
    if (dir && existing.status === "preparing") schedule(job.id, dir, existing);
    return publicRecord(job.id, existing);
  }
  checkLegacySource(job, selection);
  if (!existing && records.length >= MAX_EXPORTS_PER_JOB) {
    throw new StudioDownloadError(429, "studio_download_capacity", "这单的成片下载已满，请使用已有成片");
  }
  if (scheduled.size >= MAX_QUEUED_EXPORTS) {
    throw new StudioDownloadError(429, "studio_download_busy", "正在准备其他成片，请稍后重试");
  }
  dir ??= directory(job.id, true);
  if (!dir) throw unavailable();
  const now = new Date().toISOString();
  const name = existing?.name ?? attachmentName(fileOf(job, selection.key)?.name, selection.key);
  const pending = { id, owner, name, createdAt: existing?.createdAt ?? now, updatedAt: now, selection, status: "preparing" as const };
  writeRecord(dir, pending);
  schedule(job.id, dir, pending);
  return publicRecord(job.id, pending);
}

export function listStudioDownloads(jobId: string, owner: string) {
  const dir = directory(jobId, false);
  if (!dir) return [];
  const records = recordsIn(jobId, dir).filter(record => record.owner === owner && !expired(record))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const record of records) {
    if (record.status === "preparing") schedule(jobId, dir, record);
  }
  return records.reverse().map(record => publicRecord(jobId, record));
}

export function openStudioDownload(jobId: string, owner: string, id: string) {
  if (!ID.test(id)) throw missing();
  const dir = directory(jobId, false);
  if (!dir) throw missing();
  const found = readRecord(jobId, dir, id);
  if (!found || found.owner !== owner) throw missing();
  const record = found.status === "ready" ? found : reconcileImage(dir, found, readdirSync(dir));
  if (expired(record)) {
    dropExpired(dir, record);
    throw missing();
  }
  if (record.status !== "ready") throw missing();
  try {
    const { fd, st } = openRegularFile(pngPath(dir, id, record.image.sha256), MAX_PNG_BYTES);
    if (st.size !== record.image.bytes || st.mtimeMs !== record.image.mtimeMs) {
      closeSync(fd);
      throw unavailable();
    }
    readers.set(id, (readers.get(id) ?? 0) + 1);
    let closed = false;
    return {
      fd, ...record.image,
      name: record.name,
      close: () => {
        if (closed) return;
        closed = true;
        try { closeSync(fd); }
        finally {
          const remaining = (readers.get(id) ?? 1) - 1;
          if (remaining) readers.set(id, remaining);
          else readers.delete(id);
        }
      },
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw missing();
    throw error;
  }
}

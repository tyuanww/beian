import { createReadStream, openSync, readSync, closeSync } from "node:fs";
import { Readable } from "node:stream";
import type { Context } from "hono";
import type { Session } from "./auth.js";
import { compressionProblem, type PublicCompressionBatch } from "./compressionModel.js";
import {
  COMPRESSION_GLOBAL_ACTIVE,
  COMPRESSION_GLOBAL_SOURCE_BYTES,
  COMPRESSION_MAX_BATCH_BYTES,
  COMPRESSION_MAX_FILE_BYTES,
  COMPRESSION_MAX_FILES,
  COMPRESSION_OWNER_ACTIVE,
  COMPRESSION_OWNER_SOURCE_BYTES,
  COMPRESSION_REQUIRED_FREE_BYTES,
  compressionFileReady,
  compressionMagic,
  defaultCompressionTitle,
  isCompressionAssetField,
  isCompressionFileKey,
  type CompressionMediaType,
} from "./compressionPolicy.js";
import { assessCapability } from "./compressionProbe.js";
import { additionalSourceUsage } from "./sourceQuota.js";
import { compressionZipStream } from "./compressionZip.js";
import {
  acquireCompressionLease,
  releaseCompressionLease,
  toPublicCompression,
} from "./compressionRuntime.js";
import {
  compressionHasTombstone,
  compressionManifestExists,
  compressionOutputPath,
  compressionStoreSnapshot,
  createQueuedCompression,
  findCompressionByReceipt,
  freezeCompressionSources,
  newCompressionId,
  readCompressionBatch,
  readCompressionReceiptPointer,
  removeCompressionReceiptPointer,
  removeCompressionWorkdir,
  writeCompressionReceiptPointer,
} from "./compressionStore.js";
import { enqueueCompression, removeCompression, retryCompression } from "./jobs.js";
import { isTid, viewerFromSession } from "./tasks.js";
import {
  claimReceipt,
  commitReceiptClaim,
  loadReceipt,
  receiptOwner,
  rollbackReceiptClaim,
  serializeReceiptStart,
  sourceReservation,
  type UploadReceipt,
} from "./uploads.js";

type CompressionContext = Context<{ Variables: { session: Session } }>;

type CompressionApp = {
  post(path: string, handler: (c: CompressionContext) => Response | Promise<Response>): void;
  get(path: string, handler: (c: CompressionContext) => Response | Promise<Response>): void;
  delete(path: string, handler: (c: CompressionContext) => Response | Promise<Response>): void;
};

let startFault: "after-pointer" | null = null;

export function setCompressionStartFaultForTest(fault: "after-pointer" | null): void {
  if (process.env.VITEST !== "1") throw new Error("压缩开工测试钩子只能在 VITEST 使用");
  startFault = fault;
}

function readPrefix(path: string): Buffer {
  const buf = Buffer.alloc(16);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytes);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertRoom(owner: string, exceptReceiptId: string, incomingBytes: number): void {
  const reserved = sourceReservation(owner, exceptReceiptId);
  const extra = additionalSourceUsage(owner);
  if (reserved.ownerCount + extra.ownerCount >= COMPRESSION_OWNER_ACTIVE) {
    throw compressionProblem("compression_source_quota");
  }
  if (reserved.ownerBytes + extra.ownerBytes + incomingBytes > COMPRESSION_OWNER_SOURCE_BYTES) {
    throw compressionProblem("compression_source_quota");
  }
  if (reserved.globalCount + extra.globalCount >= COMPRESSION_GLOBAL_ACTIVE) {
    throw compressionProblem("compression_source_quota");
  }
  if (reserved.globalBytes + extra.globalBytes + incomingBytes > COMPRESSION_GLOBAL_SOURCE_BYTES) {
    throw compressionProblem("compression_source_quota");
  }
}

function compressionFiles(receipt: UploadReceipt): Array<{
  id: string;
  name: string;
  media_type: CompressionMediaType;
  path: string;
}> {
  if (!receipt.files.length || receipt.files.length > COMPRESSION_MAX_FILES) {
    throw compressionProblem("compression_receipt_invalid");
  }
  let total = 0;
  return receipt.files.map((file) => {
    if (!isCompressionAssetField(file.field) || !file.path) throw compressionProblem("compression_receipt_invalid");
    const media = compressionMedia(compressionMagic(file.name, readPrefix(file.path)));
    if (!media) throw compressionProblem("compression_receipt_invalid");
    if (file.bytes <= 0 || file.bytes > COMPRESSION_MAX_FILE_BYTES) throw compressionProblem("compression_receipt_invalid");
    total += file.bytes;
    if (total > COMPRESSION_MAX_BATCH_BYTES) throw compressionProblem("compression_receipt_invalid");
    return { id: file.field, name: file.name, media_type: media, path: file.path };
  });
}

function compressionMedia(value: string): CompressionMediaType | null {
  if (value === "application/pdf" || value === "image/jpeg" || value === "image/png" || value === "image/webp") return value;
  return null;
}

function titleOf(raw: unknown, names: string[]): string {
  if (raw == null || raw === "") return defaultCompressionTitle(names);
  if (typeof raw !== "string") throw compressionProblem("compression_query_invalid");
  const title = raw.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
  return title || defaultCompressionTitle(names);
}

export async function startCompression(
  session: Session,
  body: { receipt?: unknown; title?: unknown },
  draining: boolean,
): Promise<{ status: 200 | 202; batch: PublicCompressionBatch }> {
  if (draining) throw compressionProblem("compression_draining");
  const receiptId = String(body?.receipt || "");
  if (!isTid(receiptId)) throw compressionProblem("compression_query_invalid");
  const owner = receiptOwner(session);
  const viewer = viewerFromSession(session);
  return serializeReceiptStart(receiptId, owner, async () => {
    const existing = findCompressionByReceipt(owner, receiptId);
    if (existing) return { status: 200 as const, batch: toPublicCompression(existing, viewer) };
    const pointer = readCompressionReceiptPointer(owner, receiptId);
    if (pointer && !compressionManifestExists(pointer.batch_id)) {
      removeCompressionReceiptPointer(owner, receiptId);
    } else if (pointer) {
      throw compressionProblem("compression_record_unreadable");
    }
    const receipt = loadReceipt(receiptId, owner);
    if (!receipt) throw compressionProblem("upload_receipt_expired");
    const files = compressionFiles(receipt);
    assertRoom(owner, receiptId, files.reduce((sum, file) => sum + (receipt.files.find((item) => item.field === file.id)?.bytes || 0), 0));
    const capability = assessCapability();
    if (capability.budget !== "enforced") throw compressionProblem("platform_budget_unavailable");
    if (capability.diskFreeBytes < COMPRESSION_REQUIRED_FREE_BYTES) throw compressionProblem("disk_space");
    if (files.some((file) => !compressionFileReady(file.media_type, capability))) {
      throw compressionProblem("dependency_missing");
    }
    const claim = claimReceipt(receiptId, owner);
    if (!claim) throw compressionProblem("upload_receipt_expired");
    const id = newCompressionId();
    try {
      const frozen = freezeCompressionSources(id, files);
      writeCompressionReceiptPointer(owner, receiptId, id);
      if (startFault === "after-pointer") throw new Error("compression start fault");
      createQueuedCompression({
        id,
        title: titleOf(body.title, files.map((file) => file.name)),
        ownerId: owner,
        createdBy: viewer.name || owner,
        receiptId,
        files: frozen,
        policyFingerprint: capability.policyFingerprint,
        toolGeneration: capability.toolGeneration,
      });
    } catch (err) {
      const written = readCompressionReceiptPointer(owner, receiptId);
      if (!written || written.batch_id === id) removeCompressionReceiptPointer(owner, receiptId);
      removeCompressionWorkdir(id);
      rollbackReceiptClaim(claim);
      throw err;
    }
    commitReceiptClaim(claim);
    enqueueCompression(id);
    const saved = readCompressionBatch(id);
    if (!saved) throw compressionProblem("compression_not_found");
    return { status: 202 as const, batch: toPublicCompression(saved, viewer) };
  });
}

function param(c: CompressionContext, name: string): string {
  return c.req.param(name) || "";
}

function visibleBatch(id: string): ReturnType<typeof readCompressionBatch> {
  if (!isTid(id) || compressionHasTombstone(id)) return null;
  const batch = readCompressionBatch(id);
  if (!batch && compressionManifestExists(id)) throw compressionProblem("compression_record_unreadable");
  return batch;
}

function zipEntryName(name: string, used: Set<string>): string {
  const clean = name.replace(/[\\/\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let index = 2;
  while (used.has(`${stem} (${index})${ext}`)) index += 1;
  const unique = `${stem} (${index})${ext}`;
  used.add(unique);
  return unique;
}

export function registerCompressionRoutes(
  app: CompressionApp,
  deps: { need: (c: CompressionContext, perm: string) => Session; draining: () => boolean },
): void {
  app.post("/api/compressions/start", async (c) => {
    const session = deps.need(c, "create");
    const body = await c.req.json().catch(() => {
      throw compressionProblem("compression_query_invalid");
    }) as { receipt?: unknown; title?: unknown };
    const started = await startCompression(session, body, deps.draining());
    return c.json(started.batch, started.status);
  });

  app.get("/api/compressions", (c) => {
    const session = deps.need(c, "read");
    const viewer = viewerFromSession(session);
    const snapshot = compressionStoreSnapshot();
    if (snapshot.unreadable > 0) throw compressionProblem("compression_record_unreadable");
    const items = snapshot.batches
      .filter((batch) => !compressionHasTombstone(batch.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((batch) => toPublicCompression(batch, viewer));
    return c.json({ items });
  });

  app.get("/api/compressions/:id", (c) => {
    const session = deps.need(c, "read");
    const batch = visibleBatch(param(c, "id"));
    if (!batch) throw compressionProblem("compression_not_found");
    return c.json(toPublicCompression(batch, viewerFromSession(session)));
  });

  app.post("/api/compressions/:id/retry", async (c) => {
    const session = deps.need(c, "create");
    if (deps.draining()) throw compressionProblem("compression_draining");
    const id = param(c, "id");
    const batch = visibleBatch(id);
    if (!batch) throw compressionProblem("compression_not_found");
    const viewer = viewerFromSession(session);
    if (!viewer.admin && viewer.id !== batch.owner_id) throw compressionProblem("compression_forbidden");
    const body = await c.req.json().catch(() => {
      throw compressionProblem("compression_query_invalid");
    }) as { expected_revision?: unknown; file_ids?: unknown };
    if (body.file_ids != null && (!Array.isArray(body.file_ids) || body.file_ids.some((item) => typeof item !== "string"))) {
      throw compressionProblem("compression_query_invalid");
    }
    const result = retryCompression(
      id,
      Number(body.expected_revision),
      body.file_ids as string[] | undefined,
    );
    return c.json(toPublicCompression(result.batch, viewer), result.replay ? 200 : 202);
  });

  app.get("/api/compressions/:id/files/:key", (c) => {
    const session = deps.need(c, "export");
    if (deps.draining()) throw compressionProblem("compression_draining");
    const id = param(c, "id");
    const key = param(c, "key");
    const batch = visibleBatch(id);
    if (!batch || !isCompressionFileKey(key)) throw compressionProblem("compression_not_found");
    const file = batch.files.find((item) => `file-${item.id}` === key);
    if (!file || file.output_bytes == null || (file.status !== "succeeded" && file.status !== "passthrough")) {
      throw compressionProblem("compression_file_missing");
    }
    const path = compressionOutputPath(id, file.id);
    const lease = acquireCompressionLease(id, viewerFromSession(session).id);
    const stream = createReadStream(path);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseCompressionLease(lease);
    };
    stream.once("close", release);
    stream.once("error", release);
    c.header("content-type", file.media_type);
    c.header("content-length", String(file.output_bytes));
    c.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(Readable.toWeb(stream) as ReadableStream);
  });

  app.get("/api/compressions/:id/zip", (c) => {
    const session = deps.need(c, "export");
    if (deps.draining()) throw compressionProblem("compression_draining");
    const id = param(c, "id");
    const batch = visibleBatch(id);
    if (!batch) throw compressionProblem("compression_not_found");
    if (batch.status === "queued" || batch.status === "running") throw compressionProblem("compression_not_terminal");
    const used = new Set<string>();
    const entries = batch.files.filter((file) => file.status === "succeeded" || file.status === "passthrough").map((file) => ({
      name: zipEntryName(file.name, used),
      path: compressionOutputPath(id, file.id),
    }));
    if (!entries.length) throw compressionProblem("compression_zip_empty");
    const lease = acquireCompressionLease(id, viewerFromSession(session).id);
    const stream = compressionZipStream(entries);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseCompressionLease(lease);
    };
    stream.once("close", release);
    stream.once("error", release);
    c.header("content-type", "application/zip");
    c.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${batch.title || "compression"}.zip`)}`);
    return c.body(Readable.toWeb(stream) as ReadableStream);
  });

  app.delete("/api/compressions/:id", (c) => {
    const session = deps.need(c, "delete");
    const id = param(c, "id");
    const batch = readCompressionBatch(id);
    if (!batch && compressionManifestExists(id)) throw compressionProblem("compression_record_unreadable");
    if (batch && !viewerFromSession(session).admin && viewerFromSession(session).id !== batch.owner_id) {
      throw compressionProblem("compression_forbidden");
    }
    if (!batch && !compressionHasTombstone(id)) throw compressionProblem("compression_not_found");
    const removed = removeCompression(id);
    return c.json(removed.body, removed.status);
  });
}

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Public reason codes. Chinese copy is the HTTP message, not a second field. */
const UNFOLDED_REASON = {
  source_missing: "source_missing",
  geometry_incomplete: "geometry_incomplete",
  separation_unreliable: "separation_unreliable",
  host_unavailable: "host_unavailable",
  source_changed: "source_changed",
  close_unconfirmed: "close_unconfirmed",
  export_failed: "export_failed",
  busy: "busy",
} as const;

export type UnfoldedReason = (typeof UNFOLDED_REASON)[keyof typeof UNFOLDED_REASON];

export const UNFOLDED_MESSAGE: Record<UnfoldedReason, string> = {
  source_missing: "找不到这单的源稿，不能做净版展开。",
  geometry_incomplete: "展开几何不完整，不能确认粘口和封口。",
  separation_unreliable: "刀线、折线和印刷装饰无法可靠分开，不能按颜色猜测删除。",
  host_unavailable: "需要用 Illustrator 重新导出净版，但本机宿主现在不可用。",
  source_changed: "源稿已经变了，这份净版不再对应当前稿。",
  close_unconfirmed: "Illustrator 还没有确认关闭，净版先不算做好。",
  export_failed: "净版展开没有做成，请稍后再试。",
  busy: "这单还有别的打样动作，暂时不能做净版展开。",
};

export const UNFOLDED_PROTOCOL = "beian.illustrator.export/2";
const UNFOLDED_SOURCE_SCHEMA = "unfolded-print-source/1";
export const UNFOLDED_SOURCE_NAME = "unfolded-source.json";
export const UNFOLDED_PRINT_NAME = "unfolded-print.pdf";
const UNFOLDED_PRINT_KEY = "unfolded_print";
const PRINT_FACES_ZIP_KEY = "print_faces_zip";
export const UNFOLDED_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const UNFOLDED_BINARY_MAX_BYTES = 256 * 1024 * 1024;
export const PRINT_FACE_NAMES = ["front", "back", "left", "right", "top", "bottom"] as const;

const PUBLIC_STATUS_REASONS = new Set<string>([
  "source_missing",
  "geometry_incomplete",
  "separation_unreliable",
  "host_unavailable",
  "source_changed",
  "close_unconfirmed",
  "export_failed",
]);

export type UnfoldedPrintMode = "publish_existing" | "native_export";

export type UnfoldedPrintRequest = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  mode: UnfoldedPrintMode;
  created_at: string;
  actor_id: string;
  source_sha256: string;
  generation_id: string;
  native_source_sha256?: string;
  started_at?: string;
  finished_at?: string;
  worker_pid?: number;
  error?: string;
  reason?: string;
  host_fence?: "unconfirmed";
};

export type UnfoldedPrintAsset = {
  source_sha256: string;
  generation_id: string;
  width_mm: number;
  height_mm: number;
  file_name: "unfolded-print.pdf";
};

export type PublicUnfoldedPrint = {
  status: "unavailable" | "queued" | "running" | "ready" | "failed";
  reason?: string;
  file_key?: typeof UNFOLDED_PRINT_KEY;
  width_mm?: number;
  height_mm?: number;
};

export type PublicPrintFacesZip = {
  status: "unavailable" | "incomplete" | "ready";
  reason?: "faces_incomplete";
  file_key?: typeof PRINT_FACES_ZIP_KEY;
};

export class UnfoldedPrintHttpError extends Error {
  status: number;
  reason: string;
  unfolded_print: PublicUnfoldedPrint;

  constructor(status: number, reason: string, unfolded_print: PublicUnfoldedPrint) {
    super(UNFOLDED_MESSAGE[reason as UnfoldedReason] || UNFOLDED_MESSAGE.export_failed);
    this.status = status;
    this.reason = reason;
    this.unfolded_print = unfolded_print;
  }
}
export type UnfoldedSourcePlan =
  | { ok: true; mode: UnfoldedPrintMode; assembly: "semantic-net" | "attested-pdf" }
  | { ok: false; reason: "geometry_incomplete" | "separation_unreliable" };

const HELPER_ROLES = new Set(["cut", "crease", "dimension", "production"]);
const KEEP_ROLES = new Set(["print", "decoration"]);

export function readUnfoldedSourcePlan(text: string): UnfoldedSourcePlan {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "geometry_incomplete" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "geometry_incomplete" };
  }
  const record = payload as Record<string, unknown>;
  if (record.schema !== UNFOLDED_SOURCE_SCHEMA) return { ok: false, reason: "geometry_incomplete" };
  const requested = record.export === undefined ? "publish" : record.export;
  if (requested !== "publish" && requested !== "native") return { ok: false, reason: "geometry_incomplete" };
  const assembly = record.assembly;
  if (assembly !== "semantic-net" && assembly !== "attested-pdf") return { ok: false, reason: "geometry_incomplete" };
  if (requested === "native" && assembly !== "attested-pdf") return { ok: false, reason: "geometry_incomplete" };
  if (assembly === "semantic-net") {
    const separation = record.separation;
    if (!separation || typeof separation !== "object" || Array.isArray(separation)) {
      return { ok: false, reason: "separation_unreliable" };
    }
    const spec = separation as Record<string, unknown>;
    if (spec.method !== "semantic-identity" || !Array.isArray(spec.objects)) {
      return { ok: false, reason: "separation_unreliable" };
    }
    for (const item of spec.objects) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, reason: "separation_unreliable" };
      const role = (item as Record<string, unknown>).role;
      if (typeof role !== "string" || (!HELPER_ROLES.has(role) && !KEEP_ROLES.has(role))) {
        return { ok: false, reason: "separation_unreliable" };
      }
    }
  }
  return {
    ok: true,
    mode: requested === "native" ? "native_export" : "publish_existing",
    assembly,
  };
}

export function projectUnfoldedPrint(input: {
  request?: UnfoldedPrintRequest;
  asset?: UnfoldedPrintAsset;
  generationId: string;
  sourceSha256: string | null;
  pdfReady: boolean;
}): PublicUnfoldedPrint {
  const request = input.request;
  const generation = input.generationId || "";
  if (request?.status === "queued") return { status: "queued" };
  if (request?.status === "running") {
    if (request.mode === "native_export" && request.host_fence === "unconfirmed") {
      return { status: "running", reason: "close_unconfirmed" };
    }
    return { status: "running" };
  }
  const asset = input.asset;
  if (
    asset
    && input.pdfReady
    && asset.file_name === UNFOLDED_PRINT_NAME
    && asset.generation_id === generation
    && input.sourceSha256
    && asset.source_sha256 === input.sourceSha256
    && Number.isFinite(asset.width_mm)
    && asset.width_mm > 0
    && Number.isFinite(asset.height_mm)
    && asset.height_mm > 0
  ) {
    return {
      status: "ready",
      file_key: UNFOLDED_PRINT_KEY,
      width_mm: asset.width_mm,
      height_mm: asset.height_mm,
    };
  }
  if (request?.status === "failed") {
    const reason = request.reason && PUBLIC_STATUS_REASONS.has(request.reason) && request.reason !== "close_unconfirmed"
      ? request.reason
      : "export_failed";
    return { status: "failed", reason };
  }
  if (asset && !input.sourceSha256) return { status: "failed", reason: "source_missing" };
  if (asset && (asset.source_sha256 !== input.sourceSha256 || asset.generation_id !== generation)) {
    return { status: "failed", reason: "source_changed" };
  }
  return { status: "unavailable" };
}

export function projectPrintFacesZip(readyFaces: number): PublicPrintFacesZip {
  if (readyFaces === PRINT_FACE_NAMES.length) return { status: "ready", file_key: PRINT_FACES_ZIP_KEY };
  if (readyFaces > 0) return { status: "incomplete", reason: "faces_incomplete" };
  return { status: "unavailable" };
}

function knownUnfoldedReason(value: unknown): UnfoldedReason {
  const reason = typeof value === "string" ? value : "";
  if (reason === "busy" || !PUBLIC_STATUS_REASONS.has(reason)) return "export_failed";
  return reason as UnfoldedReason;
}

export function parseUnfoldedPublishStdout(stdout: string): { ok: true; width_mm: number; height_mm: number } | { ok: false; reason: UnfoldedReason } {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const width = value.width_mm;
    const height = value.height_mm;
    if (value.ok === true && typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { ok: true, width_mm: Math.round(width * 1000) / 1000, height_mm: Math.round(height * 1000) / 1000 };
    }
    return { ok: false, reason: knownUnfoldedReason(value.reason) };
  } catch {
    return { ok: false, reason: "export_failed" };
  }
}

export function sha256RegularFile(path: string, root: string, maxBytes: number): string | null {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  let size = 0;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) return null;
    size = stat.size;
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let read = 0;
    while (read < size) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      read += count;
    }
    if (read !== size) return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function pdfHeaderRegularFile(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 5) return false;
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(5);
    return readSync(fd, buffer, 0, 5, 0) === 5 && buffer.toString("ascii") === "%PDF-";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function unfoldedRequestRecordValid(request: UnfoldedPrintRequest, jobStatus: string): boolean {
  if (!/^[a-f0-9]{32}$/.test(request.id)) return false;
  if (!["queued", "running", "succeeded", "failed"].includes(request.status)) return false;
  if (request.mode !== "publish_existing" && request.mode !== "native_export") return false;
  if (typeof request.created_at !== "string" || typeof request.actor_id !== "string" || !request.actor_id) return false;
  if (!/^[a-f0-9]{64}$/.test(request.source_sha256)) return false;
  if (typeof request.generation_id !== "string" || request.generation_id.length > 128) return false;
  if (request.generation_id && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.generation_id)) return false;
  if (request.native_source_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(request.native_source_sha256)) return false;
  if (request.worker_pid !== undefined && (request.status !== "running" || !Number.isSafeInteger(request.worker_pid) || request.worker_pid <= 0)) {
    return false;
  }
  if (request.host_fence !== undefined && (request.host_fence !== "unconfirmed" || request.mode !== "native_export" || request.status !== "running")) {
    return false;
  }
  if (request.reason !== undefined && !PUBLIC_STATUS_REASONS.has(request.reason)) return false;
  if (request.reason === "close_unconfirmed" && request.status !== "running") return false;
  if ((request.status === "queued" || request.status === "running") && jobStatus !== "done") return false;
  if (request.error !== undefined && typeof request.error !== "string") return false;
  return true;
}

export function unfoldedAssetRecordValid(asset: UnfoldedPrintAsset): boolean {
  return /^[a-f0-9]{64}$/.test(asset.source_sha256)
    && typeof asset.generation_id === "string"
    && asset.generation_id.length <= 128
    && (asset.generation_id === "" || /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(asset.generation_id))
    && asset.file_name === UNFOLDED_PRINT_NAME
    && Number.isFinite(asset.width_mm)
    && asset.width_mm > 0
    && asset.width_mm < 10000
    && Number.isFinite(asset.height_mm)
    && asset.height_mm > 0
    && asset.height_mm < 10000;
}

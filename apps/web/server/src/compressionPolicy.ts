import { createHash } from "node:crypto";

/** 压缩策略 v1。版本字符串单独存在，不参与指纹；只改版本不能解锁重试。 */
export const COMPRESSION_POLICY_VERSION = "compression-policy-v1";
export const PDF_TARGET_BYTES = 10_000_000;
export const PDF_ESTIMATE_HEADROOM_BYTES = 9_800_000;
export const PDF_MAX_ROUNDS = 8;
export const PDF_MAX_MS = 5 * 60 * 1000;
export const PDF_MIN_QUALITY = 60;
export const PDF_MIN_DPI = 150;
export const PDF_QUALITY_LADDER = [95, 90, 85, 80, 75, 70, 60] as const;
export const QPDF_WARNING_ALLOWLIST_V1: readonly string[] = [];
export const COMPRESSION_MAX_FILES = 20;
export const COMPRESSION_MAX_BATCH_BYTES = 100 * 1024 * 1024;
export const COMPRESSION_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const COMPRESSION_OWNER_SOURCE_BYTES = 400 * 1024 * 1024;
export const COMPRESSION_GLOBAL_SOURCE_BYTES = 1024 * 1024 * 1024;
export const COMPRESSION_OWNER_ACTIVE = 8;
export const COMPRESSION_GLOBAL_ACTIVE = 64;
export const COMPRESSION_MAX_IMAGE_PIXELS = 32_000_000;
export const COMPRESSION_MAX_IMAGE_DECODE_BYTES = 128 * 1024 * 1024;
export const COMPRESSION_MAX_DECODE_STREAM_BYTES = 1024 * 1024 * 1024;
export const COMPRESSION_MAX_PDF_PAGES = 200;
export const COMPRESSION_MAX_PDF_OBJECTS = 100_000;
export const COMPRESSION_MAX_FORM_DEPTH = 32;
export const COMPRESSION_CONCURRENCY = 1;
export const COMPRESSION_JAVA_XMX_BYTES = 256 * 1024 * 1024;
export const COMPRESSION_RSS_BYTES = 768 * 1024 * 1024;
export const COMPRESSION_GROUP_RSS_BYTES = 1024 * 1024 * 1024;
export const COMPRESSION_ATTEMPT_DISK_BYTES = 2 * 1024 * 1024 * 1024;
export const COMPRESSION_CANDIDATE_BYTES = 128 * 1024 * 1024;
export const COMPRESSION_DISK_SAFETY_BYTES = 2 * 1024 * 1024 * 1024;
export const COMPRESSION_REQUIRED_FREE_BYTES =
  COMPRESSION_ATTEMPT_DISK_BYTES + COMPRESSION_DISK_SAFETY_BYTES;
export const COMPRESSION_DOWNLOADS_PER_OWNER = 2;
export const COMPRESSION_DOWNLOADS_GLOBAL = 4;
export const COMPRESSION_DOWNLOAD_IDLE_MS = 120_000;
export const COMPRESSION_DOWNLOAD_MAX_MS = 15 * 60 * 1000;
export const COMPRESSION_MAX_MANUAL_RETRIES = 3;
export const COMPRESSION_RETRY_INTERVAL_MS = 30_000;
/** 进程确认消失后的自动重排次数。不消耗人工重试，用尽后留下可人工重试的中断结果。 */
export const COMPRESSION_MAX_AUTO_REQUEUES = 3;

export const COMPRESSION_POLICY = {
  version: COMPRESSION_POLICY_VERSION,
  pdf_target_bytes: PDF_TARGET_BYTES,
  pdf_estimate_headroom_bytes: PDF_ESTIMATE_HEADROOM_BYTES,
  pdf_max_rounds: PDF_MAX_ROUNDS,
  pdf_max_ms: PDF_MAX_MS,
  pdf_min_quality: PDF_MIN_QUALITY,
  pdf_min_dpi: PDF_MIN_DPI,
  pdf_quality_ladder: PDF_QUALITY_LADDER,
  qpdf_warning_allowlist: QPDF_WARNING_ALLOWLIST_V1,
  max_files: COMPRESSION_MAX_FILES,
  max_batch_bytes: COMPRESSION_MAX_BATCH_BYTES,
  max_file_bytes: COMPRESSION_MAX_FILE_BYTES,
  owner_source_bytes: COMPRESSION_OWNER_SOURCE_BYTES,
  global_source_bytes: COMPRESSION_GLOBAL_SOURCE_BYTES,
  owner_active: COMPRESSION_OWNER_ACTIVE,
  global_active: COMPRESSION_GLOBAL_ACTIVE,
  max_image_pixels: COMPRESSION_MAX_IMAGE_PIXELS,
  max_image_decode_bytes: COMPRESSION_MAX_IMAGE_DECODE_BYTES,
  max_decode_stream_bytes: COMPRESSION_MAX_DECODE_STREAM_BYTES,
  max_pdf_pages: COMPRESSION_MAX_PDF_PAGES,
  max_pdf_objects: COMPRESSION_MAX_PDF_OBJECTS,
  max_form_depth: COMPRESSION_MAX_FORM_DEPTH,
  concurrency: COMPRESSION_CONCURRENCY,
  java_xmx_bytes: COMPRESSION_JAVA_XMX_BYTES,
  rss_bytes: COMPRESSION_RSS_BYTES,
  group_rss_bytes: COMPRESSION_GROUP_RSS_BYTES,
  attempt_disk_bytes: COMPRESSION_ATTEMPT_DISK_BYTES,
  candidate_bytes: COMPRESSION_CANDIDATE_BYTES,
  disk_safety_bytes: COMPRESSION_DISK_SAFETY_BYTES,
  required_free_bytes: COMPRESSION_REQUIRED_FREE_BYTES,
  downloads_per_owner: COMPRESSION_DOWNLOADS_PER_OWNER,
  downloads_global: COMPRESSION_DOWNLOADS_GLOBAL,
  download_idle_ms: COMPRESSION_DOWNLOAD_IDLE_MS,
  download_max_ms: COMPRESSION_DOWNLOAD_MAX_MS,
  max_manual_retries: COMPRESSION_MAX_MANUAL_RETRIES,
  retry_interval_ms: COMPRESSION_RETRY_INTERVAL_MS,
  max_auto_requeues: COMPRESSION_MAX_AUTO_REQUEUES,
} as const;

export function compressionPolicyFingerprint(
  policy: { version?: string } & Record<string, unknown> = COMPRESSION_POLICY,
): string {
  const limits = { ...policy };
  delete limits.version;
  return createHash("sha256").update(JSON.stringify(limits)).digest("hex");
}

export type CompressionMediaType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

export function isCompressionAssetField(field: string): boolean {
  return /^asset(?:[1-9]|1\d|20)$/.test(field);
}

export function compressionFileKey(fileId: string): string {
  return `file-${fileId}`;
}

export function isCompressionFileKey(key: string): boolean {
  return /^file-asset(?:[1-9]|1\d|20)$/.test(key);
}

/** 魔数和扩展名必须一致。动画或多帧不在这里判断。 */
export function compressionMagic(
  name: string,
  buf: Buffer,
): CompressionMediaType | string {
  const lower = name.toLowerCase();
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && /\.jpe?g$/.test(lower)) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a &&
    lower.endsWith(".png")
  ) {
    return "image/png";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP" &&
    lower.endsWith(".webp")
  ) {
    return "image/webp";
  }
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-" && lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  return "只接收 JPG、PNG、WebP 或 PDF";
}

export function defaultCompressionTitle(names: string[]): string {
  const clean = names.map((name) => name.replace(/[\u0000-\u001f]/g, " ").trim()).filter(Boolean);
  if (!clean.length) return "压缩文件";
  if (clean.length === 1) return clean[0].slice(0, 80);
  return `${clean[0].slice(0, 60)} 等${clean.length}个文件`.slice(0, 80);
}

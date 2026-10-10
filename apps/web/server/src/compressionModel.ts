import {
  COMPRESSION_MAX_MANUAL_RETRIES,
  COMPRESSION_POLICY_VERSION,
  COMPRESSION_RETRY_INTERVAL_MS,
  PDF_MAX_ROUNDS,
  PDF_TARGET_BYTES,
  QPDF_WARNING_ALLOWLIST_V1,
  type CompressionMediaType,
  COMPRESSION_POLICY,
  type CompressionPolicySnapshot,
} from "./compressionPolicy.js";

export type CompressionFileStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "passthrough"
  | "unmet_target"
  | "unsupported"
  | "failed";

export type CompressionBatchStatus = "queued" | "running" | "done" | "partial" | "failed";

type RetryClass = "never" | "capability" | "dependency" | "interrupt";

const COMPRESSION_REASON_CLASS: Record<string, RetryClass> = {
  magic_mismatch: "never",
  corrupt: "never",
  password_required: "never",
  signature_over_limit: "never",
  modification_restricted: "never",
  content_invalid: "never",
  multi_frame: "never",
  signature_unknown: "capability",
  policy_unavailable: "capability",
  filter_unsupported: "capability",
  resource_limit: "capability",
  qpdf_warning_unapproved: "capability",
  unmet_target: "capability",
  attempt_budget: "capability",
  platform_budget_unavailable: "capability",
  dependency_missing: "dependency",
  disk_space: "dependency",
  timed_out: "interrupt",
  interrupted: "interrupt",
};

export const COMPRESSION_ERROR_CATALOG = [
  { code: "upload_receipt_expired", status: 400, detail: "上传已过期，请重新传文件" },
  { code: "compression_receipt_invalid", status: 400, detail: "这份回执不是可压缩的 JPG、PNG、WebP 或 PDF" },
  { code: "compression_query_invalid", status: 400, detail: "压缩请求参数不正确" },
  { code: "compression_forbidden", status: 403, detail: "没有权限处理这批压缩文件" },
  { code: "compression_not_found", status: 404, detail: "没有这批压缩文件" },
  { code: "compression_record_unreadable", status: 503, detail: "压缩记录已损坏，不能当成空结果" },
  { code: "compression_file_missing", status: 404, detail: "这份结果还不能下载" },
  { code: "compression_revision_conflict", status: 409, detail: "压缩批次已更新，请刷新后再试" },
  { code: "compression_retry_rejected", status: 409, detail: "这些文件现在不能重试" },
  { code: "compression_not_terminal", status: 409, detail: "压缩还在进行，不能删除" },
  { code: "compression_delete_busy", status: 409, detail: "仍有下载未结束，删除会在下载结束后继续" },
  { code: "compression_zip_empty", status: 409, detail: "没有可下载的文件，不会生成空的压缩包" },
  { code: "compression_source_quota", status: 429, detail: "待处理的原件已经达到上限，请先完成或删除已有批次" },
  { code: "compression_download_busy", status: 429, detail: "同时下载过多，请等一个下载结束后再试" },
  { code: "compression_draining", status: 503, detail: "系统正在安全升版，暂不接收新的压缩或下载" },
  { code: "platform_budget_unavailable", status: 503, detail: "这台系统不能在解析前强制压缩进程的内存预算" },
  { code: "dependency_missing", status: 503, detail: "压缩所需的本机工具还不可用" },
  { code: "disk_space", status: 507, detail: "磁盘剩余空间不够完成本次压缩" },
] as const;

const DOWNLOADABLE = new Set<CompressionFileStatus>(["succeeded", "passthrough"]);
const FAIL_TERMINAL = new Set<CompressionFileStatus>(["unmet_target", "unsupported", "failed"]);

function compressionReasonMessage(reason: string | null): string | null {
  if (!reason) return null;
  const found = COMPRESSION_ERROR_CATALOG.find((item) => item.code === reason);
  if (found) return found.detail;
  const messages: Record<string, string> = {
    magic_mismatch: "文件格式和内容不一致",
    corrupt: "文件已损坏，不能重写",
    password_required: "带密码的文件本版不处理",
    signature_over_limit: "超过 10 MB 的已签名 PDF 不会重写",
    modification_restricted: "超过 10 MB 且限制修改的 PDF 不会重写",
    content_invalid: "文件内容不能安全重写",
    multi_frame: "多帧或动态图片不会压成单帧",
    signature_unknown: "签名状态无法判断，没有重写",
    policy_unavailable: "原压缩策略无法恢复，请在策略更新后重试",
    filter_unsupported: "PDF 使用了当前工具不能安全处理的过滤器",
    resource_limit: "文件超出本批页数、对象或内存预算",
    qpdf_warning_unapproved: "qpdf 报告了尚未批准的警告，结果没有发布",
    unmet_target: "在保留内容的前提下仍不能小于 10 MB",
    attempt_budget: "已达到本份 PDF 的轮数或时间上限",
    timed_out: "压缩超时，确认执行结束后可以重试",
    interrupted: "压缩进程中断，确认执行结束后可以重试",
    retry_exhausted: "同一原件的人工重试次数已用完",
    retry_interval: "距离上次重试还不到 30 秒",
    capability_unchanged: "策略和工具能力没有变化，这次不能重试",
    not_retryable: "这份文件不能重试",
    file_unknown: "要重试的文件不在这批里",
    executor_fence: "上一次执行是否已经结束还不能确认",
  };
  return messages[reason] || "压缩没有完成";
}

export function rollupCompressionStatus(
  files: Array<{ status: CompressionFileStatus }>,
): CompressionBatchStatus {
  if (files.some((file) => file.status === "running")) return "running";
  if (files.some((file) => file.status === "queued")) return "queued";
  const downloadable = files.filter((file) => DOWNLOADABLE.has(file.status)).length;
  if (files.length > 0 && downloadable === files.length) return "done";
  if (downloadable === 0) return "failed";
  return "partial";
}

export function isDownloadableCompressionStatus(status: CompressionFileStatus): boolean {
  return DOWNLOADABLE.has(status);
}

export type RetryCapability = {
  policyFingerprint: string;
  toolGeneration: string;
  ready: boolean;
  executorFence: boolean;
};

export type RetryFileState = {
  status: CompressionFileStatus;
  reason: string | null;
  manual_retries: number;
  last_retry_at: string | null;
  policy_fingerprint: string;
  tool_generation: string;
};

export function evaluateCompressionRetry(
  file: RetryFileState,
  nowMs: number,
  capability: RetryCapability,
): { ok: true } | { ok: false; reason: string } {
  if (!FAIL_TERMINAL.has(file.status)) return { ok: false, reason: "not_retryable" };
  const klass = COMPRESSION_REASON_CLASS[file.reason || ""] || "never";
  if (klass === "never") return { ok: false, reason: file.reason || "not_retryable" };
  if (file.manual_retries >= COMPRESSION_MAX_MANUAL_RETRIES) return { ok: false, reason: "retry_exhausted" };
  if (file.last_retry_at) {
    const elapsed = nowMs - Date.parse(file.last_retry_at);
    if (!Number.isFinite(elapsed) || elapsed < COMPRESSION_RETRY_INTERVAL_MS) {
      return { ok: false, reason: "retry_interval" };
    }
  }
  if (
    klass === "capability" &&
    capability.toolGeneration === file.tool_generation &&
    capability.policyFingerprint === file.policy_fingerprint
  ) {
    return { ok: false, reason: "capability_unchanged" };
  }
  if (klass === "dependency" && !capability.ready) return { ok: false, reason: file.reason || "dependency_missing" };
  if (klass === "interrupt" && capability.executorFence) return { ok: false, reason: "executor_fence" };
  return { ok: true };
}

export type QpdfCommand = "check" | "transform" | "is_encrypted" | "requires_password";

export type QpdfInterpretation =
  | { ok: true; encrypted?: boolean; passwordRequired?: boolean }
  | { ok: false; reason: "qpdf_error" | "qpdf_warning_unapproved" | "qpdf_exit_unknown" };

/**
 * 检查和转换：0 干净成功，2 错误，3 警告。v1 警告白名单为空，退出码 3 不发布。
 * 加密探测使用各自的退出码，不把语义上的 3 当成警告。
 * 不使用 --no-warn 或 --warning-exit-0。
 */
export function interpretQpdfExit(command: QpdfCommand, code: number): QpdfInterpretation {
  if (command === "is_encrypted") {
    if (code === 0) return { ok: true, encrypted: true };
    if (code === 2) return { ok: true, encrypted: false };
    if (code === 3) return { ok: false, reason: "qpdf_warning_unapproved" };
    return { ok: false, reason: "qpdf_exit_unknown" };
  }
  if (command === "requires_password") {
    if (code === 0) return { ok: true, passwordRequired: true };
    if (code === 2) return { ok: true, passwordRequired: false, encrypted: false };
    if (code === 3) return { ok: true, passwordRequired: false, encrypted: true };
    return { ok: false, reason: "qpdf_exit_unknown" };
  }
  if (code === 0) return { ok: true };
  if (code === 2) return { ok: false, reason: "qpdf_error" };
  if (code === 3) {
    return QPDF_WARNING_ALLOWLIST_V1.length === 0
      ? { ok: false, reason: "qpdf_warning_unapproved" }
      : { ok: true };
  }
  return { ok: false, reason: "qpdf_exit_unknown" };
}

export function qpdfCheckArgs(inputPath: string): string[] {
  return ["--check", inputPath];
}

export function qpdfLosslessArgs(inputPath: string, outputPath: string): string[] {
  return [
    "--object-streams=generate",
    "--recompress-flate",
    "--compression-level=9",
    "--stream-data=compress",
    inputPath,
    outputPath,
  ];
}

export function pdfUnderTarget(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes < PDF_TARGET_BYTES;
}

/** 9_800_000 只是估算余量，不参与停止判断。不假设体积单调。 */
export function firstQualifiedPdfCandidate(sizes: readonly number[]): { index: number; bytes: number } | null {
  const rounds = Math.min(sizes.length, PDF_MAX_ROUNDS);
  for (let index = 0; index < rounds; index += 1) {
    const bytes = sizes[index];
    if (pdfUnderTarget(bytes)) return { index, bytes };
  }
  return null;
}

export function pdfRoundPlan(policy: Pick<CompressionPolicySnapshot, "pdf_quality_ladder" | "pdf_max_rounds"> = COMPRESSION_POLICY): Array<{ kind: "lossless" } | { kind: "quality"; quality: number }> {
  return [{ kind: "lossless" as const }, ...policy.pdf_quality_ladder.map((quality) => ({ kind: "quality" as const, quality }))].slice(0, policy.pdf_max_rounds);
}

export type PdfInspection = {
  readable: boolean;
  bytes: number;
  passwordRequired: boolean;
  filledSignatures: number;
  emptySignatureFields: number;
  docMdp: boolean;
  signatureUnknown: boolean;
  stampAnnotations: number;
  checkWarning: boolean;
  checkError: boolean;
};

export type PdfDecision = {
  status: CompressionFileStatus;
  reason: string | null;
  rewrite: boolean;
};

/**
 * 空签名域、Stamp 和印章图不构成签名。判断不明则不重写。
 * 小于 10_000_000 字节且可读的原件按原字节直出，包括已签名或限制修改的文件。
 */
export function decidePdf(inspection: PdfInspection): PdfDecision {
  if (inspection.passwordRequired) return { status: "unsupported", reason: "password_required", rewrite: false };
  if (inspection.checkError || !inspection.readable) return { status: "unsupported", reason: "corrupt", rewrite: false };
  if (inspection.checkWarning) return { status: "failed", reason: "qpdf_warning_unapproved", rewrite: false };
  if (pdfUnderTarget(inspection.bytes)) return { status: "passthrough", reason: null, rewrite: false };
  if (inspection.signatureUnknown) return { status: "failed", reason: "signature_unknown", rewrite: false };
  if (inspection.filledSignatures > 0) return { status: "unsupported", reason: "signature_over_limit", rewrite: false };
  if (inspection.docMdp) return { status: "unsupported", reason: "modification_restricted", rewrite: false };
  return { status: "running", reason: null, rewrite: true };
}

export function exifOrientedSize(
  width: number,
  height: number,
  orientation: number | null,
): { width: number; height: number } | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  if (orientation == null || orientation === 1) return { width, height };
  if (orientation < 1 || orientation > 8) return null;
  if (orientation >= 5) return { width: height, height: width };
  return { width, height };
}

export type PublicCompressionFile = {
  id: string;
  name: string;
  media_type: CompressionMediaType;
  status: CompressionFileStatus;
  input_bytes: number;
  output_bytes: number | null;
  reason: string | null;
  message: string | null;
  can_retry: boolean;
  key: string | null;
  target_bytes: number | null;
};

export type PublicCompressionBatch = {
  id: string;
  title: string;
  created_at: string;
  status: CompressionBatchStatus;
  revision: number;
  owner: string;
  creator_id: string;
  queue_ahead: number;
  policy_version: typeof COMPRESSION_POLICY_VERSION;
  files: PublicCompressionFile[];
};

export class CompressionProblem extends Error {
  readonly reason?: string;

  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429 | 503 | 507,
    readonly code: string,
    message: string,
    reason?: string,
  ) {
    super(message);
    this.name = "CompressionProblem";
    this.reason = reason;
  }
}

export function compressionProblem(code: string, reason?: string): CompressionProblem {
  const found = COMPRESSION_ERROR_CATALOG.find((item) => item.code === code);
  if (!found) return new CompressionProblem(400, "compression_query_invalid", "压缩请求参数不正确", reason);
  return new CompressionProblem(found.status, found.code, found.detail, reason);
}

export function publicCompressionFile(input: {
  id: string;
  name: string;
  media_type: CompressionMediaType;
  status: CompressionFileStatus;
  input_bytes: number;
  output_bytes: number | null;
  reason: string | null;
  key: string | null;
  can_retry: boolean;
}): PublicCompressionFile {
  const output = input.output_bytes == null || !isDownloadableCompressionStatus(input.status)
    ? null
    : input.output_bytes;
  return {
    id: input.id,
    name: input.name,
    media_type: input.media_type,
    status: input.status,
    input_bytes: input.input_bytes,
    output_bytes: output,
    reason: input.reason,
    message: compressionReasonMessage(input.reason),
    can_retry: input.can_retry,
    key: isDownloadableCompressionStatus(input.status) ? input.key : null,
    target_bytes: input.media_type === "application/pdf" ? PDF_TARGET_BYTES : null,
  };
}

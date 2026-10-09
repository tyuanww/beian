import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decidePdf,
  interpretQpdfExit,
  pdfRoundPlan,
  pdfUnderTarget,
  qpdfCheckArgs,
  qpdfLosslessArgs,
  type CompressionFileStatus,
  type PdfInspection,
} from "./compressionModel.js";
import {
  COMPRESSION_ATTEMPT_DISK_BYTES,
  COMPRESSION_CANDIDATE_BYTES,
  COMPRESSION_JAVA_XMX_BYTES,
  COMPRESSION_MAX_FORM_DEPTH,
  COMPRESSION_MAX_PDF_OBJECTS,
  COMPRESSION_MAX_PDF_PAGES,
  COMPRESSION_RSS_BYTES,
  COMPRESSION_GROUP_RSS_BYTES,
  PDF_MAX_MS,
  compressionFileReady,
  type CompressionMediaType,
} from "./compressionPolicy.js";
import { pdfboxJar, probeResourceLimits, type CompressionCapability } from "./compressionProbe.js";
import type { CompressionFileRecord } from "./compressionStore.js";

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "../tools/compression");
const CONTAIN = join(TOOL_DIR, "contain.py");
const WORKER = join(TOOL_DIR, "image-worker.mjs");
const JAVA_SOURCE = join(TOOL_DIR, "PdfCompress.java");
const FORBIDDEN_ARGS = ["--no-warn", "--warning-exit-0", "--optimize-images"];
const STDOUT_LIMIT = 1024 * 1024;

export type CompressionJobResult = {
  status: CompressionFileStatus;
  reason: string | null;
  publish: "copy_source" | "output" | "none";
};

type JobRequest = {
  file: CompressionFileRecord;
  sourcePath: string;
  outputPath: string;
  signal: AbortSignal;
  capability: CompressionCapability;
};

type ToolStop = { stop: CompressionJobResult };
type ToolOk = { status: number; stdout: string };

let pythonPath: string | null | undefined;

export function compressionContainPath(): string {
  return CONTAIN;
}

export function imageWorkerCommand(input: string, output: string, media: CompressionMediaType): string[] {
  return [process.execPath, WORKER, "--input", input, "--output", output, "--media", media];
}

export function javaHelperCommand(java: string, jar: string, mode: string, args: string[]): string[] {
  const heap = Math.round(COMPRESSION_JAVA_XMX_BYTES / (1024 * 1024));
  return [java, `-Xmx${heap}m`, "-cp", jar, "--source", "17", JAVA_SOURCE, mode, ...args];
}

export function containArgs(command: string[], workDir?: string): string[] {
  return [
    CONTAIN,
    "--as",
    String(COMPRESSION_RSS_BYTES),
    "--group-memory",
    String(COMPRESSION_GROUP_RSS_BYTES),
    "--fsize",
    String(COMPRESSION_CANDIDATE_BYTES),
    "--disk",
    String(COMPRESSION_ATTEMPT_DISK_BYTES),
    ...(workDir ? ["--work-dir", workDir] : []),
    "--cpu",
    String(Math.ceil(PDF_MAX_MS / 1000)),
    "--",
    ...command,
  ];
}

export function assertCompressionArgv(args: readonly string[]): void {
  for (const arg of args) {
    if (FORBIDDEN_ARGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new Error("压缩命令包含被禁止的参数");
    }
  }
}

export function resolveExecutable(name: string): string | null {
  if (!name) return null;
  if (name.includes("/") || name.includes("\\")) return statOk(name) ? name : null;
  const finder = process.platform === "win32" ? "where" : "which";
  const run = spawnSync(finder, [name], { encoding: "utf8", timeout: 3_000, windowsHide: true });
  if (run.status !== 0) return null;
  const found = (run.stdout || "").split(/\r?\n/).map((item) => item.trim()).find((item) => item && statOk(item));
  return found || null;
}

function statOk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function none(status: CompressionFileStatus, reason: string): CompressionJobResult {
  return { status, reason, publish: "none" };
}

function pythonBin(): string | null {
  if (pythonPath === undefined) pythonPath = probeResourceLimits().python;
  return pythonPath;
}

function runContained(command: string[], signal: AbortSignal, workDir?: string): Promise<ToolStop | ToolOk> {
  assertCompressionArgv(command);
  const python = pythonBin();
  if (!python) return Promise.resolve({ stop: none("failed", "platform_budget_unavailable") });
  const args = containArgs(command, workDir);
  assertCompressionArgv(args.filter((arg) => arg !== "--"));
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: ToolStop | ToolOk): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(python, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
    } catch {
      finish({ stop: none("failed", signal.aborted ? "timed_out" : "platform_budget_unavailable") });
      return;
    }
    const take = (chunk: Buffer, into: "out" | "err"): void => {
      const text = chunk.toString("utf8");
      if (into === "out") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > STDOUT_LIMIT) child.kill();
    };
    child.stdout?.on("data", (chunk: Buffer) => take(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => take(chunk, "err"));
    child.once("error", () => {
      // Abort waits for close: the supervisor must release its owned tree first.
      if (child.pid) return;
      finish({ stop: none("failed", signal.aborted ? "timed_out" : "dependency_missing") });
    });
    child.once("close", (status) => {

      if (stderr.includes("containment=resource_limit")) {
        finish({ stop: none("failed", "resource_limit") });
        return;
      }
      if (/unable to locate a java runtime/i.test(stderr)) {
        finish({ stop: none("failed", "dependency_missing") });
        return;
      }
      if (stderr.includes("containment=unavailable") || (status === 3 && !stderr.includes("containment=ok"))) {
        finish({ stop: none("failed", "platform_budget_unavailable") });
        return;
      }
      if (signal.aborted) {
        finish({ stop: none("failed", "timed_out") });
        return;
      }
      if (stdout.length + stderr.length > STDOUT_LIMIT) {
        finish({ stop: none("failed", "resource_limit") });
        return;
      }
      finish({ status: status ?? 1, stdout });
    });
  });
}

function isStop(value: ToolStop | ToolOk): value is ToolStop {
  return "stop" in value;
}

async function executeImage(request: JobRequest): Promise<CompressionJobResult> {
  mkdirSync(dirname(request.outputPath), { recursive: true });
  const run = await runContained(
    imageWorkerCommand(request.sourcePath, request.outputPath, request.file.media_type),
    request.signal,
    dirname(request.outputPath),
  );
  if (isStop(run)) return run.stop;
  if (run.status === 4) return none("unsupported", "multi_frame");
  if (run.status === 3) return none("failed", "resource_limit");
  if (run.status !== 0) return none("unsupported", "corrupt");
  let size = 0;
  try {
    size = statSync(request.outputPath).size;
  } catch {
    return none("failed", "content_invalid");
  }
  if (size <= 0) return none("failed", "content_invalid");
  if (size >= request.file.input_bytes) return { status: "passthrough", reason: null, publish: "copy_source" };
  return { status: "succeeded", reason: null, publish: "output" };
}

async function qpdfCode(qpdf: string, args: string[], signal: AbortSignal): Promise<ToolStop | ToolOk> {
  return runContained([qpdf, ...args], signal);
}

async function pageCount(qpdf: string, path: string, signal: AbortSignal): Promise<number | CompressionJobResult> {
  const run = await qpdfCode(qpdf, ["--show-npages", path], signal);
  if (isStop(run)) return run.stop;
  const checked = interpretQpdfExit("check", run.status);
  if (!checked.ok) return none(checked.reason === "qpdf_error" ? "unsupported" : "failed", checked.reason === "qpdf_error" ? "corrupt" : checked.reason);
  const pages = Number(run.stdout.trim());
  if (!Number.isInteger(pages) || pages < 1) return none("unsupported", "corrupt");
  return pages;
}

function javaStop(status: number): CompressionJobResult | null {
  if (status === 0) return null;
  if (status === 3) return none("failed", "resource_limit");
  if (status === 4) return none("failed", "filter_unsupported");
  if (status === 2) return none("failed", "content_invalid");
  return none("failed", "interrupted");
}

async function executePdf(request: JobRequest): Promise<CompressionJobResult> {
  const qpdf = resolveExecutable("qpdf");
  const java = resolveExecutable("java");
  const jar = pdfboxJar();
  if (!qpdf || !java || !jar || !statOk(JAVA_SOURCE)) return none("failed", "dependency_missing");
  const password = await qpdfCode(qpdf, ["--requires-password", request.sourcePath], request.signal);
  if (isStop(password)) return password.stop;
  const passwordResult = interpretQpdfExit("requires_password", password.status);
  if (!passwordResult.ok) {
    return none("failed", passwordResult.reason === "qpdf_warning_unapproved" ? "qpdf_warning_unapproved" : "corrupt");
  }
  if (passwordResult.passwordRequired) return none("unsupported", "password_required");
  const encrypted = await qpdfCode(qpdf, ["--is-encrypted", request.sourcePath], request.signal);
  if (isStop(encrypted)) return encrypted.stop;
  const encryptedResult = interpretQpdfExit("is_encrypted", encrypted.status);
  if (!encryptedResult.ok) {
    return none("failed", encryptedResult.reason === "qpdf_warning_unapproved" ? "qpdf_warning_unapproved" : "corrupt");
  }
  const check = await qpdfCode(qpdf, qpdfCheckArgs(request.sourcePath), request.signal);
  if (isStop(check)) return check.stop;
  const checked = interpretQpdfExit("check", check.status);
  if (!checked.ok) {
    return none(checked.reason === "qpdf_error" ? "unsupported" : "failed", checked.reason === "qpdf_error" ? "corrupt" : checked.reason);
  }
  const pages = await pageCount(qpdf, request.sourcePath, request.signal);
  if (typeof pages !== "number") return pages;
  if (pages > COMPRESSION_MAX_PDF_PAGES) return none("failed", "resource_limit");
  const inputBytes = statSync(request.sourcePath).size;
  if (pdfUnderTarget(inputBytes)) return { status: "passthrough", reason: null, publish: "copy_source" };
  if (encryptedResult.encrypted) return none("unsupported", "password_required");

  const javaBin = java;
  const inspect = await runContained(javaHelperCommand(javaBin, jar, "inspect", [request.sourcePath]), request.signal);
  if (isStop(inspect)) return inspect.stop;
  const inspectStop = javaStop(inspect.status);
  if (inspectStop) return inspectStop;
  let info: Partial<PdfInspection> & { objects?: number; formDepth?: number; incremental?: boolean };
  try {
    info = JSON.parse(inspect.stdout) as typeof info;
  } catch {
    return none("failed", "content_invalid");
  }
  if ((info.objects || 0) > COMPRESSION_MAX_PDF_OBJECTS || (info.formDepth || 0) > COMPRESSION_MAX_FORM_DEPTH) {
    return none("failed", "resource_limit");
  }
  const decision = decidePdf({
    readable: info.readable !== false,
    bytes: inputBytes,
    passwordRequired: false,
    filledSignatures: info.filledSignatures || 0,
    emptySignatureFields: info.emptySignatureFields || 0,
    docMdp: info.docMdp === true,
    signatureUnknown: info.signatureUnknown === true || info.incremental === true,
    stampAnnotations: info.stampAnnotations || 0,
    checkWarning: false,
    checkError: false,
  });
  if (!decision.rewrite) return none(decision.status, decision.reason || "content_invalid");

  const sourceBoxes = await runContained(javaHelperCommand(javaBin, jar, "boxes", [request.sourcePath]), request.signal);
  if (isStop(sourceBoxes)) return sourceBoxes.stop;
  const sourceStop = javaStop(sourceBoxes.status);
  if (sourceStop) return sourceStop;
  const started = Date.now();
  let oversize = false;
  let roundIndex = 0;
  mkdirSync(dirname(request.outputPath), { recursive: true });
  for (const round of pdfRoundPlan()) {
    if (request.signal.aborted) return none("failed", "timed_out");
    if (Date.now() - started >= PDF_MAX_MS) return none("failed", "attempt_budget");
    const candidate = `${request.outputPath}.r${roundIndex}`;
    roundIndex += 1;
    const command = round.kind === "lossless"
      ? [qpdf, ...qpdfLosslessArgs(request.sourcePath, candidate)]
      : javaHelperCommand(javaBin, jar, "recompress", [request.sourcePath, candidate, String(round.quality)]);
    const ran = await runContained(command, request.signal, dirname(request.outputPath));
    if (isStop(ran)) {
      rmSync(candidate, { force: true });
      return ran.stop;
    }
    if (round.kind === "lossless") {
      const lossless = interpretQpdfExit("transform", ran.status);
      if (!lossless.ok) {
        rmSync(candidate, { force: true });
        continue;
      }
    } else {
      const helperStop = javaStop(ran.status);
      if (helperStop) {
        rmSync(candidate, { force: true });
        return helperStop;
      }
    }
    let size = 0;
    try {
      size = statSync(candidate).size;
    } catch {
      continue;
    }
    if (size <= 0 || size > COMPRESSION_CANDIDATE_BYTES) {
      rmSync(candidate, { force: true });
      continue;
    }
    if (!pdfUnderTarget(size)) {
      oversize = true;
      rmSync(candidate, { force: true });
      continue;
    }
    const again = await qpdfCode(qpdf, qpdfCheckArgs(candidate), request.signal);
    if (isStop(again)) {
      rmSync(candidate, { force: true });
      return again.stop;
    }
    const candidatePages = await pageCount(qpdf, candidate, request.signal);
    if (typeof candidatePages !== "number") {
      rmSync(candidate, { force: true });
      if (candidatePages.reason === "platform_budget_unavailable" || candidatePages.reason === "timed_out") return candidatePages;
      continue;
    }
    const boxes = await runContained(javaHelperCommand(javaBin, jar, "boxes", [candidate]), request.signal);
    if (isStop(boxes)) {
      rmSync(candidate, { force: true });
      return boxes.stop;
    }
    const clean = interpretQpdfExit("check", again.status).ok && again.status === 0;
    const sameBoxes = boxes.status === 0 && boxes.stdout.trim() === sourceBoxes.stdout.trim();
    if (!clean || candidatePages !== pages || !sameBoxes) {
      rmSync(candidate, { force: true });
      if (round.kind === "quality" && (candidatePages !== pages || !sameBoxes)) return none("failed", "content_invalid");
      continue;
    }
    renameSync(candidate, request.outputPath);
    return { status: "succeeded", reason: null, publish: "output" };
  }
  return none(oversize ? "unmet_target" : "failed", oversize ? "unmet_target" : "content_invalid");
}

export async function runCompressionJob(request: JobRequest): Promise<CompressionJobResult> {
  if (!compressionFileReady(request.file.media_type, request.capability)) {
    return none("failed", "dependency_missing");
  }
  if (request.signal.aborted) return none("failed", "timed_out");
  if (request.file.media_type === "application/pdf") return executePdf(request);
  return executeImage(request);
}

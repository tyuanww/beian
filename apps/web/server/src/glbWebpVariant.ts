/**
 * 旧打样 GLB 的 WebP 旁路（方案 v2.1 PR-a）。原件一字不改，旁路放在
 * `<jobDir>/.webp-variant/<原文件名>.webpv`，旁边是 `<原文件名>.webpv.json` 元数据。
 *
 * - 隐藏目录 + 非 .glb 后缀：collectOutputs 不进 "." 目录、只认 .glb/.png/.pptx/.pdf，两层都挡住。
 * - 完成的定义：meta 存在、source hash 与原件一致、variant hash 与旁路一致。缺一项就回退原件。
 * - 写入顺序：删旧 meta → 删旧旁路 → 旁路 tmp(fsync) → rename → meta tmp(fsync) → rename；
 *   每次 unlink/rename 后对目录 fsync（Windows 不支持目录 fsync，best-effort）。
 * - 所有会让 Blender 写这单 job 目录的入口进入时同步调用 dropGlbWebpVariant（jobs.ts，静态测试 A 锁住）。
 *   即使漏删，原件被重写后 source hash 对不上，也只会回退原件，不会把旧旁路发出去。
 * - 本模块不读环境变量；对外返回由 rolloutFlags.GLB_WEBP_VARIANT 控制，默认关。
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { DATA_DIR } from "./config.js";
import { compressGlbTexturesToWebp, type GlbWebpOptions, type GlbWebpResult } from "./glbWebp.js";
import { GLB_WEBP_VARIANT } from "./rolloutFlags.js";

export const GLB_WEBP_VARIANT_DIR = ".webp-variant";
export const GLB_WEBP_VARIANT_SCHEMA = "glb-webp-variant/1";
const VARIANT_SUFFIX = ".webpv";
const META_SUFFIX = ".webpv.json";
const GLB_WEBP_VARIANT_QUALITY = 90;
const GLB_WEBP_TOOL_VERSION = "gltf-transform@4.5.1+sharp@0.34.4";
const HASH_CACHE_MAX = 512;
const HASH_CHUNK = 1024 * 1024;

export type GlbWebpVariantMeta = {
  schema: typeof GLB_WEBP_VARIANT_SCHEMA;
  source: { name: string; sha256: string; bytes: number };
  variant: { sha256: string; bytes: number };
  quality: number;
  tool_version: string;
  created_at: string;
};

let enabled: boolean = GLB_WEBP_VARIANT;

/** 对外返回旁路的总开关（rolloutFlags.GLB_WEBP_VARIANT，默认关）。 */
export function glbWebpVariantEnabled(): boolean {
  return enabled;
}

/** 测试注入：不读 env，不提供运行时覆盖。 */
export function setGlbWebpVariantEnabledForTest(value: boolean): void {
  enabled = value;
}

let unlinkImpl: (path: string) => void = unlinkSync;

/** 测试用：记录删除顺序（meta 必须先于旁路被删）。传 null 恢复。 */
export function setGlbWebpVariantUnlinkForTest(fn: ((path: string) => void) | null): void {
  unlinkImpl = fn ?? unlinkSync;
}

function mockupsRoot(): string {
  return join(DATA_DIR, "mockups");
}

function safeJobId(jobId: string): boolean {
  return Boolean(jobId) && !jobId.startsWith(".") && !/[\\/]/.test(jobId) && !jobId.includes("..");
}

export function glbWebpVariantDir(jobId: string): string {
  return join(mockupsRoot(), jobId, GLB_WEBP_VARIANT_DIR);
}

export type GlbWebpVariantPaths = { jobDir: string; dir: string; sourceName: string; variant: string; meta: string };

/** 原件必须是这单 job 目录内的 .glb；否则没有旁路。 */
export function glbWebpVariantPaths(jobId: string, glbPath: string): GlbWebpVariantPaths | null {
  if (!safeJobId(jobId) || !/\.glb$/i.test(glbPath)) return null;
  const jobDir = join(mockupsRoot(), jobId);
  const rel = relative(jobDir, glbPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const sourceName = rel.split(sep).join("/");
  if (sourceName.split("/").some((part) => part.startsWith("."))) return null;
  const dir = join(jobDir, GLB_WEBP_VARIANT_DIR);
  const name = basename(glbPath);
  return { jobDir, dir, sourceName, variant: join(dir, `${name}${VARIANT_SUFFIX}`), meta: join(dir, `${name}${META_SUFFIX}`) };
}

let fsyncDirWarned = false;

/** unlink/rename 之后让目录项落盘。Windows 打开目录会报 EISDIR/EPERM：best-effort，记一次 debug 后继续。 */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!fsyncDirWarned) {
      fsyncDirWarned = true;
      console.debug(`glb webp variant: directory fsync unsupported (${(error as NodeJS.ErrnoException).code || "unknown"}), relying on meta-last + hash checks`);
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

const hashCache = new Map<string, string>();
let hashComputeCount = 0;

export function resetGlbWebpVariantCacheForTest(): void {
  hashCache.clear();
  hashComputeCount = 0;
}

/** 测试用：实际流式重算 sha256 的次数（命中缓存不计）。 */
export function glbWebpVariantHashComputeCountForTest(): number {
  return hashComputeCount;
}

/**
 * 同一 fd 上算 sha256。缓存键 = dev+ino+mtimeNs+size（bigint fstat）：原地同大小覆盖会改 mtimeNs，
 * rename 替换会换 inode；不命中就从这个 fd 流式重算。
 */
export function sha256OfFd(fd: number): { sha256: string; bytes: number } {
  const st = fstatSync(fd, { bigint: true });
  const bytes = Number(st.size);
  const key = `${st.dev}:${st.ino}:${st.mtimeNs}:${st.size}`;
  const cached = hashCache.get(key);
  if (cached) {
    hashCache.delete(key);
    hashCache.set(key, cached);
    return { sha256: cached, bytes };
  }
  hashComputeCount += 1;
  const hash = createHash("sha256");
  const buf = Buffer.alloc(Math.min(HASH_CHUNK, Math.max(1, bytes)));
  let position = 0;
  while (position < bytes) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, bytes - position), position);
    if (n <= 0) break;
    hash.update(buf.subarray(0, n));
    position += n;
  }
  const sha256 = hash.digest("hex");
  if (hashCache.size >= HASH_CACHE_MAX) {
    const oldest = hashCache.keys().next().value;
    if (oldest !== undefined) hashCache.delete(oldest);
  }
  hashCache.set(key, sha256);
  return { sha256, bytes };
}

const SHA_RE = /^[a-f0-9]{64}$/;

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function readGlbWebpVariantMeta(path: string): GlbWebpVariantMeta | null {
  if (!isRegularFile(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GlbWebpVariantMeta>;
    if (value?.schema !== GLB_WEBP_VARIANT_SCHEMA) return null;
    const { source, variant } = value;
    if (!source || typeof source.name !== "string" || !SHA_RE.test(source.sha256 || "") || !Number.isSafeInteger(source.bytes)) return null;
    if (!variant || !SHA_RE.test(variant.sha256 || "") || !Number.isSafeInteger(variant.bytes)) return null;
    return value as GlbWebpVariantMeta;
  } catch {
    return null;
  }
}

function originalEtagOfFd(fd: number): string {
  const st = fstatSync(fd);
  return `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
}

export type OpenedGlb =
  | { kind: "variant"; fd: number; bytes: number; sha256: string }
  | { kind: "original"; fd: number; bytes: number; etag: string; reason: string };

const warnedMismatch = new Set<string>();

function warnMismatch(jobId: string, reason: string): void {
  const key = `${jobId}:${reason}`;
  if (warnedMismatch.has(key)) return;
  if (warnedMismatch.size > 1000) warnedMismatch.clear();
  warnedMismatch.add(key);
  console.warn(`glb webp variant ${jobId}: problem=旁路失效 cause=${reason} fix=回退原件，等回填重做`);
}

/**
 * 打开原件 fd_s；核 meta、原件 hash、旁路 hash。全部通过返回旁路 fd（fd_s 已关）；
 * 任一不符返回原件 fd_s（不重开路径），调用方负责关闭返回的 fd。
 */
export function openGlbForServe(jobId: string, glbPath: string): OpenedGlb {
  const fdS = openSync(glbPath, "r");
  let bytesS: number;
  try {
    bytesS = fstatSync(fdS).size;
  } catch (error) {
    closeSync(fdS);
    throw error;
  }
  const original = (reason: string): OpenedGlb => {
    if (reason !== "no_meta" && reason !== "no_paths") warnMismatch(jobId, reason);
    return { kind: "original", fd: fdS, bytes: bytesS, etag: originalEtagOfFd(fdS), reason };
  };
  try {
    const paths = glbWebpVariantPaths(jobId, glbPath);
    if (!paths) return original("no_paths");
    const meta = readGlbWebpVariantMeta(paths.meta);
    if (!meta) return original("no_meta");
    if (meta.source.name !== paths.sourceName) return original("source_name_mismatch");
    const source = sha256OfFd(fdS);
    if (source.sha256 !== meta.source.sha256 || source.bytes !== meta.source.bytes) return original("source_hash_mismatch");
    if (!isRegularFile(paths.variant)) return original("variant_missing");
    let fdV: number;
    try {
      fdV = openSync(paths.variant, "r");
    } catch {
      return original("variant_missing");
    }
    try {
      const variant = sha256OfFd(fdV);
      if (variant.sha256 !== meta.variant.sha256 || variant.bytes !== meta.variant.bytes) {
        closeSync(fdV);
        return original("variant_hash_mismatch");
      }
      closeSync(fdS);
      return { kind: "variant", fd: fdV, bytes: variant.bytes, sha256: variant.sha256 };
    } catch (error) {
      try { closeSync(fdV); } catch { /* ignore */ }
      throw error;
    }
  } catch (error) {
    try { closeSync(fdS); } catch { /* ignore */ }
    throw error;
  }
}

/** texture_format 用：旁路校验通过报 "webp"，否则 null（调用方按原件判断）。走同一个 hash 缓存。 */
export function glbWebpVariantTextureFormat(jobId: string, glbPath: string | undefined): "webp" | null {
  if (!glbPath) return null;
  const paths = glbWebpVariantPaths(jobId, glbPath);
  if (!paths || !isRegularFile(paths.meta)) return null;
  let opened: OpenedGlb;
  try {
    opened = openGlbForServe(jobId, glbPath);
  } catch {
    return null;
  }
  closeSync(opened.fd);
  return opened.kind === "variant" ? "webp" : null;
}

const dropEpoch = new Map<string, number>();

function epochOf(jobId: string): number {
  return dropEpoch.get(jobId) ?? 0;
}

function unlinkIgnoringMissing(path: string): boolean {
  try {
    unlinkImpl(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isMetaName(name: string): boolean {
  return name.endsWith(META_SUFFIX) || /\.webpv\.json\.\d+-\d+\.tmp$/.test(name);
}

/**
 * 会改 GLB 的入口进入时同步调用：先删全部 meta（让"完成"标记先失效），再删旁路和 tmp，各做一次目录 fsync。
 * ENOENT 忽略；其他错误只记日志不抛（服务时的 hash 核对兜底）。同时让正在进行的旁路写入作废。
 */
export function dropGlbWebpVariant(jobId: string): void {
  if (!safeJobId(jobId)) return;
  dropEpoch.set(jobId, epochOf(jobId) + 1);
  const dir = glbWebpVariantDir(jobId);
  try {
    let st;
    try {
      st = lstatSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!st.isDirectory()) {
      unlinkIgnoringMissing(dir);
      fsyncDir(join(mockupsRoot(), jobId));
      return;
    }
    const names = readdirSync(dir);
    let removed = false;
    for (const name of names.filter(isMetaName)) removed = unlinkIgnoringMissing(join(dir, name)) || removed;
    if (removed) fsyncDir(dir);
    removed = false;
    for (const name of names.filter((n) => !isMetaName(n))) {
      if (!isRegularFile(join(dir, name))) continue;
      removed = unlinkIgnoringMissing(join(dir, name)) || removed;
    }
    if (removed) fsyncDir(dir);
  } catch (error) {
    console.warn(`glb webp variant ${jobId}: problem=删旁路失败 cause=${error instanceof Error ? error.message : String(error)} fix=服务时 hash 核对会回退原件`);
  }
}

export type WriteGlbWebpVariantOptions = Pick<GlbWebpOptions, "quality" | "convert" | "lockWaitMs" | "beforeCommit"> & { now?: () => Date };

/**
 * 生成一单的旁路（回填任务 PR-b 调用）。原件不动。写入顺序见文件头；
 * 期间若有入口调用了 dropGlbWebpVariant，本次结果作废。
 */
export async function writeGlbWebpVariant(jobId: string, glbPath: string, opts: WriteGlbWebpVariantOptions = {}): Promise<GlbWebpResult> {
  const paths = glbWebpVariantPaths(jobId, glbPath);
  if (!paths) return { status: "failed", reason: "not_job_glb" };
  const epoch = epochOf(jobId);
  const stillValid = () => epochOf(jobId) === epoch && (!opts.beforeCommit || opts.beforeCommit());
  try {
    try {
      const st = lstatSync(paths.dir);
      if (!st.isDirectory()) return { status: "failed", reason: "variant_dir_not_directory" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(paths.dir);
      fsyncDir(paths.jobDir);
    }
    if (unlinkIgnoringMissing(paths.meta)) fsyncDir(paths.dir);
    if (unlinkIgnoringMissing(paths.variant)) fsyncDir(paths.dir);
    const result = await compressGlbTexturesToWebp(glbPath, {
      quality: opts.quality ?? GLB_WEBP_VARIANT_QUALITY,
      convert: opts.convert,
      lockWaitMs: opts.lockWaitMs,
      beforeCommit: stillValid,
      outPath: paths.variant,
    });
    if (result.status !== "converted") return result;
    fsyncDir(paths.dir);
    const meta: GlbWebpVariantMeta = {
      schema: GLB_WEBP_VARIANT_SCHEMA,
      source: { name: paths.sourceName, sha256: result.inputSha256, bytes: result.beforeBytes },
      variant: { sha256: result.outputSha256, bytes: result.afterBytes },
      quality: opts.quality ?? GLB_WEBP_VARIANT_QUALITY,
      tool_version: GLB_WEBP_TOOL_VERSION,
      created_at: (opts.now?.() ?? new Date()).toISOString(),
    };
    const tmp = join(paths.dir, `.${basename(paths.meta)}.${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(meta));
    const fd = openSync(tmp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (!stillValid()) {
      unlinkIgnoringMissing(tmp);
      unlinkIgnoringMissing(paths.variant);
      fsyncDir(paths.dir);
      return { status: "skipped", reason: "deadline_insufficient" };
    }
    const metaPath = paths.meta;
    renameSync(tmp, metaPath);
    fsyncDir(paths.dir);
    return result;
  } catch (error) {
    try { unlinkIgnoringMissing(paths.meta); unlinkIgnoringMissing(paths.variant); } catch { /* ignore */ }
    return { status: "failed", reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
}

/**
 * 启动清理（在任何旁路写入之前调用）：删 `.webp-variant` 下所有 *.tmp；删没有 meta 的旁路（孤儿）；
 * 删没有旁路的 meta；meta 读不出或 source 已不存在的整对删除（先 meta 后旁路）。不跟随符号链接。返回删除个数。
 */
export function cleanupGlbWebpVariantsOnBoot(root: string = mockupsRoot()): number {
  let removed = 0;
  let jobs;
  try {
    jobs = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const job of jobs) {
    if (!job.isDirectory() || job.name.startsWith(".")) continue;
    const jobDir = join(root, job.name);
    const dir = join(jobDir, GLB_WEBP_VARIANT_DIR);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let changed = false;
    const drop = (name: string) => {
      try {
        if (unlinkIgnoringMissing(join(dir, name))) {
          removed += 1;
          changed = true;
        }
      } catch {
        // 无权限等：下次启动再试。
      }
    };
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => isRegularFile(join(dir, name)));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".tmp"))) drop(name);
    const metas = new Set(names.filter((n) => n.endsWith(META_SUFFIX)).map((n) => n.slice(0, -META_SUFFIX.length)));
    const variants = new Set(names.filter((n) => n.endsWith(VARIANT_SUFFIX)).map((n) => n.slice(0, -VARIANT_SUFFIX.length)));
    for (const base of metas) {
      const meta = readGlbWebpVariantMeta(join(dir, `${base}${META_SUFFIX}`));
      const sourceOk = Boolean(meta) && basename(meta!.source.name) === base
        && !meta!.source.name.split("/").some((part) => part === ".." || part.startsWith("."))
        && isRegularFile(join(jobDir, ...meta!.source.name.split("/")));
      if (!variants.has(base) || !sourceOk) {
        drop(`${base}${META_SUFFIX}`);
        if (variants.has(base)) drop(`${base}${VARIANT_SUFFIX}`);
      }
    }
    for (const base of variants) if (!metas.has(base)) drop(`${base}${VARIANT_SUFFIX}`);
    if (changed) fsyncDir(dir);
  }
  return removed;
}

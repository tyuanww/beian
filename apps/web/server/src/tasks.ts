import type { NativeRequest } from "./nativeTextJobs.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.js";
import { guardErrorFields } from "./pathRedact.js";
import { cleanCompleteKind, forgetHistory, noteHistoryReview } from "./historyIndex.js";
import { skipPackSheetField } from "./sheetSkip.js";

export type Hit = {
  id?: string;
  field?: string;
  status?: string;
  decision?: string;
  note?: string;
  excel?: string;
  excel_value?: string;
  pdf?: string;
  expected?: string;
  found?: string;
  page?: number | string;
  bboxes?: unknown[];
};

export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type JobKind = "compare" | "rework" | "mockup";

export type Viewer = {
  id: string;
  name: string;
  admin: boolean;
};

export function viewerFromSession(session: {
  open_id?: string;
  display_name?: string;
  role?: string;
}): Viewer {
  const name = String(session.display_name || "").trim();
  return {
    id: String(session.open_id || name).trim(),
    name,
    admin: session.role === "admin",
  };
}

export function canAccessOwner(owner: string, viewer: Viewer): boolean {
  if (viewer.admin) return true;
  const expected = String(owner || "").trim();
  return Boolean(expected) && (expected === viewer.id || expected === viewer.name);
}

export type Task = {
  native_text_request?: NativeRequest;
  /** 仅服务端用于把已失败的 Illustrator 尝试传给 OCR worker，不返回前端。 */
  native_text_attempted?: boolean;
  /** 新包装核对单才有。空 hits_v2 表示这轮没有错，不得回退第一轮。 */
  verbatim_check?: boolean;
  verbatim_warning?: string;
  fsc_note?: string;
  id: string;
  title: string;
  product_name?: string;
  type: string;
  status: string;
  created_at?: string;
  owner?: string;
  created_by?: string;
  actor?: string;
  completed_by?: string;
  completed_at?: string;
  conclusion?: string;
  complete_kind?: string;
  error?: string;
  hits?: Hit[];
  hits_v2?: Hit[];
  pages?: unknown[];
  pages_b?: unknown[];
  pages_v2?: unknown[];
  round?: number;
  rework_check?: unknown[];
  audit?: unknown[];
  job_kind?: JobKind;
  job_status?: JobStatus;
  job_stage?: string;
  job_stage_label?: string;
  job_eta_s?: number;
  job_error?: string;
  job_started_at?: string;
  job_finished_at?: string;
  job_pid?: number;
  notify_job_id?: string;
  notify_sent?: boolean;
  reclaim_count?: number;
  status_before_job?: string;
  /** 仅服务端用于开始接口幂等恢复，不返回前端。 */
  source_receipt?: string;
  [k: string]: unknown;
};

const TID = /^[0-9a-f]{12}$/;

function tasksDir() {
  const d = join(DATA_DIR, "tasks");
  mkdirSync(d, { recursive: true });
  return d;
}

export function isTid(tid: string): boolean {
  return TID.test(tid || "");
}

export function assertTid(tid: string): string {
  if (!isTid(tid)) throw Object.assign(new Error("无效任务 id"), { status: 400 });
  return tid;
}

export function loadTask(tid: string): Task {
  const p = join(tasksDir(), `${assertTid(tid)}.json`);
  if (!existsSync(p)) throw Object.assign(new Error("任务不存在"), { status: 404 });
  return JSON.parse(readFileSync(p, "utf8")) as Task;
}

/** Task plus a content revision of the exact bytes parsed, for compare-before-write. */
export function loadTaskWithRevision(tid: string): { task: Task; revision: string } {
  const p = join(tasksDir(), `${assertTid(tid)}.json`);
  if (!existsSync(p)) throw Object.assign(new Error("任务不存在"), { status: 404 });
  const raw = readFileSync(p);
  return { task: JSON.parse(raw.toString("utf8")) as Task, revision: createHash("sha256").update(raw).digest("hex") };
}

const REPLACE_RENAME_ATTEMPTS = 8;
const REPLACE_RETRY_MS = 15;

type ReplaceFileHooks = { rename?: typeof renameSync; now?: () => number };
let replaceFileHooks: ReplaceFileHooks = {};

/** 测试替换 rename / 时钟。生产路径不设。 */
export function setReplaceFileHooksForTest(hooks: ReplaceFileHooks | null): void {
  if (process.env.VITEST !== "1") throw new Error("replaceFile 测试钩子只能在 VITEST 使用");
  replaceFileHooks = hooks || {};
}

function sleepMs(ms: number): void {
  const now = replaceFileHooks.now || Date.now;
  const until = now() + ms;
  while (now() < until) {
    /* busy wait: replaceFile stays sync like the rest of task IO */
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/** POSIX rename 原子替换。Windows 上 rename 失败只重试，最终失败抛错；绝不 copyFile 覆盖。 */
export function replaceFile(dest: string, contents: string): void {
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  const rename = replaceFileHooks.rename || renameSync;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= REPLACE_RENAME_ATTEMPTS; attempt += 1) {
    try {
      rename(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "";
      const retryable = code === "EEXIST" || code === "EPERM" || code === "EACCES";
      if (!retryable || attempt >= REPLACE_RENAME_ATTEMPTS) {
        unlinkQuietly(tmp);
        throw err;
      }
      sleepMs(REPLACE_RETRY_MS * attempt);
    }
  }
  unlinkQuietly(tmp);
  throw lastErr instanceof Error ? lastErr : new Error("replaceFile rename failed");
}

export function saveTask(task: Task): void {
  const tid = assertTid(task.id);
  const p = join(tasksDir(), `${tid}.json`);
  replaceFile(p, JSON.stringify(task, null, 2));
  try { noteHistoryReview(task); } catch { /* 摘要失败不回滚审稿记录 */ }
}

const TASK_STATUSES = new Set(["comparing", "compare_failed", "pending_review", "in_review", "completed"]);
const TASK_JOB_KINDS = new Set(["compare", "rework"]);
const TASK_JOB_STATUSES = new Set(["queued", "running", "succeeded", "failed"]);
const NATIVE_REASONS = new Set(["native_busy", "native_offline", "source_changed", "close_unconfirmed", "native_failed", "save_timeout", "save_source_changed"]);

/**
 * Durable job state is a release-safety contract, not just a TypeScript hint.
 * A parseable but contradictory record must block release rather than vanish
 * from the running/queued counters.
 */
function hasValidTaskJobState(task: Task): boolean {
  const native = task.native_text_request;
  if (task.native_text_attempted !== undefined && typeof task.native_text_attempted !== "boolean") return false;
  if (native !== undefined && (!native || native.version !== "native-text/1"
      || !/^[0-9a-f]{32}$/.test(native.id) || !/^[0-9a-f]{64}$/.test(native.source_sha256)
      || !["artwork.pdf", "artwork_v2.pdf"].includes(native.source_name)
      || !["queued", "running", "ready", "fallback"].includes(native.status)
      || !Number.isFinite(Date.parse(native.created_at))
      || (native.reason !== undefined && (typeof native.reason !== "string" || !NATIVE_REASONS.has(native.reason)))
      || (native.pid !== undefined && (!Number.isSafeInteger(native.pid) || native.pid <= 0)))) return false;
  if (!TASK_STATUSES.has(task.status)) return false;
  const hasKind = task.job_kind !== undefined;
  const hasJobStatus = task.job_status !== undefined;
  const hasPid = task.job_pid !== undefined;
  if (hasKind !== hasJobStatus) return false;
  if (!hasKind) return !hasPid && task.status !== "comparing";
  if (!TASK_JOB_KINDS.has(String(task.job_kind)) || !TASK_JOB_STATUSES.has(String(task.job_status))) return false;
  if (hasPid && (!Number.isSafeInteger(task.job_pid) || Number(task.job_pid) <= 0 || task.job_status !== "running")) {
    return false;
  }
  if (task.job_status === "queued" || task.job_status === "running") return task.status === "comparing";
  if (task.job_status === "succeeded") {
    return task.status === "pending_review" || task.status === "in_review" || task.status === "completed";
  }
  if (task.job_kind === "compare") return task.status === "compare_failed";
  return task.status === "pending_review" || task.status === "in_review" || task.status === "completed";
}

function isLegacyInterruptedTask(task: Task): boolean {
  return task.status === "comparing"
    && task.job_kind === undefined
    && task.job_status === undefined
    && task.job_pid === undefined;
}

function readTaskStore(allowLegacyInterrupted: boolean): { tasks: Task[]; unreadable: number } {
  const items: Task[] = [];
  let unreadable = 0;
  for (const name of readdirSync(tasksDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      const task = JSON.parse(readFileSync(join(tasksDir(), name), "utf8")) as Task;
      const expectedId = name.slice(0, -".json".length);
      if (
        !task
        || typeof task !== "object"
        || Array.isArray(task)
        || !isTid(task.id)
        || task.id !== expectedId
        || (!hasValidTaskJobState(task) && !(allowLegacyInterrupted && isLegacyInterruptedTask(task)))
      ) {
        throw new Error("invalid task record");
      }
      items.push(task);
    } catch {
      unreadable += 1;
    }
  }
  return { tasks: items, unreadable };
}

export function taskStoreSnapshot(): { tasks: Task[]; unreadable: number } {
  return readTaskStore(false);
}

/** Only boot recovery may see the one known v0.10 shape and convert it to failed. */
export function loadTasksForRecovery(): Task[] {
  return readTaskStore(true).tasks;
}

export function loadAllTasks(): Task[] {
  return taskStoreSnapshot().tasks;
}

export function taskOwner(task: Task): string {
  return String(task.owner || "").trim();
}

/** 回执属于具体账号；管理员权限也不能跨账号命中别人的幂等键。 */
export function findTaskBySourceReceipt(receiptId: string, owner: string): Task | undefined {
  if (!isTid(receiptId) || !owner) return undefined;
  return loadAllTasks().find(
    (task) => task.source_receipt === receiptId && taskOwner(task) === owner,
  );
}

export function assertCanAccessTask(task: Task, viewer: Viewer): void {
  if (!canAccessOwner(taskOwner(task), viewer)) {
    throw Object.assign(new Error("没有权限"), { status: 403 });
  }
}

export function listTasks(q: string, viewer: Viewer): Record<string, unknown>[] {
  const needle = q.trim().toLowerCase();
  const items = taskStoreSnapshot().tasks;
  const filtered = items.filter((t) => {
    if (!canAccessOwner(taskOwner(t), viewer)) return false;
    if (needle) {
      const hay = `${t.product_name || ""} ${t.title || ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const open = filtered.filter((t) => t.status !== "completed");
  const done = filtered.filter((t) => t.status === "completed");
  const byTime = (a: Task, b: Task) => String(b.created_at || "").localeCompare(String(a.created_at || ""));
  open.sort(byTime);
  done.sort(byTime);
  // 非管理员：报错字段脱敏 + 兜底（残留特征时整条隐藏并加 error_hidden / error_ticket，单号 = t.id）；管理员看原文。
  const guarded = (t: Task, row: Record<string, unknown>) =>
    viewer.admin ? row : { ...row, ...guardErrorFields(t.id, { error: row.error, job_error: row.job_error }) };
  return [...open, ...done].map((t) => guarded(t, {
    id: t.id,
    title: t.title,
    product_name: t.product_name || "",
    type: t.type,
    status: t.status,
    created_at: t.created_at,
    owner: t.created_by || t.actor || t.owner,
    completed_by: t.completed_by,
    complete_kind: t.status === "completed" ? cleanCompleteKind(t.complete_kind) : null,
    round: t.round || 1,
    board: boardColumn(t.status, t.job_status),
    error: typeof t.error === "string" ? t.error : t.job_error || "",
    job_kind: t.job_kind,
    job_status: t.job_status,
    job_stage: t.job_stage,
    job_stage_label: t.job_stage_label,
    job_eta_s: t.job_eta_s,
    job_error: t.job_error,
    job_started_at: t.job_started_at,
    job_finished_at: t.job_finished_at,
  }));
}

export const REVIEWABLE_STATUSES = ["pending_review", "in_review"] as const;
export const HIT_DECISIONS = ["confirm", "issue", "ignore"] as const;
const VERBATIM_STATUS_FILE = join(dirname(fileURLToPath(import.meta.url)), "../../backend/app/verbatim_statuses.json");
export const VERBATIM_STATUSES = JSON.parse(readFileSync(VERBATIM_STATUS_FILE, "utf8")) as {
  statuses: string[];
  true_errors: string[];
  space_errors: string[];
  warning: string;
  fsc_note: string;
};
const HIT_STATUSES = ["一致", "疑点", "缺失", "跳过", ...VERBATIM_STATUSES.statuses] as const;
export type HitDecision = (typeof HIT_DECISIONS)[number];

const VERBATIM_MODELS = ["PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_medium.onnx", "PP-OCRv6_rec_small.onnx"];

/** 模型目录、NOTICE 和三份权重都在时，才给新建核对单写标记。缺一就不写，旧路径保持今天的 argv。 */
export function newCompareVerbatimFlag(modelDir = process.env.VERBATIM_MODEL_DIR): { verbatim_check: true } | Record<string, never> {
  if (!modelDir || !existsSync(modelDir) || !existsSync(join(modelDir, "NOTICE"))) return {};
  if (!VERBATIM_MODELS.every((name) => existsSync(join(modelDir, name)))) return {};
  return { verbatim_check: true };
}

export function isReviewableStatus(status: string): boolean {
  return (REVIEWABLE_STATUSES as readonly string[]).includes(status);
}

export function isReworkableStatus(status: string): boolean {
  return status === "pending_review" || status === "in_review" || status === "completed";
}

export function hasReworkPages(task: { pages_v2?: unknown }): boolean {
  return Array.isArray(task.pages_v2) && task.pages_v2.length > 0;
}

export function isReworkableTask(task: { status: string; complete_kind?: string; pages_v2?: unknown }): boolean {
  if (hasReworkPages(task)) return false;
  if (task.status === "pending_review" || task.status === "in_review") return true;
  return task.status === "completed" && task.complete_kind === "rework";
}

export function activeHits(task: Task): Hit[] {
  const hits = task.verbatim_check === true
    ? (Array.isArray(task.hits_v2) ? task.hits_v2 : (Array.isArray(task.hits) ? task.hits : []))
    : (Array.isArray(task.hits_v2) && task.hits_v2.length > 0 ? task.hits_v2 : task.hits || []);
  return hits.filter((hit) => !skipPackSheetField(hit.field));
}

export function isHitDecision(value: unknown): value is HitDecision {
  return typeof value === "string" && (HIT_DECISIONS as readonly string[]).includes(value);
}

export function isValidHitReviewState(hit: Hit): boolean {
  if (!(HIT_STATUSES as readonly string[]).includes(String(hit.status || ""))) return false;
  const decision = hit.decision;
  return decision == null || decision === "pending" || isHitDecision(decision);
}

const TRUE_ERRORS = new Set([...VERBATIM_STATUSES.true_errors, "疑点", "缺失"]);
const SPACE_ERRORS = new Set(VERBATIM_STATUSES.space_errors);

export function hitNeedsDecision(hit: Hit): boolean {
  if (isHitDecision(hit.decision)) return false;
  if (hit.status === "待人工确认") return false;
  if (TRUE_ERRORS.has(String(hit.status || ""))) return true;
  return SPACE_ERRORS.has(String(hit.status || "")) && hit.decision === "pending";
}

export type BoardColumn = "comparing" | "failed" | "review" | "done";

export function boardColumn(status: string, jobStatus?: string): BoardColumn {
  if (status === "completed") return "done";
  if (status === "pending_review" || status === "in_review") return "review";
  if (status === "compare_failed" || jobStatus === "failed") return "failed";
  return "comparing";
}

export function deleteTask(tid: string): void {
  const task = loadTask(tid);
  if (task.native_text_request?.status === "running" || task.job_status === "queued" || task.job_status === "running") {
    throw Object.assign(new Error("对照还在跑，不能删。等结束或失败后再删。"), { status: 409 });
  }
  const p = join(tasksDir(), `${task.id}.json`);
  const uploads = join(DATA_DIR, "uploads", task.id);
  if (existsSync(uploads)) rmSync(uploads, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  unlinkSync(p);
  try { forgetHistory("review", task.id); } catch { /* 摘要失败不恢复已删除审稿 */ }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newTid(): string {
  return randomTid();
}

function randomTid(): string {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 12; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

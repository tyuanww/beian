import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * 统一历史只读摘要。权威记录仍在审稿/打样/上传/压缩目录。
 * 可信时查询只读 index.json；缺失或损坏则本次只重建一段并返回 503，不回空列表。
 */

export const HISTORY_SEGMENT_SIZE = 200;
const NAME_LIMIT = 40;
const MATCHED_NAME_LIMIT = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY = 200;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const TID = /^[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TZ = /^(Z|[+-](?:\d{2}):(?:\d{2}))$/;

const HISTORY_TYPES = ["review", "mockup", "upload", "compression"] as const;
export type HistoryType = (typeof HISTORY_TYPES)[number];
type HistoryVisibility = "owner" | "team" | "upload_owner";

const PHASES = ["review", "mockup", "upload_receipt", "upload_session", "compression"] as const;
type Phase = (typeof PHASES)[number];

const STATUS: Record<HistoryType, readonly string[]> = {
  review: ["comparing", "compare_failed", "pending_review", "in_review", "completed"],
  mockup: ["queued", "running", "review_required", "unsupported", "done", "failed"],
  upload: ["ready", "uploading"],
  compression: ["queued", "running", "done", "partial", "failed"],
};

const HISTORY_ERROR_CATALOG = {
  history_query_invalid: { status: 400, detail: "查询参数无效" },
  history_index_unavailable: { status: 503, detail: "历史索引还没准备好" },
  history_index_corrupt: { status: 503, detail: "历史索引已损坏" },
} as const;

export type HistoryErrorCode = keyof typeof HISTORY_ERROR_CATALOG;

export class HistoryProblem extends Error {
  readonly status: 400 | 503;
  readonly code: HistoryErrorCode;

  constructor(code: HistoryErrorCode) {
    const item = HISTORY_ERROR_CATALOG[code];
    super(item.detail);
    this.status = item.status;
    this.code = code;
  }
}

export type HistoryViewer = { id: string; name: string; admin: boolean };

type Stored = {
  id: string;
  type: HistoryType;
  title: string;
  product_name: string;
  status: string;
  created_at: string;
  creator_id: string;
  creator_name: string;
  names: string[];
  visibility: HistoryVisibility;
  access_owner: string;
  expires_at: string | null;
  has_unmet_target?: boolean;
  complete_kind?: string | null;
};

type OverlayOp =
  | { op: "upsert"; record: Stored }
  | { op: "delete"; type: HistoryType; id: string };

type Doc = {
  schema_version: 1;
  trusted: boolean;
  records: Stored[];
  overlay: OverlayOp[];
  scan: { phase: Phase; cursor: string } | null;
};

type HistoryItem = {
  id: string;
  type: HistoryType;
  title: string;
  product_name: string;
  status: string;
  created_at: string;
  creator_id: string;
  creator_name: string;
  names: string[];
  matched_names: string[];
  visibility: HistoryVisibility;
  /** 仅 review：signed / rework；未完成或旧任务为 null。 */
  complete_kind?: string | null;
};

export type HistoryPage = {
  items: HistoryItem[];
  next_cursor: string | null;
  total: number;
  facets: {
    type: Record<HistoryType, number>;
    status: Record<string, number>;
  };
};

type Filter = {
  q: string;
  type: HistoryType | "";
  status: string;
  creator: string;
  date_from: string;
  date_to: string;
  tz: string;
  fromMs: number | null;
  toMs: number | null;
  limit: number;
};

function historyProblem(code: HistoryErrorCode): HistoryProblem {
  return new HistoryProblem(code);
}

function indexFile(): string {
  return join(DATA_DIR, "history", "index.json");
}

function recordKey(record: Pick<Stored, "type" | "id">): string {
  return `${record.type}:${record.id}`;
}

function isHistoryType(value: string): value is HistoryType {
  return (HISTORY_TYPES as readonly string[]).includes(value);
}

function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

function cleanText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}

function baseName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const base = (slash >= 0 ? value.slice(slash + 1) : value).replace(/[\u0000-\u001f]/g, "").trim();
  if (!base || base === "." || base === "..") return null;
  return base.slice(0, 180);
}

function collectNames(values: unknown[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    const name = baseName(value);
    if (!name || names.includes(name)) continue;
    names.push(name);
    if (names.length >= NAME_LIMIT) break;
  }
  return names;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function storedFromParts(input: {
  id: string;
  type: HistoryType;
  title: string;
  product_name: string;
  status: string;
  created_at: string;
  creator_id: string;
  creator_name: string;
  names: string[];
  visibility: HistoryVisibility;
  access_owner: string;
  expires_at: string | null;
  has_unmet_target?: boolean;
  complete_kind?: string | null;
}): Stored | null {
  if (!TID.test(input.id) || !ISO.test(input.created_at)) return null;
  if (!STATUS[input.type].includes(input.status)) return null;
  if (input.expires_at !== null && !ISO.test(input.expires_at)) return null;
  if (input.type === "upload" && !input.creator_id.trim()) return null;
  return {
    id: input.id,
    type: input.type,
    title: cleanText(input.title, 200),
    product_name: cleanText(input.product_name, 200),
    status: input.status,
    created_at: input.created_at,
    creator_id: cleanText(input.creator_id, 120),
    creator_name: cleanText(input.creator_name, 120),
    names: input.names.slice(0, NAME_LIMIT),
    visibility: input.visibility,
    access_owner: cleanText(input.access_owner, 120),
    expires_at: input.expires_at,
    ...(input.type === "compression" ? { has_unmet_target: input.has_unmet_target === true } : {}),
    ...(input.type === "review" ? { complete_kind: cleanCompleteKind(input.complete_kind) } : {}),
  };
}

function parseStored(value: unknown): Stored | null {
  const raw = asObject(value);
  if (!raw || typeof raw.type !== "string" || !isHistoryType(raw.type)) return null;
  // Old compression summaries cannot answer the virtual filter; rebuild in bounded passes.
  if (raw.type === "compression" && typeof raw.has_unmet_target !== "boolean") return null;
  // Old review summaries lack complete_kind; rebuild in bounded passes like compression.
  if (raw.type === "review" && !("complete_kind" in raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.status !== "string" || typeof raw.created_at !== "string") return null;
  if (!Array.isArray(raw.names) || raw.visibility !== "owner" && raw.visibility !== "team" && raw.visibility !== "upload_owner") {
    return null;
  }
  return storedFromParts({
    id: raw.id,
    type: raw.type,
    title: typeof raw.title === "string" ? raw.title : "",
    product_name: typeof raw.product_name === "string" ? raw.product_name : "",
    status: raw.status,
    created_at: raw.created_at,
    creator_id: typeof raw.creator_id === "string" ? raw.creator_id : "",
    creator_name: typeof raw.creator_name === "string" ? raw.creator_name : "",
    names: raw.names.filter((name): name is string => typeof name === "string").slice(0, NAME_LIMIT),
    visibility: raw.visibility,
    access_owner: typeof raw.access_owner === "string" ? raw.access_owner : "",
    expires_at: raw.expires_at === null ? null : typeof raw.expires_at === "string" ? raw.expires_at : "bad",
    has_unmet_target: raw.has_unmet_target === true,
    complete_kind: typeof raw.complete_kind === "string" ? raw.complete_kind : null,
  });
}

export function cleanCompleteKind(value: unknown): string | null {
  return value === "signed" || value === "rework" ? value : null;
}

function parseDoc(value: unknown): Doc | null {
  const raw = asObject(value);
  if (!raw || raw.schema_version !== 1 || typeof raw.trusted !== "boolean" || !Array.isArray(raw.records) || !Array.isArray(raw.overlay)) {
    return null;
  }
  const records: Stored[] = [];
  const seen = new Set<string>();
  for (const item of raw.records) {
    const record = parseStored(item);
    if (!record) return null;
    const key = recordKey(record);
    if (seen.has(key)) return null;
    seen.add(key);
    records.push(record);
  }
  const overlay: OverlayOp[] = [];
  for (const item of raw.overlay) {
    const op = asObject(item);
    if (!op) return null;
    if (op.op === "delete") {
      if (typeof op.type !== "string" || !isHistoryType(op.type) || typeof op.id !== "string" || !TID.test(op.id)) return null;
      overlay.push({ op: "delete", type: op.type, id: op.id });
      continue;
    }
    if (op.op !== "upsert") return null;
    const record = parseStored(op.record);
    if (!record) return null;
    overlay.push({ op: "upsert", record });
  }
  let scan: Doc["scan"] = null;
  if (raw.scan !== null) {
    const cursor = asObject(raw.scan);
    if (!cursor || typeof cursor.phase !== "string" || !isPhase(cursor.phase) || typeof cursor.cursor !== "string") return null;
    scan = { phase: cursor.phase, cursor: cursor.cursor };
  }
  if (raw.trusted) {
    if (scan || overlay.length) return null;
  } else if (!scan) return null;
  return { schema_version: 1, trusted: raw.trusted, records, overlay, scan };
}

function emptyDoc(): Doc {
  return { schema_version: 1, trusted: false, records: [], overlay: [], scan: { phase: "review", cursor: "" } };
}

function discardIndex(): void {
  try {
    unlinkSync(indexFile());
  } catch {
    /* 已不在 */
  }
}

function atomicWrite(doc: Doc): void {
  const dest = indexFile();
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${basename(dest)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(JSON.stringify(doc)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 旧索引保持不变 */
    }
    throw err;
  }
}

function readDoc(): { kind: "missing" } | { kind: "corrupt" } | { kind: "ready"; doc: Doc } {
  if (!existsSync(indexFile())) return { kind: "missing" };
  try {
    const doc = parseDoc(JSON.parse(readFileSync(indexFile(), "utf8")) as unknown);
    return doc ? { kind: "ready", doc } : { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function listIds(phase: Phase): string[] {
  if (phase === "review") {
    return listDir(join(DATA_DIR, "tasks"))
      .filter((name) => name.endsWith(".json") && TID.test(name.slice(0, -5)))
      .map((name) => name.slice(0, -5))
      .sort();
  }
  if (phase === "mockup") {
    return listDir(join(DATA_DIR, "mockups")).filter((name) => TID.test(name)).sort();
  }
  if (phase === "upload_receipt") {
    return listDir(join(DATA_DIR, "uploads", "receipts"))
      .map((name) => /^([0-9a-f]{12})\.json$/.exec(name)?.[1] || "")
      .filter(Boolean)
      .sort();
  }
  if (phase === "upload_session") {
    return listDir(join(DATA_DIR, "uploads", "sessions")).filter((name) => TID.test(name)).sort();
  }
  return listDir(join(DATA_DIR, "compressions")).filter((name) => TID.test(name)).sort();
}

function freshIso(start: string): string | null {
  const at = Date.parse(start);
  if (!Number.isFinite(at)) return null;
  const expires = at + UPLOAD_TTL_MS;
  if (expires <= Date.now()) return null;
  return new Date(expires).toISOString();
}

function fileNames(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return collectNames(files.map((file) => asObject(file)?.name));
}

function projectReview(raw: Record<string, unknown>, id: string): Stored | null {
  if (raw.id !== id || typeof raw.created_at !== "string" || typeof raw.status !== "string") return null;
  const access = typeof raw.owner === "string" ? raw.owner : "";
  const createdBy = cleanText(raw.created_by, 120) || cleanText(raw.actor, 120);
  return storedFromParts({
    id,
    type: "review",
    title: cleanText(raw.title, 200),
    product_name: cleanText(raw.product_name, 200),
    status: raw.status,
    created_at: raw.created_at,
    creator_id: cleanText(access, 120),
    creator_name: createdBy || cleanText(access, 120),
    names: [],
    visibility: "owner",
    access_owner: access,
    expires_at: null,
    complete_kind: raw.status === "completed" ? cleanCompleteKind(raw.complete_kind) : null,
  });
}

function projectMockup(raw: Record<string, unknown>, id: string): Stored | null {
  if (raw.id !== id || typeof raw.created_at !== "string" || typeof raw.status !== "string") return null;
  const owner = typeof raw.owner === "string" ? raw.owner : "";
  const names = collectNames([
    ...fileNames(raw.files),
    baseName(raw.source_path),
  ].filter((name) => name !== null));
  return storedFromParts({
    id,
    type: "mockup",
    title: cleanText(raw.title, 200),
    product_name: "",
    status: raw.status,
    created_at: raw.created_at,
    creator_id: cleanText(owner, 120),
    creator_name: cleanText(raw.created_by, 120) || cleanText(owner, 120),
    names,
    visibility: "team",
    access_owner: owner,
    expires_at: null,
  });
}

function projectReceipt(raw: Record<string, unknown>, id: string): Stored | null {
  if (raw.id !== id || typeof raw.created_at !== "string" || typeof raw.owner !== "string") return null;
  const expires = freshIso(raw.created_at);
  if (!expires) return null;
  const names = fileNames(raw.files);
  const product = cleanText(raw.product_name, 200);
  return storedFromParts({
    id,
    type: "upload",
    title: product || names[0] || "上传",
    product_name: product,
    status: "ready",
    created_at: raw.created_at,
    creator_id: raw.owner,
    creator_name: raw.owner,
    names,
    visibility: "upload_owner",
    access_owner: raw.owner,
    expires_at: expires,
  });
}

function projectSession(raw: Record<string, unknown>, id: string): Stored | null {
  if (raw.id !== id || typeof raw.created_at !== "string" || typeof raw.updated_at !== "string" || typeof raw.owner !== "string") {
    return null;
  }
  const expires = freshIso(raw.updated_at);
  if (!expires || !ISO.test(raw.created_at)) return null;
  const names = fileNames(raw.files);
  const product = cleanText(raw.product_name, 200);
  return storedFromParts({
    id,
    type: "upload",
    title: product || names[0] || "上传",
    product_name: product,
    status: "uploading",
    created_at: raw.created_at,
    creator_id: raw.owner,
    creator_name: raw.owner,
    names,
    visibility: "upload_owner",
    access_owner: raw.owner,
    expires_at: expires,
  });
}

function projectCompression(raw: Record<string, unknown>, id: string): Stored | null {
  if (raw.id !== id || typeof raw.created_at !== "string" || typeof raw.status !== "string") return null;
  if (raw.delete_state != null && raw.delete_state !== "none") return null;
  if (existsSync(join(DATA_DIR, "compressions", id, "tombstone.json"))) return null;
  const owner = typeof raw.owner_id === "string" ? raw.owner_id : "";
  if (!owner.trim()) return null;
  return storedFromParts({
    id,
    type: "compression",
    title: cleanText(raw.title, 200),
    product_name: "",
    status: raw.status,
    created_at: raw.created_at,
    creator_id: owner,
    creator_name: cleanText(raw.created_by, 120) || owner,
    names: fileNames(raw.files),
    visibility: "team",
    access_owner: owner,
    expires_at: null,
    has_unmet_target: Array.isArray(raw.files) && raw.files.some((file) => asObject(file)?.status === "unmet_target"),
  });
}

function projectPhase(phase: Phase, id: string): Stored | null {
  if (phase === "review") {
    const raw = readJson(join(DATA_DIR, "tasks", `${id}.json`));
    return raw ? projectReview(raw, id) : null;
  }
  if (phase === "mockup") {
    const raw = readJson(join(DATA_DIR, "mockups", id, "job.json"));
    return raw ? projectMockup(raw, id) : null;
  }
  if (phase === "upload_receipt") {
    const raw = readJson(join(DATA_DIR, "uploads", "receipts", `${id}.json`));
    return raw ? projectReceipt(raw, id) : null;
  }
  if (phase === "upload_session") {
    if (existsSync(join(DATA_DIR, "uploads", "receipts", `${id}.json`))) return null;
    const raw = readJson(join(DATA_DIR, "uploads", "sessions", id, "session.json"));
    return raw ? projectSession(raw, id) : null;
  }
  const raw = readJson(join(DATA_DIR, "compressions", id, "batch.json"));
  return raw ? projectCompression(raw, id) : null;
}

function nextPhase(phase: Phase): Phase | null {
  const index = PHASES.indexOf(phase);
  return index >= 0 && index < PHASES.length - 1 ? PHASES[index + 1] : null;
}

function applyOverlay(map: Map<string, Stored>, overlay: OverlayOp[]): void {
  for (const op of overlay) {
    if (op.op === "delete") map.delete(`${op.type}:${op.id}`);
    else map.set(recordKey(op.record), op.record);
  }
}

function advance(doc: Doc): void {
  if (doc.trusted) return;
  let budget = HISTORY_SEGMENT_SIZE;
  let phase: Phase = doc.scan?.phase ?? "review";
  let cursor = doc.scan?.cursor ?? "";
  const map = new Map(doc.records.map((record) => [recordKey(record), record]));
  let emptyPasses = 0;
  while (budget > 0 && emptyPasses <= PHASES.length) {
    const ids = listIds(phase).filter((id) => id > cursor);
    if (!ids.length) {
      const next = nextPhase(phase);
      if (!next) {
        applyOverlay(map, doc.overlay);
        doc.records = [...map.values()];
        doc.overlay = [];
        doc.scan = null;
        doc.trusted = true;
        return;
      }
      phase = next;
      cursor = "";
      emptyPasses += 1;
      continue;
    }
    emptyPasses = 0;
    for (const id of ids.slice(0, budget)) {
      budget -= 1;
      cursor = id;
      const projected = projectPhase(phase, id);
      if (projected) map.set(recordKey(projected), projected);
    }
  }
  doc.records = [...map.values()];
  doc.scan = { phase, cursor };
  doc.trusted = false;
}

function collapse(overlay: OverlayOp[]): OverlayOp[] {
  const map = new Map<string, OverlayOp>();
  for (const op of overlay) {
    const key = op.op === "delete" ? `${op.type}:${op.id}` : recordKey(op.record);
    map.set(key, op);
  }
  return [...map.values()];
}

function mutate(apply: (doc: Doc) => void): void {
  const observed = readDoc();
  if (observed.kind === "missing") return;
  if (observed.kind === "corrupt") {
    discardIndex();
    return;
  }
  try {
    apply(observed.doc);
    if (!observed.doc.trusted) observed.doc.overlay = collapse(observed.doc.overlay);
    atomicWrite(observed.doc);
  } catch {
    discardIndex();
  }
}

export function noteHistoryReview(task: {
  id: string;
  title?: string;
  product_name?: string;
  status?: string;
  created_at?: string;
  owner?: string;
  created_by?: string;
  actor?: string;
  complete_kind?: string;
}): void {
  const record = projectReview(task as unknown as Record<string, unknown>, task.id);
  if (record) upsertRecord(record);
}

export function noteHistoryMockup(job: {
  id: string;
  title?: string;
  status?: string;
  created_at?: string;
  owner?: string;
  created_by?: string;
  files?: { name?: string }[];
  source_path?: string;
}): void {
  const record = projectMockup(job as unknown as Record<string, unknown>, job.id);
  if (record) upsertRecord(record);
}

export function noteHistoryCompression(batch: {
  id: string;
  title?: string;
  status?: string;
  created_at?: string;
  owner_id?: string;
  created_by?: string;
  delete_state?: string;
  files?: { name?: string; status?: string }[];
}): void {
  if (batch.delete_state && batch.delete_state !== "none") {
    forgetHistory("compression", batch.id);
    return;
  }
  const record = projectCompression(batch as unknown as Record<string, unknown>, batch.id);
  if (record) upsertRecord(record);
  else forgetHistory("compression", batch.id);
}

export function noteHistoryUploadId(id: string): void {
  if (!TID.test(id)) return;
  const receipt = readJson(join(DATA_DIR, "uploads", "receipts", `${id}.json`));
  if (receipt) {
    const record = projectReceipt(receipt, id);
    if (record) upsertRecord(record);
    else forgetHistory("upload", id);
    return;
  }
  const session = readJson(join(DATA_DIR, "uploads", "sessions", id, "session.json"));
  if (session) {
    const record = projectSession(session, id);
    if (record) upsertRecord(record);
    else forgetHistory("upload", id);
    return;
  }
  forgetHistory("upload", id);
}

export function forgetHistory(type: HistoryType, id: string): void {
  if (!TID.test(id)) return;
  mutate((doc) => {
    if (doc.trusted) {
      doc.records = doc.records.filter((record) => record.type !== type || record.id !== id);
      return;
    }
    doc.overlay.push({ op: "delete", type, id });
  });
}

function upsertRecord(record: Stored): void {
  mutate((doc) => {
    if (doc.trusted) {
      const index = doc.records.findIndex((item) => item.type === record.type && item.id === record.id);
      if (index >= 0) doc.records[index] = record;
      else doc.records.push(record);
      return;
    }
    doc.overlay.push({ op: "upsert", record });
  });
}

function offsetMinutes(tz: string): number | null {
  if (tz === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return (match[1] === "+" ? 1 : -1) * (hours * 60 + minutes);
}

function startOfZonedDay(day: string, tz: string): number | null {
  const match = DAY.exec(day);
  const offset = offsetMinutes(tz);
  if (!match || offset === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || date < 1 || date > 31) return null;
  const utc = Date.UTC(year, month - 1, date) - offset * 60_000;
  const shifted = new Date(utc + offset * 60_000);
  if (shifted.getUTCFullYear() !== year || shifted.getUTCMonth() !== month - 1 || shifted.getUTCDate() !== date) return null;
  return utc;
}

function one(values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.length !== 1) throw historyProblem("history_query_invalid");
  return values[0];
}

function parseFilter(queries: Record<string, string[]>): Filter {
  const allowed = new Set(["q", "type", "status", "creator", "date_from", "date_to", "tz", "cursor", "limit"]);
  if (Object.keys(queries).some((key) => !allowed.has(key))) throw historyProblem("history_query_invalid");
  const q = one(queries.q) ?? "";
  const typeRaw = one(queries.type) ?? "";
  const status = one(queries.status) ?? "";
  const creator = one(queries.creator) ?? "";
  const dateFrom = one(queries.date_from) ?? "";
  const dateTo = one(queries.date_to) ?? "";
  const tz = one(queries.tz) ?? "";
  const limitRaw = one(queries.limit);
  const cursor = one(queries.cursor);
  if (q.length > MAX_QUERY || creator.length > 120) throw historyProblem("history_query_invalid");
  if (typeRaw && !isHistoryType(typeRaw)) throw historyProblem("history_query_invalid");
  if (status) {
    const vocab = typeRaw ? STATUS[typeRaw as HistoryType] : Object.values(STATUS).flat();
    const virtual = status === "unmet_target" && (!typeRaw || typeRaw === "compression");
    if (!virtual && !vocab.includes(status)) throw historyProblem("history_query_invalid");
  }
  if ((dateFrom || dateTo) && !TZ.test(tz)) throw historyProblem("history_query_invalid");
  if (tz && !TZ.test(tz)) throw historyProblem("history_query_invalid");
  const fromMs = dateFrom ? startOfZonedDay(dateFrom, tz || "Z") : null;
  const toStart = dateTo ? startOfZonedDay(dateTo, tz || "Z") : null;
  if ((dateFrom && fromMs === null) || (dateTo && toStart === null)) throw historyProblem("history_query_invalid");
  const toMs = toStart === null ? null : toStart + 86_400_000;
  if (fromMs !== null && toMs !== null && fromMs >= toMs) throw historyProblem("history_query_invalid");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitRaw)) throw historyProblem("history_query_invalid");
    limit = Number(limitRaw);
    if (limit > MAX_LIMIT) throw historyProblem("history_query_invalid");
  }
  if (cursor !== undefined && !cursor) throw historyProblem("history_query_invalid");
  return {
    q: q.trim(),
    type: typeRaw as HistoryType | "",
    status,
    creator,
    date_from: dateFrom,
    date_to: dateTo,
    tz,
    fromMs,
    toMs,
    limit,
    ...(cursor ? {} : {}),
  };
}

type CursorBody = {
  v: 1;
  q: string;
  type: string;
  status: string;
  creator: string;
  date_from: string;
  date_to: string;
  tz: string;
  limit: number;
  scope: string;
  bound: string;
  created_at: string;
  rec_type: HistoryType;
  id: string;
};

function scopeOf(viewer: HistoryViewer): string {
  return `${viewer.admin ? "1" : "0"}\u0000${viewer.id}\u0000${viewer.name}`;
}

function decodeCursor(raw: string, filter: Filter, viewer: HistoryViewer): CursorBody {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
  } catch {
    throw historyProblem("history_query_invalid");
  }
  const rawCursor = asObject(value);
  if (!rawCursor) throw historyProblem("history_query_invalid");
  const keys = Object.keys(rawCursor).sort();
  const expected = ["bound", "created_at", "creator", "date_from", "date_to", "id", "limit", "q", "rec_type", "scope", "status", "type", "tz", "v"];
  if (keys.join() !== expected.join() || rawCursor.v !== 1) throw historyProblem("history_query_invalid");
  const cursor = rawCursor as unknown as CursorBody;
  if (
    cursor.q !== filter.q ||
    cursor.type !== filter.type ||
    cursor.status !== filter.status ||
    cursor.creator !== filter.creator ||
    cursor.date_from !== filter.date_from ||
    cursor.date_to !== filter.date_to ||
    cursor.tz !== filter.tz ||
    cursor.limit !== filter.limit ||
    cursor.scope !== scopeOf(viewer) ||
    typeof cursor.bound !== "string" ||
    !ISO.test(cursor.bound) ||
    typeof cursor.created_at !== "string" ||
    !ISO.test(cursor.created_at) ||
    typeof cursor.rec_type !== "string" ||
    !isHistoryType(cursor.rec_type) ||
    typeof cursor.id !== "string" ||
    !TID.test(cursor.id)
  ) {
    throw historyProblem("history_query_invalid");
  }
  return cursor;
}

function encodeCursor(filter: Filter, viewer: HistoryViewer, bound: string, item: HistoryItem): string {
  const body: CursorBody = {
    v: 1,
    q: filter.q,
    type: filter.type,
    status: filter.status,
    creator: filter.creator,
    date_from: filter.date_from,
    date_to: filter.date_to,
    tz: filter.tz,
    limit: filter.limit,
    scope: scopeOf(viewer),
    bound,
    created_at: item.created_at,
    rec_type: item.type,
    id: item.id,
  };
  return Buffer.from(JSON.stringify(body)).toString("base64url");
}

function canSee(record: Stored, viewer: HistoryViewer): boolean {
  if (record.visibility === "upload_owner") return record.creator_id === viewer.id;
  if (record.visibility === "team") return true;
  if (viewer.admin) return true;
  const expected = record.access_owner.trim();
  return Boolean(expected) && (expected === viewer.id || expected === viewer.name);
}

function live(record: Stored, now: number): boolean {
  if (!record.expires_at) return true;
  const at = Date.parse(record.expires_at);
  return Number.isFinite(at) && at > now;
}

function newer(a: Pick<Stored, "created_at" | "type" | "id">, b: Pick<Stored, "created_at" | "type" | "id">): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.type !== b.type) return a.type < b.type ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

function afterCursor(record: Stored, cursor: CursorBody): boolean {
  return newer(record, { created_at: cursor.created_at, type: cursor.rec_type, id: cursor.id }) > 0;
}

function matches(record: Stored, filter: Filter, now: number): boolean {
  if (!live(record, now)) return false;
  if (filter.type && record.type !== filter.type) return false;
  if (filter.status === "unmet_target") {
    if (record.type !== "compression" || !record.has_unmet_target) return false;
  } else if (filter.status && record.status !== filter.status) return false;
  if (filter.creator && record.creator_id !== filter.creator && record.creator_name !== filter.creator) return false;
  const at = Date.parse(record.created_at);
  if (!Number.isFinite(at)) return false;
  if (filter.fromMs !== null && at < filter.fromMs) return false;
  if (filter.toMs !== null && at >= filter.toMs) return false;
  if (!filter.q) return true;
  const needle = filter.q.toLowerCase();
  const hay = `${record.product_name}\n${record.title}`.toLowerCase();
  if (hay.includes(needle)) return true;
  return record.names.some((name) => name.toLowerCase().includes(needle));
}

function toItem(record: Stored, needle: string): HistoryItem {
  const matched = needle
    ? record.names.filter((name) => name.toLowerCase().includes(needle)).slice(0, MATCHED_NAME_LIMIT)
    : [];
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    product_name: record.product_name,
    status: record.status,
    created_at: record.created_at,
    creator_id: record.creator_id,
    creator_name: record.creator_name,
    names: record.names,
    matched_names: matched,
    visibility: record.visibility,
    ...(record.type === "review" ? { complete_kind: record.complete_kind ?? null } : {}),
  };
}

function answer(doc: Doc, viewer: HistoryViewer, filter: Filter, cursorRaw: string | undefined): HistoryPage {
  const now = Date.now();
  const cursor = cursorRaw ? decodeCursor(cursorRaw, filter, viewer) : null;
  const visible = doc.records.filter((record) => canSee(record, viewer));
  const selected = visible.filter((record) => matches(record, filter, now));
  let bound = cursor?.bound ?? new Date().toISOString();
  if (!cursor) {
    for (const record of selected) {
      if (record.created_at > bound) bound = record.created_at;
    }
  }
  const matched = selected.filter((record) => record.created_at <= bound);
  const needle = filter.q.toLowerCase();
  const facets = {
    type: { review: 0, mockup: 0, upload: 0, compression: 0 },
    status: {} as Record<string, number>,
  };
  for (const record of matched) {
    facets.type[record.type] += 1;
    facets.status[record.status] = (facets.status[record.status] || 0) + 1;
    if (record.type === "compression" && record.has_unmet_target) {
      facets.status.unmet_target = (facets.status.unmet_target || 0) + 1;
    }
  }
  const rows = matched
    .filter((record) => (cursor ? afterCursor(record, cursor) : true))
    .sort(newer);
  const page = rows.slice(0, filter.limit).map((record) => toItem(record, needle));
  const next = rows.length > filter.limit && page.length ? encodeCursor(filter, viewer, bound, page[page.length - 1]) : null;
  return { items: page, next_cursor: next, total: matched.length, facets };
}

export function queryHistory(viewer: HistoryViewer, queries: Record<string, string[]>): HistoryPage {
  const filter = parseFilter(queries);
  const cursorRaw = one(queries.cursor);
  const observed = readDoc();
  if (observed.kind !== "ready" || !observed.doc.trusted) {
    const code = observed.kind === "corrupt" ? "history_index_corrupt" : "history_index_unavailable";
    if (observed.kind === "corrupt") discardIndex();
    const doc = observed.kind === "ready" ? observed.doc : emptyDoc();
    try {
      advance(doc);
      atomicWrite(doc);
    } catch {
      discardIndex();
    }
    throw historyProblem(code);
  }
  return answer(observed.doc, viewer, filter, cursorRaw);
}

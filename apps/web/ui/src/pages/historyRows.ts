import type { MockupJob, TaskSummary } from "../api";
import { MOCKUP_STATUS_LABEL, NAV_LABEL, REVIEW_STATUS_LABEL, reviewCompletedLabel } from "../copy/labels";
import { liveJobLine } from "./waitCard";

export type HistoryRow = {
  resource: "task" | "mockup" | "upload";
  /** 逻辑 key；显示名用 historyKindLabel()。 */
  kind: "compare" | "mockup";
  id: string;
  uploadId?: string | null;
  uploadKind?: "compare" | "mockup";
  title: string;
  status: string;
  color: "default" | "warning" | "error" | "processing" | "success";
  at: string;
  actor: string;
  live: string | null;
};

export type HistoryKindFilter = "all" | HistoryRow["kind"];
export type HistoryTimeFilter = "all" | "today" | "7d" | "30d";

const KIND_FILTERS: readonly HistoryKindFilter[] = ["all", "compare", "mockup"];
const TIME_FILTERS: readonly HistoryTimeFilter[] = ["all", "today", "7d", "30d"];

export function historyKindLabel(kind: HistoryRow["kind"]): string {
  return kind === "compare" ? NAV_LABEL.review : NAV_LABEL.mockup;
}

/** 旧版本存下的中文筛选值（如 "审稿台"、"近 7 天"）或任何未知值一律回退到 all（全部），不抛错。 */
export function normalizeHistoryKindFilter(value: unknown): HistoryKindFilter {
  return KIND_FILTERS.includes(value as HistoryKindFilter) ? (value as HistoryKindFilter) : "all";
}

export function normalizeHistoryTimeFilter(value: unknown): HistoryTimeFilter {
  return TIME_FILTERS.includes(value as HistoryTimeFilter) ? (value as HistoryTimeFilter) : "all";
}

export type HistoryFilters = {
  kind: HistoryKindFilter;
  time: HistoryTimeFilter;
  actor: string;
  range?: { from: Date; to: Date } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_PAGE_SIZE = 10;

export function paginateHistoryRows(
  rows: HistoryRow[],
  requestedPage: number,
  pageSize = HISTORY_PAGE_SIZE,
): { page: number; pageCount: number; rows: HistoryRow[] } {
  const safeSize = Number.isFinite(pageSize) ? Math.max(1, Math.trunc(pageSize)) : HISTORY_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(rows.length / safeSize));
  const normalizedPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1;
  const page = Math.min(pageCount, Math.max(1, normalizedPage));
  const start = (page - 1) * safeSize;
  return { page, pageCount, rows: rows.slice(start, start + safeSize) };
}

function taskLive(row: TaskSummary): string | null {
  return liveJobLine({
    job_status: row.job_status,
    job_stage_label: row.job_stage_label,
    job_eta_s: row.job_eta_s,
    queue_ahead: row.queue_ahead,
    kind: row.job_kind === "rework" ? "rework" : "compare",
  });
}

function mockLive(row: MockupJob): string | null {
  const job_status =
    row.job_status || (row.status === "queued" || row.status === "running" ? row.status : undefined);
  return liveJobLine({
    job_status,
    job_stage_label: row.job_stage_label,
    job_eta_s: row.job_eta_s,
    queue_ahead: row.queue_ahead,
    kind: "mockup",
  });
}

export function historyTaskRow(row: TaskSummary): HistoryRow {
  const live = taskLive(row);
  let status = row.status;
  let color: HistoryRow["color"] = "default";
  if (row.job_status === "queued" || row.job_status === "running" || row.status === "comparing") {
    status = row.job_kind === "rework" ? REVIEW_STATUS_LABEL.reworking : REVIEW_STATUS_LABEL.comparing;
    color = "processing";
  } else if (row.status === "completed") {
    status = reviewCompletedLabel(row.complete_kind);
    color = "success";
  } else if (row.status === "in_review" || row.status === "pending_review") {
    status = REVIEW_STATUS_LABEL.pending;
    color = "warning";
  } else if (row.status === "compare_failed" || row.job_status === "failed") {
    status = row.job_error || row.error || REVIEW_STATUS_LABEL.compare_failed;
    color = "error";
  }
  return {
    resource: "task",
    kind: "compare",
    id: row.id,
    title: row.product_name || row.title,
    status,
    color,
    at: row.created_at || "",
    // “生成人”始终是建单人；签字人只代表完成动作，不能改写筛选维度。
    actor: row.owner || "",
    live,
  };
}

export function historyMockRow(row: MockupJob): HistoryRow {
  const live = mockLive(row);
  let status = "打样";
  let color: HistoryRow["color"] = "default";
  if (
    row.status === "running" ||
    row.status === "queued" ||
    row.job_status === "running" ||
    row.job_status === "queued"
  ) {
    status = MOCKUP_STATUS_LABEL.running;
    color = "processing";
  } else if (row.status === "done") {
    status = MOCKUP_STATUS_LABEL.done;
    color = "success";
  } else if (row.structure_status === "review_required") {
    status = row.structure_code === "structure_face_mapping_incomplete" ? MOCKUP_STATUS_LABEL.needFront : MOCKUP_STATUS_LABEL.failed;
    color = row.structure_code === "structure_face_mapping_incomplete" ? "warning" : "error";
  } else if (row.structure_status === "unsupported") {
    status = MOCKUP_STATUS_LABEL.unsupported;
    color = "error";
  } else if (row.status === "failed") {
    status = MOCKUP_STATUS_LABEL.interrupted;
    color = "error";
  } else {
    status = row.status;
  }
  return {
    resource: "mockup",
    kind: "mockup",
    id: row.id,
    title: row.title || row.files[0]?.name || row.id.slice(0, 8),
    status,
    color,
    at: row.created_at || "",
    actor: row.owner || "",
    live,
  };
}


export function historyHasLive(rows: HistoryRow[]): boolean {
  return rows.some((r) => r.color === "processing");
}

export function historyRowKey(row: HistoryRow): string {
  return `${row.resource}-${row.id}`;
}

export function historyCanDelete(row: HistoryRow): boolean {
  return row.color !== "processing";
}

export function historySelectionState(rows: HistoryRow[], selected: string[]): {
  keys: string[];
  all: boolean;
  some: boolean;
} {
  const keys = rows.filter(historyCanDelete).map(historyRowKey);
  const chosen = new Set(selected);
  const selectedCount = keys.reduce((count, key) => count + Number(chosen.has(key)), 0);
  return {
    keys,
    all: keys.length > 0 && selectedCount === keys.length,
    some: selectedCount > 0 && selectedCount < keys.length,
  };
}

export function historyActors(rows: HistoryRow[]): string[] {
  return [...new Set(rows.map((row) => row.actor.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
}

function timeFloor(filter: HistoryTimeFilter, now: Date): number | null {
  if (filter === "all") return null;
  if (filter === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  return now.getTime() - (filter === "7d" ? 7 : 30) * DAY_MS;
}

export function filterHistoryRows(
  rows: HistoryRow[],
  filters: HistoryFilters,
  now = new Date(),
): HistoryRow[] {
  const customFrom = filters.range?.from.getTime();
  const customTo = filters.range?.to.getTime();
  const kind = normalizeHistoryKindFilter(filters.kind);
  const floor = Number.isFinite(customFrom) ? customFrom! : timeFloor(normalizeHistoryTimeFilter(filters.time), now);
  const ceiling = Number.isFinite(customTo) ? customTo! : now.getTime();
  return rows.filter((row) => {
    if (kind !== "all" && row.kind !== kind) return false;
    if (filters.actor && row.actor !== filters.actor) return false;
    if (floor !== null) {
      const at = new Date(row.at).getTime();
      if (!Number.isFinite(at) || at < floor || at > ceiling) return false;
    }
    return true;
  });
}

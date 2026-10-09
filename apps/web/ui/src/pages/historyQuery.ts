import type { HistoryItem } from "../batchTypes";
export type HistoryTimeMode = "all" | "recent" | "custom";
export type HistoryFilters = { q: string; type: "" | HistoryItem["type"]; status: string; creator: string; date_from: string; date_to: string; time_mode: HistoryTimeMode };
export const emptyHistoryFilters: HistoryFilters = { q: "", type: "", status: "", creator: "", date_from: "", date_to: "", time_mode: "all" };
export function historyTimeFilters(mode: HistoryTimeMode, now = new Date()): Pick<HistoryFilters, "time_mode" | "date_from" | "date_to"> {
  if (mode !== "recent") return { time_mode: mode, date_from: "", date_to: "" };
  const from = new Date(now);
  from.setDate(from.getDate() - 6);
  const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { time_mode: mode, date_from: day(from), date_to: day(now) };
}
export function historyQuery(filters: HistoryFilters, cursor = "", offset = new Date().getTimezoneOffset()): string {
  const query = new URLSearchParams({ limit: "10" });
  // Time presets belong to the UI; the API only receives concrete date bounds.
  for (const key of ["q", "type", "status", "creator", "date_from", "date_to"] as const) {
    const value = filters[key].trim();
    if (value) query.set(key, value);
  }
  if (cursor) query.set("cursor", cursor);
  if (filters.date_from || filters.date_to) {
    const minutes = Math.abs(offset);
    query.set("tz", offset === 0 ? "Z" : `${offset > 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  return query.toString();
}
export const historyTypeLabels: Record<HistoryItem["type"], string> = { review: "审稿", mockup: "打样", compression: "压缩", upload: "上传" };
export function historyKey(row: HistoryItem) { return `${row.type}:${row.id}`; }
export function historyLive(row: HistoryItem) { return ["queued", "running", "uploading", "comparing", "reworking"].includes(row.status); }
export function historyDeletable(row: HistoryItem) { return !historyLive(row); }
export function historyStatusColor(status: string) {
  if (["failed", "compare_failed"].includes(status)) return "error";
  if (["queued", "running", "uploading", "comparing", "reworking"].includes(status)) return "processing";
  if (["partial", "unsupported", "review_required", "unmet_target"].includes(status)) return "warning";
  return "default";
}

import type { HistoryItem } from "../batchTypes";
export type HistoryFilters = { q: string; type: "" | HistoryItem["type"]; status: string; creator: string; date_from: string; date_to: string };
export const emptyHistoryFilters: HistoryFilters = { q: "", type: "", status: "", creator: "", date_from: "", date_to: "" };
export function historyQuery(filters: HistoryFilters, cursor = "", offset = new Date().getTimezoneOffset()): string {
  const query = new URLSearchParams({ limit: "10" });
  for (const [key, value] of Object.entries(filters)) if (value.trim()) query.set(key, value.trim());
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

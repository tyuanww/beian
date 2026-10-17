export type UnfoldedPrint = {
  status: "unavailable" | "queued" | "running" | "ready" | "failed";
  reason?: string;
  file_key?: "unfolded_print";
  width_mm?: number;
  height_mm?: number;
};
export type CompressionFile = {
  id: string; name: string; media_type: string;
  status: "queued" | "running" | "succeeded" | "passthrough" | "unmet_target" | "unsupported" | "failed";
  input_bytes: number; output_bytes: number | null; target_bytes: number | null;
  reason: string | null; message: string; can_retry: boolean; key?: string;
};
export type CompressionBatch = {
  id: string; title: string; created_at: string; revision: number;
  status: "queued" | "running" | "done" | "partial" | "failed";
  owner: string | null; creator_id: string; queue_ahead: number; files: CompressionFile[];
};
export type HistoryItem = {
  id: string; type: "review" | "mockup" | "upload" | "compression";
  title: string; product_name: string; status: string; created_at: string;
  creator_id: string; creator_name: string | null; names: string[]; matched_names: string[];
  visibility: "owner" | "team" | "upload_owner";
};
export type HistoryResult = {
  items: HistoryItem[]; next_cursor: string | null; total: number;
  facets: { type: Record<HistoryItem["type"], number>; status: Record<string, number> };
};

/** Public, per-field evidence; it never changes the field's result or decision. */
export type NativeTextEvidence = {
  version: 1;
  status: "used" | "conflict" | "not_used";
  native_text: string | null;
  ocr_text: string | null;
  message: string;
};

export function nativeEvidenceView(value: unknown) {
  if (value == null) return null;
  const invalid = { title: "文字来源暂无法确认", message: "证据信息不完整，请按稿面继续核对。", nativeText: null, ocrText: null };
  if (typeof value !== "object" || Array.isArray(value)) return invalid;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !["used", "conflict", "not_used"].includes(String(item.status))) return invalid;
  const validText = (text: unknown) => text === null || (typeof text === "string" && text.length <= 8192);
  if (!validText(item.native_text) || !validText(item.ocr_text) || typeof item.message !== "string" || !item.message.trim() || item.message.length > 500) return invalid;
  if (item.status === "used" && (typeof item.native_text !== "string" || !item.native_text.trim())) return invalid;
  return {
    title: item.status === "used" ? "已参考原稿文字" : item.status === "conflict" ? "文字来源有冲突，需人工核对" : "原稿文字未采用",
    message: item.message,
    nativeText: item.native_text as string | null,
    ocrText: item.ocr_text as string | null,
  };
}

/** 历史记录文件摘要：按文件名分类（第一期，无后端 key），纯函数。 */

export type FileKind = "model" | "ppt" | "effect" | "white" | "card" | "face" | "sheet" | "confirm" | "source" | "pdf" | "image" | "other";

/** 与 server/src/historyIndex.ts NAME_LIMIT 保持一致：names 达到此数即可能被截断。 */
export const HISTORY_NAME_LIMIT = 40;

const KIND_ORDER: FileKind[] = ["model", "ppt", "effect", "white", "card", "face", "sheet", "confirm", "source", "pdf", "image", "other"];
const KIND_LABEL: Record<FileKind, string> = {
  model: "3D 模型", ppt: "展示 PPT", effect: "效果图", white: "白底图", card: "卡片图", face: "印刷面",
  sheet: "平面图 PDF", confirm: "确认表", source: "源稿", pdf: "PDF", image: "图片", other: "其他",
};
/** 单件类：数量为 1 时摘要不写数字。 */
const SINGLE_KINDS = new Set<FileKind>(["model", "ppt", "sheet", "confirm", "source"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp"]);

function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function classifyFile(name: string): FileKind {
  const ext = extOf(name);
  const lower = name.toLowerCase();
  if (ext === "glb" || ext === "gltf") return "model";
  if (ext === "pptx" || ext === "ppt") return "ppt";
  if (ext === "ai" || ext === "eps" || ext === "psd") return "source";
  // 必须先于白底图规则：cc99285d_white_sheet.pdf 是平面图，不是白底图。
  if (ext === "pdf" && /sheet|unfolded|展开/.test(lower)) return "sheet";
  if (IMAGE_EXT.has(ext)) {
    if (/_white(?=[_.])/.test(lower)) return "white";
    // _back_left_ground_card.png 同时含 ground 与 card：卡片图优先。
    if (/_card(?=[_.])/.test(lower)) return "card";
    if (/(front|back)_(left|right)|_ground(?=[_.])|_set(?=[_.])/.test(lower)) return "effect";
    if (/(^|[_\-.])(front|back|left|right|top|bottom)(?=[_\-.])/.test(lower)) return "face";
    return "image";
  }
  if (ext === "xlsx" || ext === "xls") return "confirm";
  if (ext === "pdf") return "pdf";
  return "other";
}

type FileGroup = { kind: FileKind; label: string; files: string[] };
export type FileSummary = { groups: FileGroup[]; summary: string; total: number; truncated: boolean; matched: number };

/** names 为记录文件（可能被截断），matched 为搜索命中的文件；命中文件在组内排最前。 */
export function summarizeFiles(names: readonly string[], matched: readonly string[] = []): FileSummary {
  const hit = new Set(matched);
  const all = [...new Set([...names, ...matched].filter(name => typeof name === "string" && name.trim()))];
  const buckets = new Map<FileKind, string[]>();
  for (const name of all) {
    const kind = classifyFile(name);
    buckets.set(kind, [...(buckets.get(kind) || []), name]);
  }
  const groups: FileGroup[] = KIND_ORDER.filter(kind => buckets.has(kind)).map(kind => {
    const files = buckets.get(kind)!;
    return { kind, label: KIND_LABEL[kind], files: [...files.filter(f => hit.has(f)), ...files.filter(f => !hit.has(f))] };
  });
  const truncated = names.length >= HISTORY_NAME_LIMIT;
  const parts = groups.map(g => SINGLE_KINDS.has(g.kind) && g.files.length === 1 ? g.label : `${g.label} ${g.files.length}`);
  const summary = parts.length ? parts.join(" · ") + (truncated ? " 等" : "") : "";
  return { groups, summary, total: all.length, truncated, matched: all.filter(f => hit.has(f)).length };
}

export function expandLabel(s: Pick<FileSummary, "total" | "truncated">, open: boolean): string {
  if (open) return "收起";
  return s.truncated ? `展开前 ${s.total} 个文件（还有更多）` : `展开 ${s.total} 个文件`;
}

/** 把 name 按搜索词（不区分大小写）切成片段，用于 <mark> 高亮。 */
export function splitHit(name: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text: name, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const lower = name.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    if (i > at) out.push({ text: name.slice(at, i), hit: false });
    out.push({ text: name.slice(i, i + q.length), hit: true });
    at = i + q.length;
  }
  if (at < name.length) out.push({ text: name.slice(at), hit: false });
  return out;
}

/**
 * 旧任务 JSON 里存着以「我」自称、或一行提示带句末「。」的系统文案（fields.py 生成）。
 * 落盘数据不改；只在返回给客户端时按原句精确替换（evidence 可能带「… · 」前缀，所以按子串）。
 * 新对照已由 backend 直接生成新文案，这里只兜底老单。
 */
export const LEGACY_FIRST_PERSON_COPY: ReadonlyArray<readonly [string, string]> = [
  ["确认单要的净含量，我在这一面没读到。", "确认单要的净含量，这一面没读到，请核对"],
  ["确认单要的毫升和条码，我在这一面没读全。", "确认单要的毫升和条码，这一面没读全，请核对"],
  // 一行提示不带句末句号（产品哥 2026-10-11）：只改写这两句已知会落盘的原句。
  ["净含量和条码都在这一面读到了。", "净含量和条码都在这一面读到了"],
  ["净含量和条码没有都读全，请对着这一面看毫升和条码。", "净含量和条码没有都读全，请对着这一面看毫升和条码"],
];

export function rewriteLegacyCopy(text: string): string {
  let out = text;
  for (const [from, to] of LEGACY_FIRST_PERSON_COPY) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

function rewriteHit(hit: unknown): unknown {
  if (!hit || typeof hit !== "object") return hit;
  const ev = (hit as { evidence?: unknown }).evidence;
  if (typeof ev !== "string") return hit;
  const next = rewriteLegacyCopy(ev);
  return next === ev ? hit : { ...(hit as Record<string, unknown>), evidence: next };
}

/** 不修改入参；只有命中旧句时才复制数组/对象。 */
export function rewriteLegacyHits<T>(hits: T): T {
  if (!Array.isArray(hits)) return hits;
  let changed = false;
  const out = hits.map((hit) => {
    const next = rewriteHit(hit);
    if (next !== hit) changed = true;
    return next;
  });
  return (changed ? out : hits) as T;
}

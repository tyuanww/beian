/** 对照卡两列、抬头、翻页和没标出的原因。右栏不走这里。 */
import type { FieldHit } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import { excelText } from "./hitText";

export type SpotSpan = [number, number];
type SpanOmit = "duplicate" | "unmatched";

export type SpotColumn = {
  title: string;
  body: string;
  /** 非空才是整句，才允许标出和没标出的原因。 */
  sentence: string;
  span: SpotSpan | null;
  omit: SpanOmit | null;
  notes: string[];
};

function hasKey(hit: FieldHit, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(hit, key);
}

function spanOf(value: unknown): SpotSpan | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const start = value[0];
  const end = value[1];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
  return [start, end];
}

function omitOf(value: unknown): SpanOmit | null {
  return value === "duplicate" || value === "unmatched" ? value : null;
}

function fragment(hit: FieldHit): string {
  const text = excelText(hit);
  return text === "—" ? "" : text;
}

/** 右列只取一档。翻边不交换，所以没有 side 参数。 */
export function spotColumns(hit: FieldHit): { left: SpotColumn; right: SpotColumn } {
  const hasManuscript = hasKey(hit, "manuscript");
  const manuscript = hasManuscript ? String(hit.manuscript ?? "") : "";
  const left: SpotColumn = hasManuscript
    ? {
        title: REVIEW_COPY.manuscriptRead,
        body: manuscript,
        sentence: manuscript,
        span: spanOf(hit.pdf_span),
        omit: omitOf(hit.pdf_span_omit),
        notes: [],
      }
    : {
        title: REVIEW_COPY.manuscriptFragment,
        body: String(hit.pdf ?? ""),
        sentence: "",
        span: null,
        omit: null,
        notes: [REVIEW_COPY.notFullParagraph],
      };

  const count = hasKey(hit, "excel_row_count") ? Number(hit.excel_row_count) : null;
  const standard = hasKey(hit, "excel_standard") ? String(hit.excel_standard ?? "") : "";
  let right: SpotColumn;
  if (hit.status === "稿件有但确认单没有") {
    right = { title: "", body: REVIEW_COPY.excelMissing, sentence: "", span: null, omit: null, notes: [] };
  } else if (count != null && count > 1) {
    right = { title: "", body: REVIEW_COPY.multiRows, sentence: "", span: null, omit: null, notes: [] };
  } else if (count === 1 && standard !== "") {
    right = {
      title: REVIEW_COPY.excelStandard,
      body: standard,
      sentence: standard,
      span: spanOf(hit.excel_span),
      omit: omitOf(hit.excel_span_omit),
      notes: [],
    };
  } else {
    right = {
      title: REVIEW_COPY.diffFragment,
      body: fragment(hit),
      sentence: "",
      span: null,
      omit: null,
      notes: hasManuscript
        ? [REVIEW_COPY.notFullSentence]
        : [REVIEW_COPY.notFullSentence, REVIEW_COPY.oldNoSentence],
    };
  }
  return { left, right };
}

/** 整句在显示、又没有 span 时才解释没标出。空稿不刷这句。 */
export function spanOmitReason(column: Pick<SpotColumn, "sentence" | "span" | "omit">): string | null {
  if (!column.sentence || column.span) return null;
  if (column.omit === "duplicate") return REVIEW_COPY.spanDuplicate;
  if (column.omit === "unmatched") return REVIEW_COPY.spanUnmatched;
  return null;
}

export function spotHeaderText(status: string, item: string | undefined, pool: string, position: string): string {
  const name = (item || "").trim();
  const tail = `${pool} ${position}`;
  return name ? `${status} · ${name} · ${tail}` : `${status} · ${tail}`;
}

/** 对照卡标题：字段名在前（过长截断，悬停看全名），后接「疑点 · 待确认 1/3」（产品决定 2026-10-16）。 */
export function spotTitleParts(
  field: string | undefined,
  status: string,
  item: string | undefined,
  pool: string,
  position: string,
): { field: string; rest: string; full: string } {
  const name = (field || "").trim();
  const extra = (item || "").trim();
  const rest = spotHeaderText(status, extra && extra !== name ? extra : undefined, pool, position);
  return { field: name, rest, full: name ? `${name} · ${rest}` : rest };
}

/** 上一项 / 下一项到头停止，不绕回。 */
export function spotNavTarget(indices: number[], active: number, dir: -1 | 1): number | null {
  const at = indices.indexOf(active);
  if (at < 0) return null;
  const next = at + dir;
  if (next < 0 || next >= indices.length) return null;
  return indices[next] ?? null;
}

/** 待确认已空且本条已有结论。后面还有待确认时不出现。 */
export function spotPendingEmptyLine(pending: number, decision: string | null | undefined): boolean {
  if (pending !== 0) return false;
  return decision === "confirm" || decision === "issue" || decision === "ignore";
}

type MarkSlice = { text: string; mark: boolean };

const LOCUS_RADIUS = 16;

function pointsOf(text: string): string[] {
  return Array.from(text);
}

function indexOfPoints(haystack: string[], needle: string[], from = 0): number {
  if (!needle.length || from < 0) return -1;
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function slicePoints(text: string, start: number, end: number): string {
  return pointsOf(text).slice(start, end).join("");
}

function uniqueLocate(text: string, needle: string): SpotSpan | null {
  const hay = pointsOf(text);
  const pin = pointsOf(needle);
  if (!pin.length) return null;
  const first = indexOfPoints(hay, pin, 0);
  if (first < 0) return null;
  if (indexOfPoints(hay, pin, first + 1) >= 0) return null;
  return [first, first + pin.length];
}

/** 同一小段出现两次就不取第一处，避免把缺口标到更早的重复上。 */
function uniquePointIndex(hay: string[], needle: string[]): number | null {
  if (!needle.length) return null;
  const first = indexOfPoints(hay, needle, 0);
  if (first < 0) return null;
  if (indexOfPoints(hay, needle, first + 1) >= 0) return null;
  return first;
}

function findTail(haystack: string, context: string): number | null {
  const hay = pointsOf(haystack);
  const ctx = pointsOf(context.replace(/^…/u, ""));
  if (!ctx.length || !hay.length) return null;
  for (const n of [12, 8, 6, 4, 2]) {
    if (ctx.length < n) continue;
    const at = uniquePointIndex(hay, ctx.slice(ctx.length - n));
    if (at != null) return at + n;
  }
  return null;
}

function findHead(haystack: string, context: string): number | null {
  const hay = pointsOf(haystack);
  const ctx = pointsOf(context.replace(/…$/u, ""));
  if (!ctx.length || !hay.length) return null;
  for (const n of [12, 8, 6, 4, 2]) {
    if (ctx.length < n) continue;
    const at = uniquePointIndex(hay, ctx.slice(0, n));
    if (at != null) return at;
  }
  return null;
}

/** 短跨度原样用。长跨度对齐到另一侧，只留下第一处对不上的那几个字。 */
function focusSpan(source: string, span: SpotSpan, other: string): SpotSpan {
  const chars = pointsOf(source);
  const start = Math.max(0, Math.min(span[0], chars.length));
  const end = Math.max(start, Math.min(span[1], chars.length));
  if (end - start <= 24) return [start, end];
  const exp = chars.slice(start, end);
  const left = chars.slice(Math.max(0, start - 12), start).join("");
  const caret = findTail(other, left);
  const present = pointsOf(other);
  const anchor = caret == null && start === 0 ? 0 : caret;
  if (anchor == null) return [start, Math.min(end, start + 24)];
  let i = 0;
  while (i < exp.length && anchor + i < present.length && exp[i] === present[anchor + i]) i += 1;
  if (i >= exp.length) return [start, Math.min(end, start + 24)];
  let j = i + 1;
  while (j < exp.length && j - i < 24) {
    const ahead = exp.slice(j, j + 4).join("");
    const nearby = present.slice(anchor + i, anchor + i + 10).join("");
    if (ahead.length >= 2 && nearby.includes(ahead)) break;
    j += 1;
  }
  return [start + i, start + j];
}

function clipAround(text: string, start: number, end: number): { before: string; mark: string; after: string } {
  const chars = pointsOf(text);
  const from = Math.max(0, Math.min(start, chars.length));
  const to = Math.max(from, Math.min(end, chars.length));
  const b0 = Math.max(0, from - LOCUS_RADIUS);
  const a1 = Math.min(chars.length, to + LOCUS_RADIUS);
  return {
    before: (b0 > 0 ? "…" : "") + chars.slice(b0, from).join(""),
    mark: chars.slice(from, to).join(""),
    after: chars.slice(to, a1).join("") + (a1 < chars.length ? "…" : ""),
  };
}

function quoteOf(text: string): string {
  const chars = pointsOf(text);
  const shown = chars.slice(0, 40).join("");
  if (shown !== "" && /^\s+$/u.test(shown)) return "空格";
  return chars.length > 40 ? `${shown}…` : shown;
}

export type LocusClip = {
  before: string;
  mark: string;
  after: string;
  gap: boolean;
};

export type SpotLocus = {
  kind: "miss" | "extra";
  title: string;
  detail: string;
  manuscript: LocusClip | null;
  standard: LocusClip | null;
};

function gapClip(text: string, caret: number | null): LocusClip | null {
  if (!text || caret == null) return null;
  const at = Math.max(0, Math.min(caret, pointsOf(text).length));
  return { ...clipAround(text, at, at), mark: "", gap: true };
}

function markClip(text: string, span: SpotSpan | null): LocusClip | null {
  if (!text || !span) return null;
  const clip = clipAround(text, span[0], span[1]);
  if (!clip.mark) return null;
  return { ...clip, gap: false };
}

function bareMark(text: string): LocusClip {
  const chars = pointsOf(text);
  return {
    before: "",
    mark: chars.slice(0, 40).join(""),
    after: chars.length > 40 ? "…" : "",
    gap: false,
  };
}

/** 漏字、多字在两列全文上面点出少在哪、多在哪。其它状态不造这个板块。 */
export function spotLocus(hit: FieldHit): SpotLocus | null {
  if (hit.status !== "漏字" && hit.status !== "多字") return null;
  const columns = spotColumns(hit);
  const manuscript = columns.left.sentence || columns.left.body || "";
  const standard = columns.right.sentence || "";
  if (hit.status === "漏字") {
    let span = columns.right.span ?? (standard ? uniqueLocate(standard, String(hit.excel_value ?? "")) : null);
    if (!span || !standard) {
      const exp = String(hit.excel_value ?? "");
      if (!exp) return null;
      return {
        kind: "miss",
        title: REVIEW_COPY.missHere,
        detail: REVIEW_COPY.missedText(quoteOf(exp)),
        manuscript: null,
        standard: bareMark(exp),
      };
    }
    const focused = focusSpan(standard, span, manuscript);
    const quote = slicePoints(standard, focused[0], focused[1]);
    if (!quote) return null;
    const left = slicePoints(standard, Math.max(0, focused[0] - 12), focused[0]);
    const right = slicePoints(standard, focused[1], focused[1] + 12);
    const caret = findTail(manuscript, left) ?? findHead(manuscript, right);
    return {
      kind: "miss",
      title: REVIEW_COPY.missHere,
      detail: REVIEW_COPY.missedText(quoteOf(quote)),
      manuscript: gapClip(manuscript, caret),
      standard: markClip(standard, focused),
    };
  }
  let span = columns.left.span ?? (manuscript ? uniqueLocate(manuscript, String(hit.pdf ?? "")) : null);
  if (!span || !manuscript) {
    const got = String(hit.pdf ?? "");
    if (!got) return null;
    return {
      kind: "extra",
      title: REVIEW_COPY.extraHere,
      detail: REVIEW_COPY.extraText(quoteOf(got)),
      manuscript: bareMark(got),
      standard: null,
    };
  }
  const focused = focusSpan(manuscript, span, standard);
  const quote = slicePoints(manuscript, focused[0], focused[1]);
  if (!quote) return null;
  const left = slicePoints(manuscript, Math.max(0, focused[0] - 12), focused[0]);
  const right = slicePoints(manuscript, focused[1], focused[1] + 12);
  const caret = standard ? findTail(standard, left) ?? findHead(standard, right) : null;
  return {
    kind: "extra",
    title: REVIEW_COPY.extraHere,
    detail: REVIEW_COPY.extraText(quoteOf(quote)),
    manuscript: markClip(manuscript, focused),
    standard: gapClip(standard, caret),
  };
}

/** 按原句的 Unicode 码位切片。后端下标是码位，不用 JS 的 UTF-16 length。调用方用文本节点画，不拼 HTML。 */
export function markedSlices(sentence: string, span: SpotSpan | null): MarkSlice[] {
  if (!sentence) return [];
  if (!span) return [{ text: sentence, mark: false }];
  const chars = Array.from(sentence);
  const [start, end] = span;
  if (start < 0 || end > chars.length || start >= end) return [{ text: sentence, mark: false }];
  const out: MarkSlice[] = [];
  if (start > 0) out.push({ text: chars.slice(0, start).join(""), mark: false });
  out.push({ text: chars.slice(start, end).join(""), mark: true });
  if (end < chars.length) out.push({ text: chars.slice(end).join(""), mark: false });
  return out;
}

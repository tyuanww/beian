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

/** 按原句切片。调用方用文本节点画，不拼 HTML。 */
export function markedSlices(sentence: string, span: SpotSpan | null): MarkSlice[] {
  if (!sentence) return [];
  if (!span) return [{ text: sentence, mark: false }];
  const [start, end] = span;
  if (start < 0 || end > sentence.length || start >= end) return [{ text: sentence, mark: false }];
  const out: MarkSlice[] = [];
  if (start > 0) out.push({ text: sentence.slice(0, start), mark: false });
  out.push({ text: sentence.slice(start, end), mark: true });
  if (end < sentence.length) out.push({ text: sentence.slice(end), mark: false });
  return out;
}

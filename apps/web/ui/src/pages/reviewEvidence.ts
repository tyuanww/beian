import type { FieldHit } from "../api";
import statuses from "../../../backend/app/verbatim_statuses.json" with { type: "json" };
import { hasReadingDoubt } from "../../../server/src/readingDoubt.ts";
import { coverageTally, doubtLines, excelText, humanMissLines, NOT_READ, pdfText, spokenAsk } from "./hitText";

export type EvidenceText = {
  summary: string;
  full: string;
  expandable: boolean;
};

export type ReviewEvidence = {
  expected: EvidenceText;
  observed: EvidenceText;
};

export type IndexedReviewHit = { hit: FieldHit; index: number };

const BLOCKING = new Set([...statuses.true_errors, "疑点", "缺失"]);
const SPACE = new Set(statuses.space_errors);
/** 与服务端 tasks.ts HIT_STATUSES 同口径；不在集合里的状态不能签字/退回。 */
const KNOWN_HIT_STATUSES = new Set<string>(["一致", "疑点", "缺失", "跳过", ...statuses.statuses]);

function isKnownHitStatus(status: string | undefined): boolean {
  return KNOWN_HIT_STATUSES.has(String(status || ""));
}

export function hasInvalidHitStatus(hits: ReadonlyArray<{ status?: string }>): boolean {
  return hits.some((hit) => !isKnownHitStatus(hit.status));
}

/**
 * 没下结论时按状态本身就要结论的条目，返回状态（拦截文案里直接写它，如「疑点」「多空格」）；否则 null。
 * 与服务端 `tasks.ts` 的 `pendingWord` 同序：真错 / 疑点 / 缺失，或标了 pending 的空格类。
 */
export function blockingStatusWord(hit: FieldHit): string | null {
  const status = String(hit.status || "");
  if (BLOCKING.has(status)) return status;
  if (SPACE.has(status) && hit.decision === "pending") return status;
  return null;
}

function isHeldHit(hit: FieldHit): boolean {
  return hit.status === "待人工确认";
}

export function isReviewIssue(hit: FieldHit): boolean {
  if (isHeldHit(hit)) return false;
  if (hit.decision === "issue") return true;
  if (BLOCKING.has(String(hit.status || ""))) return true;
  if (SPACE.has(String(hit.status || "")) && hit.decision === "pending") return true;
  if (/不清|误/.test(String(hit.status || ""))) return true;
  // 认字存疑只按结构化字段（前后端共用 hasReadingDoubt）。
  if (hasReadingDoubt(hit)) return true;
  // 其余已标记条目（如未标 pending 的缺空格）仍按核对要点有无内容判断，与原规则一致。
  return doubtLines(hit).length > 0;
}

export function partitionReviewHits(hits: FieldHit[]): {
  issues: IndexedReviewHit[];
  consistent: IndexedReviewHit[];
  held: IndexedReviewHit[];
} {
  const issues: IndexedReviewHit[] = [];
  const consistent: IndexedReviewHit[] = [];
  const held: IndexedReviewHit[] = [];
  hits.forEach((hit, index) => {
    if (isHeldHit(hit)) held.push({ hit, index });
    else (isReviewIssue(hit) ? issues : consistent).push({ hit, index });
  });
  return { issues, consistent, held };
}

export function withLocalNotes(hits: FieldHit[], notes: Record<string, string>): FieldHit[] {
  return hits.map((hit) => {
    if (!hit.id || !Object.prototype.hasOwnProperty.call(notes, hit.id)) return hit;
    return { ...hit, note: notes[hit.id] };
  });
}

export function buildRevisionList(
  productName: string,
  hits: FieldHit[],
  options: { located?: (hit: FieldHit) => boolean | undefined } = {},
) {
  const issues = hits.filter((hit) => hit.decision === "issue");
  const lines = [
    "修改清单",
    `品名：${productName || "—"}`,
    ...issues.map((hit, index) => {
      const note = hit.note ? `（${hit.note}）` : "";
      const spoken = spokenAsk(hit, hit.field, options.located?.(hit));
      const doubts = spoken ? [spoken.lead, spoken.ask].filter(Boolean) : doubtLines(hit);
      const miss = humanMissLines(hit);
      const missText = miss.length ? ` / 没读到：${miss.join("；")}` : "";
      const doubtText = doubts.length ? ` / 疑点：${doubts.join("；")}` : "";
      return `${index + 1}. ${hit.field || "项目"} / 第${hit.page ?? "?"}页 / 表格：${excelText(hit)} / 稿件：${pdfText(hit, hit.field)}${doubtText}${missText}${note}`;
    }),
  ];
  return { text: lines.join("\n"), count: issues.length };
}

export function compactEvidence(value: string, limit = 180): EvidenceText {
  const full = String(value || "—").trim() || "—";
  const oneLine = full.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit && full.split("\n").length <= 3) {
    return { summary: full, full, expandable: false };
  }
  const clipped = oneLine.slice(0, Math.max(24, limit)).replace(/[，、；：,.\s]+$/u, "");
  return { summary: `${clipped}…`, full, expandable: true };
}

/** 多空格的读数常常只有一个空格。展示前的 trim 会把它收成「没读到」，空格盒就画不出来。 */
function keepSpaceBox(hit: FieldHit, observed: EvidenceText): EvidenceText {
  if (hit.status !== "多空格" || /\s/u.test(observed.full)) return observed;
  const context = observed.full === "—" || observed.full === NOT_READ ? "" : observed.full;
  const full = context ? ` ${context}` : " ";
  return { summary: full, full, expandable: false };
}

export function reviewEvidence(hit: FieldHit): ReviewEvidence {
  const observed = keepSpaceBox(hit, compactEvidence(pdfText(hit, hit.field)));
  const tally = coverageTally(hit);
  return {
    expected: compactEvidence(excelText(hit)),
    observed: tally
      ? {
          summary: observed.summary,
          full: observed.full === NOT_READ ? tally : `${observed.full}\n${tally}`,
          expandable: true,
        }
      : observed,
  };
}

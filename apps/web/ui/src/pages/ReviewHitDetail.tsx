import { useLayoutEffect, useRef, useState } from "react";
import { Input, Tooltip } from "antd";
import { REVIEW_COPY } from "../copy/labels";
import type { Decision, FieldHit } from "../api";
import { spokenAsk } from "./hitText";
import { allowedDecisions } from "./reviewDecisions";
import { nativeEvidenceView } from "./nativeTextEvidence";
import { reviewEvidence, type EvidenceText } from "./reviewEvidence";
import { markedSlices, spanOmitReason, spotColumns, spotLocus, type LocusClip, type SpotColumn, type SpotSpan } from "./spotCopy";

type Props = {
  hit: FieldHit;
  hasBox: boolean;
  verbatim?: boolean;
  reviewable: boolean;
  busy: boolean;
  note: string;
  locationCopy: string;
  onDecide: (hit: FieldHit, decision: Decision, note: string) => void;
  onNoteChange: (value: string) => void;
  onNoteCommit: (hit: FieldHit, decision: Decision, note: string) => void;
  /** rail 保持今天的列题。card 用整句对照。 */
  surface?: "rail" | "card";
  onPrev?: () => void;
  onNext?: () => void;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  pendingEmpty?: boolean;
};

function SpacedReading({ text }: { text: string }) {
  const parts = text.split(/(\s+)/u);
  return (
    <p className="review-evidence-value mono">
      {parts.map((part, index) => (
        /\s/u.test(part) ? (
          <span key={index} className="review-space-box" role="img" aria-label={REVIEW_COPY.spaceLabel}>
            <i aria-hidden="true" />
          </span>
        ) : <span key={index}>{part}</span>
      ))}
    </p>
  );
}

function MarkedReading({ text, span }: { text: string; span: SpotSpan | null }) {
  const slices = markedSlices(text, span);
  return (
    <p className="review-evidence-value mono">
      {slices.map((slice, i) => slice.text.split(/(\s+)/u).map((part, j) => {
        if (!part) return null;
        const key = `${i}-${j}`;
        if (/\s/u.test(part)) {
          return (
            <span key={key} className="review-space-box" role="img" aria-label={REVIEW_COPY.spaceLabel}>
              <i aria-hidden="true" />
            </span>
          );
        }
        return slice.mark
          ? <span key={key} className="review-spot-mark">{part}</span>
          : <span key={key}>{part}</span>;
      }))}
    </p>
  );
}

function LocusLine({ label, clip }: { label: string; clip: LocusClip }) {
  return (
    <p className="review-spot-locus-line">
      <span className="review-evidence-label">{label}</span>
      {clip.before}
      {clip.gap ? (
        <i className="review-spot-gap" aria-label={REVIEW_COPY.locusGap} />
      ) : (
        <span className="review-spot-mark">{clip.mark}</span>
      )}
      {clip.after}
    </p>
  );
}

function SpotColumnView({ column }: { column: SpotColumn }) {
  const reason = spanOmitReason(column);
  return (
    <section className="review-evidence-cell">
      {column.title ? <p className="review-evidence-label">{column.title}</p> : null}
      {column.sentence
        ? <MarkedReading text={column.sentence} span={column.span} />
        : <p className="review-evidence-value mono">{column.body}</p>}
      {column.notes.map((note) => <p key={note} className="review-spot-aside">{note}</p>)}
      {reason ? <p className="review-spot-omit">{reason}</p> : null}
    </section>
  );
}

function EvidenceBlock({ title, value, tone, spaced }: { title: string; value: EvidenceText; tone?: "issue"; spaced?: boolean }) {
  return (
    <section className={tone === "issue" ? "review-evidence-cell is-issue" : "review-evidence-cell"}>
      <p className="review-evidence-label">{title}</p>
      {spaced ? <SpacedReading text={value.full} /> : <p className="review-evidence-value mono">{value.summary}</p>}
      {value.expandable && !spaced ? (
        <details className="review-evidence-details">
          <summary>查看全部</summary>
          <p className="mono">{value.full}</p>
        </details>
      ) : null}
    </section>
  );
}

/** 结论按钮。右栏和对照卡共用这组按钮。 */
function VerdictButtons({
  hit, reviewable, busy, note, selected, onDecide, tipOpen, setTipOpen,
}: {
  hit: FieldHit;
  reviewable: boolean;
  busy: boolean;
  note: string;
  selected: Decision | undefined;
  onDecide: (hit: FieldHit, decision: Decision, note: string) => void;
  tipOpen: boolean;
  setTipOpen: (open: boolean) => void;
}) {
  return (
    <>
      {allowedDecisions(hit).map((d) => {
        const keyNo = { confirm: 1, issue: 2, ignore: 3 }[d];
        const button = (
          <button key={d} type="button" aria-pressed={selected === d} className={selected === d ? "is-on" : undefined}
            disabled={!reviewable || !hit.id || busy} onClick={() => onDecide(hit, d, note)}>
            {REVIEW_COPY.verdict[d]} <kbd>{keyNo}</kbd>
          </button>
        );
        return d === "ignore" ? (
          <Tooltip key={d} title={REVIEW_COPY.ignoreTip} open={tipOpen} onOpenChange={setTipOpen}>{button}</Tooltip>
        ) : button;
      })}
    </>
  );
}

export function ReviewHitDetail({
  hit, hasBox, verbatim = false, reviewable, busy, note, locationCopy, onDecide, onNoteChange, onNoteCommit,
  surface = "rail", onPrev, onNext, prevDisabled = false, nextDisabled = false, pendingEmpty = false,
}: Props) {
  const [tipOpen, setTipOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const evidence = reviewEvidence(hit);
  const spanKey = `${hit.id ?? ""}:${hit.status ?? ""}:${hit.pdf_span?.join(",") ?? ""}:${hit.excel_span?.join(",") ?? ""}`;
  useLayoutEffect(() => {
    if (surface !== "card") return;
    const body = bodyRef.current;
    if (!body) return;
    if (body.querySelector(".review-spot-locus")) {
      body.scrollTop = 0;
      return;
    }
    const mark = body.querySelector(".review-spot-mark");
    if (!(mark instanceof HTMLElement)) return;
    const delta = mark.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTop += delta - 8;
  }, [surface, spanKey]);
  const spoken = spokenAsk(hit, hit.field, hasBox);
  const nativeEvidence = nativeEvidenceView(hit.native_text_evidence);
  const selected = hit.decision === "confirm" || hit.decision === "issue" || hit.decision === "ignore" ? hit.decision : undefined;
  const noteDirty = note !== (hit.note ?? "");
  if (surface === "card") {
    const columns = spotColumns(hit);
    const locus = spotLocus(hit);
    return (
      <>
        <div className="review-spot-body" ref={bodyRef}>
          {locus ? (
            <section className="review-spot-locus" aria-label={locus.title}>
              <h3>{locus.title}</h3>
              <p className="review-spot-locus-detail">{locus.detail}</p>
              {locus.manuscript ? <LocusLine label={REVIEW_COPY.manuscriptRead} clip={locus.manuscript} /> : null}
              {locus.standard ? <LocusLine label={REVIEW_COPY.excelStandard} clip={locus.standard} /> : null}
            </section>
          ) : null}
          <div className="review-evidence-grid">
            <SpotColumnView column={columns.left} />
            <SpotColumnView column={columns.right} />
          </div>
          {hit.page_skew ? <p className="review-evidence-location">{REVIEW_COPY.pageSkew}</p> : null}
          {nativeEvidence ? <NativeEvidenceSection evidence={nativeEvidence} hitId={hit.id} /> : null}
        </div>
        <footer className="review-spot-foot">
          <div className="review-spot-nav">
            <button type="button" disabled={prevDisabled} onClick={() => onPrev?.()}>{REVIEW_COPY.prevItem}</button>
            <button type="button" disabled={nextDisabled} onClick={() => onNext?.()}>{REVIEW_COPY.nextItem}</button>
          </div>
          <div className="review-verdicts" role="group" aria-label="审核结果">
            <VerdictButtons hit={hit} reviewable={reviewable} busy={busy} note={note} selected={selected} onDecide={onDecide} tipOpen={tipOpen} setTipOpen={setTipOpen} />
          </div>
          {selected === "issue" ? (
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 5 }}
              aria-label="写原因"
              className="review-evidence-note"
              placeholder={REVIEW_COPY.writeReason}
              value={note}
              disabled={!reviewable || !hit.id || busy}
              onChange={(event) => onNoteChange(event.target.value)}
              onBlur={() => { if (noteDirty) onNoteCommit(hit, "issue", note); }}
              onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }}
            />
          ) : null}
          {selected === "issue" && noteDirty ? <p className="review-draft-status" role="status">{busy ? "保存中…" : "未保存"}</p> : null}
          {pendingEmpty ? <p className="review-spot-empty" role="status">{REVIEW_COPY.pendingEmptySign}</p> : null}
        </footer>
      </>
    );
  }
  return (
    <div className="review-flat-detail">
      {spoken ? (
        <section className="review-spoken" aria-label={REVIEW_COPY.lead}>
          <p><b>{REVIEW_COPY.lead}：</b>{spoken.lead}</p>
          {spoken.because ? <p>{spoken.because}</p> : null}
          {spoken.ask ? <p className="is-ask">{spoken.ask}</p> : null}
        </section>
      ) : null}
      <div className="review-evidence-grid">
        <EvidenceBlock
          title="Excel 应印"
          value={hit.status === "稿件有但确认单没有" ? { summary: REVIEW_COPY.excelMissing, full: REVIEW_COPY.excelMissing, expandable: false } : evidence.expected}
        />
        <EvidenceBlock title="稿上读到" value={evidence.observed} spaced={verbatim} tone={hit.status && hit.status !== "一致" ? "issue" : undefined} />
      </div>
      <div className="review-verdicts" role="group" aria-label="审核结果">
        <VerdictButtons hit={hit} reviewable={reviewable} busy={busy} note={note} selected={selected} onDecide={onDecide} tipOpen={tipOpen} setTipOpen={setTipOpen} />
      </div>
      {selected === "issue" ? (
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 5 }}
          aria-label="写原因"
          className="review-evidence-note"
          placeholder={REVIEW_COPY.writeReason}
          value={note}
          disabled={!reviewable || !hit.id || busy}
          onChange={(event) => onNoteChange(event.target.value)}
          onBlur={() => { if (noteDirty) onNoteCommit(hit, "issue", note); }}
          onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }}
        />
      ) : null}
      {selected === "issue" && noteDirty ? <p className="review-draft-status" role="status">{busy ? "保存中…" : "未保存"}</p> : null}
      {nativeEvidence ? <NativeEvidenceSection evidence={nativeEvidence} hitId={hit.id} /> : null}
      {hit.page_skew ? <p className="review-evidence-location">{REVIEW_COPY.pageSkew}</p> : null}
      {!hasBox ? <p className="review-evidence-location">{locationCopy}</p> : null}
    </div>
  );
}

/** 文字来源证据：对照卡和右栏共用，默认收起「查看文字来源」。 */
function NativeEvidenceSection({ evidence, hitId }: { evidence: NonNullable<ReturnType<typeof nativeEvidenceView>>; hitId?: string }) {
  return (
    <section className="review-native-evidence" aria-label="文字来源证据">
      <h3>{evidence.title}</h3>
      <p>{evidence.message}</p>
      <p className="review-native-hint">请确认结果</p>
      {evidence.nativeText || evidence.ocrText ? (
        <details key={hitId}>
          <summary>查看文字来源</summary>
          <div className="review-native-readings">
            <section><strong>原稿文字</strong><p className="mono">{evidence.nativeText || "暂时读不到文字"}</p></section>
            <section><strong>图片文字</strong><p className="mono">{evidence.ocrText || "暂时读不到文字"}</p></section>
          </div>
        </details>
      ) : null}
    </section>
  );
}

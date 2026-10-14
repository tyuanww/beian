import { useState } from "react";
import { Input, Tooltip } from "antd";
import { REVIEW_COPY } from "../copy/labels";
import type { Decision, FieldHit } from "../api";
import { spokenAsk } from "./hitText";
import { nativeEvidenceView } from "./nativeTextEvidence";
import { reviewEvidence, type EvidenceText } from "./reviewEvidence";

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

/** 一条疑点的对照：要点、应印、稿上读到、结论。右栏和就地对照窗共用。 */
export function ReviewHitDetail({
  hit, hasBox, verbatim = false, reviewable, busy, note, locationCopy, onDecide, onNoteChange, onNoteCommit,
}: Props) {
  const [tipOpen, setTipOpen] = useState(false);
  const evidence = reviewEvidence(hit);
  const spoken = spokenAsk(hit, hit.field, hasBox);
  const nativeEvidence = nativeEvidenceView(hit.native_text_evidence);
  const selected = hit.decision === "confirm" || hit.decision === "issue" || hit.decision === "ignore" ? hit.decision : undefined;
  const noteDirty = note !== (hit.note ?? "");
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
        {(hit.status === "待人工确认" ? (["issue", "ignore"] as const) : (["confirm", "issue", "ignore"] as const)).map((d) => {
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
      {nativeEvidence ? (
        <section className="review-native-evidence" aria-label="文字来源证据">
          <h3>{nativeEvidence.title}</h3>
          <p>{nativeEvidence.message}</p>
          <p className="review-native-hint">请确认结果</p>
          {nativeEvidence.nativeText || nativeEvidence.ocrText ? (
            <details key={hit.id}>
              <summary>查看文字来源</summary>
              <div className="review-native-readings">
                <section><strong>原稿文字</strong><p className="mono">{nativeEvidence.nativeText || "暂时读不到文字"}</p></section>
                <section><strong>图片文字</strong><p className="mono">{nativeEvidence.ocrText || "暂时读不到文字"}</p></section>
              </div>
            </details>
          ) : null}
        </section>
      ) : null}
      {hit.page_skew ? <p className="review-evidence-location">{REVIEW_COPY.pageSkew}</p> : null}
      {!hasBox ? <p className="review-evidence-location">{locationCopy}</p> : null}
    </div>
  );
}

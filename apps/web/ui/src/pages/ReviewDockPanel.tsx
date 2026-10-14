import { useEffect, useRef, useState } from "react";
import { Input, Tag, Tooltip } from "antd";
import { REVIEW_COPY } from "../copy/labels";
import type { Decision, FieldHit, TaskDetail } from "../api";
import { spokenAsk } from "./hitText";
import { nativeEvidenceView, nativeTaskNote } from "./nativeTextEvidence";
import { reviewProgress } from "./reviewNav";
import { tabIndices, verdictCounts, isOpenHeld, openHeldAfterPending, type FlatTab } from "./reviewFlat";
import { reviewEvidence, type EvidenceText } from "./reviewEvidence";

type Props = {
  hits: FieldHit[];
  active: number;
  current?: FieldHit;
  currentHasBox: boolean;
  pageNo: number;
  reviewable: boolean;
  busy: boolean;
  note: string;
  emptyMessage: string;
  reworkCheck?: TaskDetail["rework_check"];
  nativeTaskEvidence?: TaskDetail["native_text"];
  ocrMeta?: TaskDetail["ocr_meta"];
  onPick: (index: number) => void;
  onDecide: (hit: FieldHit, decision: Decision, note: string) => void;
  onNoteCommit: (hit: FieldHit, decision: Decision, note: string) => void;
  onCopy: () => void;
  onCollapse?: () => void;
  tab: FlatTab;
  onTab: (tab: FlatTab) => void;
  onNoteChange: (value: string) => void;
  verbatim?: boolean;
  fscNote?: string;
  locationCopy?: string;
};

/** 标签文字用加深色（deviations 第 13 行）：状态既有文字也有颜色，不只靠颜色。 */
function verdictTag(hit: FieldHit) {
  const d = hit.decision;
  if (d === "issue") return <Tag className="t-err">{REVIEW_COPY.verdict.issue}</Tag>;
  if (d === "confirm") return <Tag className="t-ok">{REVIEW_COPY.verdict.confirm}</Tag>;
  if (d === "ignore") return <Tag className="t-ign">{REVIEW_COPY.verdict.ignore}</Tag>;
  if (hit.status === "待人工确认" && hit.decision !== "issue" && hit.decision !== "ignore") {
    return <Tag className="t-pend">待人工</Tag>;
  }
  if (/疑|缺|不清/.test(hit.status || "")) return <Tag className="t-pend">{REVIEW_COPY.tabs.pending}</Tag>;
  return <Tag className="t-ok">{hit.status || REVIEW_COPY.verdict.confirm}</Tag>;
}

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

export function ReviewDockPanel({
  hits, active, current, currentHasBox, pageNo, reviewable, busy, note, emptyMessage, reworkCheck,
  nativeTaskEvidence, ocrMeta, onPick, onDecide, onNoteCommit, onCopy, onNoteChange, onCollapse, tab, onTab,
  verbatim = false, fscNote, locationCopy = REVIEW_COPY.noBox,
}: Props) {
  const [tipOpen, setTipOpen] = useState(false);
  const counts = verdictCounts(hits);
  const held = hits.filter(isOpenHeld);
  const [heldOpen, setHeldOpen] = useState(counts.pending === 0 && held.length > 0);
  const pendingRef = useRef(counts.pending);
  useEffect(() => {
    if (openHeldAfterPending(pendingRef.current, counts.pending, held.length)) setHeldOpen(true);
    pendingRef.current = counts.pending;
  }, [counts.pending, held.length]);
  const list = tabIndices(hits, tab, active);
  const evidence = current ? reviewEvidence(current) : null;
  const nativeEvidence = nativeEvidenceView(current?.native_text_evidence);
  const selected =
    current?.decision === "confirm" || current?.decision === "issue" || current?.decision === "ignore"
      ? (current.decision as Decision)
      : undefined;
  const spoken = current ? spokenAsk(current, current.field, currentHasBox) : null;
  const progress = reviewProgress(hits, pageNo, active);
  const noteDirty = note !== (current?.note ?? "");
  const taskNote = nativeTaskNote(nativeTaskEvidence);
  const tabCount: Record<FlatTab, number> = { pending: counts.pending, issue: counts.issue, all: hits.length };

  return (
    <div className="review-dock-panel review-flat-panel">
      <div className="review-ptabs" role="tablist" aria-label={REVIEW_COPY.doubts}>
        {(["pending", "issue", "all"] as FlatTab[]).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key && !heldOpen} className={tab === key && !heldOpen ? "review-ptab is-on" : "review-ptab"} onClick={() => { setHeldOpen(false); onTab(key); }}>
            {REVIEW_COPY.tabs[key]} <i>{tabCount[key]}</i>
          </button>
        ))}
        {onCollapse ? <button type="button" className="review-pcollapse" aria-label="收起右栏" onClick={onCollapse}>{REVIEW_COPY.collapse}</button> : null}
      </div>
      {taskNote ? <p className="review-native-evidence" role="status">{taskNote}</p> : null}
      {verbatim ? (
        <button type="button" className="review-held-bar" data-testid="review-held-bar" aria-pressed={heldOpen} onClick={() => setHeldOpen((open) => !open)}>
          {REVIEW_COPY.heldBar(held.length)}
        </button>
      ) : null}
      {fscNote ? <p className="review-fsc-note" role="note">{fscNote}</p> : null}
      {ocrMeta?.skipped && ocrMeta.reason === "native_coverage" ? (
        <p className="review-native-evidence" role="status">已直接读取原稿文字</p>
      ) : null}
      {verbatim && counts.total === 0 && held.length === 0 ? (
        <div className="review-verbatim-none" data-testid="review-verbatim-none">
          <p>{REVIEW_COPY.verbatimNoneLead}</p>
          <p>{REVIEW_COPY.verbatimNoneNote}</p>
        </div>
      ) : null}
      {counts.total === 0 && held.length === 0 && reviewable && !verbatim ? <p className="review-zero" role="status">{REVIEW_COPY.zeroIssues}</p> : null}
      <ol className="review-flat-list" aria-label="疑点列表" data-testid={heldOpen ? "review-held-group" : undefined}>
        {heldOpen && held.some((hit) => !/备注/u.test(`${hit.field || ""}${hit.status || ""}`)) ? <li className="review-held-title">{REVIEW_COPY.heldUnread}</li> : null}
        {heldOpen && held.some((hit) => /备注/u.test(`${hit.field || ""}${hit.status || ""}`)) ? <li className="review-held-title">{REVIEW_COPY.heldNote}</li> : null}
        {(heldOpen ? held.map((hit) => hits.indexOf(hit)) : list).map((index) => {
          const hit = hits[index];
          const on = index === active;
          return (
            <li key={hit.id || index} className={on ? "is-on" : undefined}>
              <button type="button" className="review-flat-row" aria-current={on ? "true" : undefined} onClick={() => onPick(index)}>
                <span className="hit-no">{index + 1}</span>
                <strong>{hit.field || "项目"}</strong>
                <small>P{hit.page ?? "?"}</small>
                {verdictTag(hit)}
              </button>
              {on && current && evidence ? (
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
                      value={current.status === "稿件有但确认单没有" ? { summary: REVIEW_COPY.excelMissing, full: REVIEW_COPY.excelMissing, expandable: false } : evidence.expected}
                    />
                    <EvidenceBlock title="稿上读到" value={evidence.observed} spaced={verbatim} tone={current.status && current.status !== "一致" ? "issue" : undefined} />
                  </div>
                  <div className="review-verdicts" role="group" aria-label="审核结果">
                    {(current.status === "待人工确认" ? (["issue", "ignore"] as const) : (["confirm", "issue", "ignore"] as const)).map((d) => {
                      const keyNo = d === "confirm" ? 1 : d === "issue" ? 2 : 3;
                      const button = (
                        <button key={d} type="button" aria-pressed={selected === d} className={selected === d ? "is-on" : undefined}
                          disabled={!reviewable || !current.id || busy} onClick={() => {
                            if (current.status === "待人工确认" && d === "issue") {
                              setHeldOpen(false);
                              onTab("issue");
                            }
                            onDecide(current, d, note);
                          }}>
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
                      disabled={!reviewable || !current.id || busy}
                      onChange={(event) => onNoteChange(event.target.value)}
                      onBlur={() => { if (noteDirty) onNoteCommit(current, "issue", note); }}
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
                        <details key={current.id || active}>
                          <summary>查看文字来源</summary>
                          <div className="review-native-readings">
                            <section><strong>原稿文字</strong><p className="mono">{nativeEvidence.nativeText || "暂时读不到文字"}</p></section>
                            <section><strong>图片文字</strong><p className="mono">{nativeEvidence.ocrText || "暂时读不到文字"}</p></section>
                          </div>
                        </details>
                      ) : null}
                    </section>
                  ) : null}
                  {current.page_skew ? <p className="review-evidence-location">{REVIEW_COPY.pageSkew}</p> : null}
                  {!currentHasBox ? <p className="review-evidence-location">{locationCopy}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
        {!heldOpen && !list.length ? <li className="review-dock-none">{hits.length ? (tab === "pending" || held.length > 0 ? REVIEW_COPY.pendingEmpty : REVIEW_COPY.allDecided) : emptyMessage}</li> : null}
      </ol>
      <div className="review-pfoot">
        <span aria-live="polite">{REVIEW_COPY.footer(counts.pending, progress.pageLeft)}</span>
        <button type="button" className="btn-ghost" onClick={onCopy}>复制修改清单</button>
      </div>
      {reworkCheck?.length ? (
        <section className="notes-foot">
          <p className="field-label">复核</p>
          {reworkCheck.map((row) => (
            <div key={row.field} className="hit-card">
              <strong>{row.field}</strong>
              <div>旧稿：{row.v1_status}</div>
              <div>新稿：{row.v2_status}</div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

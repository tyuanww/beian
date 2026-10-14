import { useEffect, useRef, useState } from "react";
import { Tag } from "antd";
import { REVIEW_COPY } from "../copy/labels";
import type { Decision, FieldHit, TaskDetail } from "../api";
import { nativeTaskNote } from "./nativeTextEvidence";
import { reviewProgress } from "./reviewNav";
import { tabIndices, verdictCounts, isOpenHeld, openHeldAfterPending, type FlatTab } from "./reviewFlat";
import { ReviewHitDetail } from "./ReviewHitDetail";

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
  /** 就地对照把这一条的说明放到稿旁，右栏只留清单。 */
  showDetail?: boolean;
  /** 稿旁对照窗把待人工确认标成有错时，收起那一组。 */
  closeHeldPulse?: number;
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

export function ReviewDockPanel({
  hits, active, current, currentHasBox, pageNo, reviewable, busy, note, emptyMessage, reworkCheck,
  nativeTaskEvidence, ocrMeta, onPick, onDecide, onNoteCommit, onCopy, onNoteChange, onCollapse, tab, onTab,
  verbatim = false, fscNote, locationCopy = REVIEW_COPY.noBox, showDetail = true, closeHeldPulse = 0,
}: Props) {
  const counts = verdictCounts(hits);
  const held = hits.filter(isOpenHeld);
  const [heldOpen, setHeldOpen] = useState(counts.pending === 0 && held.length > 0);
  const pendingRef = useRef(counts.pending);
  useEffect(() => {
    if (openHeldAfterPending(pendingRef.current, counts.pending, held.length)) setHeldOpen(true);
    pendingRef.current = counts.pending;
  }, [counts.pending, held.length]);
  useEffect(() => {
    if (closeHeldPulse > 0) setHeldOpen(false);
  }, [closeHeldPulse]);
  const list = tabIndices(hits, tab, active);
  const progress = reviewProgress(hits, pageNo, active);
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
              {on && current && showDetail ? (
                <ReviewHitDetail
                  hit={current}
                  hasBox={currentHasBox}
                  verbatim={verbatim}
                  reviewable={reviewable}
                  busy={busy}
                  note={note}
                  locationCopy={locationCopy}
                  onDecide={(hit, decision, nextNote) => {
                    if (hit.status === "待人工确认" && decision === "issue") {
                      setHeldOpen(false);
                      onTab("issue");
                    }
                    onDecide(hit, decision, nextNote);
                  }}
                  onNoteChange={onNoteChange}
                  onNoteCommit={onNoteCommit}
                />
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

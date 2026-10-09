import { useState } from "react";
import { Button, Input, Select, Tag } from "antd";
import type { Decision, FieldHit, TaskDetail } from "../api";
import { spokenAsk } from "./hitText";
import { REVIEW_DOCK_POPUP_LAYER } from "./reviewDock";
import { issueOrdinal, reviewProgress } from "./reviewNav";
import { issueNavigation } from "./reviewWorkspaceState";
import {
  partitionReviewHits,
  reviewEvidence,
  type EvidenceText,
  type IndexedReviewHit,
} from "./reviewEvidence";

type Props = {
  hits: FieldHit[];
  active: number;
  current?: FieldHit;
  fullscreen: boolean;
  currentHasBox: boolean;
  pageNo: number;
  reviewable: boolean;
  busy: boolean;
  note: string;
  emptyMessage: string;
  reworkCheck?: TaskDetail["rework_check"];
  onPick: (index: number) => void;
  onDecide: (hit: FieldHit, decision: Decision, note: string) => void;
  onNoteCommit: (hit: FieldHit, decision: Decision, note: string) => void;
  onCopy: () => void;
  onNoteChange: (value: string) => void;
};

function statusTag(status?: string) {
  const value = status || "—";
  if (/待人工|不清|疑/.test(value)) return <Tag color="warning">{value}</Tag>;
  if (/缺|误/.test(value)) return <Tag color="error">{value}</Tag>;
  return <Tag>{value}</Tag>;
}

function EvidenceBlock({ title, value, tone }: { title: string; value: EvidenceText; tone?: "issue" }) {
  return (
    <section className={tone === "issue" ? "review-evidence-cell is-issue" : "review-evidence-cell"}>
      <p className="review-evidence-label">{title}</p>
      <p className="review-evidence-value mono">{value.summary}</p>
      {value.expandable ? (
        <details className="review-evidence-details">
          <summary>查看全部</summary>
          <p className="mono">{value.full}</p>
        </details>
      ) : null}
    </section>
  );
}

export function ReviewDockPanel({
  hits,
  active,
  current,
  fullscreen,
  currentHasBox,
  pageNo,
  reviewable,
  busy,
  note,
  emptyMessage,
  reworkCheck,
  onPick,
  onDecide,
  onNoteCommit,
  onCopy,
  onNoteChange,
}: Props) {
  const [pendingOnly, setPendingOnly] = useState(false);
  const grouped = partitionReviewHits(hits);
  const navigation = issueNavigation(hits, active, pendingOnly);
  const evidence = current ? reviewEvidence(current) : null;
  const selected =
    current?.decision === "confirm" || current?.decision === "issue" || current?.decision === "ignore"
      ? (current.decision as Decision)
      : undefined;
  const spoken = current ? spokenAsk(current, current.field, currentHasBox) : null;
  const progress = reviewProgress(hits, pageNo, active);
  const noteDirty = note !== (current?.note ?? "");

  return (
    <div className="review-dock-panel">
      <section className="review-dock-issues" aria-label="疑点列表">
        <div className="review-issue-controls">
          <Button disabled={busy || navigation.previous == null} onClick={() => { if (navigation.previous != null) onPick(navigation.previous); }}>上一项</Button>
          <Button disabled={busy || navigation.next == null} onClick={() => { if (navigation.next != null) onPick(navigation.next); }}>下一项</Button>
          <Button disabled={busy || navigation.nextPending == null} onClick={() => { if (navigation.nextPending != null) onPick(navigation.nextPending); }}>下一待确认</Button>
        </div>
        <label className="review-issue-filter"><input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />仅看待确认</label>
        <details className="review-issue-directory" open>
          <summary>疑点目录 · {navigation.visible.length} 项</summary>
          <div className="review-dock-issue-row">
          {navigation.visible.length ? navigation.visible.map(({ hit, index }) => (
            <button
              key={hit.id || index}
              type="button"
              className={index === active ? "hit-card is-on" : "hit-card"}
              aria-current={index === active ? "true" : undefined}
              disabled={busy}
              onClick={() => onPick(index)}
            >
              <span className="hit-no">{issueOrdinal(hits, index)}</span>
              <strong>{hit.field || "字段"}</strong>
              {statusTag(hit.status)}
            </button>
          )) : <span className="review-dock-none">{pendingOnly ? "没有待确认的疑点" : "暂无疑点"}</span>}
          </div>
        </details>
        {grouped.consistent.length ? (
          <details className="review-dock-consistent">
            <summary>一致列表 · {grouped.consistent.length}</summary>
            <div className="review-dock-issue-row">
              {grouped.consistent.map(({ hit, index }: IndexedReviewHit) => (
                <button
                  key={hit.id || index}
                  type="button"
                  className={index === active ? "hit-card is-on" : "hit-card"}
                  aria-current={index === active ? "true" : undefined}
                  disabled={busy}
                  onClick={() => onPick(index)}
                >
                  <span className="hit-no">{index + 1}</span>
                  <strong>{hit.field || "字段"}</strong>
                  {statusTag(hit.status)}
                </button>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      {current && evidence ? (
        <>
          <h2 className="review-current-title">{current.field || "当前字段"}</h2>
          {spoken ? (
            <section className="review-spoken" aria-label="嘱咐">
              <p>{spoken.lead}</p>
              <p>{spoken.because}</p>
              <p className="is-ask">{spoken.ask}</p>
            </section>
          ) : null}
          <div className="review-evidence-actions">
            <Select<Decision>
              key={current.id || "review-decision"}
              aria-label="核对结论"
              className="review-decision-select"
              placeholder="选择结论"
              value={selected}
              popupMatchSelectWidth={220}
              styles={
                fullscreen
                  ? { popup: { root: { position: "fixed", zIndex: REVIEW_DOCK_POPUP_LAYER } } }
                  : undefined
              }
              getPopupContainer={(trigger) => {
                const fullscreenRoot = trigger.closest(".review-page.is-fullscreen");
                return fullscreenRoot instanceof HTMLElement ? fullscreenRoot : document.body;
              }}
              disabled={!reviewable || !current.id || busy}
              onChange={(value) => onDecide(current, value, note)}
              options={[
                { value: "confirm", label: "一致" },
                { value: "issue", label: "有错" },
                { value: "ignore", label: "忽略" },
              ]}
            />
            <Button onClick={onCopy}>复制改稿清单</Button>
          </div>
          <div className="review-evidence-grid">
            <EvidenceBlock title="Excel 应印" value={evidence.expected} />
            <EvidenceBlock title="稿上读到" value={evidence.observed} />
          </div>
          <div className="review-evidence-location">
            <span>包装定位</span>
            <strong>
              {currentHasBox
                ? `第 ${current.page ?? "?"} 页 · 点序号看这里`
                : "这条我钉不住，请整面看"}
            </strong>
          </div>
          <p className="review-progress" aria-live="polite">
            当前：{current.field || "字段"} · 这单还剩 {progress.jobPending} 条 · 本页还有 {progress.pageLeft} 条
          </p>
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 6 }}
            aria-label="人工备注"
            className="review-evidence-note"
            placeholder="补充说明，会进改稿清单"
            value={note}
            disabled={!reviewable || !current.id || busy}
            onChange={(event) => onNoteChange(event.target.value)}
            onBlur={() => {
              if (selected && noteDirty) onNoteCommit(current, selected, note);
            }}
            onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }}
          />
          <div className="review-issue-controls">
            <Button disabled={!reviewable || busy || !selected || !noteDirty} onClick={() => { if (selected) onNoteCommit(current, selected, note); }}>保存备注</Button>
            <p className="review-draft-status" role="status">{busy ? "正在保存…" : noteDirty ? "备注尚未保存到服务器" : "备注已与服务器同步"}</p>
          </div>
        </>
      ) : (
        <p className="page-lead">{emptyMessage}</p>
      )}

      {reworkCheck?.length ? (
        <section className="notes-foot">
          <p className="field-label">对红</p>
          {reworkCheck.map((row) => (
            <div key={row.field} className="hit-card">
              <strong>{row.field}</strong>
              <div>上一版：{row.v1_status}</div>
              <div>这一版：{row.v2_status}</div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

import type { ReactNode } from "react";
import { REVIEW_COPY } from "../copy/labels";
import { FLAT_PANEL_WIDTH, FLAT_THUMB_WIDTH, type FlatLayout } from "./reviewFlat";
import "../styles/reviewWorkspace.css";

type Props = {
  layout: FlatLayout;
  thumbs: ReactNode;
  children: ReactNode;
  panel: ReactNode;
  panelOpen: boolean;
  pending: number;
  held?: number;
  onPanelOpen: (open: boolean) => void;
};

/**
 * A 通铺三栏（deviations 第 6/7/10 行，已批 2026-10-11）：缩略图条 52 | 稿件 | 右栏 320。
 * <1440 右栏默认收起，展开时 320 浮层盖在稿件右侧；<720 手机只留稿件（第 16 行）。
 */
export function ReviewWorkspace({ layout, thumbs, children, panel, panelOpen, pending, held = 0, onPanelOpen }: Props) {
  const wide = layout === "wide";
  const phone = layout === "phone";
  const columns = phone ? "minmax(0, 1fr)" : wide && panelOpen ? `${FLAT_THUMB_WIDTH}px minmax(0, 1fr) ${FLAT_PANEL_WIDTH}px` : `${FLAT_THUMB_WIDTH}px minmax(0, 1fr)`;
  return (
    <div className={`review-desk review-workspace review-flat is-${layout}${panelOpen ? " is-open" : " is-collapsed"}`} style={{ gridTemplateColumns: columns }}>
      {phone ? null : <nav className="review-thumbs" aria-label="页面">{thumbs}</nav>}
      <div className="review-ccol">{children}</div>
      {phone ? null : panelOpen ? (
        <aside data-testid="review-dock" className={`review-sidebar${wide ? "" : " is-overlay"}`} aria-label="右侧审核栏" style={{ width: FLAT_PANEL_WIDTH }}>
          <div id="review-sidebar-content" className="review-sidebar-body">{panel}</div>
        </aside>
      ) : (
        <button type="button" data-testid="review-dock" className="review-panel-tab" aria-expanded={false} onClick={() => onPanelOpen(true)}>
          {held > 0 ? REVIEW_COPY.heldCollapse(held) : REVIEW_COPY.expand(pending)}
        </button>
      )}
    </div>
  );
}

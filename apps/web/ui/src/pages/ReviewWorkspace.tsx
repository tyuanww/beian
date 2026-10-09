import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { reviewStorage, readSidebar, sidebarWidth, SIDEBAR_BREAKPOINT, SIDEBAR_DEFAULT, SIDEBAR_MIN, writeSidebar } from "./reviewWorkspaceState";
import "../styles/reviewWorkspace.css";

type Props = { userId: string | null; children: ReactNode; panel: ReactNode };

export function ReviewWorkspace({ userId, children, panel }: Props) {
  const [preference, setPreference] = useState(() => readSidebar(reviewStorage(), userId));
  const [room, setRoom] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const stacked = room < SIDEBAR_BREAKPOINT;
  const width = sidebarWidth(preference.width, room);
  const maximum = sidebarWidth(560, room);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const read = () => setRoom(node.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  function changeWidth(next: number) {
    if (stacked) return;
    const value = { ...preference, width: sidebarWidth(next, room) };
    setPreference(value);
    writeSidebar(reviewStorage(), userId, value);
  }
  function toggle() {
    const value = { ...preference, open: !preference.open };
    setPreference(value);
    writeSidebar(reviewStorage(), userId, value);
  }
  return (
    <div ref={root} className={`review-desk review-workspace${stacked ? " is-stacked" : ""}${preference.open ? "" : " is-collapsed"}`}
      style={{ gridTemplateColumns: stacked ? "minmax(0, 1fr)" : preference.open ? `minmax(480px, 1fr) 8px ${width}px` : "minmax(0, 1fr) 56px" }}>
      {children}
      {!stacked && preference.open ? (
        <div className="review-sidebar-resizer" role="separator" tabIndex={0} aria-label="调整右侧核对栏宽度"
          aria-orientation="vertical" aria-valuemin={SIDEBAR_MIN} aria-valuemax={maximum} aria-valuenow={width}
          onKeyDown={(event) => {
            const next = event.key === "ArrowLeft" ? width + 16 : event.key === "ArrowRight" ? width - 16 : event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? maximum : null;
            if (next == null) return;
            event.preventDefault(); changeWidth(next);
          }}
          onDoubleClick={() => changeWidth(SIDEBAR_DEFAULT)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            drag.current = { x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => { if (drag.current) changeWidth(drag.current.width + drag.current.x - event.clientX); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} />
      ) : null}
      <aside data-testid="review-dock" className={`review-sidebar glass-pane${preference.open ? "" : " is-shut"}`} aria-label="右侧核对栏">
        <div className="review-sidebar-header">
          {preference.open ? <strong>核对与处理</strong> : null}
          <button type="button" className="btn-ghost" aria-expanded={preference.open} aria-controls="review-sidebar-content" onClick={toggle}>
            {preference.open ? "收起" : "展开核对栏"}
          </button>
        </div>
        <div id="review-sidebar-content" className="review-sidebar-body" hidden={!preference.open}>{panel}</div>
      </aside>
    </div>
  );
}

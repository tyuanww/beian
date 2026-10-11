import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Tag } from "antd";
import { REVIEW_COPY } from "../copy/labels";
import { ApiError, api, type Decision, type FieldHit, type TaskDetail, type TaskPage } from "../api";
import { WaitCard } from "../chrome/WaitCard";
import { forgetReviewHandoff, reviewHandoffFor } from "../jobHandoff";
import { fittedPage, panBy, resetZoom, zoomAt, zoomCss, zoomToBox } from "./canvasZoom";
import { locateBoxesForHit, locationPageForHit, overlayFromBox, overlaysForHit, pickHitBox, pinHitGroupsForPage, resolvePageMetrics, visiblePinGroups } from "./pinBox";
import {
  enterElementFullscreen,
  exitElementFullscreen,
  fullscreenFailureMessage,
  isElementFullscreen,
} from "./mockupFullscreen";
import { readBoxesOn, readPinsOn, skipPackSheetField, writeBoxesOn, writePinsOn } from "./reviewDock";
import { ReviewSubmitDialog } from "./ReviewSubmitDialog";
import {
  conclusionFor, decisionFailureText, flatLayout, isTypingTarget, lockedBy, markShortcutsSeen, markerOutsideCorner, nextPendingAfter,
  panToClearPanel, positionLabel, rejectRows, shouldShowShortcutsOnOpen, submitGate, tabIndices, thumbMarks, verdictCounts, verdictForKey,
  type FlatLayout, type FlatTab,
} from "./reviewFlat";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { useReviewSession } from "./useReviewSession";
import { detailLoadState, shouldShowWaitCard } from "./waitCard";
import { reviewHits, shouldUseReworkView } from "./reviewVersion";
import { ReviewDockPanel } from "./ReviewDockPanel";
import { firstPendingIssueIndex, pageIndexForHit } from "./reviewNav";
import { customerCopy } from "./customerCopy";
import { reviewVersionToggle } from "./reviewStatus";
import { buildRevisionList, partitionReviewHits, withLocalNotes } from "./reviewEvidence";
import {
  prepareReviewMedia,
  prepareReviewMediaAfterFailure,
  type PreparedReviewMedia,
} from "./reviewMedia";

const REVIEW_COPY_DONE = { sign: "已签字", reject: "已退回" } as const;

function browserStore(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

type Props = {
  taskId: string | null;
  userId: string | null;
  /** 当前登录人显示名；只用来判断「已被别人签字」。 */
  displayName?: string | null;
  onBack: () => void;
};

function isReviewable(status?: string) {
  return status === "pending_review" || status === "in_review";
}

function isReworkable(task: TaskDetail | null) {
  if (!task) return false;
  if (Array.isArray(task.pages_v2) && task.pages_v2.length > 0) return false;
  if (task.status === "pending_review" || task.status === "in_review") return true;
  return task.status === "completed" && task.complete_kind === "rework";
}

function pageList(task: TaskDetail | null): TaskPage[] {
  const raw = task?.pages;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p) => p && (p.url || p.name));
}


function viewportLayout(): FlatLayout {
  return typeof window === "undefined" ? "wide" : flatLayout(window.innerWidth);
}

export function ReviewPage({ taskId, userId, displayName = null, onBack }: Props) {
  const { message } = App.useApp();
  const [task, setTask] = useState<TaskDetail | null>(() => reviewHandoffFor(taskId));
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [active, setActive] = useState(0);
  const [layout, setLayout] = useState<FlatLayout>(viewportLayout);
  const [panelOpen, setPanelOpen] = useState(() => viewportLayout() === "wide");
  const [tab, setTab] = useState<FlatTab>("pending");
  const [seenPages, setSeenPages] = useState<Set<number>>(() => new Set());
  const [dialog, setDialog] = useState<"sign" | "reject" | null>(null);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mediaRetry, setMediaRetry] = useState(0);
  const [phoneListOpen, setPhoneListOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [useV2, setUseV2] = useState(false);
  const { notes, setNote, clearNote, savedHitId, rememberHit } = useReviewSession(userId, taskId, useV2);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [nat, setNat] = useState<{ width: number; height: number } | null>(null);
  const [reviewMedia, setReviewMedia] = useState<PreparedReviewMedia | null>(null);
  const [reviewMediaError, setReviewMediaError] = useState<string | null>(null);
  const [viewSize, setViewSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(resetZoom);
  const [pinsOn, setPinsOn] = useState(() => readPinsOn(browserStore()));
  const [boxesOn, setBoxesOn] = useState(() => readBoxesOn(browserStore()));
  const [reviewFullscreen, setReviewFullscreen] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const zoomElRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  const laidRef = useRef({ imgW: 0, imgH: 0, offsetX: 0, offsetY: 0 });
  const activeRef = useRef(active);
  activeRef.current = active;
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  const panRaf = useRef<number | null>(null);
  const wheelEnd = useRef<number | null>(null);
  const pendingFit = useRef<number | null>(null);
  const seededNav = useRef("");
  const fitHitRef = useRef<(i: number) => void>(() => undefined);
  const busyDepthRef = useRef(0);
  const decisionQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const seededTaskId = useRef(taskId);
  const reviewMediaLoad = useRef<AbortController | null>(null);
  const taskIdRef = useRef(taskId);
  const useV2Ref = useRef(useV2);
  const pageIdxRef = useRef(pageIdx);
  taskIdRef.current = taskId;
  useV2Ref.current = useV2;
  pageIdxRef.current = pageIdx;
  const waiting = shouldShowWaitCard(task);
  const loadState = detailLoadState(task, error);

  function beginBusy() {
    busyDepthRef.current += 1;
    setBusy(true);
  }

  function endBusy() {
    busyDepthRef.current = Math.max(0, busyDepthRef.current - 1);
    if (busyDepthRef.current === 0) setBusy(false);
  }

  function paintZoom(next: typeof zoom) {
    const el = zoomElRef.current;
    if (el) {
      el.style.transform = zoomCss(next);
      el.style.setProperty("--review-pin-scale", String(1 / next.scale));
    }
  }

  function commitZoom(next: typeof zoom) {
    zoomRef.current = next;
    paintZoom(next);
    setZoom(next);
  }

  useLayoutEffect(() => {
    paintZoom(zoomRef.current);
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    function onFullscreenChange() {
      setReviewFullscreen(isElementFullscreen(pageRef.current));
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    let last = viewportLayout();
    const onResize = () => {
      const next = viewportLayout();
      if (next === last) return;
      last = next;
      setLayout(next);
      setPanelOpen(next === "wide");
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function endPan(target?: EventTarget | null) {
    if (target instanceof HTMLElement) target.classList.remove("is-panning");
    else viewRef.current?.classList.remove("is-panning");
    if (panRaf.current != null) {
      window.cancelAnimationFrame(panRaf.current);
      panRaf.current = null;
    }
    paintZoom(zoomRef.current);
    setZoom(zoomRef.current);
    panDrag.current = null;
  }

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    if (seededTaskId.current !== taskId) {
      seededTaskId.current = taskId;
      setTask(reviewHandoffFor(taskId));
    }
    setError(null);
    void api
      .task(taskId)
      .then((t) => {
        if (cancelled) return;
        setError(null);
        forgetReviewHandoff(taskId);
        setTask(t);
        setUseV2(shouldUseReworkView(t));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          forgetReviewHandoff(taskId);
          setTask(null);
        }
        setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  useEffect(() => {
    if (!taskId || !waiting) return;
    const id = window.setInterval(() => {
      void api
        .task(taskId)
        .then((next) => {
          setError(null);
          setTask(next);
          if (shouldShowWaitCard(next)) return;
          if (next.job_kind !== "rework" || next.job_status === "failed") return;
          if (shouldUseReworkView(next)) setUseV2(true);
        message.success("新稿已上传，请复核上一轮的问题。");
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) {
            forgetReviewHandoff(taskId);
            setError("这单已经不在了");
            setTask(null);
          }
        });
    }, 2500);
    return () => window.clearInterval(id);
  }, [taskId, waiting]);

  const hits = reviewHits(task, useV2).filter((h) => !skipPackSheetField(h.field));
  const pages = pageList(useV2 ? { ...(task as TaskDetail), pages: task?.pages_v2 } : task);
  const page = pages[pageIdx];
  const signed = task?.status === "completed";
  const reviewable = isReviewable(task?.status);
  const reworkable = isReworkable(task);
  const current = hits[active];

  useLayoutEffect(() => {
    if (!task) return;
    if (task.status === "completed") {
      seededNav.current = `${task.id}:signed`;
      return;
    }
    const phase = isReviewable(task.status) ? "review" : task.status;
    const key = `${task.id}:${phase}:${useV2 ? "v2" : "v1"}:${hits.length}`;
    if (seededNav.current === key) return;
    seededNav.current = key;
    const restored = hits.findIndex((hit) => hit.id === savedHitId);
    const i = restored >= 0 ? restored : firstPendingIssueIndex(hits) ?? partitionReviewHits(hits).issues[0]?.index ?? null;
    if (i == null) {
      pendingFit.current = null;
      setActive(0);
      return;
    }
    pendingFit.current = i;
    const idx = pageIndexForHit(pages, hits[i]);
    if (idx != null) setPageIdx(idx);
    setActive(i);
  }, [task?.id, task?.status, useV2, hits.length]);

  const pageNo = Number(page?.page || pageIdx + 1);
  const locked = lockedBy(task, displayName);
  const gate = submitGate(hits, reviewable, Boolean(locked));
  const counts = verdictCounts(hits);
  const tabList = tabIndices(hits, tab, active);
  /** 有 SVG 却只显示了 PNG：高清（矢量）没加载出来，保留 PNG 并给重试。 */
  const hiResFailed = Boolean(reviewMedia && reviewMedia.source === "raster" && page?.url && page.raster_url && page.url !== page.raster_url);
  const metrics = resolvePageMetrics(page, nat);
  const laid = metrics && viewSize ? fittedPage(metrics, viewSize) : { imgW: 0, imgH: 0, offsetX: 0, offsetY: 0 };
  laidRef.current = laid;
  const pinHits = useMemo(() => {
    return visiblePinGroups(pinHitGroupsForPage(hits, pageNo), signed ? -1 : active);
  }, [hits, pageNo, active, signed]);
  const currentBox = current
    ? pickHitBox(locateBoxesForHit(current), pageNo, metrics)
    : null;
  const currentHasBox = Boolean(currentBox);

  useEffect(() => {
    let cancelled = false;
    reviewMediaLoad.current?.abort();
    const controller = new AbortController();
    reviewMediaLoad.current = controller;
    setReviewMedia(null);
    setReviewMediaError(null);
    setNat(
      Number(page?.width) > 1 && Number(page?.height) > 1
        ? { width: Number(page?.width), height: Number(page?.height) }
        : null,
    );
    commitZoom(resetZoom());
    if (page) {
      void prepareReviewMedia(page, { signal: controller.signal })
        .then((media) => {
          if (cancelled || controller.signal.aborted) return;
          setReviewMedia(media);
          setNat({ width: media.width, height: media.height });
        })
        .catch((err: unknown) => {
          if (!cancelled && !controller.signal.aborted) {
            setReviewMediaError(err instanceof Error ? err.message : "页面图片加载失败");
          }
        });
    }
    return () => {
      cancelled = true;
      controller.abort();
      reviewMediaLoad.current?.abort();
      reviewMediaLoad.current = null;
    };
  }, [page?.url, page?.raster_url, page?.width, page?.height, mediaRetry]);

  function recoverDisplayedReviewMedia(failedMedia: PreparedReviewMedia) {
    if (!page) return;
    if (failedMedia.source === "raster") {
      setReviewMedia(null);
      setReviewMediaError("页面图片显示失败，请刷新后重试。");
      return;
    }
    reviewMediaLoad.current?.abort();
    const controller = new AbortController();
    reviewMediaLoad.current = controller;
    setReviewMedia(null);
    setReviewMediaError(null);
    void prepareReviewMediaAfterFailure(page, failedMedia.url, { signal: controller.signal })
      .then((media) => {
        if (controller.signal.aborted) return;
        setReviewMedia(media);
        setNat({ width: media.width, height: media.height });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setReviewMediaError(err instanceof Error ? err.message : "页面图片显示失败，请刷新后重试。");
        }
      });
  }

  useEffect(() => {
    const i = pendingFit.current;
    const mediaReady =
      Boolean(reviewMedia) &&
      Boolean(page) &&
      (reviewMedia?.url === page?.url || reviewMedia?.url === page?.raster_url);
    if (i == null || !metrics || !mediaReady || !viewSize) return;
    const id = window.requestAnimationFrame(() => {
      pendingFit.current = null;
      fitHitRef.current(i);
    });
    return () => window.cancelAnimationFrame(id);
  }, [metrics?.width, metrics?.height, pageIdx, page?.url, page?.raster_url, reviewMedia?.url, viewSize]);

  useLayoutEffect(() => {
    const node = viewRef.current;
    if (!node) return;
    const read = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setViewSize((prev) => {
        if (prev && prev.width === width && prev.height === height) return prev;
        if (prev && zoomRef.current.scale > 1) pendingFit.current = activeRef.current;
        return { width, height };
      });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(node);
    return () => ro.disconnect();
  }, [page?.url, waiting]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const parked = laidRef.current;
      const ox = e.clientX - rect.left - parked.offsetX;
      const oy = e.clientY - rect.top - parked.offsetY;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomRef.current = zoomAt(zoomRef.current, zoomRef.current.scale * factor, ox, oy);
      if (panRaf.current == null) {
        panRaf.current = window.requestAnimationFrame(() => {
          panRaf.current = null;
          paintZoom(zoomRef.current);
        });
      }
      if (wheelEnd.current != null) window.clearTimeout(wheelEnd.current);
      wheelEnd.current = window.setTimeout(() => {
        wheelEnd.current = null;
        setZoom(zoomRef.current);
      }, 80);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelEnd.current != null) window.clearTimeout(wheelEnd.current);
    };
  }, [page?.url, waiting]);

  useEffect(() => {
    setSeenPages((prev) => (prev.has(pageNo) ? prev : new Set(prev).add(pageNo)));
  }, [pageNo]);

  useEffect(() => {
    if (layout === "phone") return;
    if (shouldShowShortcutsOnOpen(browserStore())) {
      setShortcutsOpen(true);
      markShortcutsSeen(browserStore());
    }
  }, []);

  /** <1440 浮层展开后，当前标记若被右栏盖住就平移画布（第 7 行）。 */
  useEffect(() => {
    if (layout !== "overlay" || !panelOpen) return;
    const id = window.requestAnimationFrame(() => {
      const pin = viewRef.current?.querySelector(".pin.is-on") || viewRef.current?.querySelector(".hit-box.is-on");
      const aside = pageRef.current?.querySelector(".review-sidebar.is-overlay");
      if (!pin || !aside) return;
      const dx = panToClearPanel(pin.getBoundingClientRect().right, aside.getBoundingClientRect().left);
      if (dx < 0) commitZoom(panBy(zoomRef.current, dx, 0));
    });
    return () => window.cancelAnimationFrame(id);
  }, [layout, panelOpen, active, reviewMedia?.url, zoom.scale]);

  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!taskId) {
    return (
      <Empty description="还没有打开审稿单">
        <Button onClick={onBack}>回到审稿</Button>
      </Empty>
    );
  }

  function goToHit(i: number) {
    setActive(i);
    rememberHit(hits[i]?.id);
    const pIdx = pageIndexForHit(pages, hits[i]);
    if (pIdx != null && pIdx !== pageIdxRef.current) {
      pendingFit.current = i;
      setPageIdx(pIdx);
    } else {
      pendingFit.current = null;
      window.requestAnimationFrame(() => fitHitRef.current(i));
    }
  }

  function decide(hit: FieldHit, decision: Decision, note = "", opts: { undoable?: boolean } = {}): Promise<boolean> {
    const targetTaskId = task?.id;
    if (!targetTaskId || !hit.id || !reviewable || locked) return Promise.resolve(false);
    const hitId = hit.id;
    const previous = hit.decision;
    const fromIndex = hits.findIndex((h) => h.id === hitId);
    const operation = decisionQueueRef.current.then(async () => {
      beginBusy();
      try {
        const next = await api.decide(targetTaskId, { hit_id: hitId, decision, note });
        setTask((currentTask) => (currentTask?.id === targetTaskId ? next : currentTask));
        if (taskIdRef.current !== targetTaskId) return true;
        clearNote(hitId, note);
        setDecisionError(null);
        const nextUseV2 = useV2Ref.current;
        const nextHits = reviewHits(next, nextUseV2).filter((h) => !skipPackSheetField(h.field));
        const nextPages = pageList(nextUseV2 ? { ...next, pages: next.pages_v2 } : next);
        const nextPending = previous === decision ? null : nextPendingAfter(nextHits, fromIndex, decision);
        if (nextPending != null) {
          setActive(nextPending);
          rememberHit(nextHits[nextPending]?.id);
          const pIdx = pageIndexForHit(nextPages, nextHits[nextPending]);
          if (pIdx != null && pIdx !== pageIdxRef.current) {
            pendingFit.current = nextPending;
            setPageIdx(pIdx);
          } else {
            pendingFit.current = null;
            window.requestAnimationFrame(() => fitHitRef.current(nextPending));
          }
        }
        if (nextPending == null) rememberHit(hitId);
        if (opts.undoable !== false && previous !== decision) showUndo(hit, decision, previous, fromIndex);
        return true;
      } catch (err) {
        const detail = decisionFailureText(err, typeof navigator === "undefined" ? true : navigator.onLine !== false);
        if (taskIdRef.current === targetTaskId) setDecisionError(detail);
        message.error({ content: detail, key: "review-decision-error" });
        return false;
      } finally {
        endBusy();
      }
    });
    decisionQueueRef.current = operation;
    return operation;
  }

  /** 撤销提示（第 32 行）。服务端不接受改回「待确认」，没有旧结论时撤销只回到该条，等人重新下结论。 */
  function showUndo(hit: FieldHit, decision: Decision, previous: string | undefined, fromIndex: number) {
    const key = "review-undo";
    const label = REVIEW_COPY.verdict[decision as "confirm" | "issue" | "ignore"] || "";
    message.open({
      key,
      type: "success",
      duration: 5,
      content: (
        <span className="review-undo-toast" data-testid="review-undo-toast">
          {REVIEW_COPY.undoToast(label)}
          <button
            type="button"
            className="review-undo-link"
            onClick={() => {
              message.destroy(key);
              if (fromIndex >= 0) goToHit(fromIndex);
              if (previous === "confirm" || previous === "issue" || previous === "ignore") {
                void decide({ ...hit, decision }, previous, hit.note || "", { undoable: false });
              }
            }}
          >
            {REVIEW_COPY.undo}
          </button>
        </span>
      ),
    });
  }

  async function copyList() {
    if (!task) return;
    const { text, count } = buildRevisionList(
      task.product_name || task.title,
      withLocalNotes(hits, notes),
      {
        located: (hit) => {
          const hitPage = locationPageForHit(hit);
          const hitPageMeta = pages.find((candidate) => Number(candidate.page) === hitPage);
          const hitMetrics = resolvePageMetrics(hitPageMeta, hitPage === pageNo ? nat : null);
          return Boolean(pickHitBox(locateBoxesForHit(hit), hitPage, hitMetrics));
        },
      },
    );
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制 ${count} 条给设计`);
    } catch {
      message.error("复制失败，请手动选中文字");
    }
  }

  const hasUnsavedNotes = hits.some((hit) => hit.id && notes[hit.id] != null && notes[hit.id] !== (hit.note ?? ""));

  async function uploadRework(file: File) {
    if (!task || !reworkable || hasUnsavedNotes) return;
    if (!(await decisionQueueRef.current)) {
      message.error("先保存备注，再继续。");
      return;
    }
    const fd = new FormData();
    fd.append("pdf", file);
    beginBusy();
    try {
      const next = await api.rework(task.id, fd);
      setTask(next);
      if (shouldShowWaitCard(next)) return;
      setUseV2(true);
      message.success("新稿已上传，请复核上一轮的问题。");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "复核失败");
    } finally {
      endBusy();
    }
  }

  async function submit(kind: "sign" | "reject", extra: string) {
    if (!task || !reviewable || hasUnsavedNotes || locked) return;
    if (!(await decisionQueueRef.current)) {
      setSubmitFailed(true);
      return;
    }
    beginBusy();
    try {
      const next = await api.complete(task.id, { conclusion: conclusionFor(kind, extra, rejectRows(hits, notes)) });
      setTask(next);
      setDialog(null);
      setSubmitFailed(false);
      message.success(REVIEW_COPY_DONE[kind]);
    } catch {
      setSubmitFailed(true);
      // 可能已被别人签字：重读一次，用现有 completed_by 锁定。
      void api.task(task.id).then((fresh) => {
        if (fresh.status === "completed") { setTask(fresh); setDialog(null); }
      }).catch(() => undefined);
    } finally {
      endBusy();
    }
  }

  async function toggleReviewFullscreen() {
    const root = pageRef.current;
    if (!root) return;
    try {
      if (isElementFullscreen(root)) await exitElementFullscreen();
      else await enterElementFullscreen(root);
    } catch (cause) {
      message.error(fullscreenFailureMessage(cause));
    }
  }

  function fitHit(i: number) {
    const h = hits[i];
    const el = viewRef.current;
    if (!h || !metrics || !el) return;
    const box = pickHitBox(locateBoxesForHit(h), pageNo, metrics);
    if (!box) {
      commitZoom(resetZoom());
      return;
    }
    commitZoom(zoomToBox(box, metrics, { width: el.clientWidth, height: el.clientHeight }));
  }
  fitHitRef.current = fitHit;

  function pickHit(i: number) {
    if (!hits[i]) return;
    rememberHit(hits[i].id);
    setActive(i);
    const idx = pageIndexForHit(pages, hits[i]);
    if (idx != null && idx !== pageIdx) {
      pendingFit.current = i;
      setPageIdx(idx);
      return;
    }
    window.requestAnimationFrame(() => fitHitRef.current(i));
  }

  keyHandlerRef.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || dialog || isTypingTarget(e.target) || layout === "phone") return;
    if (e.key === "?") { e.preventDefault(); setShortcutsOpen((v) => !v); return; }
    if (e.key === "Escape") { setShortcutsOpen(false); return; }
    if (e.key === "[") { setPanelOpen((v) => !v); return; }
    if (e.key === "j" || e.key === "k") { step(e.key === "j" ? 1 : -1); return; }
    const verdict = verdictForKey(e.key);
    if (verdict && current && reviewable && !busy && !locked) {
      e.preventDefault();
      void decide(current, verdict, current.id ? notes[current.id] ?? current.note ?? "" : "");
    }
  };

  function step(dir: 1 | -1) {
    const k = tabList.indexOf(active);
    const target = tabList[k < 0 ? (dir > 0 ? 0 : tabList.length - 1) : k + dir];
    if (target == null) return;
    if (layout === "overlay") setPanelOpen(true);
    pickHit(target);
  }

  if (loadState === "error") {
    return (
      <section className="review-page">
        <header className="page-head">
          <h1 className="page-title">审稿单</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回列表
          </button>
        </header>
        <Alert type="error" showIcon title={error || "审稿单加载失败"} />
      </section>
    );
  }
  if (loadState === "loading") {
    return (
      <div className="desk-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开审核页…" />
      </div>
    );
  }
  if (loadState === "waiting" && task) {
    return (
      <WaitCard
        kind={task.job_kind === "rework" ? "rework" : "compare"}
        jobStatus={task.job_status}
        queueAhead={task.queue_ahead}
        stage={task.job_stage}
        stageLabel={task.job_stage_label}
        etaS={task.job_eta_s}
      />
    );
  }

  const thumbs = thumbMarks(pages, hits, seenPages);
  const issueRows = rejectRows(hits, notes);
  const phone = layout === "phone";
  const noteFor = (h?: FieldHit) => (h?.id ? notes[h.id] ?? h.note ?? "" : "");
  const zoomBy = (factor: number) => {
    const el = viewRef.current;
    if (!el) return;
    const parked = laidRef.current;
    commitZoom(zoomAt(zoomRef.current, zoomRef.current.scale * factor, el.clientWidth / 2 - parked.offsetX, el.clientHeight / 2 - parked.offsetY));
  };
  const pinSize = metrics && laid.imgW > 1 ? { w: (28 / laid.imgW) * 100, h: (28 / laid.imgH) * 100 } : { w: 4, h: 4 };

  return (
    <section
      className={`review-page review-flat-page is-${layout}${reviewFullscreen ? " is-fullscreen" : ""}`}
      data-testid="review-root"
      ref={pageRef}
    >
      <header className="review-top">
        <button type="button" className="review-crumb" onClick={onBack}>审稿台 /</button>
        <h1 className="review-title">{task?.product_name || task?.title || "审核页"}</h1>
        {Array.isArray(task?.pages_v2) && task.pages_v2.length > 0 ? (
          <span className="review-ver">
            <Tag className="review-version-current" color={useV2 ? "processing" : "default"}>{reviewVersionToggle(useV2).current}</Tag>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setUseV2((v) => !v); setPageIdx(0); setActive(0); commitZoom(resetZoom()); }}>
              {reviewVersionToggle(useV2).button}
            </button>
          </span>
        ) : null}
        {!phone ? (
          <span className="review-posn" role="group" aria-label="当前位置">
            <button type="button" aria-label="上一条" onClick={() => step(-1)}>‹</button>
            <b data-testid="review-posn">{positionLabel(tabList, active)}</b>
            <button type="button" aria-label="下一条" onClick={() => step(1)}>›</button>
          </span>
        ) : null}
        <span className="review-grow" />
        {hasUnsavedNotes ? <span className="review-draft-status" role="status">先保存备注，再继续。</span> : null}
        <span className="review-actions">
        {gate.hint ? <span className="review-signhint" id="review-sign-hint" title={gate.title} aria-live="polite">{gate.hint}</span> : null}
        <button type="button" className="btn-ghost review-reject" disabled={!gate.canReject || busy || hasUnsavedNotes} title={gate.title || undefined} onClick={() => { setSubmitFailed(false); setDialog("reject"); }}>
          {REVIEW_COPY.reject}
        </button>
        <button type="button" className="btn-primary review-sign" disabled={!gate.canSign || busy || hasUnsavedNotes} title={gate.title || undefined} aria-describedby={gate.hint ? "review-sign-hint" : undefined} onClick={() => { setSubmitFailed(false); setDialog("sign"); }}>
          {REVIEW_COPY.sign}
        </button>
        </span>
      </header>

      {locked ? <Alert className="review-lock" type="warning" showIcon title={`🔒 ${locked}`} description="只读，结论和签字/退回已锁。" /> : null}
      {error ? <Alert type="error" title={error} /> : null}
      {task?.error || task?.job_error ? (
        <Alert type="error" showIcon title={customerCopy(task.error || task.job_error || "") || "检查失败。"} />
      ) : null}
      {signed && !locked ? <Alert type="success" showIcon title={task?.complete_kind === "rework" ? "已退回。" : "已签字。"} /> : null}
      {decisionError ? <Alert type="error" showIcon title={`未保存：${decisionError}`} /> : null}

      {phone ? (
        <section className="review-phone-sum">
          <p className="review-phone-note">{REVIEW_COPY.phoneOnly}</p>
          {counts.total === 0 ? <p className="review-zero">{REVIEW_COPY.zeroIssues}</p> : (
            <details open={phoneListOpen} onToggle={(e) => setPhoneListOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary>{REVIEW_COPY.phoneIssues(counts.issue)} · 待确认 {counts.pending}</summary>
              <ul>{issueRows.map((r) => <li key={r.index}><b>#{r.no} {r.field}</b> {r.missingReason ? <span className="review-miss">{REVIEW_COPY.missingReason}</span> : r.reason}</li>)}</ul>
            </details>
          )}
        </section>
      ) : null}

      <ReviewWorkspace
        layout={layout}
        panelOpen={panelOpen}
        pending={counts.pending}
        onPanelOpen={setPanelOpen}
        thumbs={thumbs.map((t) => (
          <button key={pages[t.index]?.url || t.index} type="button" className={`review-th s-${t.state}${t.index === pageIdx ? " is-on" : ""}`}
            aria-label={t.label} aria-current={t.index === pageIdx ? "page" : undefined} title={t.label} disabled={busy} onClick={() => setPageIdx(t.index)}>
            <span className="review-th-p">P{t.page}</span>
            <span className="review-th-s" aria-hidden="true">{t.symbol}</span>
            <span className="review-th-w" aria-hidden="true">{t.word}</span>
          </button>
        ))}
        panel={
          <ReviewDockPanel
            key={`${taskId}:${useV2 ? "v2" : "v1"}`}
            hits={hits} active={active} current={current} tab={tab} onTab={setTab}
            onCollapse={layout === "wide" ? undefined : () => setPanelOpen(false)}
            currentHasBox={currentHasBox} pageNo={pageNo} reviewable={reviewable && !locked} busy={busy}
            note={noteFor(current)}
            emptyMessage={task?.status === "compare_failed" || task?.job_status === "failed" ? "检查未完成，暂时没有结果。" : "暂时没有检查结果，请翻页查看。"}
            nativeTaskEvidence={task?.native_text} ocrMeta={task?.ocr_meta} reworkCheck={task?.rework_check} onPick={pickHit}
            onDecide={(hit, decision, note) => void decide(hit, decision, note)}
            onNoteCommit={(hit, decision, note) => void decide(hit, decision, note, { undoable: false })}
            onCopy={() => void copyList()}
            onNoteChange={(value) => { if (current?.id) setNote(current.id, value); }}
          />
        }
      >
        <div className="canvas">
          {hiResFailed ? (
            <p className="review-media-hint" role="status">
              {REVIEW_COPY.hiResFailed} · <button type="button" onClick={() => setMediaRetry((n) => n + 1)}>{REVIEW_COPY.retry}</button>
            </p>
          ) : null}
          {page?.url ? (
            <div
              className="canvas-view"
              ref={viewRef}
              onDragStart={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                panDrag.current = { x: e.clientX, y: e.clientY };
                e.currentTarget.classList.add("is-panning");
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = panDrag.current;
                if (!d) return;
                e.preventDefault();
                const dx = e.clientX - d.x;
                const dy = e.clientY - d.y;
                d.x = e.clientX;
                d.y = e.clientY;
                const next = panBy(zoomRef.current, dx, dy);
                zoomRef.current = next;
                if (panRaf.current == null) {
                  panRaf.current = window.requestAnimationFrame(() => {
                    panRaf.current = null;
                    paintZoom(zoomRef.current);
                  });
                }
              }}
              onPointerUp={(e) => endPan(e.currentTarget)}
              onPointerCancel={(e) => endPan(e.currentTarget)}
              onLostPointerCapture={(e) => endPan(e.currentTarget)}
            >
              <div
                className="canvas-zoom"
                ref={zoomElRef}
                style={{
                  transform: zoomCss(zoom),
                  width: laid.imgW > 1 ? laid.imgW : undefined,
                  height: laid.imgH > 1 ? laid.imgH : undefined,
                }}
              >
                {reviewMedia ? (
                  <img
                    src={reviewMedia.url}
                    alt=""
                    decoding="sync"
                    fetchPriority="high"
                    draggable={false}
                    onDragStart={(e) => e.preventDefault()}
                    onError={() => recoverDisplayedReviewMedia(reviewMedia)}
                  />
                ) : (
                  <div className={reviewMediaError ? "review-media-status is-error" : "review-media-status"} role={reviewMediaError ? "alert" : undefined}>
                    {reviewMediaError ? (
                      <>
                        {REVIEW_COPY.lowResFailed}
                        <button type="button" className="btn-ghost" onPointerDown={(e) => e.stopPropagation()} onClick={() => setMediaRetry((n) => n + 1)}>{REVIEW_COPY.retry}</button>
                      </>
                    ) : "正在载入页面…"}
                  </div>
                )}
                {(reviewMedia ? pinHits : []).map(({ h, i, indices }) => {
                  const locateBoxes = locateBoxesForHit(h);
                  const overlays = overlaysForHit(locateBoxes, pageNo, metrics);
                  const preferred = pickHitBox(locateBoxes, pageNo, metrics);
                  const ov = preferred && metrics ? overlayFromBox(preferred, metrics) : null;
                  const pin = ov
                    ? markerOutsideCorner({ left: parseFloat(ov.left), top: parseFloat(ov.top), width: parseFloat(ov.width), height: parseFloat(ov.height) }, pinSize)
                    : null;
                  const pairActive = indices.includes(active);
                  const pinNo = (pairActive ? active : i) + 1;
                  return (
                    <Fragment key={h.id || i}>
                      {boxesOn
                        ? overlays.map((box, k) => (
                            <span
                              key={`${h.id || i}-box-${k}`}
                              className={`hit-box ${box.kind === "warn" ? "is-warn" : ""} ${pairActive ? "is-on" : "is-dim"}`.trim()}
                              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                            />
                          ))
                        : null}
                      {pinsOn && pin ? (
                        <button
                          type="button"
                          className={pairActive ? "pin is-on" : "pin is-dim"}
                          aria-label={`${REVIEW_COPY.marker} ${pinNo}`}
                          style={{ left: `${pin.left}%`, top: `${pin.top}%` }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => { if (layout === "overlay") setPanelOpen(true); pickHit(pairActive ? active : i); }}
                        >
                          {pinNo}
                        </button>
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          ) : (
            <Empty
              description={
                task?.status === "compare_failed" || task?.job_status === "failed"
                  ? "检查中断，这一页没有图。请返回看板重新上传。"
                  : "这一页还没有图"
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ padding: 48 }}
            />
          )}
        </div>
        <div className="review-tbar" role="toolbar" aria-label="稿件工具">
          <button type="button" aria-label="缩小" title="缩小 −" onClick={() => zoomBy(1 / 1.25)}>−</button>
          <button type="button" aria-label="回到 100%" title="回到 100%" onClick={() => commitZoom(resetZoom())}>{Math.round(zoom.scale * 100)}%</button>
          <button type="button" aria-label="放大" title="放大 +" onClick={() => zoomBy(1.25)}>+</button>
          <button type="button" aria-pressed={boxesOn} title={boxesOn ? "隐藏本项目框" : "显示本项目框"} onClick={() => { const next = !boxesOn; setBoxesOn(next); writeBoxesOn(browserStore(), next); }}>
            {boxesOn ? "隐藏框" : "显示框"}
          </button>
          <button type="button" aria-pressed={pinsOn} title={pinsOn ? `隐藏本项目${REVIEW_COPY.marker}` : `显示本项目${REVIEW_COPY.marker}`} onClick={() => { const next = !pinsOn; setPinsOn(next); writePinsOn(browserStore(), next); }}>
            {pinsOn ? `隐藏${REVIEW_COPY.marker}` : `显示${REVIEW_COPY.marker}`}
          </button>
          <button type="button" className="review-fullscreen-toggle" aria-pressed={reviewFullscreen} onClick={() => void toggleReviewFullscreen()}>
            {reviewFullscreen ? "退出" : "全屏"}
          </button>
          {!phone && reworkable && !(Array.isArray(task?.pages_v2) && task.pages_v2.length > 0) ? (
            <button
              type="button"
              disabled={busy || hasUnsavedNotes}
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".pdf";
                input.onchange = () => { const f = input.files?.[0]; if (f) void uploadRework(f); };
                input.click();
              }}
            >
              上传新稿
            </button>
          ) : null}
          {!phone ? <button type="button" aria-label="快捷键" aria-expanded={shortcutsOpen} title="快捷键 ?" onClick={() => setShortcutsOpen((v) => !v)}>?</button> : null}
          {shortcutsOpen && !phone ? (
            <div className="review-keys" role="note">
              <b>{REVIEW_COPY.shortcutsTitle}</b> 读要点 → 按 <kbd>1</kbd>一致 <kbd>2</kbd>有错 <kbd>3</kbd>忽略，自动跳下一条 · <kbd>J</kbd>/<kbd>K</kbd> 上下条 · <kbd>[</kbd> 右栏 · <kbd>?</kbd> 再看
              <button type="button" onClick={() => setShortcutsOpen(false)}>{REVIEW_COPY.shortcutsGotIt}</button>
            </div>
          ) : null}
        </div>
      </ReviewWorkspace>

      <ReviewSubmitDialog
        key={dialog || "closed"}
        kind={dialog}
        rows={issueRows}
        busy={busy}
        failed={submitFailed}
        onCancel={() => { if (!busy) { setDialog(null); setSubmitFailed(false); } }}
        onConfirm={(extra) => { if (dialog) void submit(dialog, extra); }}
      />
    </section>
  );
}

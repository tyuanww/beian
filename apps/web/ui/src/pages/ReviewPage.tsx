import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Empty, Tag } from "antd";
import { REVIEW_COPY, NAV_LABEL } from "../copy/labels";
import { ApiError, api, type Decision, type FieldHit, type TaskDetail, type TaskPage } from "../api";
import { WaitCard } from "../chrome/WaitCard";
import { forgetReviewHandoff, reviewHandoffFor } from "../jobHandoff";
import { fittedPage, frameRangeForCard, panBy, panToBoxAt, resetZoom, zoomAt, zoomCss } from "./canvasZoom";
import { boxesExceptRange, drawableRange, groupsForSpot, locateBoxesForHit, locationPageForHit, missLineUnboxed, overlayFromBox, overlaysForHit, pickHitBox, pinHitGroupsForPage, resolvePageMetrics, spotDrawBoxes, spotFrameBox, spotMarkerBox, visiblePinGroups } from "./pinBox";
import {
  enterElementFullscreen,
  exitElementFullscreen,
  fullscreenFailureMessage,
  isElementFullscreen,
} from "./mockupFullscreen";
import { readBoxesOn, readPinsOn, readSpotOn, writeBoxesOn, writePinsOn, writeSpotOn } from "./reviewDock";
import { ReviewSubmitDialog } from "./ReviewSubmitDialog";
import { createFlagStore, UndoToastGate } from "./undoToastGate";
import {
  clampPinToView, conclusionFor, decisionFailureText, reworkUploadBlocked, submitFailureText, flatLayout, isTypingTarget, lockedBy, markShortcutsSeen, markerOutsideCorner, nextPendingAfter,
  panToClearPanel, phonePendingLines, positionLabel, rejectNote, rejectRows, reviewPositionLabel, shouldShowShortcutsOnOpen, showCleanBill, signHint, tabIndices, thumbMarks, verdictCounts, verdictForKey, isOpenHeld, openHeldAfterPending, pendingTally,
  type FlatLayout, type FlatTab,
} from "./reviewFlat";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { phoneDraftPlan, useReviewSession } from "./useReviewSession";
import { isDecisionAllowed, isHeldStatus } from "./reviewDecisions";
import { completePayload, needsOrderHeldConfirm, showOrderHeldCheckbox } from "./orderHeldConfirm";
import { unsavedNotesHint } from "./unsavedNotesHint";
import { detailLoadState, shouldShowWaitCard } from "./waitCard";
import { shouldUseReworkView } from "./reviewVersion";
import { hrefOf } from "../appRoute";
import { canAccessTaskOwner, canReuploadFailed, failedNoHitsBar, isDeadCompareFailed, isFailedJob, isReworkableTask, isReviewableStatus, reviewGate, reviewPageHits, reviewSubmitButtons } from "./reviewActions";
import { ReviewDockPanel } from "./ReviewDockPanel";
import { ReviewHitDetail } from "./ReviewHitDetail";
import { SPOT_CARD_GAP, SPOT_CARD_MARGIN, SPOT_CARD_MIN_HEIGHT, SPOT_CARD_MIN_WIDTH, SPOT_CARD_WIDTH, avoidSpotObstacle, placeSpotCard, resolveSpotPosition, spotDragStarted, spotLane, spotSideRoom, type SpotObstacle } from "./spotCard";
import { spotTitleParts, spotNavTarget, spotPendingEmptyLine } from "./spotCopy";
import { firstPendingIssueIndex, pageIndexForHit } from "./reviewNav";
import { reviewErrorCopy, reviewErrorType, type FailedWithHitsKind } from "./reviewErrorCopy";
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
  /** 有 complete 权限才能看见签字/退回；viewer 为 false。缺省 true。 */
  canComplete?: boolean;
  /** 有 create 权限（`me.perms`）：失败条里的「重新上传这一单」要它；viewer 为 false。缺省 false。 */
  canCreate?: boolean;
  /** 当前登录人是管理员（`isAdmin(me)`）；服务端 /rework 对管理员不看归属。 */
  admin?: boolean;
  onBack: () => void;
  /** 手机底部导航「历史」。 */
  onHistory?: () => void;
};

function pageList(task: TaskDetail | null): TaskPage[] {
  const raw = task?.pages;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p) => p && (p.url || p.name));
}


function viewportLayout(): FlatLayout {
  return typeof window === "undefined" ? "wide" : flatLayout(window.innerWidth);
}

/** 收起钮相对稿面的矩形。右栏开着时没有这个钮。 */
function spotTabObstacle(canvas: HTMLElement): SpotObstacle | null {
  const tab = canvas.closest(".review-workspace")?.querySelector(".review-panel-tab");
  if (!(tab instanceof HTMLElement)) return null;
  const c = canvas.getBoundingClientRect();
  const t = tab.getBoundingClientRect();
  const obstacle = { left: t.left - c.left, top: t.top - c.top, right: t.right - c.left, bottom: t.bottom - c.top };
  if (obstacle.right <= 0 || obstacle.bottom <= 0 || obstacle.left >= c.width || obstacle.top >= c.height) return null;
  return obstacle;
}

export function ReviewPage({ taskId, userId, displayName = null, canComplete = true, canCreate = false, admin = false, onBack, onHistory }: Props) {
  const { message, modal } = App.useApp();
  const [task, setTask] = useState<TaskDetail | null>(() => reviewHandoffFor(taskId));
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [active, setActive] = useState(0);
  const [layout, setLayout] = useState<FlatLayout>(viewportLayout);
  const [panelOpen, setPanelOpen] = useState(() => viewportLayout() === "wide");
  const [tab, setTab] = useState<FlatTab>("pending");
  const [heldOpen, setHeldOpen] = useState(false);
  const [dockQuery, setDockQuery] = useState("");
  const [seenPages, setSeenPages] = useState<Set<number>>(() => new Set());
  const [dialog, setDialog] = useState<"sign" | "reject" | null>(null);
  const [orderHeldConfirm, setOrderHeldConfirm] = useState(false);
  // 换单或不再需要整单确认时清掉勾选，避免带着上一单的勾。
  useEffect(() => {
    setOrderHeldConfirm(false);
  }, [taskId]);
  /** 签字/退回失败的提示文案；null = 没失败。 */
  const [submitFailed, setSubmitFailed] = useState<string | null>(null);
  /** 同步置位，防连点：await 队列之前就挡住第二次提交。 */
  const submittingRef = useRef(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mediaRetry, setMediaRetry] = useState(0);
  const [phoneListOpen, setPhoneListOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [useV2, setUseV2] = useState(false);
  const { notes, setNote, clearNote, discardDraft, savedHitId, rememberHit } = useReviewSession(userId, taskId, useV2);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [nat, setNat] = useState<{ width: number; height: number } | null>(null);
  const [reviewMedia, setReviewMedia] = useState<PreparedReviewMedia | null>(null);
  const [reviewMediaError, setReviewMediaError] = useState<string | null>(null);
  const [viewSize, setViewSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(resetZoom);
  const [pinsOn, setPinsOn] = useState(() => readPinsOn(browserStore()));
  const [boxesOn, setBoxesOn] = useState(() => readBoxesOn(browserStore()));
  const [spotOn, setSpotOn] = useState(() => readSpotOn(browserStore()));
  const [spotPlaced, setSpotPlaced] = useState(false);
  const [closeHeldPulse, setCloseHeldPulse] = useState(0);
  const [reviewFullscreen, setReviewFullscreen] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const spotPlacedRef = useRef(false);
  const placeSpotRef = useRef<() => void>(() => undefined);
  const spotUiRef = useRef({ layout: "wide" as FlatLayout, panelOpen: false, showSpot: false });
  const spotDraggedRef = useRef(false);
  const spotPosRef = useRef<{ left: number; top: number } | null>(null);
  const spotDragRef = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [spotDragged, setSpotDragged] = useState(false);
  const [spotSize, setSpotSize] = useState<{ width: number; height: number | null }>({ width: SPOT_CARD_WIDTH, height: null });
  const spotSizeRef = useRef(spotSize);
  spotSizeRef.current = spotSize;
  const spotUserSizedRef = useRef(false);
  const spotUserWidthRef = useRef<number | null>(null);
  const spotResizeRef = useRef<{ id: number; x: number; y: number; width: number; height: number } | null>(null);
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
      el.style.setProperty("--spot-zoom", String(next.scale || 1));
    }
    placeSpotRef.current();
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

  const hits = reviewPageHits(task, useV2);
  const pages = pageList(useV2 ? { ...(task as TaskDetail), pages: task?.pages_v2 } : task);
  const page = pages[pageIdx];
  const signed = task?.status === "completed";
  const reviewable = isReviewableStatus(task?.status);
  const reworkable = isReworkableTask(task);
  const current = hits[active];

  useLayoutEffect(() => {
    if (!task) return;
    if (task.status === "completed") {
      seededNav.current = `${task.id}:signed`;
      return;
    }
    const phase = isReviewableStatus(task.status) ? "review" : task.status;
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
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // 锁页后撤销已无意义（服务端不再收结论），收起撤销提示：
  // 内容在锁页那次提交的 layout 阶段就卸掉（不等 message 退出动画），外壳再交给 destroy 收走。
  const [undoHidden] = useState(createFlagStore);
  useLayoutEffect(() => {
    undoHidden.set(Boolean(locked));
    if (locked) message.destroy("review-undo");
  }, [locked]);
  const gate = reviewGate(task, hits, Boolean(locked));
  const counts = verdictCounts(hits);
  const heldSeeded = useRef(false);
  const pendingWas = useRef(0);
  useEffect(() => {
    heldSeeded.current = false;
    pendingWas.current = 0;
    setHeldOpen(false);
    setDockQuery("");
  }, [taskId, useV2]);
  useEffect(() => {
    if (!task || task.id !== taskId) return;
    const pending = counts.pending;
    const held = hits.filter(isOpenHeld).length;
    if (!heldSeeded.current) {
      heldSeeded.current = true;
      pendingWas.current = pending;
      if (pending === 0 && held > 0) setHeldOpen(true);
      return;
    }
    if (openHeldAfterPending(pendingWas.current, pending, held)) setHeldOpen(true);
    pendingWas.current = pending;
  }, [task, taskId, hits, counts.pending]);
  const tabList = tabIndices(hits, tab, active);
  /** 有 SVG 却只显示了 PNG：高清（矢量）没加载出来，保留 PNG 并给重试。 */
  const hiResFailed = Boolean(reviewMedia && reviewMedia.source === "raster" && page?.url && page.raster_url && page.url !== page.raster_url);
  const metrics = resolvePageMetrics(page, nat);
  const laid = metrics && viewSize ? fittedPage(metrics, viewSize) : { imgW: 0, imgH: 0, offsetX: 0, offsetY: 0 };
  laidRef.current = laid;
  const spotActive = spotOn && layout !== "phone";
  const pinHits = useMemo(() => {
    const groups = pinHitGroupsForPage(hits, pageNo);
    if (spotActive) return groupsForSpot(groups, active);
    return visiblePinGroups(groups, signed ? -1 : active);
  }, [hits, pageNo, active, signed, spotActive]);
  const currentLocate = current ? locateBoxesForHit(current) : [];
  const currentBox = current ? pickHitBox(boxesExceptRange(currentLocate), pageNo, metrics) : null;
  const currentHasBox = Boolean(currentBox);
  const spotRange = current ? drawableRange(currentLocate, pageNo, metrics) : null;
  const showSpot = Boolean(spotActive && boxesOn && reviewMedia && current && (spotRange || currentBox));
  spotUiRef.current = { layout, panelOpen, showSpot };
  function markSpotPlaced(on: boolean) {
    if (spotPlacedRef.current === on) return;
    spotPlacedRef.current = on;
    setSpotPlaced(on);
  }
  placeSpotRef.current = () => {
    const ui = spotUiRef.current;
    const card = cardRef.current;
    if (!ui.showSpot || !card) {
      markSpotPlaced(false);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const c = canvas.getBoundingClientRect();
    const view = { width: Math.max(160, c.width), height: c.height };
    const wantW = spotUserSizedRef.current ? (spotUserWidthRef.current ?? SPOT_CARD_WIDTH) : SPOT_CARD_WIDTH;
    const cardHeight = card.offsetHeight || spotSizeRef.current.height || 180;
    const measure = { width: wantW, height: cardHeight };
    const frame = canvas.querySelector("[data-spot-frame].is-on");
    const dragged = spotDraggedRef.current ? spotPosRef.current : null;
    if (!dragged && !(frame instanceof HTMLElement)) return;
    const bounds = frame instanceof HTMLElement ? frame.getBoundingClientRect() : null;
    const box = bounds
      ? { left: bounds.left - c.left, top: bounds.top - c.top, width: bounds.width, height: bounds.height }
      : { left: 0, top: 0, width: 0, height: 0 };
    const placed = dragged
      ? resolveSpotPosition(dragged, box, measure, view)
      : placeSpotCard(box, measure, view, SPOT_CARD_GAP, SPOT_CARD_MARGIN);
    const pos = avoidSpotObstacle(
      placed,
      { width: placed.width, height: cardHeight },
      view,
      spotTabObstacle(canvas),
      SPOT_CARD_MARGIN,
      SPOT_CARD_GAP,
      dragged ? null : box,
    );
    if (!dragged && Math.abs(placed.width - spotSizeRef.current.width) >= 1) {
      const next = { width: placed.width, height: spotSizeRef.current.height };
      spotSizeRef.current = next;
      setSpotSize(next);
    }
    if (dragged) spotPosRef.current = { left: pos.left, top: pos.top };
    card.style.left = `${Math.round(pos.left)}px`;
    card.style.top = `${Math.round(pos.top)}px`;
    card.style.maxHeight = !dragged && placed.maxHeight ? `${placed.maxHeight}px` : "";
    card.dataset.side = placed.side;
    markSpotPlaced(true);
  };

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => placeSpotRef.current());
    ro.observe(card);
    return () => ro.disconnect();
  }, [showSpot, active, reviewMedia?.url]);

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

  useLayoutEffect(() => {
    if (layout !== "overlay" || !panelOpen) return;
    if (spotOn) fitHitRef.current(activeRef.current);
    const pin = viewRef.current?.querySelector(".pin.is-on") || viewRef.current?.querySelector(".hit-box.is-on");
    const aside = pageRef.current?.querySelector(".review-sidebar.is-overlay");
    if (!pin || !aside) return;
    const dx = panToClearPanel(pin.getBoundingClientRect().right, aside.getBoundingClientRect().left);
    if (dx < 0) commitZoom(panBy(zoomRef.current, dx, 0));
  }, [layout, panelOpen, active, reviewMedia?.url, zoom.scale, spotOn]);

  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 产品要求：切到手机（含桌面拉窄、首次打开）不丢备注草稿。草稿留在本机会话里，回到桌面还在。
  // 手机上存不了的草稿，由页头「保存备注」处理：能存就存，存不了先确认再丢。

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
    // 和按钮、快捷键同一条规则：待人工确认不能选一致。服务端也会拒收。
    if (!isDecisionAllowed(hit, decision)) return Promise.resolve(false);
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
        const nextHits = reviewPageHits(next, nextUseV2);
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
        // 已被别人签字/退回：服务端 /decision 回 400，重读后按 completed_by 锁页，不再报「没存上」。
        if (err instanceof ApiError && err.status === 400 && (await refreshIfCompleted(targetTaskId))) return false;
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
        <UndoToastGate hidden={undoHidden}>
        <span className="review-undo-toast" data-testid="review-undo-toast">
          {REVIEW_COPY.undoToast(label)}
          <button
            type="button"
            className="review-undo-link"
            onClick={() => {
              message.destroy(key);
              if (lockedRef.current) return;
              if (fromIndex >= 0) goToHit(fromIndex);
              if (previous === "confirm" || previous === "issue" || previous === "ignore") {
                void decide({ ...hit, decision }, previous, hit.note || "", { undoable: false });
              }
            }}
          >
            {REVIEW_COPY.undo}
          </button>
        </span>
        </UndoToastGate>
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

  /** 手机上没有逐条备注框：能带原结论存的先存；存不了的确认后再丢，不悄悄丢。 */
  async function settlePhoneDrafts() {
    const plan = phoneDraftPlan(hits, notes);
    for (const item of plan.save) {
      const hit = hits.find((h) => h.id === item.id);
      if (hit) await decide(hit, item.decision, item.note, { undoable: false });
    }
    if (plan.drop.length === 0) return;
    modal.confirm({
      title: REVIEW_COPY.phoneDraftLoseTitle,
      okText: REVIEW_COPY.phoneDraftLoseOk,
      cancelText: REVIEW_COPY.phoneDraftLoseCancel,
      onOk: () => { for (const id of plan.drop) discardDraft(id); },
    });
  }

  const hasUnsavedNotes = hits.some((hit) => hit.id && notes[hit.id] != null && notes[hit.id] !== (hit.note ?? ""));

  /** 选 PDF 走 /rework（页头「上传新稿」和失败条「重新上传这一单」共用）；被拒时照常提示服务端的话。 */
  async function uploadRework(file: File) {
    if (!task || !reworkable || hasUnsavedNotes) return;
    // 公网上传上限预检：超了就直接提示，不发请求（否则会先被 413 HTML 拦掉）。
    const tooLarge = reworkUploadBlocked(file);
    if (tooLarge) {
      message.error({ content: tooLarge, key: "review-rework-too-large" });
      return;
    }
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
    if (!task || !reviewable || hasUnsavedNotes || locked || submittingRef.current) return;
    submittingRef.current = true;
    beginBusy();
    try {
      if (!(await decisionQueueRef.current)) {
        setSubmitFailed(REVIEW_COPY.submitFailed);
        return;
      }
      const heldOpen = kind === "sign" ? hits.filter(isOpenHeld).length : 0;
      const conclusion = conclusionFor(kind, extra, rejectRows(hits, notes), heldOpen);
      const next = await api.complete(task.id, completePayload(
        conclusion,
        kind === "sign" && needsOrderHeldConfirm(task, hits) && orderHeldConfirm,
      ));
      setTask(next);
      setDialog(null);
      setSubmitFailed(null);
      message.success(REVIEW_COPY_DONE[kind]);
    } catch (err) {
      const failure = err instanceof ApiError
        ? { status: err.status, code: err.code, params: err.params, detail: err.message }
        : { status: null, code: null, params: null, detail: "" };
      let fresh: TaskDetail | null = null;
      if (failure.status === 400) fresh = await api.task(task.id).catch(() => null);
      const freshTally = fresh ? pendingTally(reviewPageHits(fresh, useV2Ref.current), fresh.verbatim_check === true) : [];
      const text = submitFailureText(failure, fresh, freshTally);
      if (text === REVIEW_COPY.submitFailed) console.error("[review] 提交失败", err);
      if (fresh) setTask((cur) => (cur?.id === fresh!.id ? fresh : cur));
      if (fresh?.status === "completed") {
        // 已被别人签字/退回：关框，页面按 completed_by 锁定只读。
        setDialog(null);
        setSubmitFailed(null);
        message.warning({ content: text, key: "review-submit-locked" });
      } else {
        setSubmitFailed(text);
      }
    } finally {
      submittingRef.current = false;
      endBusy();
    }
  }

  /** 重读任务；已被别人完成就换上新任务（页面按 completed_by 锁定），返回是否已完成。 */
  async function refreshIfCompleted(id: string, onCompleted?: (by: string) => void): Promise<boolean> {
    try {
      const fresh = await api.task(id);
      if (fresh.status !== "completed") return false;
      setTask((cur) => (cur?.id === id ? fresh : cur));
      onCompleted?.(fresh.completed_by || "别人");
      return true;
    } catch {
      return false;
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
    const boxes = locateBoxesForHit(h);
    const box = spotActive
      ? spotFrameBox(boxes, pageNo, metrics)
      : pickHitBox(boxesExceptRange(boxes), pageNo, metrics);
    if (!box) {
      commitZoom(resetZoom());
      return;
    }
    if (spotActive) {
      // 卡可见时不把 320 浮层加进预留，否则段落会被挤进 80px。
      const want = spotUserSizedRef.current ? (spotUserWidthRef.current ?? SPOT_CARD_WIDTH) : SPOT_CARD_WIDTH;
      commitZoom(frameRangeForCard(
        box,
        metrics,
        { width: el.clientWidth, height: el.clientHeight },
        { width: want, gap: SPOT_CARD_GAP },
        spotLane(box, metrics.width),
      ));
      return;
    }
    // 产品哥：默认整页适配进画布，切条时不自动放大；用户自己放大过才保持倍数、平移到这条的框。
    commitZoom(panToBoxAt(box, metrics, { width: el.clientWidth, height: el.clientHeight }, zoomRef.current.scale));
  }
  fitHitRef.current = fitHit;

  function publishDecision(hit: FieldHit, decision: Decision, note: string, undoable = true) {
    if (isHeldStatus(hit) && decision === "issue") {
      setTab("issue");
      setCloseHeldPulse((n) => n + 1);
    }
    void decide(hit, decision, note, { undoable });
  }

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
    // 按住不放的自动重复不算（避免一路连标）。
    if (e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey || dialog || isTypingTarget(e.target) || layout === "phone") return;
    if (e.key === "?") { e.preventDefault(); setShortcutsOpen((v) => !v); return; }
    if (e.key === "Escape") { setShortcutsOpen(false); return; }
    if (e.key === "[") { setPanelOpen((v) => !v); return; }
    if (e.key === "j" || e.key === "k") { step(e.key === "j" ? 1 : -1); return; }
    const verdict = verdictForKey(e.key);
    if (verdict && current && reviewable && !busy && !locked) {
      if (!isDecisionAllowed(current, verdict)) return;
      e.preventDefault();
      publishDecision(current, verdict, current.id ? notes[current.id] ?? current.note ?? "" : "");
    }
  };

  function step(dir: 1 | -1) {
    const k = tabList.indexOf(active);
    const target = tabList[k < 0 ? (dir > 0 ? 0 : tabList.length - 1) : k + dir];
    if (target == null) return;
    // 对照开着时栏内详情是藏的，展开只会盖住稿面。点框已经不展开。
    if (layout === "overlay" && !spotActive) setPanelOpen(true);
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

  const heldCount = hits.filter(isOpenHeld).length;
  const orderHeldNeeded = needsOrderHeldConfirm(task, hits);
  const draftBlock = unsavedNotesHint(hasUnsavedNotes);
  const failedJob = isFailedJob(task);
  // 签字/退回：有 complete 权限，且这单自己能动（同服务端 assertCanAccessTask）；别人的单（非管理员）两个按钮都不在。
  const canCompleteThis = canComplete && canAccessTaskOwner(task, { admin, openId: userId, displayName });
  const buttons = reviewSubmitButtons(task, hits, { locked: Boolean(locked), orderHeldConfirm, busy, hasUnsavedNotes, canComplete: canCompleteThis });
  const failedWithoutHits = failedJob && hits.length === 0;
  const deadCompare = isDeadCompareFailed(task);
  // 对照失败但没有有效条目（按服务端 activeHits 算，如认字单 hits_v2 为空）：不算「带上一轮条目」，走无条目失败条。
  const failedWithHits: FailedWithHitsKind | undefined = failedJob && hits.length > 0 && !deadCompare ? (task?.job_kind === "rework" ? "rework" : "compare") : undefined;
  const reuploadFailed = canReuploadFailed(task, hits, { canCreate, admin, openId: userId, displayName });
  /** 和页头「上传新稿」同一条选文件 → /rework 流程。 */
  const pickReworkPdf = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf";
    input.onchange = () => { const f = input.files?.[0]; if (f) void uploadRework(f); };
    input.click();
  };
  // 没有上一轮条目的失败条：正文 + 按钮（超页无条目只给自己能动的人「回首页」，别人的单只出标题）。
  const noHitsBar = failedNoHitsBar(task, reuploadFailed, { canCreate, admin, openId: userId, displayName });
  const failedBarAction = noHitsBar.action === "reupload" ? (
    <button type="button" className="btn-ghost review-upload-failed" disabled={busy || hasUnsavedNotes} onClick={pickReworkPdf}>
      {REVIEW_COPY.reupload}
    </button>
  ) : noHitsBar.action === "backHome" && !failedWithHits ? (
    <a href={hrefOf({ view: "tasks" })} className="btn-ghost review-back-home" data-testid="review-back-home" onClick={(e) => { e.preventDefault(); onBack(); }}>
      {REVIEW_COPY.backHome}
    </a>
  ) : undefined;
  /** 无条目失败单的正文（标题另出）：见 `failedNoHitsBar`。 */
  const failedNoHitsCopy = failedJob && !failedWithHits ? noHitsBar.body : null;
  const thumbs = thumbMarks(pages, hits, seenPages);
  const issueRows = rejectRows(hits, notes);
  const releaseHeld = task?.verbatim_check === true;
  const pendingLines = phonePendingLines(hits, releaseHeld);
  const phone = layout === "phone";
  const posnLabel = failedWithoutHits ? null : locked ? positionLabel(tabIndices(hits, "all", active), active, undefined, heldCount) : reviewPositionLabel(hits, tabList, active, tab === "pending" ? counts.pending : undefined, heldCount);
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
        {/* 手机 <720 不显示「审稿台 /」面包屑（底部导航已有「审稿台」）。 */}
        {!phone ? <button type="button" className="review-crumb" onClick={onBack}>审稿台 /</button> : null}
        <h1 className="review-title">{task?.product_name || task?.title || "审核页"}</h1>
        {task?.verbatim_check && heldCount > 0 ? (
          <p className="review-held-line" data-testid="review-held-line">
            {REVIEW_COPY.heldHeader(heldCount)}
          </p>
        ) : null}
        {Array.isArray(task?.pages_v2) && task.pages_v2.length > 0 ? (
          <span className="review-ver">
            <Tag className="review-version-current" color={useV2 ? "processing" : "default"}>{reviewVersionToggle(useV2).current}</Tag>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setUseV2((v) => !v); setPageIdx(0); setActive(0); commitZoom(resetZoom()); }}>
              {reviewVersionToggle(useV2).button}
            </button>
          </span>
        ) : null}
        {!phone && posnLabel !== null ? (
          <span className="review-posn" role="group" aria-label="当前位置">
            <button type="button" aria-label="上一条" onClick={() => step(-1)}>‹</button>
            <b data-testid="review-posn">{posnLabel}</b>
            <button type="button" aria-label="下一条" onClick={() => step(1)}>›</button>
          </span>
        ) : null}
        <span className="review-grow" />
        {hasUnsavedNotes && phone ? (
          <Button className="review-draft-settle" disabled={busy || Boolean(locked)} onClick={() => { void settlePhoneDrafts(); }}>
            {REVIEW_COPY.phoneDraftSave}
          </Button>
        ) : null}
        <span className="review-actions">
        {/* 产品哥：「上传新稿」不放看稿工具条，只在退回后出现在页头。 */}
          {!phone && reworkable && task?.status === "completed" ? (
          <button
            type="button"
            className="btn-ghost review-upload-new"
            disabled={busy || hasUnsavedNotes}
            onClick={pickReworkPdf}
          >
            上传新稿
          </button>
        ) : null}
        {draftBlock ? <span className="review-draft-status" role="status" data-testid="review-unsaved-hint">{draftBlock}</span> : null}
        {signHint(gate.hint, buttons) ? <span className="review-signhint" id="review-sign-hint" title={gate.title} aria-live="polite">{gate.hint}</span> : null}
        {showOrderHeldCheckbox(orderHeldNeeded, failedJob, canCompleteThis) ? (
          <Checkbox
            className="review-order-held"
            data-testid="review-order-held"
            checked={orderHeldConfirm}
            title={REVIEW_COPY.orderHeldConfirm}
            disabled={busy || Boolean(locked) || hasUnsavedNotes || !gate.canSign}
            onChange={(e) => setOrderHeldConfirm(e.target.checked)}
          >
            {REVIEW_COPY.orderHeldConfirm}
          </Checkbox>
        ) : null}
        {buttons.reject === "hidden" ? null : <button type="button" className="btn-ghost review-reject" disabled={buttons.reject !== "enabled"} title={gate.rejectTitle || gate.title || undefined} aria-describedby={gate.rejectTitle ? "review-reject-note" : undefined} onClick={() => { setSubmitFailed(null); setDialog("reject"); }}>
          {REVIEW_COPY.reject}
        </button>}
        {buttons.sign === "hidden" ? null : <button type="button" className="btn-primary review-sign" disabled={buttons.sign !== "enabled"} title={gate.title || undefined} aria-describedby={gate.hint ? "review-sign-hint" : undefined} onClick={() => { setSubmitFailed(null); setDialog("sign"); }}>
          {REVIEW_COPY.sign}
        </button>}
        </span>
      </header>

      {rejectNote(gate.rejectTitle, buttons) ? <p className="review-reject-note" id="review-reject-note" data-testid="review-reject-note">{gate.rejectTitle}</p> : null}
      {locked ? <Alert className="review-lock" type="warning" title={`🔒 ${locked}`} description={REVIEW_COPY.lockedNote} /> : null}
      {error ? <Alert type="error" title={error} /> : null}
      {task?.error || task?.job_error || task?.job_error_code ? (
        <Alert type={reviewErrorType(task.job_error_code)} showIcon title={reviewErrorCopy(task.error || task.job_error || "", task.job_error_code, failedWithHits, reuploadFailed) || "检查失败。"} description={failedNoHitsCopy ?? undefined} action={failedBarAction} />
      ) : failedJob ? <Alert type="error" showIcon title={failedWithHits ? reviewErrorCopy("", undefined, failedWithHits, reuploadFailed) : failedNoHitsCopy ?? (reuploadFailed ? REVIEW_COPY.reupload : "检查失败。")} action={failedBarAction} /> : null}
      {signed && !locked ? <Alert type="success" showIcon title={task?.complete_kind === "rework" ? "已退回。" : "已签字。"} /> : null}
      {decisionError ? <Alert type="error" showIcon title={`未保存：${decisionError}`} /> : null}

      {phone ? (
        <section className="review-phone-sum">
          <p className="review-phone-note">{REVIEW_COPY.phoneOnly}</p>
          {task?.verbatim_check && heldCount > 0 ? (
            <details className="review-phone-held" data-testid="review-phone-held">
              <summary>{REVIEW_COPY.heldBar(heldCount)}</summary>
              <ul>{hits.filter(isOpenHeld).map((hit) => <li key={hit.id || hit.field}>{hit.status} · 第{hit.page ?? "?"}页</li>)}</ul>
            </details>
          ) : null}
          {phone && pages.length > 1 ? (
            <div className="review-phone-pages">
              <Button disabled={busy || pageIdx <= 0} onClick={() => setPageIdx((i) => i - 1)}>{REVIEW_COPY.prevPage}</Button>
              <span>{`第${pageNo}页，共${pages.length}页`}</span>
              <Button disabled={busy || pageIdx >= pages.length - 1} onClick={() => setPageIdx((i) => i + 1)}>{REVIEW_COPY.nextPage}</Button>
            </div>
          ) : null}
          {task?.verbatim_check && showCleanBill(failedJob, counts.total, heldCount) ? (
            <div className="review-verbatim-none">
              <p>{REVIEW_COPY.verbatimNoneLead}</p>
              <p>{REVIEW_COPY.verbatimNoneNote}</p>
            </div>
          ) : null}
          {!task?.verbatim_check && showCleanBill(failedJob, counts.total, heldCount) ? <p className="review-zero">{REVIEW_COPY.zeroIssues}</p> : null}
          {/* 逐字单的待人工确认在上面单独一组，不在这里再开一条「待确认 0」。 */}
          {counts.total > 0 || (!releaseHeld && heldCount > 0) ? (
            <details open={phoneListOpen} onToggle={(e) => setPhoneListOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary>{REVIEW_COPY.phoneIssues(counts.issue)} · 待确认 {gate.pending}</summary>
              <ul>{issueRows.map((r) => <li key={r.index}><b>#{r.no} {r.field}</b> {r.missingReason ? <span className="review-miss">{REVIEW_COPY.missingReason}</span> : r.reason}</li>)}</ul>
              {pendingLines.length > 0 ? (
                <ul data-testid="review-phone-pending">
                  {pendingLines.map((row) => <li key={row.key}>{row.text}</li>)}
                </ul>
              ) : null}
            </details>
          ) : null}
        </section>
      ) : null}

      <ReviewWorkspace
        layout={layout}
        panelOpen={panelOpen}
        held={heldCount}
        pending={counts.pending}
        onPanelOpen={setPanelOpen}
        thumbs={thumbs.map((t) => (
          <button key={pages[t.index]?.url || t.index} type="button" className={`review-th s-${t.state}${t.index === pageIdx ? " is-on" : ""}`}
            aria-label={failedWithoutHits ? `第${t.page}页` : t.label} aria-current={t.index === pageIdx ? "page" : undefined} title={failedWithoutHits ? `第${t.page}页` : t.label} disabled={busy} onClick={() => setPageIdx(t.index)}>
            <span className="review-th-p">P{t.page}</span>
            {failedWithoutHits ? null : <span className="review-th-s" aria-hidden="true">{t.symbol}</span>}
            {failedWithoutHits ? null : <span className="review-th-w" aria-hidden="true">{t.word}</span>}
          </button>
        ))}
        panel={
          <ReviewDockPanel
            key={`${taskId}:${useV2 ? "v2" : "v1"}`}
            hits={hits} active={active} current={current} tab={tab} onTab={setTab}
            onCollapse={() => setPanelOpen(false)}
            currentHasBox={currentHasBox} pageNo={pageNo} reviewable={reviewable && !locked} busy={busy}
            note={noteFor(current)}
            emptyMessage={task?.status === "compare_failed" || task?.job_status === "failed" ? "检查未完成，暂时没有结果" : "暂时没有检查结果，请翻页查看"}
            nativeTaskEvidence={task?.native_text} ocrMeta={task?.ocr_meta} reworkCheck={task?.rework_check} onPick={pickHit}
            onDecide={(hit, decision, note) => publishDecision(hit, decision, note)}
            onNoteCommit={(hit, decision, note) => publishDecision(hit, decision, note, false)}
            onCopy={() => void copyList()}
            onNoteChange={(value) => { if (current?.id) setNote(current.id, value); }}
            verbatim={task?.verbatim_check === true}
            failed={failedJob}
            fscNote={task?.fsc_note}
            locationCopy={current && missLineUnboxed(locateBoxesForHit(current), pageNo, metrics) ? REVIEW_COPY.lineNotBoxed : REVIEW_COPY.noBox}
            showDetail={!showSpot}
            closeHeldPulse={closeHeldPulse}
            showProgress={!failedWithoutHits}
            heldOpen={heldOpen}
            onHeldOpen={setHeldOpen}
            query={dockQuery}
            onQuery={setDockQuery}
          />
        }
      >
        {task?.verbatim_warning ? <p className="review-verbatim-warning" role="status" data-testid="review-verbatim-warning">{customerCopy(task.verbatim_warning)}</p> : null}
        <div className="canvas" ref={canvasRef}>
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
                  ["--spot-zoom" as string]: String(zoom.scale || 1),
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
                  const pairActive = indices.includes(active);
                  const source = pairActive ? (hits[active] ?? h) : h;
                  const locateBoxes = locateBoxesForHit(source);
                  const preferred = pickHitBox(boxesExceptRange(locateBoxes), pageNo, metrics);
                  const draws = spotActive ? spotDrawBoxes(locateBoxes, pageNo, metrics) : [];
                  const overlays = spotActive
                    ? draws.flatMap((draw) => {
                        const ov = metrics ? overlayFromBox(draw.box, metrics) : null;
                        return ov ? [{ ...ov, frame: draw.frame, range: draw.box.role === "range" }] : [];
                      })
                    : overlaysForHit(locateBoxes, pageNo, metrics).map((ov) => ({ ...ov, frame: false, range: false }));
                  const markerBox = spotActive ? spotMarkerBox(draws) : preferred;
                  const anchor = markerBox && metrics ? overlayFromBox(markerBox, metrics) : null;
                  const pin = anchor
                    ? clampPinToView(
                        markerOutsideCorner({ left: parseFloat(anchor.left), top: parseFloat(anchor.top), width: parseFloat(anchor.width), height: parseFloat(anchor.height) }, pinSize),
                        laid,
                        zoom,
                        viewSize ?? { width: 0, height: 0 },
                      )
                    : null;
                  const pinNo = (pairActive ? active : i) + 1;
                  const openThis = () => {
                    if (!spotActive && layout === "overlay") setPanelOpen(true);
                    pickHit(pairActive ? active : i);
                  };
                  return (
                    <Fragment key={h.id || i}>
                      {boxesOn
                        ? overlays.map((box, k) => (
                            <span
                              key={`${h.id || i}-box-${k}`}
                              role={spotActive ? "button" : undefined}
                              tabIndex={spotActive ? 0 : undefined}
                              aria-label={spotActive ? `${REVIEW_COPY.marker} ${pinNo} ${box.range ? "范围" : "错点"}` : undefined}
                              data-spot-frame={box.frame ? "1" : undefined}
                              className={`hit-box${box.range ? " hit-range" : ""}${spotActive && !box.range ? " hit-underline" : ""} ${box.kind === "warn" ? "is-warn" : ""} ${pairActive ? "is-on" : "is-dim"}`.trim()}
                              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                              onPointerDown={spotActive ? (e) => e.stopPropagation() : undefined}
                              onClick={spotActive ? openThis : undefined}
                              onKeyDown={spotActive ? (e) => {
                                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openThis(); }
                              } : undefined}
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
                          onClick={openThis}
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
                failedJob ? REVIEW_COPY.pageMissing : REVIEW_COPY.pageNotReady
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ padding: 48 }}
            />
          )}
          {showSpot && current ? (
            <aside
              ref={cardRef}
              className={`review-spot-card${spotPlaced ? " is-placed" : ""}${spotSize.height ? " is-sized" : ""}`}
              data-testid="review-spot"
              aria-label={REVIEW_COPY.spotTitle}
              style={{ width: spotSize.width, height: spotSize.height ?? undefined }}
              onWheel={(event) => event.stopPropagation()}
            >
              <div
                className="review-spot-head"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const target = event.target;
                  if (target instanceof Element && target.closest("button")) return;
                  const card = cardRef.current;
                  if (!card) return;
                  event.stopPropagation();
                  const origin = spotPosRef.current ?? { left: card.offsetLeft, top: card.offsetTop };
                  spotDragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: origin.left, top: origin.top, moved: false };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = spotDragRef.current;
                  const card = cardRef.current;
                  const canvas = canvasRef.current;
                  if (!drag || drag.id !== event.pointerId || !card || !canvas) return;
                  const dx = event.clientX - drag.x;
                  const dy = event.clientY - drag.y;
                  if (!drag.moved && !spotDragStarted(dx, dy)) return;
                  drag.moved = true;
                  if (!spotDraggedRef.current) {
                    spotDraggedRef.current = true;
                    setSpotDragged(true);
                  }
                  const bounds = canvas.getBoundingClientRect();
                  const cardSize = { width: card.offsetWidth || SPOT_CARD_WIDTH, height: card.offsetHeight || 180 };
                  const view = { width: Math.max(160, bounds.width), height: bounds.height };
                  const next = avoidSpotObstacle(
                    { left: drag.left + dx, top: drag.top + dy },
                    cardSize,
                    view,
                    spotTabObstacle(canvas),
                    SPOT_CARD_MARGIN,
                    SPOT_CARD_GAP,
                  );
                  spotPosRef.current = next;
                  card.style.left = `${Math.round(next.left)}px`;
                  card.style.top = `${Math.round(next.top)}px`;
                  card.dataset.side = "held";
                  markSpotPlaced(true);
                }}
                onPointerUp={(event) => {
                  if (spotDragRef.current?.id === event.pointerId) spotDragRef.current = null;
                }}
                onPointerCancel={(event) => {
                  if (spotDragRef.current?.id === event.pointerId) spotDragRef.current = null;
                }}
              >
                {(() => {
                  const title = spotTitleParts(current.field, current.status || "项目", current.item, REVIEW_COPY.tabs[locked ? "all" : tab], posnLabel ?? "");
                  return (
                    <strong className="review-spot-title" data-testid="review-spot-title" aria-label={title.full} title={title.full}>
                      {title.field ? <span className="review-spot-field" title={title.field}>{title.field}</span> : null}
                      {title.field ? <span aria-hidden="true">·</span> : null}
                      <span className="review-spot-rest">{title.rest}</span>
                    </strong>
                  );
                })()}
                {spotDragged ? (
                  <button
                    type="button"
                    onClick={() => {
                      spotDraggedRef.current = false;
                      spotPosRef.current = null;
                      setSpotDragged(false);
                      placeSpotRef.current();
                    }}
                  >
                    {REVIEW_COPY.backToFrame}
                  </button>
                ) : null}
                {spotDragged ? <span className="review-spot-away">{REVIEW_COPY.cardLeftFrame}</span> : null}
              </div>
              <ReviewHitDetail
                surface="card"
                hit={current}
                hasBox
                verbatim={task?.verbatim_check === true}
                reviewable={reviewable && !locked}
                busy={busy}
                note={noteFor(current)}
                locationCopy={missLineUnboxed(currentLocate, pageNo, metrics) ? REVIEW_COPY.lineNotBoxed : REVIEW_COPY.noBox}
                onDecide={(hit, decision, note) => publishDecision(hit, decision, note)}
                onNoteCommit={(hit, decision, note) => publishDecision(hit, decision, note, false)}
                onNoteChange={(value) => { if (current.id) setNote(current.id, value); }}
                onPrev={() => { const target = spotNavTarget(locked ? tabIndices(hits, "all", active) : tabList, active, -1); if (target != null) pickHit(target); }}
                onNext={() => { const target = spotNavTarget(locked ? tabIndices(hits, "all", active) : tabList, active, 1); if (target != null) pickHit(target); }}
                prevDisabled={spotNavTarget(locked ? tabIndices(hits, "all", active) : tabList, active, -1) == null}
                nextDisabled={spotNavTarget(locked ? tabIndices(hits, "all", active) : tabList, active, 1) == null}
                pendingEmpty={spotPendingEmptyLine(counts.pending, current.decision)}
              />
              <div
                className="review-spot-resize"
                title="拖动调整大小"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const card = cardRef.current;
                  if (!card) return;
                  event.stopPropagation();
                  event.preventDefault();
                  spotResizeRef.current = {
                    id: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    width: card.offsetWidth,
                    height: card.offsetHeight,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = spotResizeRef.current;
                  const card = cardRef.current;
                  const canvas = canvasRef.current;
                  if (!drag || drag.id !== event.pointerId || !card || !canvas) return;
                  const bounds = canvas.getBoundingClientRect();
                  const view = { width: Math.max(160, bounds.width), height: bounds.height };
                  const frame = canvas.querySelector("[data-spot-frame].is-on");
                  let maxW = view.width - SPOT_CARD_MARGIN * 2;
                  let maxH = Math.max(SPOT_CARD_MIN_HEIGHT, view.height - SPOT_CARD_MARGIN * 2);
                  if (!spotDraggedRef.current && frame instanceof HTMLElement) {
                    const rect = frame.getBoundingClientRect();
                    const box = {
                      left: rect.left - bounds.left,
                      top: rect.top - bounds.top,
                      width: rect.width,
                      height: rect.height,
                    };
                    const dock = card.dataset.side;
                    if (dock === "left" || dock === "right") maxW = spotSideRoom(box, view).room;
                    else if (dock === "below") maxH = Math.max(0, view.height - SPOT_CARD_MARGIN - (box.top + box.height + SPOT_CARD_GAP));
                    else if (dock === "above") maxH = Math.max(0, box.top - SPOT_CARD_GAP - SPOT_CARD_MARGIN);
                  }
                  const minW = Math.min(SPOT_CARD_MIN_WIDTH, Math.max(0, maxW));
                  const width = Math.round(Math.min(Math.max(0, maxW), Math.max(minW, drag.width + event.clientX - drag.x)));
                  const minH = Math.min(SPOT_CARD_MIN_HEIGHT, Math.max(0, maxH));
                  const height = Math.round(Math.min(Math.max(0, maxH), Math.max(minH, drag.height + event.clientY - drag.y)));
                  spotUserSizedRef.current = true;
                  spotUserWidthRef.current = width;
                  const next = { width, height };
                  spotSizeRef.current = next;
                  setSpotSize(next);
                }}
                onPointerUp={(event) => {
                  if (spotResizeRef.current?.id !== event.pointerId) return;
                  spotResizeRef.current = null;
                  if (!spotDraggedRef.current) placeSpotRef.current();
                }}
                onPointerCancel={(event) => {
                  if (spotResizeRef.current?.id === event.pointerId) spotResizeRef.current = null;
                }}
              />
            </aside>
          ) : null}
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
          {!phone ? (
            <button
              type="button"
              aria-pressed={spotOn}
              title={REVIEW_COPY.spotTitle}
              onClick={() => {
                const next = !spotOn;
                setSpotOn(next);
                writeSpotOn(browserStore(), next);
                if (!next) {
                  spotDraggedRef.current = false;
                  spotPosRef.current = null;
                  setSpotDragged(false);
                }
                if (next) window.requestAnimationFrame(() => fitHitRef.current(activeRef.current));
                else commitZoom(resetZoom());
              }}
            >
              {REVIEW_COPY.spot}
            </button>
          ) : null}
          <button type="button" className="review-fullscreen-toggle" aria-pressed={reviewFullscreen} onClick={() => void toggleReviewFullscreen()}>
            {reviewFullscreen ? "退出" : "全屏"}
          </button>
          {!phone ? <button type="button" aria-label="快捷键" aria-expanded={shortcutsOpen} title="快捷键" onClick={() => setShortcutsOpen((v) => !v)}>?</button> : null}
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
        pending={gate.pending}
        blockedText={gate.rejectTitle}
        held={heldCount}
        fscNote={task?.fsc_note}
        busy={busy}
        failed={submitFailed}
        onCancel={() => { if (!busy) { setDialog(null); setSubmitFailed(null); } }}
        onConfirm={(extra) => { if (dialog) void submit(dialog, extra); }}
      />
      {phone ? (
        // visual-check #7（第 33 行）：手机 <720 主侧栏不显示，底部给「审稿台 / 历史」导航，签字/退回在它上面。
        <nav className="review-bottom-nav" aria-label="主导航">
          <button type="button" aria-current="page" onClick={onBack}>{NAV_LABEL.review}</button>
          <button type="button" onClick={onHistory} disabled={!onHistory}>{NAV_LABEL.history}</button>
        </nav>
      ) : null}
    </section>
  );
}

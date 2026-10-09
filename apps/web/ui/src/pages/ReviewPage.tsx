import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input } from "antd";
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
import { ReviewWorkspace } from "./ReviewWorkspace";
import { useReviewSession } from "./useReviewSession";
import { detailLoadState, shouldShowWaitCard } from "./waitCard";
import { reviewHits, shouldUseReworkView } from "./reviewVersion";
import { ReviewDockPanel } from "./ReviewDockPanel";
import { firstPendingIssueIndex, issueOrdinal, pageIndexForHit } from "./reviewNav";
import { buildRevisionList, partitionReviewHits, withLocalNotes } from "./reviewEvidence";
import {
  prepareReviewMedia,
  prepareReviewMediaAfterFailure,
  type PreparedReviewMedia,
} from "./reviewMedia";

function browserStore(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

type Props = {
  taskId: string | null;
  userId: string | null;
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

function statusLead(task: TaskDetail | null, pageIdx: number, pages: TaskPage[]) {
  const pageNo = pages[pageIdx]?.page || pageIdx + 1;
  if (!task) return "核对页";
  if (task.status === "completed") return `核对页 · 第 ${pageNo} 页 · 已签字`;
  if (isReviewable(task.status)) return `核对页 · 点疑点，图上只亮这一条。第 ${pageNo} 页 · 待审核`;
  if (task.status === "compare_failed") return `核对页 · 第 ${pageNo} 页 · 对照中断`;
  return `核对页 · 第 ${pageNo} 页`;
}

export function ReviewPage({ taskId, userId, onBack }: Props) {
  const { message } = App.useApp();
  const [task, setTask] = useState<TaskDetail | null>(() => reviewHandoffFor(taskId));
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [active, setActive] = useState(0);
  const [conclusion, setConclusion] = useState("");
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
  const [toolsOpen, setToolsOpen] = useState(true);
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
    const phone = window.matchMedia("(max-width: 720px)");
    const compactTools = () => { if (phone.matches) setToolsOpen(false); };
    compactTools();
    phone.addEventListener("change", compactTools);
    return () => phone.removeEventListener("change", compactTools);
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
        if (t.conclusion) setConclusion(t.conclusion);
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
          if (next.conclusion) setConclusion((cur) => cur || next.conclusion || "");
          if (next.job_kind !== "rework" || next.job_status === "failed") return;
          if (shouldUseReworkView(next)) setUseV2(true);
          message.success("已对照第二份 PDF。请核对上一轮有错的字段。");
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
            setReviewMediaError(err instanceof Error ? err.message : "高清核对图加载失败");
          }
        });
    }
    return () => {
      cancelled = true;
      controller.abort();
      reviewMediaLoad.current?.abort();
      reviewMediaLoad.current = null;
    };
  }, [page?.url, page?.raster_url, page?.width, page?.height]);

  function recoverDisplayedReviewMedia(failedMedia: PreparedReviewMedia) {
    if (!page) return;
    if (failedMedia.source === "raster") {
      setReviewMedia(null);
      setReviewMediaError("高清核对图显示失败，请刷新后重试");
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
          setReviewMediaError(err instanceof Error ? err.message : "高清核对图显示失败，请刷新后重试");
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

  if (!taskId) {
    return (
      <Empty description="还没有打开审核单">
        <Button onClick={onBack}>回到任务</Button>
      </Empty>
    );
  }

  function decide(hit: FieldHit, decision: Decision, note = ""): Promise<boolean> {
    const targetTaskId = task?.id;
    if (!targetTaskId || !hit.id || !reviewable) return Promise.resolve(false);
    const hitId = hit.id;
    const operation = decisionQueueRef.current.then(async () => {
      beginBusy();
      try {
        const next = await api.decide(targetTaskId, {
          hit_id: hitId,
          decision,
          note,
        });
        setTask((currentTask) => (currentTask?.id === targetTaskId ? next : currentTask));
        if (taskIdRef.current !== targetTaskId) return true;
        clearNote(hitId, note);
        setDecisionError(null);
        if (decision === "confirm" || decision === "ignore") {
          const nextUseV2 = useV2Ref.current;
          const nextHits = reviewHits(next, nextUseV2).filter((h) => !skipPackSheetField(h.field));
          const nextPages = pageList(nextUseV2 ? { ...next, pages: next.pages_v2 } : next);
          const nextPending = firstPendingIssueIndex(nextHits);
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
        }
        return true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : "记录失败";
        if (taskIdRef.current === targetTaskId) setDecisionError(detail);
        message.error(detail);
        return false;
      } finally {
        endBusy();
      }
    });
    decisionQueueRef.current = operation;
    return operation;
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
      message.error("字段结论或备注还没保存，暂不能对红");
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
      message.success("已对照第二份 PDF。请核对上一轮有错的字段。");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "对红失败");
    } finally {
      endBusy();
    }
  }

  async function signOff() {
    if (!task || !reviewable || hasUnsavedNotes) return;
    if (!(await decisionQueueRef.current)) {
      message.error("字段结论或备注还没保存，暂不能签字");
      return;
    }
    beginBusy();
    try {
      const next = await api.complete(task.id, { conclusion });
      setTask(next);
      message.success("已记录你的结论，不是系统过审");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "还不能签字");
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

  if (loadState === "error") {
    return (
      <section className="review-page">
        <header className="page-head">
          <h1 className="page-title">审核单</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回列表
          </button>
        </header>
        <Alert type="error" showIcon title={error || "审核单加载失败"} />
      </section>
    );
  }
  if (loadState === "loading") {
    return (
      <div className="desk-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开核对页…" />
      </div>
    );
  }
  if (loadState === "waiting" && task) {
    return (
      <WaitCard
        job={task.job_kind === "rework" ? "对红" : "对照"}
        jobStatus={task.job_status}
        queueAhead={task.queue_ahead}
        stage={task.job_stage}
        stageLabel={task.job_stage_label}
        etaS={task.job_eta_s}
      />
    );
  }

  return (
    <section
      className={reviewFullscreen ? "review-page is-fullscreen" : "review-page"}
      data-testid="review-root"
      ref={pageRef}
    >
      <header className="page-head">
        <div>
          <h1 className="page-title">{task?.product_name || task?.title || "核对页"}</h1>
          <p className="page-lead">{statusLead(task, pageIdx, pages)}</p>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回列表
          </button>
          <button
            type="button"
            className="btn-ghost review-fullscreen-toggle"
            aria-pressed={reviewFullscreen}
            onClick={() => void toggleReviewFullscreen()}
          >
            {reviewFullscreen ? "退出全屏" : "全屏核对"}
          </button>
          {Array.isArray(task?.pages_v2) && task.pages_v2.length > 0 ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => {
                setUseV2((v) => !v);
                setPageIdx(0);
                setActive(0);
                commitZoom(resetZoom());
              }}
            >
              {useV2 ? "看这一版" : "看上一版"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              disabled={!reworkable || busy || hasUnsavedNotes}
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".pdf";
                input.onchange = () => {
                  const f = input.files?.[0];
                  if (f) void uploadRework(f);
                };
                input.click();
              }}
            >
              上传改稿 PDF
            </button>
          )}
          {hasUnsavedNotes ? <span className="review-draft-status" role="status">请先保存各字段备注，再签字或上传改稿</span> : null}
          {pages.length > 1
            ? pages.map((p, i) => (
                <button
                  key={p.url || i}
                  type="button"
                  className={i === pageIdx ? "btn-primary" : "btn-ghost"}
                  disabled={busy}
                  onClick={() => setPageIdx(i)}
                >
                  第 {p.page || i + 1} 页
                </button>
              ))
            : null}
          {reviewable ? (
            <label className="review-conclusion review-sign-layer">
              <Input
                aria-label="结论"
                placeholder="结论，签字要用"
                value={conclusion}
                disabled={busy}
                onChange={(e) => setConclusion(e.target.value)}
              />
            </label>
          ) : signed && conclusion ? (
            <span className="review-conclusion-done review-sign-layer">{conclusion}</span>
          ) : null}
          <button
            type="button"
            className="btn-primary review-sign-layer"
            disabled={!reviewable || busy || hasUnsavedNotes || !conclusion.trim()}
            onClick={() => void signOff()}
          >
            {hits.some((h) => h.decision === "issue") ? "签字并待设计改稿" : "签字"}
          </button>
        </div>
      </header>

      {error ? <Alert type="error" title={error} style={{ marginBottom: 16 }} /> : null}
      {task?.error || task?.job_error ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} title={task.error || task.job_error} />
      ) : null}
      {task && reviewable && hits.length === 0 ? (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} title="机审没标出疑点，仍要你过一遍" />
      ) : null}
      {signed ? (
        <Alert type="success" showIcon style={{ marginBottom: 16 }} title="已签字，不是系统过审" />
      ) : null}

      <ReviewWorkspace key={userId || "session-only"} userId={userId} panel={
        <>
          {decisionError ? <Alert type="error" showIcon title={`未保存：${decisionError}`} /> : null}
          <ReviewDockPanel
            key={`${taskId}:${useV2 ? "v2" : "v1"}`}
            hits={hits} active={active} current={current} fullscreen={reviewFullscreen}
            currentHasBox={currentHasBox} pageNo={pageNo} reviewable={reviewable} busy={busy}
            note={current?.id ? notes[current.id] ?? current.note ?? "" : ""}
            emptyMessage={task?.status === "compare_failed" || task?.job_status === "failed" ? "对照没跑完，没有机审条目。" : "没有机审条目。仍请翻页看一遍。"}
            reworkCheck={task?.rework_check} onPick={pickHit}
            onDecide={(hit, decision, note) => void decide(hit, decision, note)}
            onNoteCommit={(hit, decision, note) => void decide(hit, decision, note)}
            onCopy={() => void copyList()}
            onNoteChange={(value) => { if (current?.id) setNote(current.id, value); }}
          />
        </>
      }>
        <div className="canvas glass-pane">
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
                  <div className={reviewMediaError ? "review-media-status is-error" : "review-media-status"}>
                    {reviewMediaError || "正在载入高清核对面…"}
                  </div>
                )}
                {(reviewMedia ? pinHits : []).map(({ h, i, indices }) => {
                  const locateBoxes = locateBoxesForHit(h);
                  const overlays = overlaysForHit(locateBoxes, pageNo, metrics);
                  const preferred = pickHitBox(locateBoxes, pageNo, metrics);
                  const pin = preferred && metrics ? overlayFromBox(preferred, metrics) : null;
                  const pairActive = indices.includes(active);
                  const pinNo = issueOrdinal(hits, pairActive ? active : i) || i + 1;
                  return (
                    <Fragment key={h.id || i}>
                      {boxesOn
                        ? overlays.map((ov, k) => (
                            <span
                              key={`${h.id || i}-box-${k}`}
                              className={`hit-box ${ov.kind === "warn" ? "is-warn" : ""} ${pairActive ? "is-on" : "is-dim"}`.trim()}
                              style={{ left: ov.left, top: ov.top, width: ov.width, height: ov.height }}
                            />
                          ))
                        : null}
                      {pinsOn && pin ? (
                        <button
                          type="button"
                          className={pairActive ? "pin is-on" : "pin is-dim"}
                          style={{ left: pin.pinLeft, top: pin.pinTop }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => pickHit(pairActive ? active : i)}
                        >
                          {pinNo}
                        </button>
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
              <div className="canvas-tools" onPointerDown={(e) => e.stopPropagation()}>
                {toolsOpen ? (
                  <>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const el = viewRef.current;
                        if (!el) return;
                        const parked = laidRef.current;
                        commitZoom(
                          zoomAt(
                            zoomRef.current,
                            zoomRef.current.scale * 1.2,
                            el.clientWidth / 2 - parked.offsetX,
                            el.clientHeight / 2 - parked.offsetY,
                          ),
                        );
                      }}
                    >
                      放大
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const el = viewRef.current;
                        if (!el) return;
                        const parked = laidRef.current;
                        commitZoom(
                          zoomAt(
                            zoomRef.current,
                            zoomRef.current.scale / 1.2,
                            el.clientWidth / 2 - parked.offsetX,
                            el.clientHeight / 2 - parked.offsetY,
                          ),
                        );
                      }}
                    >
                      缩小
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => commitZoom(resetZoom())}>
                      复位
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const next = !pinsOn;
                        setPinsOn(next);
                        writePinsOn(browserStore(), next);
                      }}
                    >
                      {pinsOn ? "隐藏本字段钉" : "显示本字段钉"}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const next = !boxesOn;
                        setBoxesOn(next);
                        writeBoxesOn(browserStore(), next);
                      }}
                    >
                      {boxesOn ? "隐藏本字段框" : "显示本字段框"}
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => setToolsOpen(false)}>
                      收缩
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-ghost" onClick={() => setToolsOpen(true)}>
                    标记
                  </button>
                )}
              </div>
            </div>
          ) : (
            <Empty
              description={
                task?.status === "compare_failed" || task?.job_status === "failed"
                  ? "对照中断，这一页没有图。看上面的原因，或回看板重传一对。"
                  : "这一页还没有图"
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ padding: 48 }}
            />
          )}
          <p className="page-lead" style={{ padding: "0 16px 12px" }}>
            只亮当前疑点 · 紫框已命中 · 黄框待核对 · 钉和框只作用于本字段 · 拖动画布会暂时藏框 · 滚轮缩放
          </p>
        </div>

      </ReviewWorkspace>
    </section>
  );
}

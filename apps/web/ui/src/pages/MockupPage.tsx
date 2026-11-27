import { MockupGlbViewer } from "./MockupGlbViewer";
import { glbPosterKey } from "./mockupGlbProgress";
import { type GlbTextureInfo, glbTextureFormat } from "./mockupGlbTexture";
import { type GlbVersionInfo, glbSourceUrls, glbVersions } from "./mockupGlbSource";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, ConfigProvider, Empty, Input, Segmented, Space, Table, Tag, theme as antdTheme } from "antd";
import { api, ApiError, isUploadReceiptExpired, UPLOAD_TIMEOUT_MS, type MockupJob, type PendingUploadReceipt } from "../api";
import {
  forgetMockupHandoff,
  mockupHandoffFor,
  rememberMockupHandoff,
} from "../jobHandoff";
import { UploadProgressSlot } from "../chrome/UploadProgressSlot";
import { UploadWell } from "../chrome/UploadWell";
import { useAppearance } from "../chrome/AppearanceRoot";
import { buildTheme } from "../theme";
import { WaitCard } from "../chrome/WaitCard";
import { mockupFailReason, mockupFailTag } from "./mockupError";
import { AdminRotateFront, StructureConfirmPanel } from "./StructureConfirmPanel";
import { RenderVersions } from "./RenderVersions";
import { creatorLabel, NAV_LABEL } from "../copy/labels";
import { structureIssueCopy, structureStatusLabel } from "./mockupStructure";
import { liveJobLine, mockupBoardProgress, shouldShowWaitCard } from "./waitCard";
import { stemFromFilename } from "./stemName";
import {
  HUD_MS, FULL_UPGRADE_NOTICE, STUDIO_DOWNLOAD_PREPARING,
  allowFullUpgradeNotice, downloadHudLine, missingPptHud,
} from "./mockupHud";
import {
  StudioStillDownloadHistory, StudioStillDownloadStatus, studioStillDownloadFor,
  useStudioStillDownloads, type StudioStillDownloads,
} from "./StudioStillDownloadStatus";
import {
  studioDownloadLayer,
  studioDownloadFor,
  type PaintedStudioBackground,
  type StudioShotKey,
} from "./mockupStillDownload";
import { listedReadFaces } from "./mockupReadFaces";
import { MockupPrintView } from "./MockupPrintView";
import { MockupViewTabs } from "./MockupViewTabs";
import {
  BACKDROP_LABEL,
  BACKDROP_PRESETS,
  backdropFrameClass,
  canvasFilterSupported,
  clampStudioLight,
  applyStudioPreviewDataset,
  composeStudioStill,
  loadStudioPreview,
  observeStudioFrame,
  studioAssetHref,
  studioDrawnUpgradeFailed,
  glbBackdrop,
  jobHasGround,
  jobHasReviewCard,
  jobHasSet,
  loadStillImage,
  canvasBackingSize,
  prepareStudioCanvas,
  releaseCanvasBacking,
  releaseStudioGeneration,
  stillSetKey,
  parseBackdropPreset,
  readBackdropPreset,
  reviewCardKey,
  studioBackdrop,
  writeBackdropPreset,
  type StudioPreviewSources,
  type BackdropPreset,
  STUDIO_LIGHT_DEFAULT,
  STUDIO_LIGHT_MAX,
  STUDIO_LIGHT_MIN,
} from "./mockupStudio";
import { deskClock, type DeskCardRow } from "./deskBoard";
import { DeskCol } from "./DeskCol";
import { shouldShowTaskBoard } from "./tasksBoard";
import {
  uploadIsBusy,
  UPLOAD_RECOVERY_INTERVAL_MS,
  uploadStore,
  useUploadReceiptRecovery,
  useUploadSnapshot,
  type UploadSnapshot,
} from "../uploadStore";
import {
  matchesDeskQuery,
  loadDeskReceipts,
  pendingUploadCard,
  pendingUploadOpenAction,
  pendingUploadItems,
  shouldReconcileUpload,
  type PendingUploadItem,
} from "./uploadDesk";
import {
  enterElementFullscreen,
  exitElementFullscreen,
  isElementFullscreen,
} from "./mockupFullscreen";
import { ModelViewerElement } from "@google/model-viewer";
// Version changes disconnect the old scene. Keep no unreferenced glTF texture/geometry cache.
// model-viewer's public cache policy still retains resources used by a live viewer.
ModelViewerElement.modelCacheSize = 0;

type DeskProps = {
  canCreate: boolean;
  onOpenJob: (id: string) => void;
  onCompose: () => void;
  onResumeReceipt: (receipt: string) => void;
};
type JobProps = { jobId: string; onBack: () => void };
type Layout = "board" | "table";

function mockLabel(row: MockupJob) {
  if (row.status === "done") return { text: "已完成", color: "success" as const };
  if (row.structure_status === "review_required") {
    return row.structure_code === "structure_face_mapping_incomplete"
      ? { text: "待选正面", color: "warning" as const }
      : { text: "生成失败", color: "error" as const };
  }
  if (row.structure_status === "unsupported") return { text: "暂不支持", color: "error" as const };
  if (row.status === "failed") return { text: mockupFailTag(), color: "error" as const };
  if (row.status === "queued" || row.status === "running") return { text: "生成中", color: "processing" as const };
  return { text: row.status, color: "default" as const };
}

function mockCol(row: MockupJob): "running" | "failed" | "done" {
  if (row.status === "done") return "done";
  if (row.status === "failed" || row.status === "unsupported" || row.job_status === "failed") return "failed";
  if (row.structure_status === "unsupported") return "failed";
  if (row.structure_status === "review_required" && row.structure_code !== "structure_face_mapping_incomplete") {
    return "failed";
  }
  return "running";
}

function mockTitle(row: MockupJob) {
  return row.title || row.files[0]?.name || row.id.slice(0, 8);
}

function fileHref(jobId: string, key: string, download = false, generation = "") {
  return studioAssetHref(jobId, key, generation, download);
}

function compactStudioCardHref(jobId: string, key: string, generation: string) {
  const href = fileHref(jobId, key, false, generation);
  return `${href}${href.includes("?") ? "&" : "?"}compact=1`;
}

export function MockupDesk({
  studioActor,
  openId,
  composing,
  receiptId,
  canCreate,
  canConfirmStructure,
  canAdmin,
  onOpenJob,
  onBack,
  onCompose,
  onResumeReceipt,
}: {
  studioActor: string;
  openId?: string | null;
  composing?: boolean;
  receiptId?: string | null;
  canCreate: boolean;
  canConfirmStructure: boolean;
  canAdmin?: boolean;
  onOpenJob: (id: string) => void;
  onBack: () => void;
  onCompose?: () => void;
  onResumeReceipt: (receipt: string) => void;
}) {
  const { prefs } = useAppearance();
  const lightTheme = useMemo(
    () => ({ ...buildTheme("light", prefs.fontPx), algorithm: antdTheme.defaultAlgorithm }),
    [prefs.fontPx],
  );
  let content: ReactNode;
  if (openId) {
    content = (
      <MockupJobPage
        key={openId}
        jobId={openId}
        studioActor={studioActor}
        canCreate={canCreate}
        canConfirmStructure={canConfirmStructure}
        canAdmin={canAdmin}
        onBack={onBack}
      />
    );
  } else if (composing) {
    content = <MockupNewPage key={receiptId || "active"} canCreate={canCreate} receiptId={receiptId} onCreated={onOpenJob} onBack={onBack} />;
  } else {
    content = (
      <MockupPage
        canCreate={canCreate}
        onOpenJob={onOpenJob}
        onCompose={onCompose || (() => undefined)}
        onResumeReceipt={onResumeReceipt}
      />
    );
  }
  // 打样主区在深色外观下仍是白底。只改几个 token 时，按钮底会留在外层的深色上。
  return <ConfigProvider theme={lightTheme}>{content}</ConfigProvider>;
}

function toMockCard(row: MockupJob): DeskCardRow {
  const s = mockLabel(row);
  return {
    id: row.id,
    title: mockTitle(row),
    statusText: s.text,
    statusColor: s.color,
    actor: creatorLabel(row.owner),
    at: row.job_started_at || row.created_at,
    progress: mockupBoardProgress(row),
    queued: row.job_status === "queued",
    live: liveJobLine({ ...row, kind: "mockup" }),
    error:
      row.structure_status === "review_required"
        ? structureIssueCopy(row)
        : row.structure_status === "unsupported"
          ? structureIssueCopy(row)
          : row.status === "failed"
            ? mockupFailReason(row.error || row.job_error)
            : null,
  };
}

export function MockupPage({
  canCreate,
  onOpenJob,
  onCompose,
  onResumeReceipt,
}: DeskProps) {
  const { message, modal } = App.useApp();
  const localUpload = useUploadSnapshot("mockup");
  const [rows, setRows] = useState<MockupJob[]>([]);
  const [receipts, setReceipts] = useState<PendingUploadReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [layout, setLayout] = useState<Layout>("board");
  const [reload, setReload] = useState(0);
  const listGen = useRef(0);
  const pendingStarts = useRef(new Set<string>());

  function refreshList() {
    const gen = ++listGen.current;
    return api
      .mockups()
      .then((list) => {
        if (gen !== listGen.current) return list;
        setRows(list);
        return list;
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    let cancelled = false;
    const gen = ++listGen.current;
    setLoading(true);
    setError(null);
    void Promise.all([api.mockups(), loadDeskReceipts(canCreate, api.uploads)])
      .then(([list, pending]) => {
        if (cancelled || gen !== listGen.current) return;
        setRows(list);
        for (const receipt of pending) uploadStore.recover("mockup", receipt);
        setReceipts(pending);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败，再试一次");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canCreate, reload]);

  const boardLive = rows.some((row) => row.job_status === "queued" || row.job_status === "running");
  useEffect(() => {
    if (!boardLive) return;
    const id = window.setInterval(() => {
      void refreshList();
    }, 2500);
    return () => window.clearInterval(id);
  }, [boardLive]);

  const reconcileUpload = shouldReconcileUpload("mockup", localUpload, receipts);
  useEffect(() => {
    if (!canCreate || !reconcileUpload) return;
    let cancelled = false;
    const reconcile = () => {
      void api
        .uploads()
        .then((pending) => {
          if (cancelled) return;
          for (const receipt of pending) uploadStore.recover("mockup", receipt);
          setReceipts(pending);
        })
        .catch(() => undefined);
    };
    reconcile();
    const interval = window.setInterval(reconcile, UPLOAD_RECOVERY_INTERVAL_MS);
    const stop = window.setTimeout(() => window.clearInterval(interval), UPLOAD_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(stop);
    };
  }, [canCreate, localUpload?.clientUploadId, localUpload?.phase, reconcileUpload]);

  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        matchesDeskQuery(submitted, mockTitle(row), ...row.files.map((file) => file.name)),
      ),
    [rows, submitted],
  );
  const allPendingItems = useMemo(
    () => pendingUploadItems("mockup", localUpload, receipts),
    [localUpload, receipts],
  );
  const pendingItems = useMemo(
    () => pendingUploadItems("mockup", localUpload, receipts, submitted),
    [localUpload, receipts, submitted],
  );
  const pendingCards = useMemo(
    () => pendingItems.map((item) => pendingUploadCard(item, "待生成")),
    [pendingItems],
  );
  const pendingByKey = useMemo(() => new Map(pendingItems.map((item) => [item.key, item])), [pendingItems]);
  const board = useMemo(
    () => ({
      running: filteredRows.filter((row) => mockCol(row) === "running"),
      failed: filteredRows.filter((row) => mockCol(row) === "failed"),
      done: filteredRows.filter((row) => mockCol(row) === "done"),
    }),
    [filteredRows],
  );
  const totalCount = filteredRows.length + pendingItems.length;
  const allCount = rows.length + allPendingItems.length;
  const showSearch = Boolean(submitted) || allCount > 0;
  const showBoard = shouldShowTaskBoard(totalCount, submitted) && totalCount > 0;
  const tableRows = useMemo(
    () => [...pendingCards, ...filteredRows.map(toMockCard)],
    [pendingCards, filteredRows],
  );

  function openPending(item: PendingUploadItem) {
    const action = pendingUploadOpenAction(item);
    if (action === "active") {
      onCompose();
      return;
    }
    if (action === "resume") {
      if (!item.receipt) return;
      onResumeReceipt(item.receipt);
      return;
    }
    if (!item.receipt || !item.productName) return;
    const receipt = item.receipt;
    const productName = item.productName;
    modal.confirm({
      title: "开始生成这份文件？",
      content: `品名：${productName}。上传完成后会进入生成队列。`,
      okText: "开始生成",
      cancelText: "稍后开始",
      onOk: async () => {
        if (pendingStarts.current.has(receipt)) return;
        pendingStarts.current.add(receipt);
        try {
          const next = await api.startMockup({ receipt, title: productName, product_name: productName });
          uploadStore.clear("mockup", receipt);
          setReceipts((current) => current.filter((saved) => saved.id !== receipt));
          message.success("生成已开始。");
          rememberMockupHandoff(next);
          onOpenJob(next.id);
        } catch (err) {
          if (isUploadReceiptExpired(err)) {
            uploadStore.clear("mockup", receipt);
            setReceipts((current) => current.filter((saved) => saved.id !== receipt));
            void refreshList();
            message.warning("上传已失效，请重新选择文件。");
          } else {
            message.error(err instanceof Error ? err.message : "无法开始生成");
          }
        } finally {
          pendingStarts.current.delete(receipt);
        }
      },
    });
  }

  function openCard(id: string) {
    const pending = pendingByKey.get(id);
    if (pending) openPending(pending);
    else onOpenJob(id);
  }

  return (
    <section className="mockup-desk">
      <div className="desk-head">
        <div>
          <h1 className="page-title">{NAV_LABEL.mockup}</h1>
          <p className="page-lead">查看包装的立体效果和印刷面。</p>
        </div>
        <Space wrap>
          {showSearch ? (
            <Input.Search
              allowClear
              placeholder="搜索品名或文件名"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              onClear={() => {
                setQ("");
                setSubmitted("");
              }}
              onSearch={(value) => setSubmitted(value.trim())}
              style={{ width: 240 }}
            />
          ) : null}
          {showBoard ? (
            <Segmented
              value={layout}
              onChange={(value) => setLayout(value as Layout)}
              options={[
                { label: "看板", value: "board" },
                { label: "表格", value: "table" },
              ]}
            />
          ) : null}
          {canCreate ? (
            <Button type="primary" onClick={onCompose}>
              新建打样
            </Button>
          ) : null}
        </Space>
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={error}
          action={
            <Button size="small" onClick={() => setReload((count) => count + 1)}>
              再试一次
            </Button>
          }
        />
      ) : null}
      {!showBoard ? (
        <div className="desk-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              loading ? (
                <div>正在加载…</div>
              ) : submitted ? (
                <div>没有找到相关记录</div>
              ) : (
                <div>
                  <div>还没有打样记录</div>
                  <div className="desk-empty-hint">上传平面稿开始。</div>
                </div>
              )
            }
          >
            {loading ? null : submitted ? (
              <Button
                onClick={() => {
                  setQ("");
                  setSubmitted("");
                }}
              >
                清空
              </Button>
            ) : canCreate ? (
              <Button type="primary" onClick={onCompose}>
                新建打样
              </Button>
            ) : null}
          </Empty>
        </div>
      ) : layout === "board" ? (
        <div className="review-board">
          <DeskCol
            title="生成中"
            hint="正在上传或生成。"
            rows={[...pendingCards, ...board.running.map(toMockCard)]}
            onOpen={openCard}
          />
          <DeskCol title="生成失败" hint="打开查看原因。" rows={board.failed.map(toMockCard)} onOpen={onOpenJob} />
          <DeskCol title="已完成" hint="打开查看结果。" rows={board.done.map(toMockCard)} onOpen={onOpenJob} />
        </div>
      ) : (
        <Table<DeskCardRow>
          rowKey="id"
          loading={loading}
          dataSource={tableRows}
          pagination={false}
          scroll={{ x: 760 }}
          onRow={(row) => ({ onClick: () => openCard(row.id), style: { cursor: "pointer" } })}
          columns={[
            { title: "品名 / 文件", dataIndex: "title" },
            {
              title: "状态",
              width: 180,
              render: (_, row) => (
                <div>
                  <Tag color={row.statusColor}>{row.statusText}</Tag>
                  {row.live ? <div className="review-card-live">{row.live}</div> : null}
                </div>
              ),
            },
            { title: "更新时间", dataIndex: "at", width: 180, render: (value: string) => deskClock(value) },
            { title: "操作人", dataIndex: "actor", width: 100, render: (value: string) => value || "—" },
            { title: "", key: "open", width: 100, render: () => <Button type="link">打开</Button> },
          ]}
        />
      )}
    </section>
  );
}

function receiptFromSnapshot(snapshot: UploadSnapshot | null): PendingUploadReceipt | null {
  if (!snapshot?.receipt || snapshot.phase !== "ready") return null;
  return {
    id: snapshot.receipt,
    files: snapshot.files.map((file) => ({ ...file, received: file.bytes, last_modified: file.lastModified })),
    bytes: snapshot.files.reduce((sum, file) => sum + file.bytes, 0),
    received: snapshot.files.reduce((sum, file) => sum + file.bytes, 0),
    created_at: snapshot.createdAt,
    kind: snapshot.kind,
    phase: "ready",
  };
}

export function MockupNewPage({
  canCreate,
  receiptId,
  onCreated,
  onBack,
}: {
  canCreate: boolean;
  receiptId?: string | null;
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const { message, modal } = App.useApp();
  const upload = useUploadSnapshot("mockup");
  const localReceipt = receiptFromSnapshot(upload);
  const localMatches = Boolean(receiptId && localReceipt?.id === receiptId);
  const [resumeSource, setResumeSource] = useState<"local" | "remote">(() => (!receiptId || localMatches ? "local" : "remote"));
  const [restoredReceipt, setRestoredReceipt] = useState<PendingUploadReceipt | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [productName, setProductName] = useState(resumeSource === "local" ? upload?.productName || "" : "");
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(false);
  const startLock = useRef(false);
  useUploadReceiptRecovery("mockup", upload, canCreate && resumeSource === "local");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (resumeSource !== "local" || !upload) return;
    setProductName(upload.productName || "");
  }, [resumeSource, upload?.clientUploadId, upload?.productName]);

  useEffect(() => {
    if (!canCreate || !receiptId) {
      setRestoredReceipt(null);
      setResumeError(null);
      return;
    }
    if (resumeSource === "local") {
      setRestoredReceipt(null);
      return;
    }
    let cancelled = false;
    setResumeError(null);
    void api
      .uploads()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((item) => item.id === receiptId && item.kind === "mockup") || null;
        if (found?.phase === "paused") {
          uploadStore.restore("mockup", found);
          setProductName(found.product_name || "");
          setResumeSource("local");
          setRestoredReceipt(null);
          return;
        }
        setRestoredReceipt(found);
        if (found) {
          setProductName(found.product_name || "");
        } else {
          setResumeError("上传已失效，请返回 3D 打样重新选择。");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setResumeError(err instanceof Error ? err.message : "上传回执读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [canCreate, receiptId, resumeSource]);

  const receipt = resumeSource === "local" ? upload?.receipt || null : restoredReceipt?.id || null;
  const files = resumeSource === "local" ? upload?.files || [] : restoredReceipt?.files || [];
  const ai = files.find((file) => file.field === "file" || file.field === "ai");
  const busy = resumeSource === "local" && uploadIsBusy(upload);

  function updateName(next: string) {
    setProductName(next);
    if (resumeSource === "local") uploadStore.updateMeta("mockup", { productName: next });
  }

  function takeFile(next: File | null) {
    if (next) setResumeError(null);
    let name = productName;
    if (next && !name.trim()) {
      name = stemFromFilename(next.name);
      setProductName(name);
    }
    const state = uploadStore.replaceFile("mockup", "ai", next, { productName: name });
    if (state.phase === "failed" && state.error) message.error(state.error);
    else if (next) message.success("已选平面稿");
  }

  async function run() {
    if (startLock.current) return;
    const name = productName.trim();
    if (!name) {
      message.warning("品名必填。");
      return;
    }
    if (!receipt) {
      message.warning("请先等文件传完。");
      return;
    }
    startLock.current = true;
    setSubmitting(true);
    try {
      const next = await api.startMockup({
        receipt,
        title: name,
        product_name: name,
      });
      uploadStore.clear("mockup", receipt);
      rememberMockupHandoff(next);
      if (!mounted.current) return;
      onCreated(next.id);
    } catch (err) {
      if (!mounted.current) return;
      if (isUploadReceiptExpired(err)) {
        uploadStore.clear("mockup", receipt);
        setRestoredReceipt(null);
        setResumeSource("local");
        setResumeError("上传已失效，请重新选择文件。");
        message.warning("上传已失效，请重新选择文件。");
      } else {
        message.error(err instanceof Error ? err.message : "生成失败");
      }
    } finally {
      startLock.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  function confirmAbandon() {
    modal.confirm({
      title: "放弃这次上传？",
      content: "暂存文件会删除；以后需要时要重新选择并上传。",
      okText: "放弃上传",
      okButtonProps: { danger: true },
      cancelText: "继续保留",
      onOk: async () => {
        try {
          if (resumeSource === "remote" && restoredReceipt) {
            const result = await api.discardUpload(restoredReceipt.id);
            if (!result.ok) throw new Error("这份上传已经过期或已经开工");
            setRestoredReceipt(null);
          } else {
            await uploadStore.abandon("mockup");
          }
          message.success("已放弃这次上传。");
          onBack();
        } catch (err) {
          message.error(err instanceof Error ? err.message : "无法放弃这次上传");
          throw err;
        }
      },
    });
  }

  if (!canCreate) {
    return (
      <section className="new-form mockup-desk">
        <header className="page-head">
          <h1 className="page-title">新建打样</h1>
          <Button onClick={onBack}>返回</Button>
        </header>
        <Alert type="warning" showIcon title="当前账号只有查看权限，不能上传或新建打样。" />
      </section>
    );
  }

  return (
    <section className="new-form mockup-desk">
      <header className="page-head">
        <div>
          <h1 className="page-title">新建打样</h1>
          <p className="page-lead">上传平面稿，生成立体图。</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Button disabled={submitting} onClick={onBack}>
            返回
          </Button>
          <Button
            type="primary"
            disabled={!receipt || busy || submitting}
            onClick={() => void run()}
          >
            {submitting ? "正在提交" : busy ? "上传中" : "开始生成"}
          </Button>
        </div>
      </header>
      <div className="new-meta">
        <label className="new-meta-name">
          品名
          <input
            maxLength={80}
            placeholder="选稿后自动填写，可修改。"
            value={productName}
            onChange={(event) => updateName(event.target.value)}
          />
        </label>
      </div>
      {resumeError ? <Alert type="error" showIcon title={resumeError} /> : null}
      <UploadProgressSlot
        snapshot={resumeSource === "local" ? upload : null}
        receipt={resumeSource === "remote" ? restoredReceipt : null}
        readyText="上传完成，可以开始生成。"
        onRetry={resumeSource === "local" ? () => uploadStore.retry("mockup") : undefined}
        onDiscard={files.length ? confirmAbandon : undefined}
      />
      <div className="upload-row is-single">
        <UploadWell
          icon="/brand/ui/well-pdf.svg"
          title="平面稿"
          hint="拖入或选择文件。"
          accept=".ai"
          fileName={ai?.name}
          fileBytes={ai?.bytes}
          disabled={resumeSource === "remote"}
          onFile={takeFile}
          onReject={() => message.warning("请选择 AI 文件。")}
        >
          <span className="upload-well-btn">{ai ? "更换平面稿" : "选择平面稿"}</span>
        </UploadWell>
      </div>
    </section>
  );
}

type StudioPreviewVisit = {
  identity: string;
  id: number;
  shots: ReadonlySet<StudioShotKey>;
  painted: boolean;
};

function useStudioFirstPaint(identity: string, front: boolean, back: boolean) {
  const [visit, setVisit] = useState<StudioPreviewVisit>(() => ({ identity, id: 0, shots: new Set(), painted: false }));
  if (visit.identity !== identity) {
    setVisit({ identity, id: visit.id + 1, shots: new Set(), painted: false });
  }
  const { id, shots, painted } = visit;
  const complete = (!front || shots.has("white_a")) && (!back || shots.has("white_b"));

  useEffect(() => {
    if (!complete || (!front && !back)) return;
    // Allow the browser to present the canvases before admitting background requests.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        setVisit((previous) => previous.id === id ? { ...previous, painted: true } : previous);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [id, complete, front, back]);

  const markSettled = useCallback((shot: StudioShotKey) => {
    setVisit((previous) => previous.id === id ? { ...previous, shots: new Set([...previous.shots, shot]) } : previous);
  }, [id]);

  return { afterFirstPreview: (!front && !back) || painted, markSettled };
}

const RESULT_TABS = [
  { key: "studio", label: "立体效果" },
  { key: "print", label: "印刷面" },
] as const;
type ResultView = (typeof RESULT_TABS)[number]["key"];

export function MockupJobPage({
  jobId,
  studioActor,
  canCreate,
  canConfirmStructure,
  canAdmin = false,
  onBack,
}: JobProps & { studioActor: string; canCreate: boolean; canConfirmStructure: boolean; canAdmin?: boolean }) {
  const { message } = App.useApp();
  const [job, setJob] = useState<MockupJob | null>(() => mockupHandoffFor(jobId));
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState("");
  const [glbFs, setGlbFs] = useState(false);
  const [productLight, setProductLight] = useState(STUDIO_LIGHT_DEFAULT);
  const [backgroundLight, setBackgroundLight] = useState(STUDIO_LIGHT_DEFAULT);
  const [retrying, setRetrying] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [lightsOpen, setLightsOpen] = useState(false);
  const [backdrop, setBackdrop] = useState<BackdropPreset>(readBackdropPreset);
  const [view, setView] = useState<ResultView>("studio");
  const [unfoldedSubmitting, setUnfoldedSubmitting] = useState(false);
  const [unfoldedError, setUnfoldedError] = useState<string | null>(null);
  const glbBox = useRef<HTMLDivElement>(null);
  const hudTimer = useRef<number | null>(null);
  const announced = useRef("");
  const fullUpgradeHud = useRef<string | null>(null);
  const lastGlbFs = useRef(false);
  const seededJobId = useRef(jobId);
  const waiting = Boolean(job) && shouldShowWaitCard(job);
  const repairPending = job?.print_faces_repair?.status === "queued" || job?.print_faces_repair?.status === "running";
  const unfoldedPending = job?.unfolded_print?.status === "queued" || job?.unfolded_print?.status === "running";
  const generation=job?.current_render_generation_id || job?.studio_relit_at || job?.job_finished_at || job?.created_at || "";
  const whiteA = job?.files?.find((file) => file.key === "white_a");
  const whiteB = job?.files?.find((file) => file.key === "white_b");
  const downloads = useStudioStillDownloads(jobId, studioActor, job?.id === jobId && job.status === "done");
  const showStudioHud = downloads.preparing && (!hud || hud === FULL_UPGRADE_NOTICE);
  const displayedHud = showStudioHud ? STUDIO_DOWNLOAD_PREPARING : hud;
  const groundA = job?.files?.find((file) => file.key === "white_a_ground");
  const groundB = job?.files?.find((file) => file.key === "white_b_ground");
  const { afterFirstPreview, markSettled } = useStudioFirstPaint(
    `${jobId}:${generation}`, Boolean(whiteA && groundA), Boolean(whiteB && groundB),
  );
  const visibleGeneration=useRef(generation);
  visibleGeneration.current=generation;
  const sourceErrorGeneration=useRef<string | null>(null);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>()=>releaseStudioGeneration(jobId,generation),[jobId,generation]);
  useEffect(()=>{fullUpgradeHud.current=null;},[generation]);

  function refreshSource(options?: { quiet?: boolean }) {
    if (sourceErrorGeneration.current === generation) return;
    sourceErrorGeneration.current=generation;
    void api.refreshMockup(jobId).then(next=>{
      if (!alive.current || visibleGeneration.current !== generation) return;
      setJob(next);
      if (options?.quiet && next.current_render_generation_id === generation) return;
      notice(next.current_render_generation_id !== generation ? "当前版本已变化，已刷新图片" : "版本图片暂时读不到，请重新打开此单");
    }).catch(()=>{if(alive.current && visibleGeneration.current === generation && !options?.quiet)notice("版本图片暂时读不到，未改动当前版本");});
  }

  function notice(text: string) {
    if (text === FULL_UPGRADE_NOTICE) {
      if (!allowFullUpgradeNotice(fullUpgradeHud.current, generation)) return;
      fullUpgradeHud.current = generation;
    }
    setHud(text);
    if (hudTimer.current != null) window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(""), HUD_MS);
  }

  async function retry() {
    if (!job || retrying) return;
    setRetrying(true);
    try {
      const next = await api.retryMockup(job.id);
      setError(null);
      setJob(next);
      message.success("已重新排队。");
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : "重试失败");
    } finally {
      setRetrying(false);
    }
  }

  async function repairPrintFaces() {
    if (!job || repairing || repairPending) return;
    setRepairing(true);
    notice("正在生成印刷面");
    try {
      const next = await api.repairMockupPrintFaces(job.id);
      setError(null);
      setJob(next);
      notice(next.print_faces_repair?.status === "queued" || next.print_faces_repair?.status === "running"
        ? "印刷面已排队，可以离开此页" : "印刷面已生成");
    } catch (err: unknown) {
      const status = err instanceof ApiError ? err.status : 0;
      notice("");
      message.error(
        status === 404
          ? "这版还不能补切面"
          : err instanceof Error
            ? err.message
            : "印刷面生成失败",
      );
    } finally {
      setRepairing(false);
    }
  }

  useEffect(() => {
    return () => {
      if (hudTimer.current != null) window.clearTimeout(hudTimer.current);
      if (isElementFullscreen(glbBox.current)) void exitElementFullscreen().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    function onFs() {
      const el = glbBox.current;
      const on = isElementFullscreen(el);
      setGlbFs(on);
      if (on === lastGlbFs.current) return;
      lastGlbFs.current = on;
    }
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (seededJobId.current !== jobId) {
      seededJobId.current = jobId;
      setJob(mockupHandoffFor(jobId));
      setView("studio");
      setUnfoldedSubmitting(false);
      setUnfoldedError(null);
    }
    setError(null);
    announced.current = "";
    void api
      .mockup(jobId)
      .then((next) => {
        if (cancelled) return;
        setError(null);
        forgetMockupHandoff(jobId);
        setJob(next);
        announced.current = `${next.id}:${next.status}`;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          forgetMockupHandoff(jobId);
          setJob(null);
        }
        setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (!job?.id || (!waiting && !repairPending && !unfoldedPending)) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void api
        .mockup(job.id)
        .then((next) => {
          if (cancelled) return;
          setError(null);
          setJob(next);
          if (repairPending) {
            if (next.print_faces_repair?.status === "failed") notice(next.print_faces_repair.error || "印刷面生成失败，请重试");
            else if (next.print_faces_repair?.status === "succeeded") notice("印刷面已生成");
            return;
          }
          if (shouldShowWaitCard(next)) return;
          const key = `${next.id}:${next.status}`;
          if (announced.current === key) return;
          announced.current = key;
          if (next.status === "failed") message.error(mockupFailReason(next.error || next.job_error));
          else if (next.status === "done") message.success("生成完成。请查看立体效果和印刷面。");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 404) {
            forgetMockupHandoff(job.id);
            setJob(null);
          }
          setError(err instanceof Error ? err.message : "打样结果加载失败");
        });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job?.id, waiting, repairPending, unfoldedPending, message]);

  if (error && !job) {
    return (
      <section>
        <header className="page-head">
          <h1 className="page-title">打样结果</h1>
          <Button onClick={onBack}>
            返回 3D 打样
          </Button>
        </header>
        <Alert type="error" showIcon title={error} />
      </section>
    );
  }

  if (!job) {
    return (
      <section>
        <header className="page-head">
          <h1 className="page-title">打样结果</h1>
          <Button onClick={onBack}>
            返回 3D 打样
          </Button>
        </header>
        <div className="desk-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开打样结果…" />
        </div>
      </section>
    );
  }

  if (waiting) {
    return (
      <section className="mockup-sheet">
        <header className="page-head">
          <div>
            <h1 className="page-title">{mockTitle(job)}</h1>
            <p className="page-lead">正在生成，可离开页面。</p>
          </div>
          <div className="mockup-sheet-head-actions">
            {canCreate ? (
              <Button disabled={retrying} onClick={() => void retry()}>
                {retrying ? "正在重试…" : "重试"}
              </Button>
            ) : null}
            <Button onClick={onBack}>
              返回 3D 打样
            </Button>
          </div>
        </header>
        <WaitCard
          kind="mockup"
          jobStatus={job.job_status || (job.status === "queued" || job.status === "running" ? job.status : "queued")}
          queueAhead={job.queue_ahead}
          stage={job.job_stage}
          stageLabel={job.job_stage_label}
          etaS={job.job_eta_s}
        />
      </section>
    );
  }

  if (job.structure_status === "review_required" || job.structure_status === "unsupported") {
    return (
      <section className="mockup-sheet is-structure-confirm">
        <header className="page-head">
          <div>
            <h1 className="page-title">{mockTitle(job)}</h1>
            <p className="page-lead">
              {canAdmin && job.structure_input?.proposal_layers.length
                && !(job.structure_preview?.net_proposals || []).length
                ? "请选择刀线所在图层。"
                : job.structure_status === "review_required" && (job.structure_preview?.net_proposals || []).length
                  ? "点选印有品名的一面。"
                  : `${structureStatusLabel(job) || "这份稿现在无法生成"}。`}
            </p>
          </div>
          <Button onClick={onBack}>
            返回 3D 打样
          </Button>
        </header>
        <StructureConfirmPanel
          key={job.id}
          job={job}
          canConfirmStructure={canConfirmStructure}
          canAdmin={canAdmin}
          onConfirmed={setJob}
        />
      </section>
    );
  }

  const hasGlb = (job.files || []).some((f) => f.key === "glb");
  const hasPpt = (job.files || []).some((f) => f.key === "ppt");
  const grounded = jobHasGround(job.files);
  const viewId = `mockup-result-${job.id}`;
  const showStudio = view === "studio";
  const boundAssetsReady=!job.render_generation_capabilities || Boolean(job.current_render_generation_id);
  const readFaces = listedReadFaces(job.files || []);
  const missingRequired = (["front", "back", "left", "right"] as const).filter((role) => !readFaces.includes(role));
  const canRepairPrint = Boolean(job.can_repair_print_faces);
  const repairFailed = job.print_faces_repair?.status === "failed";
  const showPrintAlert = job.status === "done" && (missingRequired.length > 0 || repairPending || repairFailed);
  const printAlertCopy = repairFailed ? "印刷面生成失败，请重试。" : canRepairPrint && canCreate
    ? "缺少印刷面图，可重新生成。"
    : canCreate
      ? "没有可用底稿，请重新生成。"
      : "没有印刷面图，请重新生成。";

  const requestUnfolded = async () => {
    setUnfoldedSubmitting(true);
    setUnfoldedError(null);
    try {
      const next = await api.requestUnfoldedPrint(job.id);
      if (alive.current && seededJobId.current === job.id) setJob(next);
    } catch (err) {
      if (!alive.current || seededJobId.current !== job.id) return;
      setUnfoldedError(err instanceof Error ? err.message : "展开图生成失败，请重试。");
      void api.mockup(job.id).then((next) => {
        if (alive.current && seededJobId.current === job.id) setJob(next);
      }).catch(() => undefined);
    } finally {
      if (alive.current && seededJobId.current === job.id) setUnfoldedSubmitting(false);
    }
  };

  return (
    <section className="mockup-sheet">
      <header className="page-head">
        <div>
          <h1 className="page-title">{mockTitle(job)}</h1>
        </div>
        <div className="mockup-sheet-head-actions">
          {showStudio ? <Button
            aria-expanded={lightsOpen}
            aria-controls="mockup-studio-lights"
            onClick={() => setLightsOpen((open) => !open)}
          >
            {lightsOpen ? "收起调灯" : "调灯"}
          </Button> : null}
          {canCreate && job.status === "failed" ? (
            <Button disabled={retrying} onClick={() => void retry()}>
              {retrying ? "正在重试…" : "重试"}
            </Button>
          ) : null}
          {showStudio && job.render_generation_capabilities?.history.allowed ? (
            <Button aria-expanded={versionsOpen} aria-controls="mockup-render-versions" onClick={()=>setVersionsOpen(value=>!value)}>
              {versionsOpen ? "收起版本" : "出图版本"}
            </Button>
          ) : null}
          <Button onClick={onBack}>
            返回 3D 打样
          </Button>
          {!showStudio || grounded ? null : hasPpt ? (
            <Button
              href={fileHref(job.id, "ppt", true)}
              download
              onClick={() => notice(downloadHudLine("PPT"))}
            >
              下载演示稿
            </Button>
          ) : (
            <Button onClick={() => notice(missingPptHud())}>
              下载演示稿
            </Button>
          )}
        </div>
      </header>
      {error ? <p className="page-lead" role="status">{error}</p> : null}
      {job.status === "failed" ? (
        <Alert type="error" showIcon title={mockupFailReason(job.error || job.job_error)} />
      ) : null}

      {showPrintAlert ? (
        <div className="mockup-print-alert" role="status" aria-live="polite">
          <p className="mockup-print-alert-copy">
            {repairPending ? (job.print_faces_repair?.status === "queued" ? "印刷面已排队，可以离开此页" : "正在生成印刷面，可以离开此页")
              : repairing ? "正在提交生成请求" : job.print_faces_repair?.error || printAlertCopy}
          </p>
          {canRepairPrint && canCreate ? (
            <Button
              disabled={repairing || repairPending}
              aria-busy={repairing || repairPending || undefined}
              onClick={() => void repairPrintFaces()}
            >
              {repairing || repairPending ? "正在生成印刷面" : "生成印刷面"}
            </Button>
          ) : null}
        </div>
      ) : null}

      <MockupViewTabs id={viewId} label="打样内容" tabs={RESULT_TABS} active={view} onChange={setView} />
      <div className="mockup-result-panel" role="tabpanel" aria-labelledby={`${viewId}-tab-studio`} hidden={!showStudio}>
        {job.render_generation_capabilities ? <RenderVersions key={job.id} job={job} open={versionsOpen}
          productLight={productLight} backgroundLight={backgroundLight} onJob={setJob} /> : null}
        <div className="mockup-backdrop-switch">
          <span className="mockup-backdrop-label" id="mockup-backdrop-label">
            背景
          </span>
          <Segmented
            aria-labelledby="mockup-backdrop-label"
            options={BACKDROP_PRESETS.map((preset) => ({
              label: BACKDROP_LABEL[preset],
              value: preset,
            }))}
            value={backdrop}
            onChange={(value) => {
              const next = parseBackdropPreset(value);
              setBackdrop(next);
              writeBackdropPreset(next);
            }}
          />
        </div>
        {lightsOpen ? (
          <div id="mockup-studio-lights">
            <StudioLightSliders
              productLight={productLight}
              backgroundLight={backgroundLight}
              onProductLight={setProductLight}
              onBackgroundLight={setBackgroundLight}
            />
          </div>
        ) : null}

        {canAdmin && !repairPending && job.status === "done" && !job.has_render_generations && !job.render_mutation ? (
          <AdminRotateFront job={job} onConfirmed={setJob} />
        ) : null}

        {!boundAssetsReady ? <p className="page-lead" role="status">正在确认当前版本资源。</p> : <div key={`${job.id}:${generation}`} data-render-generation={generation} className={grounded ? "mockup-sheet-photos is-grounded" : "mockup-sheet-photos"}>
          {groundA && whiteA ? (
            <GroundedShot
              afterFirstPreview={afterFirstPreview && !downloads.preparing}
              onInitialPreview={markSettled}
              generation={generation}
              onSourceError={refreshSource}
              jobId={job.id}
              files={job.files}
              fileKey="white_a"
              groundKey="white_a_ground"
              alt="正面与侧面成片"
              caption="正面 + 侧面"
              downloads={downloads}
              productLight={productLight}
              backgroundLight={backgroundLight}
              backdrop={backdrop}
              onProductLight={setProductLight}
              onBackgroundLight={setBackgroundLight}
              onNotice={notice}
            />
          ) : whiteA ? (
            <WhiteShot
              key={`${job.id}:${generation}:white_a`}
              queueFull={grounded}
              generation={generation}
              onSourceError={grounded ? () => refreshSource({ quiet: true }) : refreshSource}
              jobId={job.id}
              fileKey="white_a"
              alt="正面与侧面白底"
              caption="正面 + 侧面"
              downloads={downloads}
              productLight={productLight}
              backgroundLight={backgroundLight}
              backdrop={backdrop}
              onProductLight={setProductLight}
              onBackgroundLight={setBackgroundLight}
            />
          ) : (
            <figure className="mockup-sheet-photo">
              <div
                className={`mockup-sheet-frame${grounded ? " is-studio-ground" : ""} ${backdropFrameClass(backdrop)}`}
                style={{ background: studioBackdrop(backgroundLight, backdrop) }}
              >
                <p className="page-lead">还没有正面+侧面。</p>
              </div>
              <figcaption className="mockup-sheet-cap">正面 + 侧面</figcaption>
            </figure>
          )}
          {groundB && whiteB ? (
            <GroundedShot
              afterFirstPreview={afterFirstPreview && !downloads.preparing}
              onInitialPreview={markSettled}
              generation={generation}
              onSourceError={refreshSource}
              jobId={job.id}
              files={job.files}
              fileKey="white_b"
              groundKey="white_b_ground"
              alt="反面与侧面成片"
              caption="反面 + 侧面"
              downloads={downloads}
              productLight={productLight}
              backgroundLight={backgroundLight}
              backdrop={backdrop}
              onProductLight={setProductLight}
              onBackgroundLight={setBackgroundLight}
              onNotice={notice}
            />
          ) : whiteB ? (
            <WhiteShot
              key={`${job.id}:${generation}:white_b`}
              queueFull={grounded}
              generation={generation}
              onSourceError={grounded ? () => refreshSource({ quiet: true }) : refreshSource}
              jobId={job.id}
              fileKey="white_b"
              alt="反面与侧面白底"
              caption="反面 + 侧面"
              downloads={downloads}
              productLight={productLight}
              backgroundLight={backgroundLight}
              backdrop={backdrop}
              onProductLight={setProductLight}
              onBackgroundLight={setBackgroundLight}
            />
          ) : (
            <figure className="mockup-sheet-photo">
              <div
                className={`mockup-sheet-frame${grounded ? " is-studio-ground" : ""} ${backdropFrameClass(backdrop)}`}
                style={{ background: studioBackdrop(backgroundLight, backdrop) }}
              >
                <p className="page-lead">还没有反面+侧面。</p>
              </div>
              <figcaption className="mockup-sheet-cap">反面 + 侧面</figcaption>
            </figure>
          )}
          {hasGlb ? (
            <GlbShot
              afterFirstPreview={afterFirstPreview}
              deferLoad={downloads.preparing}
              jobId={job.id}
              files={job.files}
              generation={generation}
              onSourceError={() => refreshSource({ quiet: true })}
              boxRef={glbBox}
              backgroundLight={backgroundLight}
              productLight={productLight}
              backdrop={backdrop}
              glbFs={glbFs}
              onNotice={notice}
            />
          ) : (
            <figure className="mockup-sheet-photo">
              <div className="mockup-sheet-frame">
                <Empty description={job.status === "done" ? "暂无 3D 模型" : "3D 模型还未生成"} />
              </div>
              <figcaption className="mockup-sheet-cap">3D 模型</figcaption>
            </figure>
          )}
        </div>}
        <StudioStillDownloadHistory downloads={downloads} visible={[
          whiteA && boundAssetsReady ? studioDownloadFor(downloads.entries, { generation, fileKey: "white_a", backdrop, productLight, backgroundLight }) : undefined,
          whiteB && boundAssetsReady ? studioDownloadFor(downloads.entries, { generation, fileKey: "white_b", backdrop, productLight, backgroundLight }) : undefined,
        ]} />
      </div>
      <div className="mockup-result-panel" role="tabpanel" aria-labelledby={`${viewId}-tab-print`} hidden={showStudio}>
        <MockupPrintView key={job.id} job={job} active={!showStudio} canCreate={canCreate}
          submitting={unfoldedSubmitting} error={unfoldedError} onRequest={() => void requestUnfolded()}
          onDownload={() => notice(downloadHudLine("印刷面"))} />
      </div>
      {typeof document !== "undefined"
        ? createPortal(
            <div role="status" aria-live="polite" aria-atomic="true">
              {displayedHud && <p className="mockup-hud" aria-hidden={showStudioHud || undefined}>{displayedHud}</p>}
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

function GlbShot({
  afterFirstPreview,
  deferLoad,
  jobId,
  files,
  generation,
  onSourceError,
  boxRef,
  backgroundLight,
  productLight,
  backdrop,
  glbFs,
  onNotice,
}: {
  afterFirstPreview: boolean;
  deferLoad: boolean;
  jobId: string;
  files?: Array<{ key: string } & GlbTextureInfo & GlbVersionInfo>;
  generation:string;
  onSourceError:()=>void;
  boxRef: { current: HTMLDivElement | null };
  backgroundLight: number;
  productLight: number;
  backdrop: BackdropPreset;
  glbFs: boolean;
  onNotice: (text: string) => void;
}) {
  const fill = glbBackdrop(backgroundLight, backdrop);
  const posterKey = glbPosterKey(files, backdrop);
  const glbVersionInfo = glbVersions(files);
  const glbUrls = glbSourceUrls(fileHref(jobId, "glb", false, generation), glbVersionInfo);
  const [showPoster, setShowPoster] = useState(false);
  useEffect(() => {
    if (afterFirstPreview && !deferLoad) setShowPoster(true);
  }, [afterFirstPreview, deferLoad]);
  const poster = showPoster && posterKey
    ? posterKey.endsWith("_card") ? compactStudioCardHref(jobId, posterKey, generation) : fileHref(jobId, posterKey, false, generation)
    : undefined;
  return (
    <figure className="mockup-sheet-photo">
      <div
        className={`mockup-sheet-frame mockup-sheet-glb ${backdropFrameClass(backdrop)}`}
        ref={boxRef}
        style={{ background: fill }}
      >
        <MockupGlbViewer
          allowLoad={afterFirstPreview}
          deferLoad={deferLoad}
          source={glbUrls.primary}
          originalSource={glbUrls.original}
          versions={glbVersionInfo}
          poster={poster}
          textureFormat={glbTextureFormat(files)}
          backdrop={backdrop}
          backgroundLight={backgroundLight}
          productLight={productLight}
          onSourceError={onSourceError}
        />
        <button
          type="button"
          className="mockup-dl mockup-dl-fs"
          aria-label={glbFs ? "退出全屏" : "全屏"}
          onClick={() => {
            const el = boxRef.current;
            if (!el) return;
            if (isElementFullscreen(el)) {
              void exitElementFullscreen().catch(() => undefined);
              return;
            }
            void enterElementFullscreen(el).catch(() => onNotice("全屏打不开"));
          }}
        >
          {glbFs ? "退出" : "全屏"}
        </button>
        <a
          className="mockup-dl mockup-dl-corner"
          href={fileHref(jobId, "glb", true,generation)}
          download
          aria-label="下载模型"
          onClick={() => onNotice(downloadHudLine("GLB"))}
        >
          下载
        </a>
      </div>
      <figcaption className="mockup-sheet-cap">3D 模型</figcaption>
    </figure>
  );
}

type PreviewSource = CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };

function useReleasedCanvasRef() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const setCanvasRef = useCallback((node: HTMLCanvasElement | null) => {
    if (canvasRef.current && canvasRef.current !== node) releaseCanvasBacking(canvasRef.current);
    canvasRef.current = node;
  }, []);
  return [canvasRef, setCanvasRef] as const;
}

function GroundedShot({
  afterFirstPreview,
  onInitialPreview,
  generation,
  onSourceError,
  jobId,
  files,
  fileKey,
  groundKey,
  alt,
  caption,
  downloads,
  productLight,
  backgroundLight,
  backdrop,
  onProductLight,
  onBackgroundLight,
  onNotice,
  lazy,
}: {
  afterFirstPreview: boolean;
  onInitialPreview: (shot: StudioShotKey) => void;
  generation: string;
  onSourceError:()=>void;
  jobId: string;
  files?: Array<{ key: string }>;
  fileKey: "white_a" | "white_b";
  groundKey: "white_a_ground" | "white_b_ground";
  alt: string;
  caption: string;
  downloads: StudioStillDownloads;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
  onNotice: (text: string) => void;
  lazy?: boolean;
}) {
  const [bad, setBad] = useState(false);
  const [ready, setReady] = useState(0);
  const [frameSize, setFrameSize] = useState<[number, number]>([0, 0]);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [visible, setVisible] = useState(!lazy);
  const [canvasRef, setCanvasRef] = useReleasedCanvasRef();
  const frameRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<StudioPreviewSources | null>(null);
  const loaderRef = useRef<ReturnType<typeof loadStudioPreview> | null>(null);
  const settledRef = useRef<string>();
  const paintedBackground = useRef<PaintedStudioBackground | null>(null);
  const lightboxBackground = useRef<PaintedStudioBackground | null>(null);
  const download = studioStillDownloadFor(downloads, { generation, fileKey, backdrop, productLight, backgroundLight });
  const noticedUpgrade = useRef("");
  const sourceIdentity = `${jobId}:${generation}:${fileKey}:${groundKey}:${(files || []).map((file) => file.key).sort().join(",")}`;

  function markInitialPreview() {
    if (settledRef.current === sourceIdentity) return;
    settledRef.current = sourceIdentity;
    onInitialPreview(fileKey);
  }

  useEffect(() => {
    setBad(false);
    setOriginalOpen(false);
    setReady(0);
    previewRef.current = null;
    paintedBackground.current = null;
    noticedUpgrade.current = "";
    if (canvasRef.current) {
      releaseCanvasBacking(canvasRef.current);
      applyStudioPreviewDataset(canvasRef.current, null, backdrop, null);
    }
  }, [sourceIdentity]);

  useEffect(() => {
    if (!visible || bad || !frameRef.current) return;
    return observeStudioFrame(frameRef.current, (width, height) => setFrameSize([width, height]));
  }, [visible, bad]);

  useEffect(() => {
    if (!lazy || visible) return;
    const node = frameRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [lazy, visible]);

  useEffect(() => {
    if (!visible) return;
    const urls = (key: "white_a" | "white_b" | "white_a_ground" | "white_b_ground" | "white_a_set" | "white_b_set") => ({
      full: fileHref(jobId, key, false, generation),
      card: jobHasReviewCard(files, key) ? compactStudioCardHref(jobId, reviewCardKey(key), generation) : undefined,
    });
    const loader = loadStudioPreview({
      product: urls(fileKey), ground: urls(groundKey),
      set: jobHasSet(files, fileKey) ? urls(stillSetKey(fileKey)) : null,
    }, (sources) => {
      previewRef.current = sources;
      setBad(false);
      setReady((value) => value + 1);
    }, () => {
      setBad(true);
      markInitialPreview();
      onSourceError();
    });
    loaderRef.current = loader;
    return () => {
      loader.cancel();
      loaderRef.current = null;
      previewRef.current = null;
    };
  }, [visible, sourceIdentity]);

  useEffect(() => {
    loaderRef.current?.show(backdrop, afterFirstPreview);
  }, [visible, sourceIdentity, backdrop, afterFirstPreview]);

  useEffect(() => {
    if (!visible || bad || !ready) return;
    const canvas = canvasRef.current;
    const sources = previewRef.current;
    if (!canvas || !sources || !frameSize[0] || !frameSize[1]) return;
    const ctx = prepareStudioCanvas(canvas, frameSize[0], frameSize[1]);
    if (!ctx) { setBad(true); markInitialPreview(); applyStudioPreviewDataset(canvas, null, backdrop, null); return; }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
    composeStudioStill(ctx, canvas.width, canvas.height, sources.product, sources.ground, {
      productLight,
      backgroundLight,
      backdrop,
      set: sources.set,
      filterSupported: canvasFilterSupported(ctx),
    });
    paintedBackground.current = { backdrop, layer: sources.set ? "set" : sources.ground ? "ground" : "none" };
    applyStudioPreviewDataset(canvas, sources.facts, backdrop, sources.set);
    markInitialPreview();
    if (typeof window !== "undefined" && (window as Window & { __RF09_PERF__?: boolean }).__RF09_PERF__
      && typeof performance !== "undefined" && typeof performance.mark === "function") {
      if (performance.getEntriesByName("rf09-composed", "mark").length >= 24) performance.clearMarks("rf09-composed");
      performance.mark("rf09-composed");
    }
    if (studioDrawnUpgradeFailed(sources.facts, backdrop, sources.set) && noticedUpgrade.current !== sourceIdentity) {
      noticedUpgrade.current = sourceIdentity;
      onNotice(FULL_UPGRADE_NOTICE);
    }
    } catch {
      paintedBackground.current = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      applyStudioPreviewDataset(canvas, null, backdrop, null);
      setBad(true);
      markInitialPreview();
    }
  }, [visible, bad, ready, frameSize, productLight, backgroundLight, backdrop]);

  useEffect(() => {
    if (!originalOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOriginalOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [originalOpen]);

  return (
    <figure className="mockup-sheet-photo">
      <div
        className={`mockup-sheet-frame is-studio-ground ${backdropFrameClass(backdrop)}`}
        ref={frameRef}
        style={{ background: studioBackdrop(backgroundLight, backdrop) }}
      >
        {bad ? (
          <p className="page-lead">这张预览图无法显示，请重新生成。</p>
        ) : (
          <canvas ref={setCanvasRef} className="mockup-studio-canvas" aria-label={alt} />
        )}
        {bad ? null : (
          <>
            <button
              type="button"
              className="mockup-dl mockup-dl-fs"
              aria-label={`打开${caption}原图`}
              onClick={() => {
                lightboxBackground.current = null;
                setOriginalOpen(true);
              }}
            >
              原图
            </button>
            <button
              type="button"
              className="mockup-dl mockup-dl-corner"
              aria-label={`下载${caption}`}
              aria-disabled={download.active || undefined}
              onClick={() => download.start(studioDownloadLayer(backdrop, paintedBackground.current))}
            >
              下载
            </button>
          </>
        )}
      </div>
      <figcaption className="mockup-sheet-cap">
        {caption}
        <StudioStillDownloadStatus caption={caption} state={download.state} onRetry={downloads.start} muted={originalOpen && !bad} />
      </figcaption>
      {originalOpen && !bad
        ? createPortal(
            <div
              className="mockup-still-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`${caption}原图`}
              onClick={() => setOriginalOpen(false)}
            >
              <div className="mockup-still-lightbox-panel" onClick={(event) => event.stopPropagation()}>
                <div
                  className={`mockup-still-lightbox-stage is-studio-ground ${backdropFrameClass(backdrop)}`}
                  style={{ background: studioBackdrop(backgroundLight, backdrop) }}
                >
                  <GroundedLightboxStill
                    generation={generation}
                    jobId={jobId}
                    files={files}
                    fileKey={fileKey}
                    groundKey={groundKey}
                    alt={alt}
                    productLight={productLight}
                    backgroundLight={backgroundLight}
                    backdrop={backdrop}
                    paintedBackground={lightboxBackground}
                    placeholder={previewRef.current ? { product: previewRef.current.product, ground: previewRef.current.ground, set: previewRef.current.set } : null}
                  />
                </div>
                <StudioLightSliders
                  productLight={productLight}
                  backgroundLight={backgroundLight}
                  onProductLight={onProductLight}
                  onBackgroundLight={onBackgroundLight}
                />
                <StudioStillDownloadStatus caption={caption} state={download.state} onRetry={downloads.start} />
                <div className="mockup-still-lightbox-actions">
                  <button
                    type="button"
                    className="mockup-dl"
                    aria-disabled={download.active || undefined}
                    onClick={() => download.start(studioDownloadLayer(backdrop, lightboxBackground.current))}
                  >
                    下载
                  </button>
                  <button type="button" className="mockup-dl" onClick={() => setOriginalOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </figure>
  );
}

function GroundedLightboxStill({
  generation,
  jobId,
  files,
  fileKey,
  groundKey,
  alt,
  productLight,
  backgroundLight,
  backdrop,
  placeholder,
  paintedBackground,
}: {
  generation: string;
  jobId: string;
  files?: Array<{ key: string }>;
  fileKey: "white_a" | "white_b";
  groundKey: "white_a_ground" | "white_b_ground";
  alt: string;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  placeholder?: { product: PreviewSource; ground: PreviewSource | null; set: PreviewSource | null } | null;
  paintedBackground: { current: PaintedStudioBackground | null };
}) {
  const [canvasRef, setCanvasRef] = useReleasedCanvasRef();
  const sourcesRef = useRef<{ product: PreviewSource; ground: PreviewSource | null; set: PreviewSource | null } | null>(
    placeholder || null,
  );
  const [loaded, setLoaded] = useState(placeholder ? 1 : 0);
  const [paintError, setPaintError] = useState(false);
  useEffect(() => {
    const seed = placeholder ?? null;
    sourcesRef.current = seed;
    setLoaded(seed ? 1 : 0);
    setPaintError(false);
    const seedSet = seed?.set ?? null;
    const controller = new AbortController();
    const loadOriginal = (key: string) => loadStillImage(fileHref(jobId, key, false, generation), {
      urgency: "original", signal: controller.signal,
    });
    void (async () => {
      try {
        const setKey = stillSetKey(fileKey);
        const productP = loadOriginal(fileKey);
        const groundP = loadOriginal(groundKey);
        const setP = jobHasSet(files, fileKey)
          ? loadOriginal(setKey)
          : Promise.resolve(null);
        const required = Promise.all([productP, groundP]);
        required.catch(() => undefined);
        setP.catch(() => undefined);
        const [product, ground] = await required;
        if (controller.signal.aborted) return;
        sourcesRef.current = { product, ground, set: seedSet };
        setLoaded((n) => n + 1);
        try {
          const set = await setP;
          if (controller.signal.aborted) return;
          sourcesRef.current = { product, ground, set };
          setLoaded((n) => n + 1);
        } catch {
          /* keep the shown set card; do not swap in ground-only */
        }
      } catch {
        /* lightbox keeps the card placeholder or STUDIO_GROUND_FILL stage */
      }
    })();
    return () => {
      controller.abort();
      if (canvasRef.current) releaseCanvasBacking(canvasRef.current);
    };
  }, [jobId, generation, files, fileKey, groundKey]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const sources = sourcesRef.current;
    if (!canvas || !sources || !loaded) return;
    const ctx = prepareStudioCanvas(
      canvas,
      Number(sources.product.naturalWidth || sources.product.width || 0),
      Number(sources.product.naturalHeight || sources.product.height || 0),
    );
    if (!ctx) return;
    try {
    composeStudioStill(ctx, canvas.width, canvas.height, sources.product, sources.ground, {
      productLight,
      backgroundLight,
      backdrop,
      set: sources.set,
      filterSupported: canvasFilterSupported(ctx),
    });
    paintedBackground.current = { backdrop, layer: sources.set ? "set" : sources.ground ? "ground" : "none" };
    setPaintError(false);
    } catch {
      paintedBackground.current = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setPaintError(true);
    }
  }, [loaded, productLight, backgroundLight, backdrop, jobId, generation]);
  return <>{paintError ? <p className="page-lead">调灯失败，请重新加载图片。</p> : null}<canvas ref={setCanvasRef} className="mockup-studio-lightbox-canvas" aria-label={alt} /></>;
}

function StudioLightSliders({
  productLight,
  backgroundLight,
  onProductLight,
  onBackgroundLight,
}: {
  productLight: number;
  backgroundLight: number;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
}) {
  return (
    <div className="mockup-studio-lights">
      <label className="mockup-studio-light">
        产品灯光
        <input
          aria-label="产品灯光"
          aria-valuemax={STUDIO_LIGHT_MAX}
          aria-valuemin={STUDIO_LIGHT_MIN}
          aria-valuenow={productLight}
          max={STUDIO_LIGHT_MAX}
          min={STUDIO_LIGHT_MIN}
          onChange={(event) => onProductLight(clampStudioLight(Number(event.target.value)))}
          step={0.02}
          type="range"
          value={productLight}
        />
      </label>
      <label className="mockup-studio-light">
        背景灯光
        <input
          aria-label="背景灯光"
          aria-valuemax={STUDIO_LIGHT_MAX}
          aria-valuemin={STUDIO_LIGHT_MIN}
          aria-valuenow={backgroundLight}
          max={STUDIO_LIGHT_MAX}
          min={STUDIO_LIGHT_MIN}
          onChange={(event) => onBackgroundLight(clampStudioLight(Number(event.target.value)))}
          step={0.02}
          type="range"
          value={backgroundLight}
        />
      </label>
    </div>
  );
}

function WhiteShot({
  queueFull,
  generation,
  onSourceError,
  jobId,
  fileKey,
  alt,
  caption,
  downloads,
  productLight,
  backgroundLight,
  backdrop,
  onProductLight,
  onBackgroundLight,
}: {
  queueFull: boolean;
  generation: string;
  onSourceError:()=>void;
  jobId: string;
  fileKey: "white_a" | "white_b";
  alt: string;
  caption: string;
  downloads: StudioStillDownloads;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
}) {
  const [bad, setBad] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const download = studioStillDownloadFor(downloads, { generation, fileKey, backdrop, productLight, backgroundLight });
  const fill = studioBackdrop(backgroundLight, backdrop);
  const sourceUrl = fileHref(jobId, fileKey, false, generation);

  useEffect(() => {
    if (!queueFull || image || bad) return;
    const controller = new AbortController();
    void loadStillImage(sourceUrl, {
      urgency: originalOpen ? "original" : "fallback", signal: controller.signal,
    }).then((source) => {
      if (!controller.signal.aborted) setImage(source);
    }, () => {
      if (controller.signal.aborted) return;
      setBad(true);
      setOriginalOpen(false);
      onSourceError();
    });
    return () => controller.abort();
  }, [queueFull, image, bad, sourceUrl, originalOpen]);

  useEffect(() => {
    if (!originalOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOriginalOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [originalOpen]);

  return (
    <figure className="mockup-sheet-photo">
      <div className={`mockup-sheet-frame ${backdropFrameClass(backdrop)}`} style={{ background: fill }}>
        {bad ? (
          <p className="page-lead">{queueFull ? "这张预览图暂时无法显示。" : "这张预览图无法显示，请重新生成。"}</p>
        ) : (
          <>
          {queueFull ? null : <img
            src={sourceUrl}
            alt={alt}
            onError={() => {setBad(true);onSourceError();}}
            onLoad={(event) => setImage(event.currentTarget)}
            style={{ display: "none" }}
          />}
          {image ? <LegacyLitCanvas image={image} alt={alt} productLight={productLight} backgroundLight={backgroundLight} backdrop={backdrop} /> : null}
          </>
        )}
        {bad ? null : (
          <button
            type="button"
            className="mockup-dl mockup-dl-fs"
            aria-label={`打开${caption}原图`}
            onClick={() => setOriginalOpen(true)}
          >
            原图
          </button>
        )}
        {!bad || queueFull ? (
          <button
            type="button"
            className="mockup-dl mockup-dl-corner"
            aria-label={`下载${caption}`}
            aria-disabled={download.active || undefined}
            onClick={() => download.start("none")}
          >
            下载
          </button>
        ) : null}
      </div>
      <figcaption className="mockup-sheet-cap">
        {caption}
        <StudioStillDownloadStatus caption={caption} state={download.state} onRetry={downloads.start} muted={originalOpen && !bad} />
      </figcaption>
      {originalOpen && !bad
        ? createPortal(
            <div
              className="mockup-still-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`${caption}原图`}
              onClick={() => setOriginalOpen(false)}
            >
              <div className="mockup-still-lightbox-panel" onClick={(event) => event.stopPropagation()}>
                <div
                  className={`mockup-still-lightbox-stage ${backdropFrameClass(backdrop)}`}
                  style={{ background: fill }}
                >
                  {image ? <LegacyLitCanvas image={image} alt={alt} productLight={productLight} backgroundLight={backgroundLight} backdrop={backdrop} full /> : null}
                </div>
                <StudioLightSliders
                  productLight={productLight}
                  backgroundLight={backgroundLight}
                  onProductLight={onProductLight}
                  onBackgroundLight={onBackgroundLight}
                />
                <StudioStillDownloadStatus caption={caption} state={download.state} onRetry={downloads.start} />
                <div className="mockup-still-lightbox-actions">
                  <button
                    type="button"
                    className="mockup-dl"
                    aria-disabled={download.active || undefined}
                    onClick={() => download.start("none")}
                  >
                    下载
                  </button>
                  <button type="button" className="mockup-dl" onClick={() => setOriginalOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </figure>
  );
}

function LegacyLitCanvas({ image, alt, productLight, backgroundLight, backdrop, full = false }: {
  image: HTMLImageElement; alt: string; productLight: number; backgroundLight: number; backdrop: BackdropPreset; full?: boolean;
}) {
  const [canvasRef, setCanvasRef] = useReleasedCanvasRef();
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const frame = canvasRef.current?.parentElement;
    if (!frame || full) return;
    return observeStudioFrame(frame, (w, h) => setSize([w, h]));
  }, [full]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const target = canvasBackingSize(
      full ? image.naturalWidth : size[0],
      full ? image.naturalHeight : size[1],
    );
    if (!target.width || !target.height) return;
    const ctx = prepareStudioCanvas(canvas, target.width, target.height);
    if (!ctx) { setError(true); return; }
    try {
      composeStudioStill(ctx, canvas.width, canvas.height, image, null, { productLight, backgroundLight, backdrop, filterSupported: canvasFilterSupported(ctx) });
      setError(false);
    } catch { ctx.clearRect(0, 0, canvas.width, canvas.height); setError(true); }
  }, [image, size, full, productLight, backgroundLight, backdrop]);
  return <>{error ? <p className="page-lead">调灯失败，请重新加载图片。</p> : null}<canvas ref={setCanvasRef} className={full ? "mockup-studio-lightbox-canvas" : "mockup-studio-canvas"} aria-label={alt} /></>;
}

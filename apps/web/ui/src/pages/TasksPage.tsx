import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Segmented, Space, Table, Tag } from "antd";
import { api, ApiError, isUploadReceiptExpired, UPLOAD_TIMEOUT_MS, type PendingUploadReceipt, type TaskSummary } from "../api";
import { UPLOAD_RECOVERY_INTERVAL_MS, uploadStore, useUploadSnapshot } from "../uploadStore";
import { rememberReviewHandoff } from "../jobHandoff";
import { compareBoardProgress, liveJobLine } from "./waitCard";
import { shouldShowTaskBoard } from "./tasksBoard";
import { PENDING_REVIEW, deskClock, type DeskCardRow } from "./deskBoard";
import { DeskCol } from "./DeskCol";
import { NAV_LABEL, REVIEW_STATUS_LABEL, reviewCompletedLabel } from "../copy/labels";
import {
  pendingUploadCard,
  pendingUploadOpenAction,
  pendingUploadItems,
  loadDeskReceipts,
  shouldReconcileUpload,
  type PendingUploadItem,
} from "./uploadDesk";

type Props = {
  canCreate: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onResumeReceipt: (receipt: string) => void;
};

type Layout = "board" | "table";
type Col = "comparing" | "failed" | "review" | "done";

export function statusLabel(row: TaskSummary) {
  if (row.status === "completed") return { text: reviewCompletedLabel(row.complete_kind), color: "default" as const };
  if (row.status === "in_review" || row.status === "pending_review") {
    return { text: PENDING_REVIEW, color: "warning" as const };
  }
  if (row.status === "compare_failed" || row.job_status === "failed") {
    return { text: "检查失败", color: "error" as const };
  }
  if (row.status === "comparing") return { text: "检查中", color: "processing" as const };
  return { text: row.status, color: "default" as const };
}

function toDeskCard(row: TaskSummary): DeskCardRow {
  const status = statusLabel(row);
  return {
    id: row.id,
    title: row.product_name || row.title,
    statusText: status.text,
    statusColor: status.color,
    actor: row.owner,
    at: row.job_started_at || row.created_at,
    live: liveJobLine({
      job_status: row.job_status,
      job_stage_label: row.job_stage_label,
      job_eta_s: row.job_eta_s,
      queue_ahead: row.queue_ahead,
      kind: row.job_kind === "rework" ? "rework" : "compare",
    }),
    error: row.error || row.job_error,
    progress: columnOf(row) === "comparing" ? compareBoardProgress(row) : undefined,
  };
}

function columnOf(row: TaskSummary): Col {
  if (row.board) return row.board;
  if (row.status === "completed") return "done";
  if (row.status === "pending_review" || row.status === "in_review") return "review";
  if (row.status === "compare_failed" || row.job_status === "failed") return "failed";
  return "comparing";
}

export function TasksPage({ canCreate, onCreate, onOpen, onResumeReceipt }: Props) {
  const { message, modal } = App.useApp();
  const localUpload = useUploadSnapshot("compare");
  const [rows, setRows] = useState<TaskSummary[]>([]);
  const [receipts, setReceipts] = useState<PendingUploadReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [layout, setLayout] = useState<Layout>("board");
  const [reload, setReload] = useState(0);
  const pendingStarts = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      api.tasks(submitted || undefined),
      loadDeskReceipts(canCreate, api.uploads),
    ])
      .then(([tasks, pending]) => {
        if (cancelled) return;
        setRows(tasks);
        for (const receipt of pending) uploadStore.recover("compare", receipt);
        setReceipts(pending);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setError("未登录，请重新用飞书进入。");
        else setError(err instanceof Error ? err.message : "加载失败，再试一次");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canCreate, submitted, reload]);

  const live = rows.some((row) => columnOf(row) === "comparing");
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void api
        .tasks(submitted || undefined)
        .then((list) => {
          if (!cancelled) setRows(list);
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [live, submitted]);

  const reconcileUpload = shouldReconcileUpload("compare", localUpload, receipts);
  useEffect(() => {
    if (!canCreate || !reconcileUpload) return;
    let cancelled = false;
    const reconcile = () => {
      void api
        .uploads()
        .then((pending) => {
          if (cancelled) return;
          for (const receipt of pending) uploadStore.recover("compare", receipt);
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

  const pendingItems = useMemo(
    () => pendingUploadItems("compare", localUpload, receipts, submitted),
    [localUpload, receipts, submitted],
  );
  const pendingCards = useMemo(
    () => pendingItems.map((item) => pendingUploadCard(item, "待检查")),
    [pendingItems],
  );
  const pendingByKey = useMemo(() => new Map(pendingItems.map((item) => [item.key, item])), [pendingItems]);
  const board = useMemo(
    () => ({
      comparing: rows.filter((row) => columnOf(row) === "comparing"),
      failed: rows.filter((row) => columnOf(row) === "failed"),
      review: rows.filter((row) => columnOf(row) === "review"),
      done: rows.filter((row) => columnOf(row) === "done"),
    }),
    [rows],
  );
  const totalCount = rows.length + pendingItems.length;
  const showSearch = Boolean(submitted) || totalCount > 0;
  const showBoard = shouldShowTaskBoard(totalCount, submitted) && totalCount > 0;
  const tableRows = useMemo(() => [...pendingCards, ...rows.map(toDeskCard)], [pendingCards, rows]);

  function openPending(item: PendingUploadItem) {
    const action = pendingUploadOpenAction(item);
    if (action === "active") {
      onCreate();
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
      title: "现在开始检查？",
      content: `品名：${productName}。上传完成后会进入检查队列。`,
      okText: "开始检查",
      cancelText: "等会儿",
      onOk: async () => {
        if (pendingStarts.current.has(receipt)) return;
        pendingStarts.current.add(receipt);
        try {
          const next = await api.startTask({
            receipt,
            product_name: productName,
            title: productName,
            pack_surface: item.packSurface || undefined,
          });
          uploadStore.clear("compare", receipt);
          setReceipts((current) => current.filter((saved) => saved.id !== receipt));
          message.success("检查已开始。");
          rememberReviewHandoff(next);
          onOpen(next.id);
        } catch (err) {
          if (isUploadReceiptExpired(err)) {
            uploadStore.clear("compare", receipt);
            setReceipts((current) => current.filter((saved) => saved.id !== receipt));
            setReload((value) => value + 1);
            message.warning("上传已失效，请重新选择文件。");
          } else {
            message.error(err instanceof Error ? err.message : "无法开始检查");
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
    else onOpen(id);
  }

  return (
    <section>
      <div className="desk-head">
        <div>
          <h1 className="page-title">{NAV_LABEL.review}</h1>
          <p className="page-lead">核对表格和稿件是否一致</p>
        </div>
        <Space wrap>
          {showSearch ? (
            <Input.Search
              allowClear
              placeholder="搜品名或文件名"
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
                { label: "卡片", value: "board" },
                { label: "列表", value: "table" },
              ]}
            />
          ) : null}
          {canCreate ? (
            <Button type="primary" onClick={onCreate}>
              新建审稿
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
              重试
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
                  <div>还没有审稿</div>
                  <div className="desk-empty-hint">传一份表格和稿件就能开始</div>
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
                清除搜索
              </Button>
            ) : canCreate ? (
              <Button type="primary" onClick={onCreate}>
                新建审稿
              </Button>
            ) : null}
          </Empty>
        </div>
      ) : layout === "board" ? (
        <div className="review-board is-four">
          <DeskCol
            title="检查中"
            hint="机器正在核对"
            rows={[...pendingCards, ...board.comparing.map(toDeskCard)]}
            onOpen={openCard}
          />
          <DeskCol title="没查完" hint="点开看原因" rows={board.failed.map(toDeskCard)} onOpen={onOpen} />
          <DeskCol title="待你确认" hint="有几处要你看一眼" rows={board.review.map(toDeskCard)} onOpen={onOpen} />
          <DeskCol title={REVIEW_STATUS_LABEL.completed} hint="结果已保存" rows={board.done.map(toDeskCard)} onOpen={onOpen} />
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
            { title: "品名", dataIndex: "title" },
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
            { title: "负责人", dataIndex: "actor", width: 100, render: (value: string) => value || "—" },
            { title: "", key: "open", width: 100, render: () => <Button type="link">查看</Button> },
          ]}
        />
      )}
    </section>
  );
}

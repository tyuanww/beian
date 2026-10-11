import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Progress, Space, Table, Tag } from "antd";
import { api, UploadPausedError, type PendingUploadReceipt } from "../api";
import type { CompressionBatch, CompressionFile } from "../batchTypes";
import { customerCopy } from "./customerCopy";
import { COMPRESSION_STATUS_LABEL } from "../copy/labels";
import { bytesTooLarge, uploadTooLargeText } from "../uploadLimit";

export const compressionStatus: Record<string, string> = {
  queued: "排队中", running: "处理中", succeeded: "已完成", passthrough: COMPRESSION_STATUS_LABEL.passthrough,
  unmet_target: COMPRESSION_STATUS_LABEL.unmet_target, unsupported: "不支持", failed: "处理失败", done: "已完成", partial: "部分完成",
};
export function displayBytes(bytes: number | null) {
  if (bytes === null) return "—";
  return bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(2)} MB`;
}
export function validateCompressionFiles(files: readonly File[]): string | null {
  if (files.length < 1 || files.length > 20) return "每批请选择 1–20 个文件。";
  if (files.some(file => !/\.(pdf|jpe?g|png|webp)$/i.test(file.name))) return "支持 PDF、JPG、PNG 和 WebP。";
  if (files.some(file => file.size <= 0)) return "文件不能为空。";
  // 和其他上传入口同一个上限（uploadLimitBytes(me)）和同一句文案。
  if (bytesTooLarge(...files.map(file => file.size))) return uploadTooLargeText();
  return null;
}
const ready = (file: CompressionFile) => (file.status === "succeeded" || file.status === "passthrough") && Boolean(file.key);
const fileUrl = (id: string, key: string) => `/api/compressions/${id}/files/${encodeURIComponent(key)}`;

type Props = { id: string | null; receiptId?: string | null; owner: string; canCreate: boolean; canExport: boolean; canAdmin: boolean;
  onOpen: (id: string) => void; onBack: () => void; onHistory: () => void };

export function CompressionPage(props: Props) {
  return props.id ? <CompressionDetail key={`${props.owner}:${props.id}`} {...props} id={props.id} />
    : <CompressionNew key={`${props.owner}:${props.receiptId || "new"}`} {...props} />;
}

function UnreadableRecovery({ canAdmin }: { canAdmin: boolean }) {
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!canAdmin) return;
    let alive = true;
    void api.compressions().then(result => {
      if (alive) setIds(result.unreadable_ids || []);
    }).catch(() => { /* the normal page remains usable if the recovery probe fails */ });
    return () => { alive = false; };
  }, [canAdmin]);
  if (!canAdmin || ids.length === 0) return null;
  async function quarantine(id: string) {
    if (busy) return;
    setBusy(id); setError(null);
    try {
      await api.deleteCompression(id);
      setIds(current => current.filter(item => item !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "隔离损坏记录失败");
    } finally { setBusy(null); }
  }
  return <Alert type="warning" showIcon title="有异常记录需要处理"
    description={<Space wrap>{ids.map(id => <span key={id} className="compression-recovery-item"><code>{id}</code><Button size="small" loading={busy === id} onClick={() => void quarantine(id)}>移除记录</Button></span>)}{error ? <span>{error}</span> : null}</Space>} />;
}

function CompressionNew({ canCreate, canAdmin, receiptId, onOpen, onHistory }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState<PendingUploadReceipt[]>([]);
  const [receipt, setReceipt] = useState<PendingUploadReceipt | null>(null);
  const [readyReceipt, setReadyReceipt] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const clientId = useRef<string>(crypto.randomUUID());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (canCreate) void api.uploads().then(rows => {
      if (!alive.current) return;
      const list = rows.filter(row => row.kind === "compression");
      setPending(list);
      const selected = list.find(row => row.id === receiptId);
      if (selected) chooseReceipt(selected);
    }).catch(err => { if (alive.current) setError(err instanceof Error ? err.message : "未能读取待上传文件"); });
    return () => { alive.current = false; controller.current?.abort(); };
  }, [canCreate, receiptId]);
  function chooseReceipt(row: PendingUploadReceipt) {
    setReceipt(row); setFiles([]); setReadyReceipt(row.phase === "ready" ? row.id : null); setError(null);
    clientId.current = row.client_upload_id || crypto.randomUUID();
  }
  function selectFiles(next: File[]) {
    const invalid = validateCompressionFiles(next);
    if (invalid) { setError(invalid); return; }
    if (receipt && (next.length !== receipt.files.length || next.some((file, i) => file.name !== receipt.files[i].name || file.size !== receipt.files[i].bytes))) {
      setError("请选择同一批文件，或新建压缩。"); return;
    }
    setFiles(next); setError(null); setProgress(null);
    if (!receipt) { clientId.current = crypto.randomUUID(); setReadyReceipt(null); }
  }
  async function start() {
    if (busy || !canCreate) return;
    setBusy(true); setError(null);
    controller.current = new AbortController();
    try {
      let id = readyReceipt;
      if (!id) {
        const invalid = validateCompressionFiles(files);
        if (invalid) throw new Error(invalid);
        const form = new FormData();
        form.set("purpose", "compression"); form.set("client_upload_id", clientId.current);
        files.forEach((file, i) => form.set(`asset${i + 1}`, file));
        const upload = await api.stageUpload(form, event => { if (alive.current) setProgress(event.pct); }, controller.current.signal);
        id = upload.receipt;
        if (alive.current) setReadyReceipt(id);
      }
      if (!alive.current) return;
      const batch = await api.startCompression(id, title.trim() || undefined);
      if (alive.current) onOpen(batch.id);
    } catch (err) {
      if (alive.current) setError(err instanceof UploadPausedError ? `${err.message} 请点击“继续压缩”。` : err instanceof Error ? err.message : "未能开始压缩，请重试。");
    } finally { if (alive.current) setBusy(false); }
  }
  return <section className="batch-page">
    <header className="page-head"><div><h1 className="page-title">压缩文件</h1><p className="page-lead">图片和 PDF 一起压缩，结果保存在历史。</p></div><Button onClick={onHistory}>看历史</Button></header>
    <UnreadableRecovery canAdmin={canAdmin} />
    {error ? <Alert type="error" showIcon title={error} /> : null}
    <div className="batch-card">
      <h2>新建压缩</h2>
      <label className="batch-label">批次名<Input value={title} maxLength={120} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="例如：海葡萄冰冰贴" /></label>
      <label className={`compression-drop ${busy || !canCreate || readyReceipt ? "is-disabled" : ""}`}
        onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy && canCreate && !readyReceipt) selectFiles(Array.from(event.dataTransfer.files)); }}>
        <img src="/brand/ui/well-pdf.svg" alt="" width="48" height="48" />
        <strong>{readyReceipt ? "上传完成，可以开始压缩。" : receipt ? "重新选择文件" : "拖入或选择文件"}</strong>
        <span>支持 PDF、JPG、PNG、WebP，最多 20 个。</span>
        <input aria-label="选择压缩文件" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp" disabled={busy || !canCreate || Boolean(readyReceipt)} onChange={event => selectFiles(Array.from(event.target.files || []))} />
      </label>
      {files.length || receipt ? <ul className="compression-file-list">{(files.length ? files.map(file => ({ name: file.name, bytes: file.size })) : receipt!.files).map((file, i) => <li key={i}><span>{file.name}</span><span>{displayBytes(file.bytes)}</span></li>)}</ul> : null}
      {progress !== null ? <Progress percent={progress} status={busy ? "active" : error ? "exception" : "normal"} format={percent => `${percent}% 已上传`} /> : null}
      <Alert type="info" showIcon title="PDF 自动压到 10 MB 内。" description="保留页面、文字和公章。" />
      <Space wrap className="batch-actions"><Button type="primary" size="large" loading={busy} disabled={!canCreate || (!readyReceipt && !files.length)} onClick={() => void start()}>{readyReceipt ? "开始压缩" : error && files.length ? "继续压缩" : "上传并压缩"}</Button>
        {(receipt || readyReceipt) && !busy ? <Button onClick={() => { setReceipt(null); setReadyReceipt(null); setFiles([]); setError(null); setProgress(null); clientId.current = crypto.randomUUID(); }}>新建压缩</Button> : null}
      </Space>
    </div>
    {pending.length ? <div className="batch-card"><h2>待处理文件</h2>{pending.map(row => <div className="batch-section-head" key={row.id}><span>{row.files[0]?.name} · {row.files.length} 个文件</span><Button disabled={busy} onClick={() => chooseReceipt(row)}>{row.phase === "ready" ? "继续压缩" : "继续上传"}</Button></div>)}</div> : null}
  </section>;
}

function CompressionDetail({ id, canCreate, canExport, canAdmin, onBack, onHistory }: Props & { id: string }) {
  const { message } = App.useApp();
  const [batch, setBatch] = useState<CompressionBatch | null>(null);
  const [preview, setPreview] = useState<CompressionFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    async function load() {
      try {
        const next = await api.compression(id, abort.signal);
        if (stopped) return;
        setBatch(next); setError(null);
        if (next.status === "queued" || next.status === "running") timer = setTimeout(load, 2500);
      } catch (err) { if (!stopped) { setError(customerCopy(err instanceof Error ? err.message : "") || "详情加载失败，请重试。"); timer = setTimeout(load, 5000); } }
    }
    void load();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [id, reload]);
  const active = batch?.status === "queued" || batch?.status === "running";
  const available = batch?.files.filter(ready).length || 0;
  const processing = batch?.files.filter(file => file.status === "queued" || file.status === "running").length || 0;
  const unsuccessful = batch?.files.filter(file => !ready(file) && file.status !== "queued" && file.status !== "running").length || 0;
  async function retry(ids: string[]) {
    if (!batch || busy || active) return;
    setBusy(true);
    try { setBatch(await api.retryCompression(id, batch.revision, ids)); setReload(value => value + 1); }
    catch (err) { message.error(err instanceof Error ? err.message : "重试失败"); setReload(value => value + 1); }
    finally { setBusy(false); }
  }
  return <section className="batch-page">
    <header className="page-head"><div><h1 className="page-title">{batch?.title || "压缩详情"}</h1><p className="page-lead">{batch ? `${batch.files.length} 个文件 · ${new Date(batch.created_at).toLocaleString("zh-CN", { hour12: false })} · ${batch.owner}` : "正在加载…"}</p></div><Space wrap><Button onClick={onBack}>新建压缩</Button><Button onClick={onHistory}>历史</Button></Space></header>
    <UnreadableRecovery canAdmin={canAdmin} />
    {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => setReload(value => value + 1)}>刷新</Button>} /> : null}
    {batch ? <div className="batch-card">
      <div className="batch-section-head"><div><Tag color={active ? "processing" : batch.status === "done" ? "success" : batch.status === "failed" ? "error" : "warning"}>{compressionStatus[batch.status]}</Tag><span>可下载 {available} · 处理中 {processing} · 失败 {unsuccessful}</span><p className="page-lead">{active ? `前面还有 ${batch.queue_ahead} 批，可离开页面。` : "下载前请查看文字、公章和页面。"}</p></div><Space wrap>
        <Button disabled={!canCreate || active || !batch.files.some(file => file.can_retry)} loading={busy} onClick={() => void retry(batch.files.filter(file => file.can_retry).map(file => file.id))}>重试失败项</Button>
        <Button type="primary" aria-label="下载结果 ZIP" href={!active && available > 0 && canExport ? `/api/compressions/${id}/zip` : undefined} disabled={active || !canExport || available === 0}>下载 ZIP</Button>
      </Space></div>
      <Table<CompressionFile> rowKey="id" dataSource={batch.files} pagination={false} scroll={{ x: 780 }} columns={[
        { title: "文件", key: "name", render: (_, file) => <div className="batch-file-name"><strong>{file.name}</strong><small>{file.media_type === "application/pdf" ? "目标：小于 10 MB" : "压缩图片"}</small></div> },
        { title: "原大小", dataIndex: "input_bytes", width: 115, render: displayBytes },
        { title: "新大小", key: "output_bytes", width: 125, render: (_, file) => file.output_bytes === null
          ? file.status === "queued" || file.status === "running" ? "等待处理" : "未生成"
          : <div>{displayBytes(file.output_bytes)}<small className="compression-saving">节省 {Math.max(0, (1 - file.output_bytes / file.input_bytes) * 100).toFixed(1)}%</small></div> },
        { title: "状态", key: "status", render: (_, file) => <div><Tag color={ready(file) ? "success" : file.status === "running" || file.status === "queued" ? "processing" : file.status === "failed" ? "error" : "warning"}>{compressionStatus[file.status]}</Tag>{file.message ? <p className="page-lead">{customerCopy(file.message)}</p> : null}</div> },
        { title: "操作", key: "actions", width: 220, render: (_, file) => <Space wrap>{ready(file) && canExport ? <><span className="format-tag">{file.media_type === "application/pdf" ? "PDF" : "图片"}</span><Button size="small" onClick={() => setPreview(file)}>预览</Button><Button size="small" href={fileUrl(id, file.key!)}>下载</Button></> : null}{file.can_retry && canCreate ? <Button size="small" disabled={active || busy} onClick={() => void retry([file.id])}>重试</Button> : null}</Space> },
      ]} />
    </div> : !error ? <Empty description="正在加载…" /> : null}
    {preview ? <ResultPreview id={id} file={preview} onClose={() => setPreview(null)} /> : null}
  </section>;
}

function ResultPreview({ id, file, onClose }: { id: string; file: CompressionFile; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetch(fileUrl(id, file.key!), { credentials: "same-origin", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("预览文件读取失败，请重试。");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(blob.type) || blob.size > 128 * 1024 * 1024) throw new Error("无法预览此文件，请下载后查看。");
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "预览加载失败"); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, file.key]);
  return <Modal open title={file.name} width={980} onCancel={onClose} footer={<Button href={fileUrl(id, file.key!)}>下载</Button>}>
    <p className="page-lead">请查看文字、公章和页面。</p>
    {error ? <Alert type="error" title={error} /> : url ? file.media_type === "application/pdf"
      ? <iframe className="result-preview" title="压缩结果预览" src={url} /> : <img className="result-preview" alt="压缩结果" src={url} /> : <p role="status">正在加载预览…</p>}
  </Modal>;
}

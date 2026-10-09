import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Progress, Space, Table, Tag } from "antd";
import { api, UploadPausedError, type PendingUploadReceipt } from "../api";
import type { CompressionBatch, CompressionFile } from "../batchTypes";

export const compressionStatus: Record<string, string> = {
  queued: "排队中", running: "压缩中", succeeded: "已压缩", passthrough: "保留原文件",
  unmet_target: "未达到 10 MB", unsupported: "暂不支持", failed: "处理失败", done: "已完成", partial: "部分完成",
};
export function displayBytes(bytes: number | null) {
  if (bytes === null) return "—";
  return bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(2)} MB`;
}
export function validateCompressionFiles(files: readonly File[]): string | null {
  if (files.length < 1 || files.length > 20) return "每批请选择 1–20 个文件。";
  if (files.some(file => !/\.(pdf|jpe?g|png|webp)$/i.test(file.name))) return "支持 PDF、JPG、PNG 和 WebP。";
  if (files.some(file => file.size <= 0) || files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) return "每批总大小不能超过 100 MiB，文件不能为空。";
  return null;
}
const ready = (file: CompressionFile) => (file.status === "succeeded" || file.status === "passthrough") && Boolean(file.key);
const fileUrl = (id: string, key: string) => `/api/compressions/${id}/files/${encodeURIComponent(key)}`;

type Props = { id: string | null; receiptId?: string | null; owner: string; canCreate: boolean; canExport: boolean;
  onOpen: (id: string) => void; onBack: () => void; onHistory: () => void };

export function CompressionPage(props: Props) {
  return props.id ? <CompressionDetail key={`${props.owner}:${props.id}`} {...props} id={props.id} />
    : <CompressionNew key={`${props.owner}:${props.receiptId || "new"}`} {...props} />;
}

function CompressionNew({ canCreate, receiptId, onOpen, onHistory }: Props) {
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
      setError("请重新选择这次上传的原文件，名称、顺序和大小需一致；或点击“新建一批”。"); return;
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
      if (alive.current) setError(err instanceof UploadPausedError ? `${err.message} 重新点击“继续上传并压缩”即可续传。` : err instanceof Error ? err.message : "未能开始压缩，请重试。");
    } finally { if (alive.current) setBusy(false); }
  }
  return <section className="batch-page">
    <header className="page-head"><div><h1 className="page-title">文件压缩</h1><p className="page-lead">图片与 PDF 一起上传，处理结果会保存到历史记录。</p></div><Button onClick={onHistory}>查看历史记录</Button></header>
    {error ? <Alert type="error" showIcon title={error} /> : null}
    <div className="batch-card">
      <h2>新建压缩批次</h2>
      <label className="batch-label">批次名称（可选）<Input value={title} maxLength={120} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="例如：海葡萄冰冰贴 · 备案资料" /></label>
      <label className={`compression-drop ${busy || !canCreate || readyReceipt ? "is-disabled" : ""}`}
        onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy && canCreate && !readyReceipt) selectFiles(Array.from(event.dataTransfer.files)); }}>
        <img src="/brand/ui/well-pdf.svg" alt="" width="48" height="48" />
        <strong>{readyReceipt ? "文件已上传，可直接开始压缩" : receipt ? "重新选择原文件，继续上传" : "选择或拖入文件"}</strong>
        <span>PDF、JPG、PNG、WebP · 每批最多 20 个 · 合计不超过 100 MiB</span>
        <input aria-label="选择压缩文件" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp" disabled={busy || !canCreate || Boolean(readyReceipt)} onChange={event => selectFiles(Array.from(event.target.files || []))} />
      </label>
      {files.length || receipt ? <ul className="compression-file-list">{(files.length ? files.map(file => ({ name: file.name, bytes: file.size })) : receipt!.files).map((file, i) => <li key={i}><span>{file.name}</span><span>{displayBytes(file.bytes)}</span></li>)}</ul> : null}
      {progress !== null ? <Progress percent={progress} status={busy ? "active" : error ? "exception" : "normal"} format={percent => `${percent}% 已上传`} /> : null}
      <Alert type="info" showIcon title="PDF 目标小于 10 MB，自动调整压缩力度" description="保留页面尺寸、图文与可见公章。完成后请预览文字和公章；遇到无法安全处理的签名或文件结构，会说明原因。图片以减小文件大小为目标。" />
      <Space wrap className="batch-actions"><Button type="primary" size="large" loading={busy} disabled={!canCreate || (!readyReceipt && !files.length)} onClick={() => void start()}>{readyReceipt ? "开始压缩" : error && files.length ? "继续上传并压缩" : "上传并压缩"}</Button>
        {(receipt || readyReceipt) && !busy ? <Button onClick={() => { setReceipt(null); setReadyReceipt(null); setFiles([]); setError(null); setProgress(null); clientId.current = crypto.randomUUID(); }}>新建一批</Button> : null}
      </Space>
    </div>
    {pending.length ? <div className="batch-card"><h2>待处理的上传</h2>{pending.map(row => <div className="batch-section-head" key={row.id}><span>{row.files[0]?.name} · {row.files.length} 个文件</span><Button disabled={busy} onClick={() => chooseReceipt(row)}>{row.phase === "ready" ? "继续开工" : "继续上传"}</Button></div>)}</div> : null}
  </section>;
}

function CompressionDetail({ id, canCreate, canExport, onBack, onHistory }: Props & { id: string }) {
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
      } catch (err) { if (!stopped) { setError(err instanceof Error ? err.message : "压缩记录加载失败"); timer = setTimeout(load, 5000); } }
    }
    void load();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [id, reload]);
  const active = batch?.status === "queued" || batch?.status === "running";
  const completed = batch?.files.filter(file => file.status !== "queued" && file.status !== "running").length || 0;
  async function retry(ids: string[]) {
    if (!batch || busy || active) return;
    setBusy(true);
    try { setBatch(await api.retryCompression(id, batch.revision, ids)); setReload(value => value + 1); }
    catch (err) { message.error(err instanceof Error ? err.message : "重试失败"); setReload(value => value + 1); }
    finally { setBusy(false); }
  }
  return <section className="batch-page">
    <header className="page-head"><div><h1 className="page-title">{batch?.title || "压缩记录"}</h1><p className="page-lead">{batch ? `${batch.files.length} 个文件 · ${new Date(batch.created_at).toLocaleString("zh-CN", { hour12: false })} · ${batch.owner}` : "正在读取记录…"}</p></div><Space wrap><Button onClick={onBack}>新建一批</Button><Button onClick={onHistory}>历史记录</Button></Space></header>
    {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => setReload(value => value + 1)}>刷新</Button>} /> : null}
    {batch ? <div className="batch-card">
      <div className="batch-section-head"><div><Tag color={active ? "processing" : batch.status === "done" ? "success" : "warning"}>{compressionStatus[batch.status]}</Tag><span>已处理 {completed} / {batch.files.length}</span><p className="page-lead">{active ? `前方 ${batch.queue_ahead} 批，可以离开此页，任务会继续处理。` : "下载后请确认小字、公章及页面完整。未达标文件不会混入 ZIP。"}</p></div><Space wrap>
        <Button disabled={!canCreate || active || !batch.files.some(file => file.can_retry)} loading={busy} onClick={() => void retry(batch.files.filter(file => file.can_retry).map(file => file.id))}>重试可重试项</Button>
        <Button type="primary" href={!active && batch.files.some(ready) && canExport ? `/api/compressions/${id}/zip` : undefined} disabled={active || !canExport || !batch.files.some(ready)}>下载可用文件 ZIP</Button>
      </Space></div>
      <Table<CompressionFile> rowKey="id" dataSource={batch.files} pagination={false} scroll={{ x: 780 }} columns={[
        { title: "文件", key: "name", render: (_, file) => <div className="batch-file-name"><strong>{file.name}</strong><small>{file.media_type === "application/pdf" ? "目标：严格小于 10 MB" : "图片压缩"}</small></div> },
        { title: "原始大小", dataIndex: "input_bytes", width: 115, render: displayBytes },
        { title: "结果大小", key: "output_bytes", width: 125, render: (_, file) => file.output_bytes === null
          ? file.status === "queued" || file.status === "running" ? "待完成" : "未生成"
          : <div>{displayBytes(file.output_bytes)}<small className="compression-saving">节省 {Math.max(0, (1 - file.output_bytes / file.input_bytes) * 100).toFixed(1)}%</small></div> },
        { title: "处理结果", key: "status", render: (_, file) => <div><Tag color={ready(file) ? "success" : file.status === "running" || file.status === "queued" ? "processing" : "warning"}>{compressionStatus[file.status]}</Tag><p className="page-lead">{file.message}</p></div> },
        { title: "操作", key: "actions", width: 160, render: (_, file) => <Space wrap>{ready(file) && canExport ? <><Button size="small" onClick={() => setPreview(file)}>预览</Button><Button size="small" href={fileUrl(id, file.key!)}>下载</Button></> : null}{file.can_retry && canCreate ? <Button size="small" disabled={active || busy} onClick={() => void retry([file.id])}>重试</Button> : null}</Space> },
      ]} />
    </div> : !error ? <Empty description="正在读取压缩记录…" /> : null}
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
  return <Modal open title={file.name} width={980} onCancel={onClose} footer={<Button href={fileUrl(id, file.key!)}>下载文件</Button>}>
    <p className="page-lead">请确认小字、公章和页面完整。</p>
    {error ? <Alert type="error" title={error} /> : url ? file.media_type === "application/pdf"
      ? <iframe className="result-preview" title="压缩结果预览" src={url} /> : <img className="result-preview" alt="压缩结果" src={url} /> : <p role="status">正在加载预览…</p>}
  </Modal>;
}

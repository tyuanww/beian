import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Empty, Input, Select, Space, Table, Tag } from "antd";
import { api, ApiError, type PendingUploadReceipt } from "../api";
import { uploadStore } from "../uploadStore";
import type { HistoryItem, HistoryResult } from "../batchTypes";
import { emptyHistoryFilters, historyDeletable, historyKey, historyLive, historyQuery, historyStatusColor, historyTimeFilters, historyTypeLabels, type HistoryFilters, type HistoryTimeMode } from "./historyQuery";

// Kept for callers of the existing row action helper during the data transition.
import { historyCanDelete, type HistoryRow } from "./historyRows";
export function historyRowAction(row: HistoryRow, editing: boolean) {
  if (editing) return historyCanDelete(row) ? "toggle" : "blocked";
  if (row.resource === "upload") return "open-upload";
  return row.resource === "task" ? "open-task" : "open-mockup";
}

type Props = { owner: string; canCreate: boolean; canDelete: boolean;
  onOpenTask: (id: string) => void; onOpenMockup: (id: string) => void; onOpenCompression: (id: string) => void;
  onOpenUpload: (kind: PendingUploadReceipt["kind"], receipt?: string | null) => void };
type Saved = { filters: HistoryFilters; cursors: string[]; page: number; scroll: number };
function restore(key: string): Saved {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null") as Saved | null;
    if (value && value.filters && Array.isArray(value.cursors) && value.cursors.length <= 5000 && Number.isInteger(value.page) && value.page >= 0 && value.page < value.cursors.length) {
      const filters = Object.fromEntries(Object.keys(emptyHistoryFilters).map(field => [field, typeof value.filters[field as keyof HistoryFilters] === "string" ? value.filters[field as keyof HistoryFilters] : ""])) as HistoryFilters;
      if (!["all", "recent", "custom"].includes(filters.time_mode)) filters.time_mode = filters.date_from || filters.date_to ? "custom" : "all";
      if (filters.time_mode === "recent") {
        const recent = historyTimeFilters("recent");
        if (filters.date_from !== recent.date_from || filters.date_to !== recent.date_to) {
          return { filters: { ...filters, ...recent }, cursors: [""], page: 0, scroll: 0 };
        }
      }
      return { filters, cursors: value.cursors.filter(item => typeof item === "string"), page: value.page, scroll: Number(value.scroll) || 0 };
    }
  } catch { /* Storage may be disabled. */ }
  return { filters: { ...emptyHistoryFilters }, cursors: [""], page: 0, scroll: 0 };
}
const stateLabels: Record<string, string> = { in_review: "待核对", pending_review: "待审核", comparing: "对照中", compare_failed: "对照失败", reworking: "对红中", uploaded: "待开工", queued: "排队中", running: "处理中", done: "已完成", completed: "已完成", signed: "已签字", failed: "失败", partial: "部分完成", unmet_target: "未达到 10 MB", ready: "待开工", uploading: "上传中", compared: "待核对", review_required: "待确认", unsupported: "暂不支持", reworked: "对红完成", idle: "待开工" };

export function HistoryPage({ owner, canCreate, canDelete, onOpenTask, onOpenMockup, onOpenCompression, onOpenUpload }: Props) {
  const { message, modal } = App.useApp();
  const storageKey = `beian:history:v2:${owner}`;
  const [state, setState] = useState<Saved>(() => restore(storageKey));
  const [search, setSearch] = useState(state.filters.q);
  const [creator, setCreator] = useState(state.filters.creator);
  const [data, setData] = useState<HistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<HistoryItem[]>([]);
  const [deleting, setDeleting] = useState(false);
  const restoreScroll = useRef(true);
  const query = historyQuery(state.filters, state.cursors[state.page]);
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Use memory. */ } }, [state, storageKey]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const result = await api.history(query, controller.signal);
        if (stopped) return;
        setData(result); setError(null); setBuilding(false); setLoading(false);
        if (restoreScroll.current) {
          restoreScroll.current = false;
          requestAnimationFrame(() => { document.querySelector(".stage")?.scrollTo(0, state.scroll); window.scrollTo(0, state.scroll); });
        }
        if (result.items.some(historyLive)) timer = setTimeout(load, 5000);
      } catch (err) {
        if (stopped) return;
        const rebuilding = err instanceof ApiError && err.status === 503 && ["history_index_unavailable", "history_index_corrupt"].includes(err.code || "");
        setBuilding(rebuilding); setLoading(false);
        setError(rebuilding ? "正在整理历史记录，页面会自动继续加载。" : err instanceof Error ? err.message : "历史记录读取失败，请重试。");
        // A 10,000-record index requires more than 50 bounded passes.
        if (rebuilding) timer = setTimeout(load, 1200);
      }
    }
    void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [query, refresh]);
  function filters(patch: Partial<HistoryFilters>) {
    setState(current => ({ filters: { ...current.filters, ...patch }, cursors: [""], page: 0, scroll: 0 }));
    setSelected([]); setEditing(false);
  }
  function rememberScroll() {
    const scroll = document.querySelector(".stage")?.scrollTop || window.scrollY;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ ...state, scroll })); } catch { /* No persistence. */ }
  }
  async function open(row: HistoryItem) {
    if (editing) { if (historyDeletable(row)) toggle(row); return; }
    rememberScroll();
    if (row.type === "review") onOpenTask(row.id);
    else if (row.type === "mockup") onOpenMockup(row.id);
    else if (row.type === "compression") onOpenCompression(row.id);
    else if (canCreate) {
      try {
        const receipt = (await api.uploads()).find(item => item.id === row.id);
        if (!receipt) throw new Error("这份上传已开工或过期，请刷新历史记录。");
        onOpenUpload(receipt.kind, receipt.id);
      } catch (err) { message.error(err instanceof Error ? err.message : "无法打开这份上传"); }
    }
  }
  function toggle(row: HistoryItem) {
    setSelected(current => current.some(item => historyKey(item) === historyKey(row)) ? current.filter(item => historyKey(item) !== historyKey(row)) : [...current, row]);
  }
  const pageRows = data?.items || [];
  const deletable = pageRows.filter(historyDeletable);
  const selectedKeys = new Set(selected.map(historyKey));
  const all = deletable.length > 0 && deletable.every(row => selectedKeys.has(historyKey(row)));
  async function removeSelected() {
    setDeleting(true);
    const failures: HistoryItem[] = [];
    for (const row of selected) {
      try {
        const response = row.type === "review" ? await api.deleteTask(row.id) : row.type === "mockup" ? await api.deleteMockup(row.id)
          : row.type === "compression" ? await api.deleteCompression(row.id) : await api.discardUpload(row.id);
        if (!response.ok) throw new Error("服务器没有确认删除");
        if (row.type === "upload") { uploadStore.clear("compare", row.id); uploadStore.clear("mockup", row.id); }
      } catch { failures.push(row); }
    }
    setSelected(failures); setDeleting(false);
    if (failures.length) message.warning(`${failures.length} 条未删除，可能正在处理或无管理权限，已保留选中。`);
    else { message.success("已删除选中的记录"); setEditing(false); }
    setState(current => ({ ...current, page: 0, cursors: [""], scroll: 0 })); setRefresh(value => value + 1);
  }
  const label = (status: string) => stateLabels[status] || status;
  const statuses = new Set(Object.keys(data?.facets.status || {}));
  if (!state.filters.type || state.filters.type === "compression") statuses.add("unmet_target");
  else statuses.delete("unmet_target");
  if (state.filters.status) statuses.add(state.filters.status);
  return <section className="batch-page history-page">
    <header className="page-head"><div><h1 className="page-title">历史记录</h1><p className="page-lead">搜索品名、批次和子文件名，查看审稿、打样、上传与压缩记录。</p></div><Space><Button aria-label="刷新历史记录" onClick={() => setRefresh(value => value + 1)} loading={loading && !building}>刷新</Button>{canDelete ? <Button disabled={deleting} onClick={() => { setEditing(value => !value); setSelected([]); }}>{editing ? "退出编辑" : "编辑"}</Button> : null}</Space></header>
    <div className="batch-card history-filterbar">
      <Input.Search aria-label="搜索历史记录" placeholder="搜索品名、批次或文件名" allowClear value={search} onChange={event => { setSearch(event.target.value); if (!event.target.value) filters({ q: "" }); }} onSearch={q => filters({ q })} enterButton="搜索" />
      <div className="history-filter-grid">
        <Select aria-label="类型" value={state.filters.type} onChange={type => filters({ type, status: "" })} options={[{ value: "", label: "全部类型" }, ...Object.entries(historyTypeLabels).map(([value, text]) => ({ value, label: text }))]} />
        <Select aria-label="状态" value={state.filters.status} onChange={status => filters({ status })} options={[{ value: "", label: "全部状态" }, ...[...statuses].map(value => ({ value, label: label(value) }))]} />
        <Input.Search aria-label="创建人" placeholder="创建人姓名或账号" value={creator} allowClear onChange={event => { setCreator(event.target.value); if (!event.target.value) filters({ creator: "" }); }} onSearch={value => filters({ creator: value })} />
        <Select aria-label="时间范围" value={state.filters.time_mode} onChange={(mode: HistoryTimeMode) => filters(mode === "custom" ? { time_mode: mode } : historyTimeFilters(mode))} options={[{ value: "all", label: "全部时间" }, { value: "recent", label: "近 7 天" }, { value: "custom", label: "自定义时间" }]} />
        <Button onClick={() => { setSearch(""); setCreator(""); filters({ ...emptyHistoryFilters }); }}>清空筛选</Button>
      </div>
      {state.filters.time_mode !== "all" ? <div className="history-date-grid">
        <label className="history-date">开始日期<input type="date" disabled={state.filters.time_mode === "recent"} value={state.filters.date_from} onChange={event => filters({ time_mode: "custom", date_from: event.target.value })} /></label>
        <label className="history-date">结束日期<input type="date" disabled={state.filters.time_mode === "recent"} value={state.filters.date_to} min={state.filters.date_from} onChange={event => filters({ time_mode: "custom", date_to: event.target.value })} /></label>
      </div> : null}
    </div>
    {error ? <Alert type={building ? "info" : "error"} showIcon title={error} description={data ? "保留上次成功加载的记录。" : undefined} action={!building ? <Button onClick={() => setRefresh(value => value + 1)}>重试</Button> : undefined} /> : null}
    <div className="history-table-shell batch-card">
      <Table<HistoryItem> rowKey={historyKey} loading={loading && !data} dataSource={pageRows} pagination={false} scroll={{ x: 800 }}
        locale={{ emptyText: error || building || loading ? <Empty description="记录暂未加载完成" /> : <Empty description="没有符合条件的记录，试试调整筛选。" /> }}
        rowSelection={editing ? { selectedRowKeys: selected.map(historyKey), onSelect: row => toggle(row), onSelectAll: checked => setSelected(current => checked ? [...current.filter(item => !deletable.some(row => historyKey(row) === historyKey(item))), ...deletable] : current.filter(item => !deletable.some(row => historyKey(row) === historyKey(item)))), getCheckboxProps: row => ({ disabled: !historyDeletable(row), title: !historyDeletable(row) ? "正在处理，结束后才能删除" : undefined, "aria-label": `选择 ${row.title}` }) } : undefined}
        onRow={row => ({ onClick: event => { if (!(event.target as HTMLElement).closest("button,a,input,.ant-checkbox-wrapper")) void open(row); } })}
        columns={[
          { title: "记录 / 文件", key: "title", render: (_, row) => <div className="batch-file-name"><button className="history-title-button" aria-label={`打开${historyTypeLabels[row.type]}记录：${row.title}`} onClick={() => void open(row)}>{row.title || row.product_name || "未命名记录"}</button><small>{row.matched_names.length ? `命中文件：${row.matched_names.join("、")}` : row.names.join("、")}</small>{editing && !historyDeletable(row) ? <small>正在处理，结束后才能删除</small> : null}</div> },
          { title: "类型", dataIndex: "type", width: 90, render: (type: HistoryItem["type"]) => historyTypeLabels[type] },
          { title: "状态", dataIndex: "status", width: 130, render: (status: string) => <Tag color={historyStatusColor(status)}>{label(status)}</Tag> },
          { title: "创建人", dataIndex: "creator_name", width: 160 },
          { title: "创建时间", dataIndex: "created_at", width: 185, render: (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) },
        ]} />
      <div className="batch-section-head history-pagination"><span>{data ? `共 ${data.total} 条 · 第 ${state.page + 1} 页 · 每页 10 条` : "每页 10 条"}</span><Space>
        <Button disabled={state.page === 0 || loading || Boolean(error)} onClick={() => setState(current => ({ ...current, page: current.page - 1, scroll: 0 }))}>上一页</Button>
        <Button disabled={!data?.next_cursor || loading || Boolean(error)} onClick={() => setState(current => ({ ...current, cursors: [...current.cursors.slice(0, current.page + 1), data!.next_cursor!], page: current.page + 1, scroll: 0 }))}>下一页</Button>
      </Space></div>
    </div>
    {editing ? <div className="history-bulkbar"><Checkbox disabled={!deletable.length || deleting} checked={all} indeterminate={!all && deletable.some(row => selectedKeys.has(historyKey(row)))} onChange={event => setSelected(current => event.target.checked ? [...current.filter(item => !deletable.some(row => historyKey(row) === historyKey(item))), ...deletable] : current.filter(item => !deletable.some(row => historyKey(row) === historyKey(item))))}>全选本页</Checkbox><span>已选 {selected.length} 条</span><Button danger disabled={!selected.length || deleting} loading={deleting} onClick={() => modal.confirm({ centered: true, title: `删除选中的 ${selected.length} 条记录？`, content: "删除后将无法从历史记录恢复。正在处理或无权限的记录会保留。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: removeSelected })}>删除选中</Button></div> : null}
  </section>;
}

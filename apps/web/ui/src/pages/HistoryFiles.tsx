import { useId, useMemo, useState } from "react";
import { Button } from "antd";
import { expandLabel, splitHit, summarizeFiles } from "./historyFileSummary";

type Props = { names: readonly string[]; matched: readonly string[]; query: string };

/** 历史记录第一列：一行文件摘要 + 行内展开的分组清单。文件名第一期为纯文本。 */
export function HistoryFiles({ names, matched, query }: Props) {
  const s = useMemo(() => summarizeFiles(names, matched), [names, matched]);
  const [open, setOpen] = useState(s.matched > 0);
  const listId = useId();
  if (!s.total) return null;
  const hits = new Set(matched);
  return <div className="history-files">
    <div className="history-files-line">
      <span className="history-files-summary" title={s.summary}>{s.summary}</span>
      {s.matched ? <span className="history-files-matched">· 匹配 {s.matched} 个</span> : null}
      <Button type="link" size="small" className="history-files-toggle" aria-expanded={open} aria-controls={listId}
        onClick={() => setOpen(value => !value)}>{expandLabel(s, open)}</Button>
    </div>
    {open ? <div id={listId} className="history-files-list">
      {s.groups.map(group => <div key={group.kind} className="history-files-group">
        <span className="history-files-group-label">{group.label}（{group.files.length}）</span>
        <ul>{group.files.map(name => <li key={name} className={hits.has(name) ? "is-hit" : undefined} title={name}>
          {hits.has(name) ? splitHit(name, query).map((part, i) => part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>) : name}
        </li>)}</ul>
      </div>)}
      {s.truncated ? <small className="history-files-more">仅显示前 {s.total} 个文件</small> : null}
    </div> : null}
  </div>;
}

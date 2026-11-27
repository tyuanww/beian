import { useEffect, useSyncExternalStore } from "react";
import { STUDIO_DOWNLOAD_FAILED, STUDIO_DOWNLOAD_PREPARING } from "./mockupHud";
import {
  studioDownloadFor,
  studioDownloads,
  type StudioDownloadEntry,
  type StudioDownloadLayer,
  type StudioDownloadSelection,
  type StudioDownloadView,
} from "./mockupStillDownload";
import { BACKDROP_LABEL } from "./mockupStudio";

export function useStudioStillDownloads(jobId: string, actor: string, enabled: boolean) {
  const snapshot = useSyncExternalStore(studioDownloads.subscribe, () => studioDownloads.snapshot(jobId, actor));
  useEffect(() => enabled ? studioDownloads.watch(jobId, actor) : undefined, [jobId, actor, enabled]);
  return {
    ...snapshot,
    start: (selection: StudioDownloadSelection) => { void studioDownloads.start(jobId, actor, selection); },
  };
}

export type StudioStillDownloads = ReturnType<typeof useStudioStillDownloads>;

export function studioStillDownloadFor(downloads: StudioStillDownloads, view: StudioDownloadView) {
  const state = studioDownloadFor(downloads.entries, view);
  return {
    state,
    active: state?.kind === "preparing",
    start: (layer: StudioDownloadLayer) => {
      if (state?.kind !== "preparing") downloads.start({ ...view, layer });
    },
  };
}

type StatusProps = {
  caption: string;
  state?: StudioDownloadEntry;
  muted?: boolean;
  onRetry: (selection: StudioDownloadSelection) => void;
};

function studioStatusText(state?: StudioDownloadEntry): string {
  if (!state) return "";
  switch (state.kind) {
    case "preparing": return STUDIO_DOWNLOAD_PREPARING;
    case "ready": return state.handedOff ? "成片已交给浏览器下载" : "成片已就绪";
    case "capacity": return "本单成片已满，暂时无法生成新成片";
    case "unreachable": return "暂时查不到成片状态";
    case "failed": return STUDIO_DOWNLOAD_FAILED;
  }
}

export function StudioStillDownloadStatus({ caption, state, muted, onRetry }: StatusProps) {
  return (
    <div className="mockup-still-download-status" aria-hidden={muted || undefined}>
      <span role={muted ? undefined : "status"}>{studioStatusText(state)}</span>
      {state?.kind === "ready" && !muted ? (
        <a className="mockup-still-download-action" href={state.href} download aria-label={`${caption}：下载成片`}>下载成片</a>
      ) : null}
      {(state?.kind === "failed" || state?.kind === "unreachable") && !muted ? (
        <button type="button" className="mockup-still-download-action" onClick={() => onRetry(state.selection)}>重试</button>
      ) : null}
    </div>
  );
}

function versionLabel(generation: string): string {
  if (generation === "g0-legacy-original") return "初版";
  const version = generation.match(/^g([1-9][0-9]*)-/)?.[1];
  if (version) return `第 ${version} 版`;
  const timestamp = new Date(generation);
  return Number.isFinite(timestamp.valueOf())
    ? `旧版 · ${timestamp.toLocaleString("zh-CN", { hour12: false })}`
    : "旧版";
}

export function StudioStillDownloadHistory({ downloads, visible }: {
  downloads: StudioStillDownloads;
  visible: readonly (StudioDownloadEntry | undefined)[];
}) {
  const history = downloads.entries.filter(entry => !visible.includes(entry));
  if (!history.length) return null;
  return (
    <details className="mockup-still-download-history">
      <summary>成片下载记录</summary>
      <ul>
        {history.map(entry => {
          const { fileKey, backdrop, generation, productLight, backgroundLight } = entry.selection;
          const angle = fileKey === "white_a" ? "正面 + 侧面" : "反面 + 侧面";
          const caption = `${angle} · ${BACKDROP_LABEL[backdrop]} · ${versionLabel(generation)}`;
          const lights = `产品灯光 ${Math.round(productLight * 100)}%，背景灯光 ${Math.round(backgroundLight * 100)}%`;
          return (
            <li key={entry.id}>
              <span>{caption} <small>{lights}</small></span>
              <StudioStillDownloadStatus caption={`${caption}，${lights}`} state={entry} onRetry={downloads.start} />
            </li>
          );
        })}
      </ul>
    </details>
  );
}

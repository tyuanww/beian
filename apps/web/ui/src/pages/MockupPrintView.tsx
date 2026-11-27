import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Empty } from "antd";
import type { MockupJob } from "../api";
import { clampScale, ZOOM_MAX, ZOOM_MIN } from "./canvasZoom";
import { listedReadFaces, READ_FACE_LABEL, readFaceKey, type ReadFaceRole } from "./mockupReadFaces";
import { studioAssetHref } from "./mockupStudio";
import { MockupViewTabs } from "./MockupViewTabs";

const FACE_ORDER = ["front", "back", "left", "right", "top", "bottom"] as const satisfies readonly ReadFaceRole[];
type PrintView = "unfolded" | ReadFaceRole;
const PRINT_TABS = [
  { key: "unfolded" as const, label: "2D 展开图" },
  ...FACE_ORDER.map((key) => ({ key, label: READ_FACE_LABEL[key] })),
];

export function MockupPrintView({ job, active, canCreate, submitting, error, onRequest, onDownload }: {
  job: MockupJob;
  active: boolean;
  canCreate: boolean;
  submitting: boolean;
  error: string | null;
  onRequest: () => void;
  onDownload: () => void;
}) {
  const [selected, setSelected] = useState<PrintView>();
  const faces = listedReadFaces(job.files);
  const firstFace = FACE_ORDER.find((face) => faces.includes(face));
  const initialView = job.unfolded_print?.status === "ready" ? "unfolded" : firstFace ?? "unfolded";
  useEffect(() => {
    if (active) setSelected((current) => current ?? initialView);
  }, [active, initialView]);
  if (!active) return null;

  const view = selected ?? initialView;
  const id = `mockup-print-${job.id}`;
  const downloadZip = job.print_faces_zip?.status === "ready";

  return (
    <section className="mockup-read-faces" aria-label="印刷面">
      <div className="mockup-print-heading">
        <h2 className="mockup-read-title">印刷面</h2>
        <Button href={downloadZip ? studioAssetHref(job.id, "print_faces_zip", "", true) : undefined}
          disabled={!downloadZip}>下载六面</Button>
      </div>
      <MockupViewTabs id={id} label="印刷面视图" tabs={PRINT_TABS} active={view} onChange={setSelected} />
      {PRINT_TABS.map(({ key, label }) => {
        const visible = key === view;
        const face = key !== "unfolded" && faces.includes(key);
        const file = face ? job.files.find((item) => item.key === readFaceKey(key)) : undefined;
        return (
          <div key={key} role="tabpanel" aria-labelledby={`${id}-tab-${key}`} hidden={!visible}
            tabIndex={visible && !face ? 0 : undefined}>
            {!visible ? null : key === "unfolded" ? (
              <UnfoldedView job={job} canCreate={canCreate} submitting={submitting} error={error} onRequest={onRequest}
                onViewFace={firstFace ? () => {
                  setSelected(firstFace);
                  document.getElementById(`${id}-tab-${firstFace}`)?.focus();
                } : undefined} />
            ) : file ? (
              <ReadFaceView jobId={job.id} file={file} label={label} onDownload={onDownload} />
            ) : <Empty description={`${label}还没有印刷面图。`} />}
          </div>
        );
      })}
    </section>
  );
}

function ReadFaceView({ jobId, file, label, onDownload }: {
  jobId: string; file: { key: string; name: string }; label: string; onDownload: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const center = useRef<{ x: number; y: number } | null>(null);
  const [bad, setBad] = useState(false);
  const [scale, setScale] = useState(ZOOM_MIN);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || bad) return;
    const stage = frame.closest(".stage");
    const measure = () => {
      const top = frame.getBoundingClientRect().top + (stage?.scrollTop ?? window.scrollY);
      const bottom = Math.min(window.innerHeight, stage?.getBoundingClientRect().bottom ?? window.innerHeight);
      const available = `${Math.max(160, Math.floor(bottom - top - 12))}px`;
      if (frame.style.getPropertyValue("--mockup-read-available") !== available) {
        frame.style.setProperty("--mockup-read-available", available);
      }
      const { clientWidth: width, clientHeight: height } = frame;
      setFrameSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [bad]);

  const zoomTo = (next: number) => {
    const frame = frameRef.current;
    if (frame) {
      center.current = {
        x: (frame.scrollLeft + frame.clientWidth / 2) / Math.max(1, frame.scrollWidth),
        y: (frame.scrollTop + frame.clientHeight / 2) / Math.max(1, frame.scrollHeight),
      };
    }
    setScale(clampScale(next));
  };
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const point = center.current;
    center.current = null;
    if (!frame || !point) return;
    frame.scrollLeft = scale === ZOOM_MIN ? 0 : point.x * frame.scrollWidth - frame.clientWidth / 2;
    frame.scrollTop = scale === ZOOM_MIN ? 0 : point.y * frame.scrollHeight - frame.clientHeight / 2;
  }, [scale]);

  if (bad) return <p className="page-lead" role="status">这张图无法显示，请重新生成。</p>;
  const loaded = natural.width > 0 && natural.height > 0 && frameSize.width > 0 && frameSize.height > 0;
  const fit = loaded ? Math.min(frameSize.width / natural.width, frameSize.height / natural.height) : 0;
  const href = studioAssetHref(jobId, file.key, "");

  return (
    <figure className="mockup-read-face">
      <div className="mockup-read-toolbar">
        <div className="mockup-read-tools">
          <Button disabled={!loaded || scale <= ZOOM_MIN} aria-label={`缩小${label}印刷面`}
            onClick={() => zoomTo(scale / 1.2)}>缩小</Button>
          <Button disabled={!loaded || scale === ZOOM_MIN} aria-label={`恢复${label}印刷面适合窗口`}
            onClick={() => zoomTo(ZOOM_MIN)}>适合窗口</Button>
          <Button disabled={!loaded || scale >= ZOOM_MAX} aria-label={`放大${label}印刷面`}
            onClick={() => zoomTo(scale * 1.2)}>放大</Button>
          <span className="sr-only" role="status">{scale > ZOOM_MIN ? `${Math.round(scale * 100)}%` : ""}</span>
        </div>
        <div className="mockup-read-tools">
          <Button href={href} target="_blank" rel="noreferrer" aria-label={`打开${label}印刷面原图`}>原图</Button>
          <Button href={studioAssetHref(jobId, file.key, "", true)} download={file.name}
            aria-label={`下载${label}印刷面`} onClick={onDownload}>下载</Button>
        </div>
      </div>
      <div className="mockup-read-frame" ref={frameRef} tabIndex={0} role="region"
        aria-label={`查看${label}印刷面`} aria-busy={!loaded}>
        <div className="mockup-read-zoom">
          {!loaded ? <p className="page-lead">正在加载图片…</p> : null}
          <img src={href} alt={`${label}印刷面`} decoding="async" draggable={false}
            style={{ width: natural.width * fit * scale, height: natural.height * fit * scale }}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setBad(true)} />
        </div>
      </div>
    </figure>
  );
}

const UNFOLDED_COPY: Record<string, string> = {
  source_missing: "找不到源稿，无法生成展开图。",
  geometry_unverified: "这单缺少已确认的粘口和封口信息，暂时无法生成可打印的展开图。",
  geometry_incomplete: "现有刀线无法确认成完整的展开图，暂时无法生成可打印的 PDF。",
  separation_unreliable: "无法区分结构线和印刷内容，请先整理源稿。",
  host_unavailable: "当前无法生成展开图，请稍后再试。",
  source_changed: "源稿已变化，请重新生成展开图。",
  close_unconfirmed: "展开图还在生成，请稍后查看。",
  export_failed: "展开图生成失败，请重试。",
};
const NEEDS_SOURCE_CHANGE = new Set(["source_missing", "geometry_unverified", "geometry_incomplete", "separation_unreliable"]);

function UnfoldedView({ job, canCreate, submitting, error, onRequest, onViewFace }: {
  job: MockupJob; canCreate: boolean; submitting: boolean; error: string | null;
  onRequest: () => void; onViewFace?: () => void;
}) {
  const result = job.unfolded_print;
  const pending = result?.status === "queued" || result?.status === "running";
  const ready = result?.status === "ready" && result.file_key === "unfolded_print";
  const reason = result?.reason;
  const blocked = reason !== undefined && NEEDS_SOURCE_CHANGE.has(reason);
  const preview = job.unfolded_artwork_preview_url;
  const statusMessage = reason && UNFOLDED_COPY[reason];
  const message = pending || ready ? statusMessage : error || statusMessage;
  const pdf = studioAssetHref(job.id, "unfolded_print", "");
  return (
    <section className="unfolded-panel" aria-label="展开图">
      <div className="batch-section-head">
        <div>
          <h3>展开图</h3>
          {ready ? <p className="physical-size">{result.width_mm} × {result.height_mm} mm · 1:1</p> : null}
        </div>
        <div className="asset-actions">
          {ready ? <>
            <Button href={pdf} target="_blank" rel="noreferrer">打开 PDF</Button>
            <Button type="primary" href={studioAssetHref(job.id, "unfolded_print", "", true)}>下载 PDF</Button>
          </> : <>
            {blocked && onViewFace ? <Button onClick={onViewFace}>查看印刷面</Button> : null}
            {!blocked && (canCreate || pending) ? (
              <Button type="primary" disabled={pending} loading={submitting || pending} onClick={onRequest}>
                {pending ? "正在生成" : result?.status === "failed" ? "重试" : "生成展开图"}
              </Button>
            ) : null}
          </>}
        </div>
      </div>
      {message ? <Alert type={pending ? "info" : "warning"} showIcon title={message} /> : null}
      {pending ? <p className="page-lead">可以离开页面，回来后再看结果。</p> : null}
      {ready ? <iframe key={job.current_render_generation_id || "current"} title="展开图预览" className="unfolded-preview" src={pdf} />
        : preview ? <ArtworkPreview key={preview} url={preview} />
          : !pending && !message ? <p className="page-lead">生成后可预览和下载。</p> : null}
    </section>
  );
}

function ArtworkPreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="page-lead" role="status">稿件预览暂时无法显示。</p> : (
    <figure className="unfolded-artwork-preview">
      <figcaption>整张稿件预览，仅供查看。</figcaption>
      <img src={url} alt="整张稿件预览" decoding="async" onError={() => setFailed(true)} />
    </figure>
  );
}

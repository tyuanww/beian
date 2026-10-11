import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelViewerElement } from "@google/model-viewer";
import { Progress } from "antd";
import { composeGlbDisplaySet, DISPLAY_TABLE_MATERIAL, DISPLAY_WALL_MATERIAL } from "./glbDisplayAsset";
import { DEFAULT_GLB_VIEW, glbCameraDistances } from "./mockupGlbCamera";
import { GLB_LOADING_TEXT, GLB_PREPARING_TEXT, type GlbProgress, glbInteractive, glbTotalKnown, glbViewerProgress, glbStatusText, readGlbWithProgress } from "./mockupGlbProgress";
import { GLB_ENVIRONMENT, glbViewerExposure, glbRoomEmission } from "./mockupGlbLighting";
import { type BackdropPreset, studioBackdrop } from "./mockupStudio";
import { GLB_WEBP_UNSUPPORTED_TEXT, glbTextureGate, webpSupport } from "./mockupGlbTexture";
import { type GlbVersionInfo, glbAttempts, whenIdle } from "./mockupGlbSource";

type Bounds = { center: number[]; sphereRadius: number };
type View = { theta: number; phi: number; zoom: number };
const initialView = (): View => ({ ...DEFAULT_GLB_VIEW });
const degrees = (radians: number) => radians * 180 / Math.PI;

type ViewerProps = {
  source: string; poster?: string; backdrop: BackdropPreset; backgroundLight: number; productLight: number;
  onSourceError: () => void;
};
type SceneProps = Omit<ViewerProps, "onSourceError"> & { onFail: () => void };

/**
 * 加载顺序：贴图是 WebP 而本机解码不了 → 直接拉原始 GLB；否则先默认地址（可能是 WebP 版），
 * 下载失败、贴图解码失败或 model-viewer 报错时自动改拉原始一次，文字始终是「正在加载 3D」，不另提示。
 * 原始也失败才显示效果图 +「这台设备显示不了 3D，已换成效果图」。
 */
export function MockupGlbViewer({ textureFormat, originalSource, versions, onSourceError, ...props }: ViewerProps & { textureFormat?: string; originalSource: string; versions: GlbVersionInfo }) {
  const [webp, setWebp] = useState<boolean | null>(() => webpSupport.known());
  const gate = glbTextureGate(textureFormat, webp);
  useEffect(() => {
    if (gate !== "detecting") return;
    let active = true;
    void webpSupport.detect().then((ok) => { if (active) setWebp(ok); });
    return () => { active = false; };
  }, [gate]);
  const attempts = glbAttempts(gate, { primary: props.source, original: originalSource }, versions);
  const plan = attempts ? attempts.join("\n") : "detecting";
  const [failed, setFailed] = useState<{ plan: string; count: number }>({ plan, count: 0 });
  const count = failed.plan === plan ? failed.count : 0;
  const errorRef = useRef(onSourceError);
  errorRef.current = onSourceError;
  const exhausted = attempts !== null && count >= attempts.length;
  const tried = Boolean(attempts?.length);
  // 真拉过且都失败才通知外层刷新版本；本机解码不了 WebP 而直接降级时不算失败。
  useEffect(() => { if (exhausted && tried) errorRef.current(); }, [exhausted, tried, plan]);
  // 先只放效果图，浏览器空闲时才开始在后台拉 GLB。
  const [idle, setIdle] = useState(false);
  useEffect(() => whenIdle(() => setIdle(true)), []);
  const source = attempts?.[count];
  if (!source || !idle) return <GlbPosterOnly poster={props.poster} note={exhausted} loading={!exhausted} />;
  return <GlbScene key={source} {...props} source={source}
    onFail={() => setFailed((prev) => ({ plan, count: (prev.plan === plan ? prev.count : 0) + 1 }))} />;
}

function GlbPosterOnly({ poster, note, loading }: { poster?: string; note: boolean; loading: boolean }) {
  const [posterFailed, setPosterFailed] = useState<string | null>(null);
  return <>
    {poster && posterFailed !== poster
      ? <img className="mockup-glb-poster" src={poster} alt="" aria-hidden="true" onError={() => setPosterFailed(poster)} />
      : <div className="mockup-glb-poster mockup-glb-skeleton" aria-hidden="true" />}
    {note && <p role="status" className="mockup-glb-message mockup-glb-progress">{GLB_WEBP_UNSUPPORTED_TEXT}</p>}
    {loading && <div className="mockup-glb-message mockup-glb-progress">
      <span className="mockup-glb-progress-visual" aria-hidden="true"><span>{GLB_LOADING_TEXT}</span></span>
      <span role="status" className="sr-only">{GLB_LOADING_TEXT}</span>
    </div>}
    <button type="button" className="mockup-dl mockup-glb-reset" aria-label="复位模型视角" disabled>复位</button>
  </>;
}

/** The display scene is disposable; the caller keeps downloads bound to the original generation. */
function GlbScene({ source, poster, backdrop, backgroundLight, productLight, onFail }: SceneProps) {
  const set = backdrop === "white_set";
  const identity = `${source}:${set ? "room" : "plain"}`;
  const [asset, setAsset] = useState<{ identity: string; url: string; bounds?: Bounds } | null>(null);
  const [error, setError] = useState(false);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<GlbProgress>({ kind: "indeterminate" });
  const [posterFailed, setPosterFailed] = useState<string | null>(null);
  const viewerRef = useRef<ModelViewerElement | null>(null);
  const view = useRef<View>(initialView());
  const lastSource = useRef(source);
  const raw = useRef<{ source: string; bytes: Uint8Array } | null>(null);
  const revision = useRef(0);
  const totalKnown = useRef(false);
  const onErrorRef = useRef(onFail);
  onErrorRef.current = onFail;
  const current = asset?.identity === identity ? asset : null;
  const ready = Boolean(current && readyUrl === current.url);
  const framedBase = useRef<number | null>(null);
  const setViewer = useCallback((node: HTMLElement | null) => {
    const previous = viewerRef.current;
    if (!node && previous?.loaded && framedBase.current) {
      const orbit = previous.getCameraOrbit();
      view.current = { theta: degrees(orbit.theta), phi: degrees(orbit.phi), zoom: orbit.radius / framedBase.current };
    }
    viewerRef.current = node as ModelViewerElement | null;
    if (!node) framedBase.current = null;
  }, []);
  const ownedUrl = useRef<string | null>(null);
  const releaseDisplay = useCallback(() => {
    if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current);
    ownedUrl.current = null;
  }, []);
  const failDisplay = useCallback(() => {
    revision.current++;
    releaseDisplay();
    raw.current = null;
    setAsset(null);
    setReadyUrl(null);
    setError(true);
  }, [releaseDisplay]);


  useEffect(() => {
    if (lastSource.current !== source) {
      lastSource.current = source;
      raw.current = null;
      view.current = initialView();
    }
    let active = true;
    let blob: string | undefined;
    const abort = new AbortController();
    setReadyUrl(null);
    setError(false);
    setProgress({ kind: "indeterminate" });
    totalKnown.current = false;
    if (!set) {
      setAsset({ identity, url: source });
      // HEAD 只取响应头、不下载正文，用来判断 model-viewer 报的进度是否可信；失败就保持不确定进度。
      void fetch(source, { method: "HEAD", signal: abort.signal })
        .then((response) => { if (active && response.ok) totalKnown.current = glbTotalKnown(response.headers); })
        .catch(() => undefined);
    } else {
      void (async () => {
        let bytes = raw.current?.source === source ? raw.current.bytes : undefined;
        if (!bytes) {
          const response = await fetch(source, { signal: abort.signal });
          if (!response.ok) throw new Error("glb_source_failed");
          bytes = await readGlbWithProgress(response, (next) => { if (active) setProgress(next); });
          if (!active) return;
          raw.current = { source, bytes };
        }
        setProgress({ kind: "preparing" });
        // 双 rAF：第二帧回调时上一帧（含「正在准备场景…」）已提交绘制，再在主线程同步组装场景。
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (!active) return;
        const display = composeGlbDisplaySet(bytes);
        if (!active) return;
        blob = URL.createObjectURL(new Blob([new Uint8Array(display.bytes)], { type: "model/gltf-binary" }));
        ownedUrl.current = blob;
        setAsset({ identity, url: blob, bounds: display.bounds });
      })().catch(() => {
        if (!active) return;
        failDisplay();
        onErrorRef.current();
      });
    }
    return () => {
      active = false;
      abort.abort();
      revision.current++;
      if (blob && ownedUrl.current === blob) releaseDisplay();
    };
  }, [source, set, identity, failDisplay, releaseDisplay]);

  const lightRef = useRef({ backgroundLight, productLight });
  lightRef.current = { backgroundLight, productLight };
  const lightRoom = useCallback(() => {
    if (!set) return;
    for (const material of viewerRef.current?.model?.materials ?? []) {
      const rgb = material.name === DISPLAY_TABLE_MATERIAL ? [228,228,232]
        : material.name === DISPLAY_WALL_MATERIAL ? [238,238,236] : null;
      if (!rgb) continue;
      const { factor, strength } = glbRoomEmission(rgb, lightRef.current.backgroundLight, lightRef.current.productLight);
      material.setEmissiveFactor(factor);
      material.setEmissiveStrength(strength);
    }
  }, [set]);
  useEffect(lightRoom, [lightRoom, backgroundLight, productLight, current]);

  const frame = useCallback(async (reset = false) => {
    const viewer = viewerRef.current;
    if (!viewer?.loaded || !current) return;
    const token = ++revision.current;
    if (reset) view.current = initialView();
    try {
      await viewer.updateFraming();
      if (revision.current !== token || viewerRef.current !== viewer) return;
      const dimensions = viewer.getDimensions();
      const center = viewer.getBoundingBoxCenter();
      const bounds = current.bounds || {
        center: [center.x, center.y, center.z],
        sphereRadius: Math.hypot(dimensions.x, dimensions.y, dimensions.z) / 2,
      };
      const fov = viewer.getFieldOfView();
      const distances = glbCameraDistances(bounds.sphereRadius, fov, view.current.zoom);
      viewer.setAttribute("camera-target", bounds.center.map(v => `${v}m`).join(" "));
      viewer.setAttribute("min-camera-orbit", `auto auto ${distances.min}m`);
      viewer.setAttribute("max-camera-orbit", `auto ${set ? "89deg" : "auto"} ${distances.max}m`);
      viewer.setAttribute("camera-orbit", `${view.current.theta}deg ${view.current.phi}deg ${distances.radius}m`);
      // LitElement applies attributes asynchronously; wait before snapping to the goal.
      await viewer.updateComplete;
      if (revision.current !== token || viewerRef.current !== viewer) return;
      lightRoom();
      viewer.jumpCameraToGoal();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (revision.current !== token || viewerRef.current !== viewer) return;
      framedBase.current = distances.base;
      setReadyUrl(current.url);
    } catch {
      if (revision.current === token) { failDisplay(); onErrorRef.current(); }
    }
  }, [current, lightRoom, failDisplay, set]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !current) return;
    let active = true;
    const loaded = () => { if (active) void frame(); };
    const failed = () => {
      if (!active) return;
      failDisplay();
      onErrorRef.current();
    };
    const moved = (event: Event) => {
      if ((event as CustomEvent).detail?.source !== "user-interaction") return;
      const orbit = viewer.getCameraOrbit();
      const d = viewer.getDimensions();
      const sphere = current.bounds?.sphereRadius ?? Math.hypot(d.x, d.y, d.z) / 2;
      const base = sphere / Math.sin(viewer.getFieldOfView() * Math.PI / 360);
      view.current = { theta: degrees(orbit.theta), phi: degrees(orbit.phi), zoom: orbit.radius / base };
    };
    const progressed = (event: Event) => {
      // 白桌白墙的 blob 已在本地，进度只对直连 src 有意义。
      if (active && !set) setProgress(glbViewerProgress((event as CustomEvent).detail?.totalProgress, totalKnown.current));
    };
    viewer.addEventListener("progress", progressed);
    viewer.addEventListener("load", loaded);
    viewer.addEventListener("error", failed);
    viewer.addEventListener("camera-change", moved);
    const resize = new ResizeObserver(loaded);
    resize.observe(viewer);
    if (viewer.loaded) loaded();
    return () => {
      active = false;
      revision.current++;
      resize.disconnect();
      viewer.removeEventListener("progress", progressed);
      viewer.removeEventListener("load", loaded);
      viewer.removeEventListener("error", failed);
      viewer.removeEventListener("camera-change", moved);
    };
  }, [current, frame, failDisplay, set]);

  const showPoster = Boolean(poster && posterFailed !== poster);
  const loading = !ready;
  const interactive = glbInteractive(ready, error);
  return <>
    {loading && (showPoster
      ? <img className="mockup-glb-poster" src={poster} alt="" aria-hidden="true" onError={() => setPosterFailed(poster ?? null)} />
      : <div className="mockup-glb-poster mockup-glb-skeleton" aria-hidden="true" />)}
    {current && !error && <model-viewer
      key={current.url}
      ref={setViewer}
      src={current.url}
      // React 18 对自定义元素会把 false 写成字符串属性，必须用 undefined 才能真正移除。
      camera-controls={interactive || undefined}
      camera-orbit="35deg 72deg 145%"
      max-camera-orbit="auto auto 155%"
      environment-image={GLB_ENVIRONMENT}
      exposure={glbViewerExposure(productLight)}
      shadow-intensity="1"
      shadow-softness="0.5"
      tone-mapping="commerce"
      interaction-prompt="none"
      style={{ background: studioBackdrop(backgroundLight, backdrop), opacity: ready ? 1 : 0, pointerEvents: interactive ? "auto" : "none" }}
    />}
    {loading && <div className="mockup-glb-message mockup-glb-progress">
      <span className="mockup-glb-progress-visual" aria-hidden="true">
        {progress.kind === "percent" ? <Progress percent={progress.percent} size="small" status="active" /> : null}
        <span>{progress.kind === "preparing" ? GLB_PREPARING_TEXT : GLB_LOADING_TEXT}</span>
      </span>
      <span role="status" className="sr-only">{glbStatusText(progress)}</span>
    </div>}
    <button type="button" className="mockup-dl mockup-glb-reset" aria-label="复位模型视角"
      disabled={!ready || error} onClick={() => { void frame(true); }}>复位</button>
  </>;
}

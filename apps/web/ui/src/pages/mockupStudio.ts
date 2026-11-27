import { studioGenerationParam } from "./mockupStudioVersion";

export const STUDIO_LIGHT_MIN = 0.6;
export const STUDIO_LIGHT_MAX = 1.4;
export const STUDIO_LIGHT_DEFAULT = 1;
export const STUDIO_GROUND_FILL = "rgb(228, 228, 232)";
export const BACKDROP_PRESETS = ["white", "silver", "white_set"] as const;
export type BackdropPreset = (typeof BACKDROP_PRESETS)[number];
export const BACKDROP_DEFAULT: BackdropPreset = "white_set";
export const BACKDROP_LABEL: Record<BackdropPreset, string> = {
  white: "白底",
  silver: "银底",
  white_set: "白桌白墙",
};
const BACKDROP_STORAGE_KEY = "beian.mockup.backdrop";
const WHITE_SET_HORIZON = 0.58;

export function clampStudioLight(value: number): number {
  if (!Number.isFinite(value)) return STUDIO_LIGHT_DEFAULT;
  return Math.min(STUDIO_LIGHT_MAX, Math.max(STUDIO_LIGHT_MIN, value));
}

export function stillsFilter(light: number): string {
  const next = clampStudioLight(light);
  return `contrast(1.04) brightness(${next})`;
}

export function parseBackdropPreset(value: unknown): BackdropPreset {
  return value === "white" || value === "silver" || value === "white_set" ? value : BACKDROP_DEFAULT;
}

export function readBackdropPreset(): BackdropPreset {
  try {
    if (typeof localStorage === "undefined") return BACKDROP_DEFAULT;
    return parseBackdropPreset(localStorage.getItem(BACKDROP_STORAGE_KEY));
  } catch {
    return BACKDROP_DEFAULT;
  }
}

export function writeBackdropPreset(preset: BackdropPreset): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(BACKDROP_STORAGE_KEY, preset);
  } catch {
    /* quota / private mode */
  }
}

export function usesContactShadow(preset: BackdropPreset): boolean {
  return preset === "white_set";
}

export function backdropFrameClass(preset: BackdropPreset): string {
  if (preset === "silver") return "is-backdrop-silver";
  if (preset === "white_set") return "is-backdrop-white-set";
  return "is-backdrop-white";
}

function litChannel(base: number, light: number): number {
  return Math.round(Math.min(255, Math.max(0, base * clampStudioLight(light))));
}

function silverFill(light: number): string {
  return `rgb(${litChannel(196, light)}, ${litChannel(201, light)}, ${litChannel(208, light)})`;
}

function whiteSetWallFill(light: number): string {
  return `rgb(${litChannel(238, light)}, ${litChannel(238, light)}, ${litChannel(236, light)})`;
}

/** 白底默认约 RGB 238，给白盒留层次；滑条仍能加到接近白。银底浅银。白桌白墙用台面灰，墙面另画。 */
export function studioBackdrop(light: number, preset: BackdropPreset = "white"): string {
  if (preset === "silver") return silverFill(light);
  if (preset === "white_set") {
    return `rgb(${litChannel(228, light)}, ${litChannel(228, light)}, ${litChannel(232, light)})`;
  }
  return `rgb(${litChannel(238, light)}, ${litChannel(238, light)}, ${litChannel(238, light)})`;
}

/** The 3D display asset supplies walls; the host only supplies a solid fallback. */
export function glbBackdrop(light: number, preset: BackdropPreset): string {
  return studioBackdrop(light, preset);
}

function paintStudioSet(
  ctx: CanvasRenderingContext2D,
  destW: number,
  destH: number,
  preset: BackdropPreset,
  backgroundLight: number,
): void {
  ctx.fillStyle = studioBackdrop(backgroundLight, preset);
  ctx.fillRect(0, 0, destW, destH);
  if (preset !== "white_set" || destH <= 0) return;
  const horizon = Math.round(destH * WHITE_SET_HORIZON);
  ctx.fillStyle = whiteSetWallFill(backgroundLight);
  ctx.fillRect(0, 0, destW, horizon);
  ctx.fillStyle = "rgba(40, 24, 56, 0.12)";
  ctx.fillRect(0, horizon, destW, Math.max(1, Math.round(destH * 0.004)));
}

export function jobHasGround(files: Array<{ key: string }> | undefined): boolean {
  return (files || []).some((file) => file.key === "white_a_ground" || file.key === "white_b_ground");
}

export type StudioStillKey =
  | "white_a"
  | "white_b"
  | "white_a_ground"
  | "white_b_ground"
  | "white_a_set"
  | "white_b_set";

export function stillSetKey(fileKey: "white_a" | "white_b"): "white_a_set" | "white_b_set" {
  return fileKey === "white_a" ? "white_a_set" : "white_b_set";
}

export function jobHasSet(
  files: Array<{ key: string }> | undefined,
  fileKey: "white_a" | "white_b",
): boolean {
  const key = stillSetKey(fileKey);
  return (files || []).some((file) => file.key === key);
}

export function reviewCardKey(key: StudioStillKey): string {
  return `${key}_card`;
}

export function jobHasReviewCard(
  files: Array<{ key: string }> | undefined,
  key: StudioStillKey,
): boolean {
  const card = reviewCardKey(key);
  return (files || []).some((file) => file.key === card);
}

export function containRect(
  destW: number,
  destH: number,
  srcW: number,
  srcH: number,
): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0 || destW <= 0 || destH <= 0) {
    return { x: 0, y: 0, w: destW, h: destH };
  }
  const scale = Math.min(destW / srcW, destH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (destW - w) / 2, y: (destH - h) / 2, w, h };
}

export type SizedSource = {
  id?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
};

function sourceSize(image: SizedSource): { width: number; height: number } {
  return {
    width: Number(image.naturalWidth || image.width || 0),
    height: Number(image.naturalHeight || image.height || 0),
  };
}

export type ComposeStudioOpts = {
  productLight: number;
  backgroundLight: number;
  filterSupported?: boolean;
  backdrop?: BackdropPreset;
  set?: SizedSource | null;
};

/** Versioned display transfer, not physical exposure or a change to source PNGs. */
const STUDIO_TRANSFER_VERSION = "highlight-power-v1";

export function highlightLut(light: number): Uint8ClampedArray {
  const exponent = 1 / Math.max(1, clampStudioLight(light));
  return Uint8ClampedArray.from({ length: 256 }, (_, value) => Math.round(255 * (value / 255) ** exponent));
}

export function protectStudioHighlights(data: Uint8ClampedArray, light: number): void {
  const lut = highlightLut(light);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = lut[data[index]];
    data[index + 1] = lut[data[index + 1]];
    data[index + 2] = lut[data[index + 2]];
    // Keep coverage unchanged, including partially transparent box edges.
  }
}

// One reusable scratch layer per destination, not a cache of full images for
// every slider position. Preview work scales with its backing size; exports
// process the original dimensions. Default/dimming paths stay unchanged.
const transferLayers = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();

function drawStudioLayer(
  ctx: CanvasRenderingContext2D, source: SizedSource,
  rect: { x: number; y: number; w: number; h: number },
  light: number, product: boolean, filterSupported: boolean,
): void {
  const next = clampStudioLight(light);
  if (next <= 1) {
    ctx.filter = filterSupported ? (product ? stillsFilter(next) : next === 1 ? "none" : `brightness(${next})`) : "none";
    ctx.drawImage(source as CanvasImageSource, rect.x, rect.y, rect.w, rect.h);
    ctx.filter = "none";
    return;
  }
  let layer = transferLayers.get(ctx);
  if (!layer) {
    layer = document.createElement("canvas");
    transferLayers.set(ctx, layer);
  }
  layer.width = Math.max(1, Math.ceil(rect.w));
  layer.height = Math.max(1, Math.ceil(rect.h));
  const work = layer.getContext("2d", { willReadFrequently: true });
  if (!work) throw new Error("这台浏览器不能进行高光保护调灯");
  work.filter = product && filterSupported ? "contrast(1.04)" : "none";
  work.drawImage(source as CanvasImageSource, 0, 0, layer.width, layer.height);
  const pixels = work.getImageData(0, 0, layer.width, layer.height);
  protectStudioHighlights(pixels.data, next);
  work.putImageData(pixels, 0, 0);
  ctx.filter = "none";
  ctx.drawImage(layer, rect.x, rect.y, rect.w, rect.h);
}

export function composeStudioStill(
  ctx: CanvasRenderingContext2D,
  destW: number,
  destH: number,
  product: SizedSource | null,
  ground: SizedSource | null,
  opts: ComposeStudioOpts,
): void {
  if (ctx.canvas) ctx.canvas.dataset.studioTransfer = STUDIO_TRANSFER_VERSION;
  // Backdrop fill → set still (white_set) or CSS wall + optional ground multiply → product.
  const preset = parseBackdropPreset(opts.backdrop ?? BACKDROP_DEFAULT);
  const productSize = product ? sourceSize(product) : { width: 0, height: 0 };
  const groundSize = ground ? sourceSize(ground) : { width: 0, height: 0 };
  const set = opts.set || null;
  const setSize = set ? sourceSize(set) : { width: 0, height: 0 };
  const useSet = preset === "white_set" && Boolean(set && setSize.width && setSize.height);
  const srcW = productSize.width || setSize.width || groundSize.width;
  const srcH = productSize.height || setSize.height || groundSize.height;
  const rect = containRect(destW, destH, srcW, srcH);
  ctx.save();
  try {
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  if (useSet) {
    ctx.fillStyle = studioBackdrop(opts.backgroundLight, preset);
    ctx.fillRect(0, 0, destW, destH);
    drawStudioLayer(ctx, set!, rect, opts.backgroundLight, false, opts.filterSupported !== false);
  } else {
    paintStudioSet(ctx, destW, destH, preset, opts.backgroundLight);
    if (usesContactShadow(preset) && ground && groundSize.width && groundSize.height) {
      ctx.globalCompositeOperation = "multiply";
      drawStudioLayer(ctx, ground, rect, opts.backgroundLight, false, opts.filterSupported !== false);
      ctx.globalCompositeOperation = "source-over";
    }
  }
  if (product && productSize.width && productSize.height) {
    drawStudioLayer(ctx, product, rect, opts.productLight, true, opts.filterSupported !== false);
  }
  } finally {
    ctx.restore();
  }
}

let filterProbe: boolean | undefined;

export function canvasFilterSupported(ctx: CanvasRenderingContext2D): boolean {
  if (typeof ctx.filter !== "string") return false;
  if (typeof document === "undefined") return false;
  if (filterProbe !== undefined) return filterProbe;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const probe = canvas.getContext("2d");
    if (!probe || typeof probe.filter !== "string") {
      filterProbe = false;
      return false;
    }
    probe.fillStyle = "rgb(255, 255, 255)";
    probe.fillRect(0, 0, 1, 1);
    probe.filter = "brightness(0)";
    probe.fillStyle = "rgb(255, 255, 255)";
    probe.fillRect(0, 0, 1, 1);
    const px = probe.getImageData(0, 0, 1, 1).data;
    filterProbe = px[0] < 128;
    return filterProbe;
  } catch {
    filterProbe = false;
    return false;
  }
}

const stillLoads = new Map<string, Promise<HTMLImageElement>>();
const STILL_URGENCY = { original: 0, fallback: 1, upgrade: 2 };
type StillUrgency = keyof typeof STILL_URGENCY;
type StillDemand = { urgency: StillUrgency; signal?: AbortSignal; order: number };
type StillRequest = {
  url: string;
  promise: Promise<HTMLImageElement>;
  resolve: (image: HTMLImageElement) => void;
  reject: (error: unknown) => void;
  demands: StillDemand[];
};
const queuedStills = new Map<string, StillRequest>();
let activeStill: StillRequest | undefined;
let stillDemandOrder = 0;

/** A successful relight changes bytes without changing job id or file keys. */
export function studioAssetHref(jobId: string, key: string, generation = "", download = false): string {
  const base = `/api/mockups/${jobId}/files/${key}`;
  const query = new URLSearchParams();
  if (generation) query.set(studioGenerationParam(generation), generation);
  if (download) query.set("download", "1");
  const suffix = query.toString();
  return suffix ? `${base}?${suffix}` : base;
}

async function decodeStillImage(url: string, priority: RequestPriority): Promise<HTMLImageElement> {
  if (typeof Image === "undefined") throw new Error("load");
  const image = new Image();
  image.crossOrigin = "anonymous";
  if (priority !== "auto") image.fetchPriority = priority;
  image.src = url;
  await image.decode();
  return image;
}

function rememberStillLoad(url: string, promise: Promise<HTMLImageElement>): void {
  if (stillLoads.get(url) === promise) return;
  // Relights reuse a logical asset: do not retain every decoded generation forever.
  const [asset, query = ""] = url.split("?");
  if (new URLSearchParams(query).has("generation") || new URLSearchParams(query).has("generation_id")) {
    for (const cached of stillLoads.keys()) {
      if (cached.split("?")[0] === asset) stillLoads.delete(cached);
    }
  }
  stillLoads.set(url, promise);
  attachPerfProbe();
}

function rejectStillLoad(request: StillRequest, error: unknown): void {
  if (stillLoads.get(request.url) === request.promise) stillLoads.delete(request.url);
  request.reject(error);
}

function startNextStill(): void {
  let next: { request: StillRequest; demand: StillDemand } | undefined;
  for (const request of queuedStills.values()) {
    request.demands = request.demands.filter(({ signal }) => !signal?.aborted);
    if (!request.demands.length) {
      queuedStills.delete(request.url);
      rejectStillLoad(request, new DOMException("Preview is no longer needed", "AbortError"));
    }
    for (const demand of request.demands) {
      const rank = STILL_URGENCY[demand.urgency];
      if (!next || rank < STILL_URGENCY[next.demand.urgency]
        || (rank === STILL_URGENCY[next.demand.urgency] && demand.order < next.demand.order)) {
        next = { request, demand };
      }
    }
  }
  if (!next || activeStill) return;
  const { request, demand } = next;
  queuedStills.delete(request.url);
  activeStill = request;
  const priority = demand.urgency === "upgrade" ? "low" : "high";
  void decodeStillImage(request.url, priority).then(
    (image) => { activeStill = undefined; request.resolve(image); },
    (error) => { activeStill = undefined; rejectStillLoad(request, error); },
  ).then(startNextStill);
}

/** The tab shares one lane for full PNGs. Cards decode directly, outside this lane. */
export function loadStillImage(
  url: string,
  { urgency = "fallback", signal }: { urgency?: StillUrgency; signal?: AbortSignal } = {},
): Promise<HTMLImageElement> {
  const demand = () => ({ urgency, signal, order: stillDemandOrder++ });
  const queued = queuedStills.get(url);
  if (queued) {
    if (!queued.demands.some((entry) => entry.urgency === urgency && entry.signal === signal)) queued.demands.push(demand());
    rememberStillLoad(url, queued.promise);
    startNextStill();
    return queued.promise;
  }
  const existing = stillLoads.get(url) ?? (activeStill?.url === url ? activeStill.promise : undefined);
  if (existing) {
    rememberStillLoad(url, existing);
    return existing;
  }
  let resolve!: StillRequest["resolve"];
  let reject!: StillRequest["reject"];
  const promise = new Promise<HTMLImageElement>((accept, fail) => { resolve = accept; reject = fail; });
  queuedStills.set(url, { url, promise, resolve, reject, demands: [demand()] });
  rememberStillLoad(url, promise);
  startNextStill();
  return promise;
}

/** Drop only this page's preview cache references. */
export function releaseStudioGeneration(jobId:string,generation:string): void {
  const prefix=`/api/mockups/${jobId}/files/`;
  for (const url of stillLoads.keys()) {
    if (!url.startsWith(prefix)) continue;
    const query=new URLSearchParams(url.split("?")[1] || "");
    if ((query.get("generation_id") || query.get("generation") || "") === generation) stillLoads.delete(url);
  }
  attachPerfProbe();
}

export function studioStillCacheHas(url: string): boolean {
  return stillLoads.has(url);
}

export function studioStillCacheSize(): number {
  return stillLoads.size;
}

function studioStillCacheUrls(): string[] {
  return [...stillLoads.keys()];
}

/** Setting canvas width/height to the current value still resets the backing store. */
export function canvasBackingSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(0, Math.round(Number(width) || 0)),
    height: Math.max(0, Math.round(Number(height) || 0)),
  };
}

export function setCanvasBacking(canvas: HTMLCanvasElement, width: number, height: number): boolean {
  const next = canvasBackingSize(width, height);
  if (canvas.width === next.width && canvas.height === next.height) return false;
  canvas.width = next.width;
  canvas.height = next.height;
  return true;
}

export function releaseCanvasBacking(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function resetCanvas2d(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (typeof ctx.filter === "string") ctx.filter = "none";
  ctx.clearRect(0, 0, width, height);
}

/** Size the backing store; same-size redraws clear context state instead of skipping the paint. */
export function prepareStudioCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const next = canvasBackingSize(width, height);
  if (!next.width || !next.height) {
    releaseCanvasBacking(canvas);
    return null;
  }
  const resized = setCanvasBacking(canvas, next.width, next.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    releaseCanvasBacking(canvas);
    return null;
  }
  if (!resized) resetCanvas2d(ctx, next.width, next.height);
  return ctx;
}

function attachPerfProbe(): void {
  if (typeof window === "undefined") return;
  if (!Boolean((window as Window & { __RF09_PERF__?: boolean }).__RF09_PERF__)) return;
  (window as Window & {
    __q05Studio?: { cacheSize: () => number; cacheUrls: () => string[] };
  }).__q05Studio = {
    cacheSize: studioStillCacheSize,
    cacheUrls: studioStillCacheUrls,
  };
}

type StudioSourceUrls = { full: string; card?: string };
export type StudioLayerKey = "product" | "ground" | "set";
type StudioLayerOrigin = "card" | "full" | "none";
type StudioLayerFetch = "deferred" | "pending" | "ready" | "failed" | "absent";
type StudioLayerFact = {
  origin: StudioLayerOrigin;
  fetch: StudioLayerFetch;
  upgradeFailed?: boolean;
};
export type StudioPreviewFacts = Record<StudioLayerKey, StudioLayerFact>;
export type StudioPreviewSources = {
  product: HTMLImageElement;
  ground: HTMLImageElement | null;
  set: HTMLImageElement | null;
  facts: StudioPreviewFacts;
};

const ABSENT_LAYER: StudioLayerFact = { origin: "none", fetch: "absent" };
const DEFERRED_LAYER: StudioLayerFact = { origin: "none", fetch: "deferred" };
const PENDING_LAYER: StudioLayerFact = { origin: "none", fetch: "pending" };

function studioDrawnLayerKeys(
  backdrop: BackdropPreset,
  set: SizedSource | null,
): { keys: ["product"] | ["product", "ground" | "set"]; setFallback: boolean } {
  const preset = parseBackdropPreset(backdrop);
  if (preset !== "white_set") return { keys: ["product"], setFallback: false };
  const size = set ? sourceSize(set) : { width: 0, height: 0 };
  if (set && size.width && size.height) return { keys: ["product", "set"], setFallback: false };
  return { keys: ["product", "ground"], setFallback: true };
}

export function studioPreviewSummary(
  facts: StudioPreviewFacts,
  backdrop: BackdropPreset,
  set: SizedSource | null,
): { source?: "card" | "full" | "mixed"; setFallback: boolean } {
  const { keys, setFallback } = studioDrawnLayerKeys(backdrop, set);
  const origins = keys.map((key) => facts[key].origin);
  if (origins.some((origin) => origin === "none")) return { setFallback };
  if (origins.every((origin) => origin === "full")) return { source: "full", setFallback };
  if (origins.every((origin) => origin === "card")) return { source: "card", setFallback };
  return { source: "mixed", setFallback };
}

export function studioDrawnUpgradeFailed(
  facts: StudioPreviewFacts,
  backdrop: BackdropPreset,
  set: SizedSource | null,
): boolean {
  const { keys } = studioDrawnLayerKeys(backdrop, set);
  return keys.some((key) => Boolean(facts[key].upgradeFailed));
}

export function applyStudioPreviewDataset(
  canvas: HTMLCanvasElement,
  facts: StudioPreviewFacts | null,
  backdrop: BackdropPreset,
  set: SizedSource | null,
): void {
  const ds = canvas.dataset;
  delete ds.previewSource;
  delete ds.previewProduct;
  delete ds.previewGround;
  delete ds.previewSet;
  delete ds.previewProductFetch;
  delete ds.previewGroundFetch;
  delete ds.previewSetFetch;
  delete ds.previewProductUpgrade;
  delete ds.previewGroundUpgrade;
  delete ds.previewSetUpgrade;
  delete ds.previewSetFallback;
  if (!facts) return;
  ds.previewProduct = facts.product.origin;
  ds.previewGround = facts.ground.origin;
  ds.previewSet = facts.set.origin;
  ds.previewProductFetch = facts.product.fetch;
  ds.previewGroundFetch = facts.ground.fetch;
  ds.previewSetFetch = facts.set.fetch;
  if (facts.product.upgradeFailed) ds.previewProductUpgrade = "failed";
  if (facts.ground.upgradeFailed) ds.previewGroundUpgrade = "failed";
  if (facts.set.upgradeFailed) ds.previewSetUpgrade = "failed";
  const summary = studioPreviewSummary(facts, backdrop, set);
  if (summary.source) ds.previewSource = summary.source;
  if (summary.setFallback) ds.previewSetFallback = "1";
}

function rf09PerfEnabled(): boolean {
  return typeof window !== "undefined" && Boolean((window as Window & { __RF09_PERF__?: boolean }).__RF09_PERF__);
}

function rf09Mark(name: string): void {
  if (!rf09PerfEnabled()) return;
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  if (performance.getEntriesByName(name, "mark").length >= 24) performance.clearMarks(name);
  performance.mark(name);
}

type StudioPreviewLayer = {
  full?: string;
  card?: string;
  image: HTMLImageElement | null;
  fact: StudioLayerFact;
  upgrading: boolean;
  fullLoad?: AbortController;
};

function previewLayer(urls: StudioSourceUrls | null): StudioPreviewLayer {
  return { ...urls, image: null, fact: urls ? DEFERRED_LAYER : ABSENT_LAYER, upgrading: false };
}

/** Keep decoded layers across backdrop switches. Only the current backdrop drives new requests. */
export function loadStudioPreview(
  urls: { product: StudioSourceUrls; ground: StudioSourceUrls; set: StudioSourceUrls | null },
  publish: (sources: StudioPreviewSources) => void,
  failed: () => void,
  loadFull = loadStillImage,
  loadCard = decodeStillImage,
) {
  attachPerfProbe();
  const product = previewLayer(urls.product);
  const ground = previewLayer(urls.ground);
  const set = previewLayer(urls.set);
  const layers = { product, ground, set };
  let cancelled = false;
  let reportedFailure = false;
  let backdrop: BackdropPreset = "white";
  let promote = false;

  function update(): void {
    if (cancelled) return;
    const room = backdrop === "white_set";
    if (!room) stopFull("set");
    if (!room || set.image) stopFull("ground");
    const needsGround = room && (!set.full || set.fact.fetch === "failed");
    if (product.fact.fetch === "failed" || (needsGround && ground.fact.fetch === "failed")) {
      if (!reportedFailure) failed();
      reportedFailure = true;
      return;
    }
    reportedFailure = false;

    requestLayer("product");
    if (room) requestLayer("set");
    if (needsGround || (room && promote && !set.image)) requestLayer("ground");

    if (product.image && (!needsGround || ground.image)) {
      publish({
        product: product.image, ground: ground.image, set: set.image,
        facts: { product: product.fact, ground: ground.fact, set: set.fact },
      });
    }
    if (promote) {
      requestUpgrade("product");
      if (room) requestUpgrade(set.image ? "set" : "ground");
    }
  }

  function requestLayer(key: StudioLayerKey): void {
    const layer = layers[key];
    const { card, full } = layer;
    if (!full || layer.fact.fetch !== "deferred") return;
    if (!card && key === "set" && !promote) return;
    layer.fact = PENDING_LAYER;
    const priority = key === "product" ? "high" : "auto";
    if (!card) {
      requestFull(key, full, "fallback");
      return;
    }
    void loadCard(card, priority).then(
      (image) => loaded(key, image, "card"),
      () => {
        if (cancelled) return;
        layer.card = undefined;
        layer.fact = DEFERRED_LAYER;
        update();
      },
    );
  }

  function loaded(key: StudioLayerKey, image: HTMLImageElement, origin: "card" | "full"): void {
    if (cancelled) return;
    const layer = layers[key];
    layer.image = image;
    layer.fact = { origin, fetch: "ready" };
    rf09Mark(`rf09-decode-${key}-${origin}`);
    update();
  }

  function requestUpgrade(key: StudioLayerKey): void {
    const layer = layers[key];
    if (!layer.full || layer.fact.origin !== "card" || layer.upgrading) return;
    layer.upgrading = true;
    requestFull(key, layer.full, "upgrade");
  }

  function requestFull(key: StudioLayerKey, url: string, urgency: "fallback" | "upgrade"): void {
    const layer = layers[key];
    const controller = new AbortController();
    layer.fullLoad = controller;
    void loadFull(url, { urgency, signal: controller.signal }).then(
      (image) => {
        if (controller.signal.aborted) return;
        layer.fullLoad = undefined;
        loaded(key, image, "full");
      },
      () => {
        if (controller.signal.aborted) return;
        layer.fullLoad = undefined;
        layer.fact = urgency === "upgrade"
          ? { ...layer.fact, upgradeFailed: true }
          : { origin: "none", fetch: "failed" };
        update();
      },
    );
  }

  function stopFull(key: StudioLayerKey): void {
    const layer = layers[key];
    if (!layer.fullLoad) return;
    layer.fullLoad.abort();
    layer.fullLoad = undefined;
    if (!layer.upgrading) layer.fact = DEFERRED_LAYER;
    layer.upgrading = false;
  }

  return {
    show(next: BackdropPreset, afterFirstPreview: boolean): void {
      backdrop = next;
      if (promote && !afterFirstPreview) {
        for (const key of ["product", "ground", "set"] as const) {
          if (layers[key].upgrading) stopFull(key);
        }
      }
      promote = afterFirstPreview;
      update();
    },
    cancel(): void {
      cancelled = true;
      for (const layer of Object.values(layers)) layer.fullLoad?.abort();
    },
  };
}

/** Observe the container, not just the viewport. DPR changes re-arm the resolution query. */
export function observeStudioFrame(frame: HTMLElement, resized: (width: number, height: number) => void): () => void {
  let raf = 0;
  let stopped = false;
  let lastWidth = 0;
  let lastHeight = 0;
  let media: MediaQueryList | undefined;
  const measure = () => {
    raf = 0;
    if (stopped || !frame.clientWidth || !frame.clientHeight) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(frame.clientWidth * dpr));
    const height = Math.max(1, Math.round(frame.clientHeight * dpr));
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    resized(width, height);
  };
  const schedule = () => { if (!stopped && !raf) raf = requestAnimationFrame(measure); };
  const watchDpr = () => {
    media?.removeEventListener("change", watchDpr);
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    media.addEventListener("change", watchDpr);
    schedule();
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  observer?.observe(frame);
  window.addEventListener("resize", schedule);
  watchDpr();
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    media?.removeEventListener("change", watchDpr);
    window.removeEventListener("resize", schedule);
  };
}

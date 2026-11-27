import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { fileOf, isWhiteFile, type MockupJob } from "./mockup.js";
import { isRenderGenerationError, type HeldGenerationFile } from "./renderGenerations.js";
import { composeStudioPng, type StudioStillAppearance } from "./studioStill.js";

type ProductKey = "white_a" | "white_b";
type BackgroundKind = "ground" | "set";
type Selection = StudioStillAppearance & {
  key: ProductKey;
  layer: BackgroundKind | "none" | "auto";
  generationId?: string;
  legacyVersion?: string;
};
type Source = Omit<HeldGenerationFile, "sha256"> & { identity: string };
type OpenGenerationFile = (jobId: string, generationId: string, key: string) => HeldGenerationFile;

const MAX_SOURCE_BYTES = 160 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const CARD_EDGE = 960;

function stillError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function light(value: string | null): number {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) throw stillError(400, "灯光参数无效");
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0.6 || result > 1.4) throw stillError(400, "灯光参数无效");
  return result;
}

export function studioStillSelection(key: string, query: URLSearchParams): Selection {
  const backdrop = query.get("backdrop");
  const layer = query.get("layer");
  const generationId = query.get("generation_id");
  const legacyVersion = query.get("generation");
  if (key !== "white_a" && key !== "white_b") throw stillError(400, "成片角度无效");
  if (backdrop !== "white" && backdrop !== "silver" && backdrop !== "white_set") {
    throw stillError(400, "成片背景无效");
  }
  if (layer !== "ground" && layer !== "set" && layer !== "none" && layer !== "auto") {
    throw stillError(400, "成片图层无效");
  }
  if (backdrop !== "white_set" && layer !== "none") throw stillError(400, "成片图层无效");
  if (generationId !== null && (legacyVersion !== null || !generationId)) throw stillError(400, "成片版本无效");
  if (new Set(query.keys()).size !== query.size) throw stillError(400, "成片参数重复");
  return {
    key, backdrop, layer,
    generationId: generationId ?? undefined,
    legacyVersion: legacyVersion ?? undefined,
    productLight: light(query.get("product_light")),
    backgroundLight: light(query.get("background_light")),
  };
}

function fromHeld(file: HeldGenerationFile): Source {
  return { ...file, identity: file.sha256 };
}

function statIdentity(stat: ReturnType<typeof fstatSync>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function openLegacyFile(job: MockupJob, key: string): Source | null {
  const file = fileOf(job, key);
  if (!file?.path) return null;
  if (!isWhiteFile(key, file.name)) throw stillError(415, "成片源图无效");
  const fd = openSync(file.path, "r");
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !st.size || st.size > MAX_SOURCE_BYTES) throw stillError(415, "成片源图无效");
    return { fd, name: file.name, bytes: st.size, identity: statIdentity(st), close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openSource(job: MockupJob, key: string, generationId: string | undefined, open: OpenGenerationFile): Source | null {
  if (!generationId) return openLegacyFile(job, key);
  try {
    return fromHeld(open(job.id, generationId, key));
  } catch (error) {
    if (isRenderGenerationError(error) && error.cause === "generation_missing") return null;
    throw error;
  }
}

export function studioLegacyVersion(job: MockupJob): string {
  return job.studio_relit_at || job.job_finished_at || job.created_at;
}

function effectiveGeneration(job: MockupJob, selection: Selection): string | undefined {
  if (selection.generationId) return selection.generationId;
  if (selection.legacyVersion !== undefined && (
    job.current_render_generation_id || selection.legacyVersion !== studioLegacyVersion(job)
  )) throw stillError(409, "当前版本已变化，请刷新后重试");
  return job.current_render_generation_id;
}

function backgroundSource(selection: Selection, open: (key: string) => Source | null) {
  if (selection.layer === "none") return null;
  if (selection.layer === "auto") {
    const set = open(`${selection.key}_set`);
    if (set) return { kind: "set" as const, file: set };
    const ground = open(`${selection.key}_ground`);
    return ground ? { kind: "ground" as const, file: ground } : null;
  }
  const file = open(`${selection.key}_${selection.layer}`);
  if (!file) throw stillError(404, "当前成片缺少所选背景");
  return { kind: selection.layer, file };
}

function readSource(file: Pick<Source, "fd" | "bytes">): Buffer {
  if (!file.bytes || file.bytes > MAX_SOURCE_BYTES) throw stillError(415, "成片源图无效");
  const before = statIdentity(fstatSync(file.fd));
  const data = Buffer.allocUnsafe(file.bytes);
  let offset = 0;
  while (offset < data.length) {
    const bytes = readSync(file.fd, data, offset, data.length - offset, offset);
    if (!bytes) throw stillError(409, "成片源图读取中断，请重试");
    offset += bytes;
  }
  if (before !== statIdentity(fstatSync(file.fd))) throw stillError(409, "成片源图已变化，请重试");
  return data;
}

function createImageCache(maxBytes: number, maxPending: number) {
  const ready = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();
  let usedBytes = 0;
  let last = Promise.resolve();

  function remember(key: string, bytes: Buffer) {
    if (bytes.length > maxBytes) return bytes;
    while (usedBytes + bytes.length > maxBytes || ready.size >= MAX_CACHE_ENTRIES) {
      const oldest = ready.entries().next().value;
      if (!oldest) break;
      ready.delete(oldest[0]);
      usedBytes -= oldest[1].length;
    }
    ready.set(key, bytes);
    usedBytes += bytes.length;
    return bytes;
  }

  function get(key: string, render: () => Promise<Buffer>) {
    const cached = ready.get(key);
    if (cached) {
      ready.delete(key);
      ready.set(key, cached);
      return Promise.resolve(cached);
    }
    const active = pending.get(key);
    if (active) return active;
    if (pending.size >= maxPending) throw stillError(503, "成片正在处理，请稍后重试");
    const next = last.then(render).then(bytes => remember(key, bytes)).finally(() => pending.delete(key));
    pending.set(key, next);
    last = next.then(() => undefined, () => undefined);
    return next;
  }

  return { get, busy: () => pending.size > 0 };
}

// Compose one original at a time. Retried and identical requests reuse the result.
const stills = createImageCache(48 * 1024 * 1024, 4);
const cards = createImageCache(8 * 1024 * 1024, 4);

export async function studioStillPng(job: MockupJob, selection: Selection, open: OpenGenerationFile) {
  const generationId = effectiveGeneration(job, selection);
  const source = (key: string) => openSource(job, key, generationId, open);
  const product = source(selection.key);
  if (!product) throw stillError(404, "当前成片缺少产品图");
  let background: ReturnType<typeof backgroundSource> = null;
  try {
    background = backgroundSource(selection, source);
    const key = JSON.stringify([job.id, selection.key, product.identity, background?.kind,
      background?.file.identity, selection.backdrop, selection.productLight, selection.backgroundLight]);
    const bytes = await stills.get(key, () => composeStudioPng(
      readSource(product),
      background ? { kind: background.kind, bytes: readSource(background.file) } : null,
      selection,
    ));
    return { bytes, name: product.name };
  } finally {
    background?.file.close();
    product.close();
  }
}

export async function warmDefaultStudioStills(job: MockupJob, generationId: string | undefined, open: OpenGenerationFile) {
  for (const key of ["white_a", "white_b"] as const) {
    if (stills.busy()) return;
    await studioStillPng(job, {
      key, generationId, backdrop: "white_set", layer: "auto", productLight: 1, backgroundLight: 1,
    }, open);
  }
}

export function isStudioCard(key: string): boolean {
  return /^white_[ab](?:_(?:ground|set))?_card$/.test(key);
}

export function compactStudioCard(fd: number, bytes: number, originalEtag: string, fileIdentity: string) {
  const identity = createHash("sha256").update(`png-${CARD_EDGE}:${fileIdentity}:${originalEtag}`).digest("hex");
  const data = () => cards.get(identity, async () => {
    const { default: sharp } = await import("sharp");
    const original = readSource({ fd, bytes });
    const compact = await sharp(original, { limitInputPixels: 32_000_000 })
      .resize({ width: CARD_EDGE, height: CARD_EDGE, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 6, adaptiveFiltering: true })
      .toBuffer();
    return compact.length < original.length ? compact : original;
  });
  return { etag: `"sha256-${identity}"`, data };
}

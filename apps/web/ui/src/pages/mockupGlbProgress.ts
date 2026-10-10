import type { BackdropPreset } from "./mockupStudio";

/** 3D 加载进度：total 未知（无 Content-Length，如服务端即时 gzip）时为 indeterminate。 */
export type GlbProgress =
  | { kind: "indeterminate" }
  | { kind: "percent"; percent: number }
  | { kind: "preparing" };

export const GLB_LOADING_TEXT = "正在加载 3D 模型…";
export const GLB_PREPARING_TEXT = "正在准备场景…";

/** 读屏播报文本：百分比只在 25/50/75/100 档位变化，避免 live region 每个分块都播报。 */
export function glbStatusText(progress: GlbProgress): string {
  if (progress.kind === "preparing") return GLB_PREPARING_TEXT;
  if (progress.kind === "indeterminate") return GLB_LOADING_TEXT;
  const milestone = Math.floor(progress.percent / 25) * 25;
  return milestone > 0 ? `${GLB_LOADING_TEXT} ${milestone}%` : GLB_LOADING_TEXT;
}

export function glbProgressFromBytes(loaded: number, total: number | null | undefined): GlbProgress {
  if (!total || !Number.isFinite(total) || total <= 0 || !Number.isFinite(loaded) || loaded < 0) {
    return { kind: "indeterminate" };
  }
  return { kind: "percent", percent: Math.min(100, Math.floor((loaded / total) * 100)) };
}

/**
 * model-viewer 的 progress 事件只给 totalProgress（0–1）。无 Content-Length 时它在下载期间
 * 停在 0 再跳到 1，所以 0 和 1 都按“无意义”处理；只有严格介于两者之间才显示百分比。
 */
export function glbProgressFromFraction(fraction: unknown): GlbProgress {
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    return { kind: "indeterminate" };
  }
  return { kind: "percent", percent: Math.floor(fraction * 100) };
}

export function parseContentLength(header: string | null): number | null {
  if (!header || !/^\d+$/.test(header.trim())) return null;
  const value = Number(header.trim());
  return value > 0 ? value : null;
}

/** 流式读取响应体并回报进度；无 Content-Length 或带 Content-Encoding 时按未知总量处理。 */
export async function readGlbWithProgress(
  response: Response,
  onProgress: (progress: GlbProgress) => void,
): Promise<Uint8Array> {
  const encoded = Boolean(response.headers.get("content-encoding"));
  const total = encoded ? null : parseContentLength(response.headers.get("content-length"));
  onProgress(glbProgressFromBytes(0, total));
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(glbProgressFromBytes(loaded, total));
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * 选一张已有效果图做 poster：白桌白墙优先用桌墙图，审阅卡（小图）优先于原图。
 * job.files 里的 key 是服务端映射后的 white_a*，不是渲染器输出名 front_right*：
 * 见 apps/web/server/src/renderGenerationBridge.ts RENDER_GENERATION_OUTPUT_KEYS
 * （front_right→white_a、front_right_set_card→white_a_set_card 等）。
 */
export function glbPosterKey(files: Array<{ key: string }> | undefined, backdrop: BackdropPreset): string | null {
  const keys = new Set((files || []).map((file) => file.key));
  const order = backdrop === "white_set"
    ? ["white_a_set_card", "white_a_set", "white_a_card", "white_a"]
    : ["white_a_card", "white_a"];
  return order.find((key) => keys.has(key)) ?? null;
}

/** 模型加载完成且已取景后才允许拖拽：加载中透明的 model-viewer 不应被转动，否则出现时机位已偏。 */
export function glbInteractive(ready: boolean, error: boolean): boolean {
  return ready && !error;
}

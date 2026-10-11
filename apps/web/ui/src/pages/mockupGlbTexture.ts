/**
 * GLB 贴图格式降级：后端在 mockup 文件信息上标出贴图格式，网页真解码一张 1×1 WebP 判断本机能否显示。
 * 字段名和取值未定稿，只在这里改：GLB_TEXTURE_FORMAT_FIELD / GlbTextureFormat。
 */
export const GLB_TEXTURE_FORMAT_FIELD = "texture_format" as const;
type GlbTextureFormat = "webp" | "png";
/** 混入 MockupJob.files 的可选字段；缺字段 = 旧单，按 PNG 处理。 */
export type GlbTextureInfo = { [K in typeof GLB_TEXTURE_FORMAT_FIELD]?: GlbTextureFormat | (string & {}) };

// 无文档依据，需老板定（见 webp-fallback-basis.md）；句式沿用「3D 预览加载失败…下载仍为原始模型。」
export const GLB_WEBP_UNSUPPORTED_TEXT = "此设备无法显示 3D 预览，先看效果图。下载仍为原始模型。";

/** 最小合法 1×1 无损 WebP。 */
const WEBP_PROBE_DATA_URL = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

export function glbTextureFormat(files: Array<{ key: string } & GlbTextureInfo> | undefined): string | undefined {
  return files?.find((file) => file.key === "glb")?.[GLB_TEXTURE_FORMAT_FIELD];
}

export type GlbTextureGate = "load" | "detecting" | "fallback";
/** 只有明确是 webp 且真解码失败才挡 3D；缺字段、png 或未知值一律照旧加载。 */
export function glbTextureGate(format: string | undefined, webpSupported: boolean | null): GlbTextureGate {
  if (format !== "webp") return "load";
  if (webpSupported === null) return "detecting";
  return webpSupported ? "load" : "fallback";
}

export type WebpDecoder = {
  createImageBitmap?: (blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>;
  fetchBlob?: (url: string) => Promise<Blob>;
  decodeImage?: (url: string) => Promise<{ width: number; height: number }>;
};

/** 真解码：优先 createImageBitmap，取不到或失败再退 Image.decode()；任何异常都算不支持。 */
export async function probeWebpDecode(decoder: WebpDecoder): Promise<boolean> {
  if (decoder.createImageBitmap && decoder.fetchBlob) {
    try {
      const bitmap = await decoder.createImageBitmap(await decoder.fetchBlob(WEBP_PROBE_DATA_URL));
      const ok = bitmap.width === 1 && bitmap.height === 1;
      bitmap.close?.();
      if (ok) return true;
    } catch { /* 退 Image 再试一次 */ }
  }
  if (!decoder.decodeImage) return false;
  try {
    const image = await decoder.decodeImage(WEBP_PROBE_DATA_URL);
    return image.width === 1 && image.height === 1;
  } catch {
    return false;
  }
}

function browserWebpDecoder(): WebpDecoder {
  const scope = globalThis as typeof globalThis & { Image?: typeof Image };
  return {
    createImageBitmap: typeof scope.createImageBitmap === "function" ? (blob) => scope.createImageBitmap(blob) : undefined,
    fetchBlob: typeof scope.fetch === "function" ? async (url) => (await scope.fetch(url)).blob() : undefined,
    decodeImage: typeof scope.Image === "function" ? async (url) => {
      const image = new scope.Image!();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    } : undefined,
  };
}

/** 每个会话只探一次；返回同一个 Promise。 */
export function createWebpSupport(decoder: () => WebpDecoder) {
  let memo: Promise<boolean> | null = null;
  let settled: boolean | null = null;
  return {
    detect(): Promise<boolean> {
      memo ??= probeWebpDecode(decoder()).then((ok) => (settled = ok));
      return memo;
    },
    known(): boolean | null { return settled; },
  };
}

export const webpSupport = createWebpSupport(browserWebpDecoder);

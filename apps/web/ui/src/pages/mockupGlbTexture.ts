/**
 * GLB 贴图格式降级：后端在 mockup 文件信息上标出贴图格式，网页真解码一张 1×1 WebP 判断本机能否显示。
 * 字段名为后端约定的 texture_format；集中在这里改：GLB_TEXTURE_FORMAT_FIELD / GlbTextureFormat。
 */
export const GLB_TEXTURE_FORMAT_FIELD = "texture_format" as const;
type GlbTextureFormat = "webp" | "png";
/** 混入 MockupJob.files 的可选字段；缺字段 = 旧单，按 PNG 处理。 */
export type GlbTextureInfo = { [K in typeof GLB_TEXTURE_FORMAT_FIELD]?: GlbTextureFormat | (string & {}) };

// 老板定稿（2026-10-11）；见 DESIGN.md「3D 贴图不支持」。
export const GLB_WEBP_UNSUPPORTED_TEXT = "这台设备显示不了 3D，已换成效果图";

/** 最小合法 1×1 无损 WebP（base64）。本地 atob 成 Blob，不走 fetch，也不用 data: URL，免得被 CSP 误判为不支持。 */
const WEBP_PROBE_BASE64 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

export function webpProbeBlob(): Blob {
  const binary = atob(WEBP_PROBE_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/webp" });
}

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
  decodeImage?: (blob: Blob) => Promise<{ width: number; height: number }>;
};

/** 真解码：优先 createImageBitmap(Blob)，取不到或失败再退 Image.decode()（blob: URL）；任何异常都算不支持。 */
export async function probeWebpDecode(decoder: WebpDecoder): Promise<boolean> {
  const blob = webpProbeBlob();
  if (decoder.createImageBitmap) {
    try {
      const bitmap = await decoder.createImageBitmap(blob);
      const ok = bitmap.width === 1 && bitmap.height === 1;
      bitmap.close?.();
      if (ok) return true;
    } catch { /* 退 Image 再试一次 */ }
  }
  if (!decoder.decodeImage) return false;
  try {
    const image = await decoder.decodeImage(blob);
    return image.width === 1 && image.height === 1;
  } catch {
    return false;
  }
}

function browserWebpDecoder(): WebpDecoder {
  const scope = globalThis as typeof globalThis & { Image?: typeof Image };
  return {
    createImageBitmap: typeof scope.createImageBitmap === "function" ? (blob) => scope.createImageBitmap(blob) : undefined,
    decodeImage: typeof scope.Image === "function" && typeof URL.createObjectURL === "function" ? async (blob) => {
      const url = URL.createObjectURL(blob);
      try {
        const image = new scope.Image!();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      } finally {
        URL.revokeObjectURL(url);
      }
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

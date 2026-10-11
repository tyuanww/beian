/**
 * GLB 两个地址与加载顺序（后端 PR-a 合同）：
 * - 默认 `/api/mockups/:id/files/glb`：开关打开且有校验过的 WebP 版时返回 WebP 版，否则返回原始 GLB；
 * - 原始 `/api/mockups/:id/files/glb?variant=original`：永远是原始 GLB。
 * 文件信息里 `glb_version` / `glb_original_version` 是两者内容的 sha256 前 16 位；带上匹配的 `?v=`
 * 服务端给 immutable 缓存，两个地址各自缓存、互不覆盖。
 */
import type { GlbTextureGate } from "./mockupGlbTexture";

const GLB_VERSION_FIELD = "glb_version" as const;
const GLB_ORIGINAL_VERSION_FIELD = "glb_original_version" as const;
export type GlbVersionInfo = { [GLB_VERSION_FIELD]?: string; [GLB_ORIGINAL_VERSION_FIELD]?: string };

export function glbVersions(files: Array<{ key: string } & GlbVersionInfo> | undefined): GlbVersionInfo {
  const glb = files?.find((file) => file.key === "glb");
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { [GLB_VERSION_FIELD]: pick(glb?.[GLB_VERSION_FIELD]), [GLB_ORIGINAL_VERSION_FIELD]: pick(glb?.[GLB_ORIGINAL_VERSION_FIELD]) };
}

function withQuery(href: string, extra: Record<string, string | undefined>): string {
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** `defaultHref` 是现有 fileHref(jobId, "glb", …) 的结果（可能已带 generation / download）。 */
export function glbSourceUrls(defaultHref: string, versions: GlbVersionInfo): { primary: string; original: string } {
  return {
    primary: withQuery(defaultHref, { v: versions[GLB_VERSION_FIELD] }),
    original: withQuery(defaultHref, { variant: "original", v: versions[GLB_ORIGINAL_VERSION_FIELD] }),
  };
}

/**
 * 依次尝试的地址：贴图是 WebP 而本机解码不了 → 只拉原始；否则先默认地址、失败自动退原始一次。
 * 探测中返回空数组（先不拉）。全部失败由调用方显示效果图降级。
 */
export function glbAttempts(gate: GlbTextureGate, urls: { primary: string; original: string }): string[] {
  if (gate === "detecting") return [];
  if (gate === "fallback") return [urls.original];
  return urls.primary === urls.original ? [urls.primary] : [urls.primary, urls.original];
}

type IdleScope = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (id: never) => void;
};

/**
 * 浏览器空闲时再开始拉 GLB：效果图和页面先画出来，模型在后台下载，审稿员点到 3D 时多半已就绪。
 * timeout 保证忙页面也不会一直不拉；没有 requestIdleCallback（Safari）时退 setTimeout。返回取消函数。
 */
export function whenIdle(run: () => void, timeoutMs = 1500, scope: IdleScope = globalThis as unknown as IdleScope): () => void {
  if (typeof scope.requestIdleCallback === "function") {
    const id = scope.requestIdleCallback(run, { timeout: timeoutMs });
    return () => scope.cancelIdleCallback?.(id);
  }
  const id = scope.setTimeout(run, Math.min(200, timeoutMs));
  return () => scope.clearTimeout(id as never);
}

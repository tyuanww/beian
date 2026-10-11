/** Cloudflare 免费/Pro 橙云主机上传上限约 100MB。我们自己的 400 文案是 200MB，公网会先被 413 HTML 拦掉。 */
const PUBLIC_UPLOAD_MB = 100;
export const PUBLIC_UPLOAD_BYTES = PUBLIC_UPLOAD_MB * 1024 * 1024;
const MB = 1024 * 1024;

/** /api/auth/me 可选下发 upload_limit_bytes；是正数就取它和公网上限里小的那个，缺或不合法就用公网上限。 */
export function uploadLimitBytes(me?: { upload_limit_bytes?: number | null } | null): number {
  const v = Number(me?.upload_limit_bytes);
  return Number.isFinite(v) && v > 0 ? Math.min(v, PUBLIC_UPLOAD_BYTES) : PUBLIC_UPLOAD_BYTES;
}

let currentLimit = PUBLIC_UPLOAD_BYTES;
/** 登录信息到手后调用一次（App 里），之后预检和提示文案都按它。 */
export function setUploadLimitFromMe(me?: { upload_limit_bytes?: number | null } | null): void {
  currentLimit = uploadLimitBytes(me);
}
export function currentUploadLimitBytes(): number {
  return currentLimit;
}

/** 产品哥 2026-10-11 定稿；MB 数取自当前上限并向下取整，不写死。 */
export function uploadTooLargeText(limitBytes: number = currentLimit): string {
  return `文件太大，请压到 ${Math.floor(limitBytes / MB)}MB 以内再传（多份合计）`;
}
/** 公网默认上限（100MB）下的文案。 */
export const UPLOAD_TOO_LARGE = uploadTooLargeText(PUBLIC_UPLOAD_BYTES);

export function bytesTooLarge(...sizes: number[]): boolean {
  let total = 0;
  for (const n of sizes) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total > currentLimit;
}

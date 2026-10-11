/** Cloudflare 免费/Pro 橙云主机上传上限约 100MB。我们自己的 400 文案是 200MB，公网会先被 413 HTML 拦掉。 */
// 十进制 MB（Cloudflare 按 1e6 算），再给 multipart 边界/表单字段留 1MB 余量：99,000,000 字节。
const MB = 1000 * 1000;
export const PUBLIC_UPLOAD_BYTES = 100 * MB - 1 * MB;

/** /api/auth/me 可选下发 upload_limit_bytes；是正数就取它和公网上限里小的那个，缺或不合法就用公网上限。 */
export function uploadLimitBytes(me?: { upload_limit_bytes?: unknown } | null): number {
  const v = me?.upload_limit_bytes;
  // 只认真正的数字：字符串 "50000000"、NaN、Infinity、0、负数都当没给。
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, PUBLIC_UPLOAD_BYTES) : PUBLIC_UPLOAD_BYTES;
}

let currentLimit = PUBLIC_UPLOAD_BYTES;
/** 登录信息到手后调用一次（App 里），之后预检和提示文案都按它。 */
export function setUploadLimitFromMe(me?: { upload_limit_bytes?: unknown } | null): void {
  currentLimit = uploadLimitBytes(me);
}
export function currentUploadLimitBytes(): number {
  return currentLimit;
}

/** 产品哥 2026-10-11 定稿；MB 数 = floor(字节/1e6)，最小显示 1（不写 KB）。 */
export function uploadLimitMb(limitBytes: number = currentLimit): number {
  return Math.max(1, Math.floor(limitBytes / MB));
}
export function uploadTooLargeText(limitBytes: number = currentLimit): string {
  return `文件太大，请压到 ${uploadLimitMb(limitBytes)}MB 以内再传（多份合计）`;
}
/** 公网默认上限（99MB）下的文案。 */
export const UPLOAD_TOO_LARGE = uploadTooLargeText(PUBLIC_UPLOAD_BYTES);

export function bytesTooLarge(...sizes: number[]): boolean {
  let total = 0;
  for (const n of sizes) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total > currentLimit;
}

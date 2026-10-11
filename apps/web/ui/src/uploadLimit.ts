/** Cloudflare 免费/Pro 橙云主机上传上限约 100MB。我们自己的 400 文案是 200MB，公网会先被 413 HTML 拦掉。 */
const PUBLIC_UPLOAD_MB = 100;
export const PUBLIC_UPLOAD_BYTES = PUBLIC_UPLOAD_MB * 1024 * 1024;
/** 产品哥 2026-10-11 定稿；数字跟 PUBLIC_UPLOAD_MB 走，不写死。 */
export const UPLOAD_TOO_LARGE = `文件太大，请压到 ${PUBLIC_UPLOAD_MB}MB 以内再传（多份合计）`;

export function bytesTooLarge(...sizes: number[]): boolean {
  let total = 0;
  for (const n of sizes) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total > PUBLIC_UPLOAD_BYTES;
}

/**
 * 飞书登录回跳失败：标题只认服务端回跳 URL 里的 `feishu_error` 码，不认原因文案（文案可改，判断不能跟着变）。
 * 码由 `apps/web/server/src/index.ts` 的 `failLogin` 写入：回调带 error → denied，OAuth state 失效 → expired，
 * 其余异常经 `auth.ts` 的 `loginFailureCode` 分成 403 → forbidden、其它 → failed。
 * 显示的字在 `copy/labels.ts` 的 `LOGIN_FAILURE_COPY`。
 * 服务端码表在 `apps/web/server/src/feishuLoginError.ts`，与本文件 `FeishuErrorCode` 的一致性由 `loginFailure.contract.test.ts` 把关。
 */
import { LOGIN_FAILURE_COPY, LOGIN_FAILURE_UNKNOWN } from "./copy/labels";

export type FeishuErrorCode = "denied" | "expired" | "forbidden" | "failed";

function isFeishuErrorCode(raw: string): raw is FeishuErrorCode {
  // 只认自有 key：toString / __proto__ 之类原型上的名字不算码。
  return Object.prototype.hasOwnProperty.call(LOGIN_FAILURE_COPY, raw);
}

export function feishuErrorCode(raw: string | null | undefined): FeishuErrorCode | null {
  return raw && isFeishuErrorCode(raw) ? raw : null;
}

export type LoginFailure = { code: FeishuErrorCode | null; title: string; message: string };

/** `raw` 是 URL 里的 feishu_error，`hint` 是服务端写进 wb_login_hint 的原因（可空，只原样显示）。 */
export function loginFailure(raw: string | null | undefined, hint: string): LoginFailure {
  const code = feishuErrorCode(raw);
  const copy = code ? LOGIN_FAILURE_COPY[code] : LOGIN_FAILURE_UNKNOWN;
  return { code, title: copy.title, message: hint || copy.fallback };
}

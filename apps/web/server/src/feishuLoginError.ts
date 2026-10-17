/**
 * 飞书登录回跳失败时写进 `/?feishu_error=<码>` 的全部码（`index.ts` 的 `failLogin`、`auth.ts` 的 `loginFailureCode`）。
 * 前端 `apps/web/ui/src/loginFailure.ts` 按这几个码选失败页标题；两边是否一致由
 * `apps/web/ui/src/loginFailure.contract.test.ts` 对照。本文件不 import 任何东西，前端测试可以直接读。
 * 加码、改码要同时改前端 `FeishuErrorCode` 与 `copy/labels.ts` 的 `LOGIN_FAILURE_COPY`。
 */
export const FEISHU_LOGIN_ERROR_CODES = ["denied", "expired", "forbidden", "failed"] as const;

export type FeishuLoginErrorCode = (typeof FEISHU_LOGIN_ERROR_CODES)[number];

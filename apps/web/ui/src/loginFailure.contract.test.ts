import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FEISHU_LOGIN_ERROR_CODES, type FeishuLoginErrorCode } from "../../server/src/feishuLoginError.ts";
import { LOGIN_FAILURE_COPY } from "./copy/labels.js";
import { feishuErrorCode, type FeishuErrorCode } from "./loginFailure.js";

/**
 * 前后端合同：服务端 failLogin / loginFailureCode 会写进 `?feishu_error=` 的码，
 * 必须和前端 FeishuErrorCode / LOGIN_FAILURE_COPY 完全一致。服务端加码、删码或改名而前端没跟上，这里变红。
 */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// 类型层对照：两边联合不一致时 UI 的 tsc（npm run typecheck 里的 UI build）报错。
const sameUnion: SameUnion<FeishuErrorCode, FeishuLoginErrorCode> = true;

describe("feishu_error 码前后端合同", () => {
  it("服务端码表与前端文案表的码完全一致", () => {
    assert.equal(sameUnion, true);
    assert.deepEqual([...FEISHU_LOGIN_ERROR_CODES].sort(), Object.keys(LOGIN_FAILURE_COPY).sort());
  });

  it("服务端发出的每个码前端都认，不落到未知码兜底", () => {
    for (const code of FEISHU_LOGIN_ERROR_CODES) assert.equal(feishuErrorCode(code), code);
  });
});

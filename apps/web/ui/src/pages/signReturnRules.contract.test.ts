import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SIGN_RETURN_DISPUTED,
  SIGN_RETURN_RULES,
  type SignReturnExpect,
  type SignReturnInput,
} from "../../../server/src/signReturnRules.ts";
import type { TaskDetail } from "../api";
import { reviewPageHits, reviewSubmitButtons } from "./reviewActions";
import { lockedBy } from "./reviewFlat";

/**
 * 前后端合同：签字/退回规则表（服务端 `signReturnRules.ts`）逐行喂给核对页的真实按钮规则 `reviewSubmitButtons`。
 * 服务端那边同一张表由 `apps/web/server/src/signReturnRules.test.ts` 对 `/complete` 断言。
 * 页面上「按钮不在 / 正常单按钮在」的渲染对照在 `e2e/sign-return-rules.spec.ts`。
 */
const ME = "审核员";

function taskFor(input: SignReturnInput): TaskDetail {
  return {
    id: "e5969b58cd91",
    title: "规则表合成单",
    status: input.status,
    ...(input.job ? { job_kind: input.job.kind, job_status: input.job.status } : {}),
    ...(input.verbatimCheck ? { verbatim_check: true } : {}),
    ...(input.verbatimWarning ? { verbatim_warning: "稿件未保留 Illustrator 编辑数据" } : {}),
    ...(input.status === "completed" ? { completed_by: input.completedByOther ? "别人" : ME } : {}),
    hits: input.hits.map((hit, i) => ({
      id: `h${i}`,
      field: hit.field ?? "中文品名",
      status: hit.status,
      ...(hit.decision === undefined ? {} : { decision: hit.decision }),
    })),
  } as TaskDetail;
}

/** 核对页当前怎么摆两个按钮（不忙、没有未保存备注；角色核对页不看）。 */
function uiButtons(input: SignReturnInput): SignReturnExpect {
  const task = taskFor(input);
  const hits = reviewPageHits(task, false);
  const b = reviewSubmitButtons(task, hits, {
    locked: Boolean(lockedBy(task, ME)),
    orderHeldConfirm: input.orderHeldConfirm === true,
    busy: false,
    hasUnsavedNotes: false,
  });
  return { sign: { button: b.sign, submits: b.signSubmits }, ret: { button: b.reject, submits: b.rejectSubmits } };
}

describe("签字/退回规则表（前端核对页）", () => {
  it("表里有「按钮不在」的行，也有「正常单按钮在」的对照行", () => {
    assert.ok(SIGN_RETURN_RULES.some((row) => row.expect.sign.button === "hidden" && row.expect.ret.button === "hidden"));
    assert.ok(SIGN_RETURN_RULES.some((row) => row.expect.sign.button === "enabled"));
    assert.ok(SIGN_RETURN_RULES.some((row) => row.expect.ret.button === "enabled"));
  });

  for (const row of SIGN_RETURN_RULES) {
    it(`规则：${row.name}`, () => {
      assert.deepEqual(uiButtons(row.input), row.expect);
    });
  }

  for (const row of SIGN_RETURN_DISPUTED) {
    it(`待决（锁现状）：${row.name}`, () => {
      assert.deepEqual(uiButtons(row.input), row.ui, row.why);
    });
  }

  it("忙碌中或有未保存备注：本该可点的按钮变灰（前端临时状态，不进表）", () => {
    const task = taskFor(SIGN_RETURN_RULES[0].input);
    for (const opts of [{ busy: true, hasUnsavedNotes: false }, { busy: false, hasUnsavedNotes: true }]) {
      const b = reviewSubmitButtons(task, reviewPageHits(task, false), { locked: false, orderHeldConfirm: false, ...opts });
      assert.deepEqual([b.sign, b.signSubmits], ["disabled", false]);
    }
  });
});

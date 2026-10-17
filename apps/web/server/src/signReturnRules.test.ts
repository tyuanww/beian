import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIGN_RETURN_DISPUTED, SIGN_RETURN_RULES, signReturnHitExtras, type SignReturnInput } from "./signReturnRules.js";
import type { Task } from "./tasks.js";
import { makeTestTempDir } from "./testTemp.js";

// auth / tasks 读 DATA_DIR；只用纯函数，不落盘。
process.env.WB_DATA_DIR = makeTestTempDir("beian-sign-rules-");
const { hasPerm } = await import("./auth.js");
const { completeGate } = await import("./completeGate.js");

function taskFor(input: SignReturnInput): Task {
  return {
    id: "e5969b58cd90",
    title: "规则表合成单",
    status: input.status,
    ...(input.job ? { job_kind: input.job.kind, job_status: input.job.status } : {}),
    ...(input.verbatimCheck ? { verbatim_check: true } : {}),
    ...(input.verbatimWarning ? { verbatim_warning: "稿件未保留 Illustrator 编辑数据" } : {}),
    ...(input.status === "completed" ? { completed_by: input.completedByOther ? "别人" : "审核员" } : {}),
    hits: input.hits.map((hit, i) => ({
      id: `h${i}`,
      field: hit.field ?? "中文品名",
      status: hit.status,
      ...(hit.decision === undefined ? {} : { decision: hit.decision }),
      ...signReturnHitExtras(hit),
    })),
  } as Task;
}

/** 与 /complete 路由同序：先 need(c, "complete")，再 completeGate。签字带勾选，退回不带（同前端 completePayload）。 */
function serverAccepts(input: SignReturnInput): { sign: boolean; ret: boolean } {
  if (!hasPerm(input.role, "complete")) return { sign: false, ret: false };
  const task = taskFor(input);
  const sign = completeGate(task, input.orderHeldConfirm === true ? true : undefined);
  const ret = completeGate(task, undefined);
  return { sign: sign.ok && sign.kind === "signed", ret: ret.ok && ret.kind === "rework" };
}

/** 前端真会发的那次 /complete（签字带不带整单确认同表）被拒时的码；收下或 403（viewer）时为 undefined。 */
function serverCode(input: SignReturnInput): string | undefined {
  if (!hasPerm(input.role, "complete")) return undefined;
  const gate = completeGate(taskFor(input), input.orderHeldConfirm === true ? true : undefined);
  return gate.ok ? undefined : gate.code;
}

describe("签字/退回规则表（服务端 /complete）", () => {
  it("表本身自洽：名字不重复，能提交的按钮一定可点", () => {
    const names = [...SIGN_RETURN_RULES, ...SIGN_RETURN_DISPUTED].map((row) => row.name);
    assert.equal(new Set(names).size, names.length);
    for (const row of SIGN_RETURN_RULES) {
      for (const side of [row.expect.sign, row.expect.ret]) {
        if (side.submits) assert.equal(side.button, "enabled", row.name);
      }
      assert.ok(!(row.expect.sign.submits && row.expect.ret.submits), `${row.name}：同一张单不能既签字又退回`);
    }
  });

  for (const row of SIGN_RETURN_RULES) {
    it(`规则：${row.name}`, () => {
      assert.deepEqual(serverAccepts(row.input), { sign: row.expect.sign.submits, ret: row.expect.ret.submits });
    });
  }

  for (const row of SIGN_RETURN_RULES) {
    it(`码：${row.name}`, () => {
      assert.equal(serverCode(row.input), row.code, `${row.name} 的拒绝码`);
    });
  }

  it("拦截文案：只有认字存疑 / 只有待人工确认 / 两类都有，分开数、按首次出现排序，params.items 同序", () => {
    const gate = (hits: SignReturnInput["hits"]) => completeGate(taskFor({ role: "reviewer", status: "in_review", hits }), undefined);
    assert.deepEqual(gate([{ status: "一致", coverageMiss: ["CAPSULE MIST"] }]), {
      ok: false,
      status: 400,
      message: "仍有 1 条认字存疑未处理",
      code: "complete_hits_pending",
      params: { items: [{ kind: "reading_doubt", count: 1 }] },
    });
    assert.deepEqual(gate([{ status: "待人工确认" }, { status: "待人工确认", decision: "pending" }]), {
      ok: false,
      status: 400,
      message: "仍有 2 条待人工确认未处理",
      code: "complete_hits_pending",
      params: { items: [{ kind: "held", count: 2 }] },
    });
    assert.deepEqual(
      gate([{ status: "待人工确认" }, { status: "缺空格", onlyInExcel: ["香柠檬"] }, { status: "待人工确认" }]),
      {
        ok: false,
        status: 400,
        message: "仍有 2 条待人工确认、1 条认字存疑未处理",
        code: "complete_hits_pending",
        params: { items: [{ kind: "held", count: 2 }, { kind: "reading_doubt", count: 1 }] },
      },
    );
    assert.deepEqual(gate([{ status: "疑点", decision: "pending" }, { status: "缺失" }, { status: "疑点" }]), {
      ok: false,
      status: 400,
      message: "仍有 2 条疑点、1 条缺失未处理",
      code: "complete_hits_pending",
      params: {
        items: [
          { kind: "status", status: "suspect", count: 2 },
          { kind: "status", status: "field_missing", count: 1 },
        ],
      },
    });
  });

  it("其余拦截带 params：状态异常与整单确认给条数", () => {
    const invalid = completeGate(taskFor({ role: "reviewer", status: "in_review", hits: [{ status: "未知状态" }, { status: "看不清" }] }), undefined);
    assert.deepEqual(invalid, { ok: false, status: 400, message: "有 2 条审核数据状态异常，请重新对照", code: "complete_hits_invalid", params: { count: 2 } });
    const held = completeGate(
      taskFor({ role: "reviewer", status: "in_review", verbatimCheck: true, verbatimWarning: true, hits: [{ status: "待人工确认" }, { status: "待人工确认" }] }),
      undefined,
    );
    assert.deepEqual(held, { ok: false, status: 400, message: "整单待人工确认，签字即认可", code: "complete_order_held_unconfirmed", params: { count: 2 } });
  });

  for (const row of SIGN_RETURN_DISPUTED) {
    it(`待决（锁现状）：${row.name}`, () => {
      assert.deepEqual(serverAccepts(row.input), row.server, row.why);
      assert.notDeepEqual(row.server, { sign: row.ui.sign.submits, ret: row.ui.ret.submits }, "两边已一致，挪进 SIGN_RETURN_RULES");
    });
  }
});

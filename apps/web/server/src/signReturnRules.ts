/**
 * 签字 / 退回规则表：前后端共用。本文件不 import 任何东西，前端测试可以直接读（同 `feishuLoginError.ts`）。
 *
 * 每行是「输入 → 期望」。服务端 `signReturnRules.test.ts` 用 `hasPerm(role, "complete")` + `completeGate`
 * （`/complete` 的真实拦截）逐行断言；前端 `apps/web/ui/src/pages/signReturnRules.contract.test.ts` 用
 * `reviewSubmitButtons`（核对页两个按钮的真实规则）逐行断言，e2e `apps/web/ui/e2e/sign-return-rules.spec.ts`
 * 再按表渲染核对页看按钮在不在、能不能点。任意一边改了规则，对应那边的测试就挂。
 *
 * 期望的含义：
 * - `button`：前端核对页上的按钮。hidden = 不渲染（等待卡、失败单）；disabled = 在但灰；enabled = 可点。
 * - `submits`：按钮可点、确认框也不挡，真的会发 `/complete`；服务端这边 = `/complete` 收下并记成这种结论
 *   （签字 = `complete_kind: "signed"`，退回 = `"rework"`）。`submits` 为 true 时 `button` 必须是 enabled。
 * 只看规则本身：忙碌中、备注未保存这两个前端临时状态不进表（两者都只会让按钮变灰，服务端不知道）。
 *
 * `SIGN_RETURN_DISPUTED` 是目前前后端结论不一致的输入，不算规则，只把两边现状各自锁住，等产品定了再挪进主表。
 */

type SignReturnButton = "hidden" | "disabled" | "enabled";
export type SignReturnSide = { button: SignReturnButton; submits: boolean };
export type SignReturnExpect = { sign: SignReturnSide; ret: SignReturnSide };

type SignReturnHit = {
  status: string;
  /** 不写 = 落盘里没有 decision 字段。 */
  decision?: string;
  /** 不写 = 「中文品名」。 */
  field?: string;
};

export type SignReturnInput = {
  role: "admin" | "reviewer" | "viewer";
  status: "comparing" | "compare_failed" | "pending_review" | "in_review" | "completed";
  /** 不写 = 没有作业字段（老单）。 */
  job?: { kind: "compare" | "rework"; status: "queued" | "running" | "failed" | "succeeded" };
  verbatimCheck?: boolean;
  verbatimWarning?: boolean;
  /** 页头「整单待人工确认，签字即认可」勾上了；服务端 = 签字请求带 `order_held_confirm: true`。 */
  orderHeldConfirm?: boolean;
  /** 已完成单是别人签的（前端锁页）；不写 = 自己。 */
  completedByOther?: boolean;
  hits: SignReturnHit[];
};

export type SignReturnRule = { name: string; input: SignReturnInput; expect: SignReturnExpect };

export type SignReturnDisputed = {
  name: string;
  input: SignReturnInput;
  /** 前端现状。 */
  ui: SignReturnExpect;
  /** 服务端现状：`/complete` 收不收这种结论。 */
  server: { sign: boolean; ret: boolean };
  why: string;
};

const HIDDEN: SignReturnSide = { button: "hidden", submits: false };
const GREY: SignReturnSide = { button: "disabled", submits: false };
const GO: SignReturnSide = { button: "enabled", submits: true };
/** 按钮可点，确认框挡住（还有待确认，老板 2026-10-11 批：签字灰时退回不灰）。 */
const DIALOG_BLOCKS: SignReturnSide = { button: "enabled", submits: false };

const SIGN_ONLY: SignReturnExpect = { sign: GO, ret: GREY };
const RETURN_ONLY: SignReturnExpect = { sign: GREY, ret: GO };
const PENDING: SignReturnExpect = { sign: GREY, ret: DIALOG_BLOCKS };
const BOTH_GREY: SignReturnExpect = { sign: GREY, ret: GREY };
const BOTH_HIDDEN: SignReturnExpect = { sign: HIDDEN, ret: HIDDEN };

const reviewer = (hits: SignReturnHit[], extra: Partial<SignReturnInput> = {}): SignReturnInput => ({
  role: "reviewer",
  status: "in_review",
  hits,
  ...extra,
});
const verbatim = (hits: SignReturnHit[], extra: Partial<SignReturnInput> = {}): SignReturnInput =>
  reviewer(hits, { verbatimCheck: true, verbatimWarning: true, ...extra });

export const SIGN_RETURN_RULES: readonly SignReturnRule[] = [
  // —— 结论 ——
  { name: "正常单零疑点：可签字，退回灰", input: reviewer([]), expect: SIGN_ONLY },
  { name: "pending_review 与 in_review 同规则", input: reviewer([], { status: "pending_review" }), expect: SIGN_ONLY },
  { name: "管理员同审核员", input: reviewer([], { role: "admin" }), expect: SIGN_ONLY },
  { name: "疑点标一致：可签字", input: reviewer([{ status: "疑点", decision: "confirm" }]), expect: SIGN_ONLY },
  { name: "疑点标忽略：可签字", input: reviewer([{ status: "疑点", decision: "ignore" }]), expect: SIGN_ONLY },
  { name: "疑点标有错：只能退回", input: reviewer([{ status: "疑点", decision: "issue" }]), expect: RETURN_ONLY },
  {
    name: "有错和一致混着：只能退回",
    input: reviewer([{ status: "错字", decision: "issue" }, { status: "疑点", decision: "confirm" }, { status: "一致" }]),
    expect: RETURN_ONLY,
  },
  // —— 待确认 ——
  { name: "疑点没下结论：签字灰，退回框挡住", input: reviewer([{ status: "疑点", decision: "pending" }]), expect: PENDING },
  { name: "缺失没有 decision 字段也算待确认", input: reviewer([{ status: "缺失" }]), expect: PENDING },
  {
    name: "已有一条有错、另一条还没下结论：退回也提交不了",
    input: reviewer([{ status: "疑点", decision: "issue" }, { status: "缺失", decision: "pending" }]),
    expect: PENDING,
  },
  { name: "多空格标 pending 算待确认", input: reviewer([{ status: "多空格", decision: "pending" }]), expect: PENDING },
  { name: "多空格没有 decision 字段不算待确认", input: reviewer([{ status: "多空格" }]), expect: SIGN_ONLY },
  { name: "decision 是非法值：按待确认挡住", input: reviewer([{ status: "疑点", decision: "maybe" }]), expect: PENDING },
  // —— 确认单底部工艺表 ——
  {
    name: "工艺说明的疑点不挡签字",
    input: reviewer([{ field: "工艺说明", status: "疑点", decision: "pending" }]),
    expect: SIGN_ONLY,
  },
  {
    name: "备案版本号不当工艺表跳过：标有错照样退回",
    input: reviewer([{ field: "备案版本号", status: "疑点", decision: "issue" }]),
    expect: RETURN_ONLY,
  },
  // —— 已完成 ——
  {
    name: "自己已签字：两个按钮都灰",
    input: reviewer([{ status: "疑点", decision: "confirm" }], { status: "completed" }),
    expect: BOTH_GREY,
  },
  {
    name: "别人已退回（锁页）：两个按钮都灰",
    input: reviewer([{ status: "疑点", decision: "issue" }], { status: "completed", completedByOther: true }),
    expect: BOTH_GREY,
  },
  // —— 作业 ——
  { name: "对照排队中：等待卡，没有按钮", input: reviewer([], { status: "comparing", job: { kind: "compare", status: "queued" } }), expect: BOTH_HIDDEN },
  { name: "对照进行中：等待卡，没有按钮", input: reviewer([], { status: "comparing", job: { kind: "compare", status: "running" } }), expect: BOTH_HIDDEN },
  {
    name: "对红进行中：等待卡，没有按钮",
    input: reviewer([{ status: "疑点", decision: "confirm" }], { status: "comparing", job: { kind: "rework", status: "running" } }),
    expect: BOTH_HIDDEN,
  },
  { name: "对照失败没有条目：没有按钮", input: reviewer([], { status: "compare_failed", job: { kind: "compare", status: "failed" } }), expect: BOTH_HIDDEN },
  {
    name: "对照失败带上一轮条目：没有按钮",
    input: reviewer([{ status: "疑点", decision: "issue" }], { status: "compare_failed", job: { kind: "compare", status: "failed" } }),
    expect: BOTH_HIDDEN,
  },
  {
    name: "已完成单对红失败回到已完成：没有按钮",
    input: reviewer([{ status: "疑点", decision: "confirm" }], { status: "completed", job: { kind: "rework", status: "failed" } }),
    expect: BOTH_HIDDEN,
  },
  {
    name: "对红成功后待审：照常签字",
    input: reviewer([{ status: "疑点", decision: "confirm" }], { job: { kind: "rework", status: "succeeded" } }),
    expect: SIGN_ONLY,
  },
  // —— 逐字单「待人工确认」与整单勾选 ——
  {
    name: "逐字单没有 warning：未决待人工确认不挡签字",
    input: verbatim([{ status: "待人工确认" }], { verbatimWarning: false }),
    expect: SIGN_ONLY,
  },
  { name: "逐字单有 warning、未决待人工确认、没勾整单确认：签字灰", input: verbatim([{ status: "待人工确认" }]), expect: BOTH_GREY },
  {
    name: "逐字单有 warning、未决待人工确认、勾了整单确认：可签字",
    input: verbatim([{ status: "待人工确认" }], { orderHeldConfirm: true }),
    expect: SIGN_ONLY,
  },
  {
    name: "整单确认只管签字：有一条有错时不勾也能退回",
    input: verbatim([{ status: "待人工确认" }, { status: "错字", decision: "issue" }]),
    expect: RETURN_ONLY,
  },
  { name: "待人工确认已标忽略：不再要整单确认", input: verbatim([{ status: "待人工确认", decision: "ignore" }]), expect: SIGN_ONLY },
  { name: "待人工确认标有错：只能退回", input: verbatim([{ status: "待人工确认", decision: "issue" }]), expect: RETURN_ONLY },
  {
    name: "只有 warning 不是逐字单：不要整单确认",
    input: reviewer([{ status: "疑点", decision: "confirm" }], { verbatimWarning: true }),
    expect: SIGN_ONLY,
  },
];

export const SIGN_RETURN_DISPUTED: readonly SignReturnDisputed[] = [
  {
    name: "复核（对红）失败、单子回到待审且带上一轮条目",
    input: reviewer([{ status: "疑点", decision: "confirm" }], { status: "pending_review", job: { kind: "rework", status: "failed" } }),
    ui: BOTH_HIDDEN,
    server: { sign: true, ret: false },
    why: "前端失败单一律不给按钮（审稿合同「失败单在核对页上的显示」）；服务端 /complete 不看 job_status=failed，照收签字。",
  },
  {
    name: "非逐字单出现未决「待人工确认」",
    input: reviewer([{ status: "待人工确认" }]),
    ui: PENDING,
    server: { sign: true, ret: false },
    why: "前端只在 verbatim_check 单上放开待人工确认，其他单把它算进待确认；服务端 hitNeedsDecision 对待人工确认一律不要结论。",
  },
  {
    name: "只读账号（viewer）打开正常单",
    input: reviewer([], { role: "viewer" }),
    ui: SIGN_ONLY,
    server: { sign: false, ret: false },
    why: "核对页不看权限，按钮照常可点；服务端 need(c, \"complete\") 回 403。",
  },
  {
    name: "条目状态不在已知集合",
    input: reviewer([{ status: "未知状态" }]),
    ui: SIGN_ONLY,
    server: { sign: false, ret: false },
    why: "前端把认不出的状态当一致；服务端 isValidHitReviewState 回 400「审核数据状态异常」。",
  },
];

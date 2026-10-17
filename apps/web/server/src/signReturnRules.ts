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
 * 产品口径（2026-10-17）：该拦的两边都拦，服务端必须能独立拦住。
 * 第 3、4 条（viewer / 未知状态）由前端对齐服务端；第 2 条与「认字存疑」由服务端对齐前端
 * （`completeGate` / `hitNeedsDecision` → `readingDoubt.ts` 的 `hasReadingDoubt`），已进主表。
 * 第 1 条（复核失败带上一轮条目）待老板定，两边各保持现状，锁在 `SIGN_RETURN_DISPUTED`。
 * `SIGN_RETURN_DISPUTED` 只放前后端结论仍不一致的输入；表测试会拦住「其实已一致」的行。
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
  /** 认字存疑的结构化字段（见 `readingDoubt.ts`），落盘为 `coverage.miss`。 */
  coverageMiss?: string[];
  /** 落盘为 `sequence_diff.only_in_excel`。 */
  onlyInExcel?: string[];
  /** 落盘为 `doubt_bucket`。 */
  doubtBucket?: string;
};

/** 表里一条 hit 的认字存疑字段 → 落盘字段。服务端测试、前端合同测试和 e2e 共用，保证三边喂的是同一份数据。 */
export function signReturnHitExtras(hit: SignReturnHit): Record<string, unknown> {
  return {
    ...(hit.coverageMiss ? { coverage: { miss: hit.coverageMiss } } : {}),
    ...(hit.onlyInExcel ? { sequence_diff: { only_in_excel: hit.onlyInExcel } } : {}),
    ...(hit.doubtBucket ? { doubt_bucket: hit.doubtBucket } : {}),
  };
}

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
  // —— 产品已定（前端对齐服务端）：viewer / 未知状态 ——
  {
    name: "只读账号（viewer）打开正常单：隐藏签字和退回",
    input: reviewer([], { role: "viewer" }),
    expect: BOTH_HIDDEN,
  },
  {
    name: "条目状态不在已知集合：两个按钮都灰，提示审核数据状态异常",
    input: reviewer([{ status: "未知状态" }]),
    expect: BOTH_GREY,
  },
  // —— 认字存疑（结构化字段，`readingDoubt.ts`）：两边已一致的行 ——
  { name: "认字存疑：coverage.miss 全是空白不算存疑", input: reviewer([{ status: "一致", coverageMiss: ["", "  "] }]), expect: SIGN_ONLY },
  {
    name: "认字存疑：一致条目只有 sequence_diff 不算存疑（未标记条目不看）",
    input: reviewer([{ status: "一致", onlyInExcel: ["香柠檬"] }]),
    expect: SIGN_ONLY,
  },
  {
    name: "认字存疑：一致条目只有 doubt_bucket 不算存疑（未标记条目不看）",
    input: reviewer([{ status: "一致", doubtBucket: "ocr_smallprint" }]),
    expect: SIGN_ONLY,
  },
  {
    name: "认字存疑：一致条目 miss 有词，已标一致，可签字",
    input: reviewer([{ status: "一致", coverageMiss: ["CAPSULE MIST"], decision: "confirm" }]),
    expect: SIGN_ONLY,
  },
  {
    name: "认字存疑：一致条目 miss 有词，已标忽略，可签字",
    input: reviewer([{ status: "一致", coverageMiss: ["CAPSULE MIST"], decision: "ignore" }]),
    expect: SIGN_ONLY,
  },
  {
    name: "认字存疑：标有错只能退回",
    input: reviewer([{ status: "一致", coverageMiss: ["CAPSULE MIST"], decision: "issue" }]),
    expect: RETURN_ONLY,
  },
  { name: "缺空格没有 decision、也没有存疑字段：不算待确认", input: reviewer([{ status: "缺空格" }]), expect: SIGN_ONLY },
  // —— 产品已定（服务端对齐前端）：非逐字单待人工确认 / 认字存疑 ——
  {
    name: "非逐字单出现未决「待人工确认」：算待确认",
    input: reviewer([{ status: "待人工确认" }]),
    expect: PENDING,
  },
  {
    name: "非逐字单「待人工确认」已标忽略：可签字",
    input: reviewer([{ status: "待人工确认", decision: "ignore" }]),
    expect: SIGN_ONLY,
  },
  {
    name: "认字存疑：一致条目 coverage.miss 有词、没下结论",
    input: reviewer([{ status: "一致", coverageMiss: ["CAPSULE MIST"] }]),
    expect: PENDING,
  },
  {
    name: "认字存疑：一致条目 coverage.miss 有词、decision 为 pending",
    input: reviewer([{ status: "一致", coverageMiss: ["CAPSULE MIST"], decision: "pending" }]),
    expect: PENDING,
  },
  {
    name: "认字存疑：缺空格（已标记）带 sequence_diff、没下结论",
    input: reviewer([{ status: "缺空格", onlyInExcel: ["香柠檬"] }]),
    expect: PENDING,
  },
  {
    name: "认字存疑：缺空格（已标记）带 doubt_bucket、没下结论",
    input: reviewer([{ status: "缺空格", doubtBucket: "ocr_graphic" }]),
    expect: PENDING,
  },
  {
    name: "认字存疑：coverage.miss 只有核算说明（score=…）也算存疑，两边都不再滤文字",
    input: reviewer([{ status: "一致", coverageMiss: ["score=0.42 覆盖偏低"] }]),
    expect: PENDING,
  },
];

const REWORK_FAILED_WHY =
  "待老板定，8/20 设计 review-job-module.md 为对红失败仍可签字。前端失败单一律不给按钮；服务端 /complete 不看 job_status=failed，照 main 按条目收签字/退回。";

export const SIGN_RETURN_DISPUTED: readonly SignReturnDisputed[] = [
  {
    name: "复核（对红）失败、单子回到待审且带上一轮条目（无有错）",
    input: reviewer([{ status: "疑点", decision: "confirm" }], { status: "pending_review", job: { kind: "rework", status: "failed" } }),
    ui: BOTH_HIDDEN,
    server: { sign: true, ret: false },
    why: REWORK_FAILED_WHY,
  },
  {
    name: "复核（对红）失败、单子回到待审且带上一轮有错条目",
    input: reviewer([{ status: "疑点", decision: "issue" }], { status: "in_review", job: { kind: "rework", status: "failed" } }),
    ui: BOTH_HIDDEN,
    server: { sign: false, ret: true },
    why: REWORK_FAILED_WHY,
  },
];

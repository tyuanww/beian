/**
 * 审稿接口的机读码表：前后端共用。本文件不 import 任何东西（同 `readingDoubt.ts`、`signReturnRules.ts`），
 * 前端直接 import 码常量和中文对照，不手抄字符串。
 *
 * 命名规则（加码设计稿 §2.1，B04 照套）：
 * - 小写 ASCII + 下划线，≤ 40 字符（`^[a-z][a-z0-9_]*$`），前端 `lint:error-text` 的码字面量豁免直接放过；
 * - 接口返回体码：`<接口域>_<对象>_<情形>`，接口域取 `complete` / `decision` / `rework`（B04 再加 `page_view`）；
 * - 任务字段码（`job_error_code`）只写情形，不带接口域，只出现在 `job_error_code`，不出现在返回体 `code`；
 * - 一个码只对一种触发条件；同一句原文可以对多个码；码只增不改名，停用的码留表标停用、不复用。
 *
 * 返回体形状：`{ detail, code, params? }`。`detail` 是中文原文（与加码前逐字相同），前端按 `code` 分支，
 * 拼文案要的数据放 `params`，不做文本匹配。
 */

/** `/complete`（签字 / 退回同一入口）被拒时的码。 */
const COMPLETE_CODES = [
  "complete_job_running",
  "complete_status_not_reviewable",
  "complete_rework_failed",
  "complete_hits_invalid",
  "complete_hits_pending",
  "complete_order_held_unconfirmed",
  "complete_conclusion_missing",
] as const;
export type CompleteCode = (typeof COMPLETE_CODES)[number];

/** `/decision` 被拒时的码。 */
const DECISION_CODES = [
  "decision_status_not_reviewable",
  "decision_value_invalid",
  "decision_hit_not_found",
  "decision_held_confirm_forbidden",
] as const;
type DecisionCode = (typeof DECISION_CODES)[number];

/** `/rework` 被拒时的码。 */
const REWORK_CODES = [
  "rework_job_running",
  "rework_status_not_allowed",
  "rework_pdf_missing",
  "rework_pdf_invalid",
  "rework_pdf_too_large",
  "rework_verbatim_not_ready",
] as const;
type ReworkCode = (typeof REWORK_CODES)[number];

export type ReviewCode = CompleteCode | DecisionCode | ReworkCode;
export const REVIEW_CODES: readonly ReviewCode[] = [...COMPLETE_CODES, ...DECISION_CODES, ...REWORK_CODES];

/** 每个码固定的 HTTP 状态（加码不改任何状态码）。 */
export const REVIEW_CODE_STATUS: Readonly<Record<ReviewCode, 400 | 404 | 409>> = {
  complete_job_running: 409,
  complete_status_not_reviewable: 400,
  complete_rework_failed: 400,
  complete_hits_invalid: 400,
  complete_hits_pending: 400,
  complete_order_held_unconfirmed: 400,
  complete_conclusion_missing: 400,
  decision_status_not_reviewable: 400,
  decision_value_invalid: 400,
  decision_hit_not_found: 404,
  decision_held_confirm_forbidden: 400,
  rework_job_running: 409,
  rework_status_not_allowed: 400,
  rework_pdf_missing: 400,
  rework_pdf_invalid: 400,
  rework_pdf_too_large: 400,
  rework_verbatim_not_ready: 400,
};

/**
 * 每个码的中文原文。函数 = 原文要用 `params` 拼；`null` = 原文由调用处给（沿用现有的动态原文：
 * 单文件超限的 `oversizeMessage()`、逐字依赖探测的返回句），码表只登记码。
 */
export const REVIEW_CODE_TEXT: Readonly<Record<ReviewCode, string | ((params: ReviewParams) => string) | null>> = {
  complete_job_running: "对照还在排队或正在跑，不能签字",
  complete_status_not_reviewable: "当前状态不可签字",
  complete_rework_failed: "当前状态不可签字",
  complete_hits_invalid: (p) => `有 ${p.count ?? 0} 条审核数据状态异常，请重新对照`,
  complete_hits_pending: (p) => pendingDetail(p.items ?? []),
  complete_order_held_unconfirmed: "整单待人工确认，签字即认可",
  complete_conclusion_missing: "请写下结论",
  decision_status_not_reviewable: "当前状态不可审核",
  decision_value_invalid: "非法审核结论",
  decision_hit_not_found: "字段不存在",
  decision_held_confirm_forbidden: "待人工确认不能选一致",
  rework_job_running: "对红还在排队或正在跑",
  rework_status_not_allowed: "当前状态不可对红",
  rework_pdf_missing: "需要改稿后的 PDF",
  rework_pdf_invalid: "不是有效的 PDF",
  rework_pdf_too_large: null,
  rework_verbatim_not_ready: null,
};

/**
 * 条目状态的英文枚举（加码 Q8：英文枚举，中文只用于显示）。只收需要下结论时会出现在
 * 「仍有 N 条…未处理」里的状态：真错 ∪ {疑点、缺失} ∪ 空格类；`reviewCodes.test.ts` 防漂移。
 * 落盘的 `hit.status` 仍是中文，不改。
 */
export const HIT_STATUS_CODES = {
  suspect: "疑点",
  field_missing: "缺失",
  wrong_char: "错字",
  missing_char: "漏字",
  extra_char: "多字",
  extra_space: "多空格",
  missing_space: "缺空格",
  artwork_only: "稿件有但确认单没有",
} as const;
export type HitStatusCode = keyof typeof HIT_STATUS_CODES;

/** 中文状态 → 英文枚举；不在表里返回 undefined。 */
export function hitStatusCode(status: string): HitStatusCode | undefined {
  for (const [code, zh] of Object.entries(HIT_STATUS_CODES)) if (zh === status) return code as HitStatusCode;
  return undefined;
}

/**
 * `complete_hits_pending.params.items` 的一项，顺序同原文（按首次出现）：
 * - `status`：按状态要结论，`status` 为英文枚举；
 * - `reading_doubt`：只因认字存疑要结论（原文「认字存疑」）；
 * - `held`：非逐字单的未决「待人工确认」。
 */
export type PendingItem =
  | { kind: "status"; status: HitStatusCode; count: number }
  | { kind: "reading_doubt"; count: number }
  | { kind: "held"; count: number };

export type ReviewParams = { count?: number; items?: PendingItem[] };

function pendingItemWord(item: PendingItem): string {
  if (item.kind === "status") return HIT_STATUS_CODES[item.status];
  return item.kind === "reading_doubt" ? "认字存疑" : "待人工确认";
}

/** 「仍有 2 条待人工确认、1 条认字存疑未处理」。 */
export function pendingDetail(items: readonly PendingItem[]): string {
  return `仍有 ${items.map((item) => `${item.count} 条${pendingItemWord(item)}`).join("、")}未处理`;
}

/** 码 + params → 中文原文；原文由调用处给的码返回 null。 */
export function reviewDetail(code: ReviewCode, params: ReviewParams = {}): string | null {
  const text = REVIEW_CODE_TEXT[code];
  return typeof text === "function" ? text(params) : text;
}

/**
 * 任务字段 `job_error_code`（作业失败写在任务上）。`job_error` 原文照旧，前端只按码选句：
 * - `page_over`：逐字稿超页（原文只存前半句「稿件超过 1 页」，后半句前端按有没有重新上传按钮拼）；
 * - `ocr_failed`：认字没出结果（模型缺失 / 模型校验失败 / 版权声明缺失 / 依赖缺失 / 内存超限 / 百度 OCR 未配置）；
 * - `result_truncated`：结果超过输出上限，没写完；
 * - `private_data_failed`：稿件里的 Illustrator 私有数据读不出来（解压超限、解析失败）。
 */
export const JOB_ERROR_CODES = ["page_over", "ocr_failed", "result_truncated", "private_data_failed"] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

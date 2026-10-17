/**
 * 每条 hit 的结构化文案投影 `hit_text`（加码 §5，Q5 已答：服务端现算，字段名 `hit_text`）。
 * 本文件不 import 任何东西，前端可直接 import 类型和函数（同 `readingDoubt.ts`）。
 *
 * 只在返回给客户端时算（`publicTask`），不落盘；入参是已经过 `legacyCopy.ts` 旧句替换的 hit。
 * 「核算说明」（后端写进 evidence / coverage.miss 的 score、覆盖率等机器记账句）的识别从前端
 * `hitText.ts` 的 `isAccountingCopy` 挪到这里一处，规则逐字照搬，不改任何显示行为。
 * 二期由 Python 直接标结构化字段后，这里遇到新字段直接用，老单才走识别。
 */

export type HitTextProjection = {
  v: 1;
  /** coverage.miss 去掉空白和核算说明后的人话漏读词（= 前端 humanMissLines）。 */
  miss: string[];
  /** 核算说明：从 coverage.miss / evidence 里拆出来，只给「查看全部」之类的地方用。 */
  accounting: string[];
  /** evidence 是人话时给原文（已过旧句替换，未做前端 customerCopy）；空或是核算说明时为 null。 */
  evidence: string | null;
  /** pdf / found，否则 coverage.hit 用空格拼；什么都没有为 null（前端显示「没读到」）。 */
  observed: string | null;
  /** 有定位框：bboxes 或 qrcode_boxes 非空；两者都明确是空数组才算没定位（同前端 hitIsLocated）。 */
  located: boolean;
};

type HitLike = {
  pdf?: unknown;
  found?: unknown;
  evidence?: unknown;
  bboxes?: unknown;
  qrcode_boxes?: unknown;
  coverage?: { hit?: unknown; miss?: unknown } | null;
};

const ACCOUNTING_RE = /score\s*=|覆盖偏低|稿上命中\s*\d+\s*\/\s*\d+|best score|未见缺失/i;

/** 后端 OCR 核对的记账句（不是报错文案）。规则同前端原 `isAccountingCopy`。 */
export function isAccountingCopy(text: string): boolean {
  return ACCOUNTING_RE.test(text);
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((s) => String(s ?? "").trim()).filter(Boolean) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function hitTextOf(hit: HitLike): HitTextProjection {
  const missAll = textList(hit.coverage?.miss);
  const evidence = str(hit.evidence);
  const evidenceIsAccounting = Boolean(evidence) && isAccountingCopy(evidence);
  const direct = str(hit.pdf) || str(hit.found);
  const covHit = textList(hit.coverage?.hit);
  const boxes = Array.isArray(hit.bboxes) ? hit.bboxes.length : -1;
  const qr = Array.isArray(hit.qrcode_boxes) ? hit.qrcode_boxes.length : 0;
  return {
    v: 1,
    miss: missAll.filter((s) => !isAccountingCopy(s)),
    accounting: [...missAll.filter(isAccountingCopy), ...(evidenceIsAccounting ? [evidence] : [])],
    evidence: evidence && !evidenceIsAccounting ? evidence : null,
    observed: direct || (covHit.length ? covHit.join(" ") : null),
    located: !(boxes === 0 && qr === 0),
  };
}

/** 给 hits 数组每条加 `hit_text`，不改入参。非对象元素原样保留。 */
export function withHitText<T>(hits: T): T {
  if (!Array.isArray(hits)) return hits;
  return hits.map((hit) => (hit && typeof hit === "object" ? { ...hit, hit_text: hitTextOf(hit as HitLike) } : hit)) as T;
}

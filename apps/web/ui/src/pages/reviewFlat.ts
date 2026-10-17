/**
 * A 通铺核对页（老板 2026-10-11 批准，deviations.md 第 3/3b/6/7/10/11/16/27/28/32–35b 行）的纯逻辑。
 * 只读现有接口字段；需要后端补的数据在这里写清回退，不编造接口。
 */
import type { Decision, FieldHit, TaskDetail, TaskPage } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import { isPendingDecision } from "./reviewNav";
import { hasReadingDoubt } from "../../../server/src/readingDoubt.ts";
import { blockingStatusWord, hasInvalidHitStatus, invalidReviewStateCount, partitionReviewHits } from "./reviewEvidence";
import { bytesTooLarge, uploadTooLargeText } from "../uploadLimit";

export const FLAT_PANEL_WIDTH = 320;
export const FLAT_THUMB_WIDTH = 52;
const FLAT_WIDE_MIN = 1440;
const FLAT_PHONE_MAX = 720;

export type FlatLayout = "wide" | "overlay" | "phone";

/** ≥1440 三栏常驻；720–1439 右栏默认收起、展开为 320 浮层；<720 手机只看稿 + 签字/退回。 */
export function flatLayout(viewportWidth: number): FlatLayout {
  if (viewportWidth < FLAT_PHONE_MAX) return "phone";
  if (viewportWidth < FLAT_WIDE_MIN) return "overlay";
  return "wide";
}

export type VerdictCounts = { pending: number; issue: number; total: number };

/** 只数需要人下结论的疑点；与服务端 hitNeedsDecision 同口径（一致项不算）。 */
export function verdictCounts(hits: FieldHit[]): VerdictCounts {
  const { issues } = partitionReviewHits(hits);
  return {
    pending: issues.filter(({ hit }) => isPendingDecision(hit.decision)).length,
    issue: hits.filter((hit) => hit.decision === "issue").length,
    total: issues.length,
  };
}

export type SubmitGate = {
  canSign: boolean;
  canReject: boolean;
  /** 签字左侧的说明；为空时不显示。 */
  hint: string;
  /** 签字按钮的悬停说明。 */
  title: string;
  /** 退回按钮的悬停说明。待确认没下完时不复用签字那句。 */
  rejectTitle: string;
  /** 和确认框用同一个数。逐字单的待人工确认不计入。 */
  pending: number;
};

/**
 * 服务端 /complete 只有一个入口：有「有错」→ 已退回，没有 → 已签字，且都要求没有待确认。
 * 所以签字要「无待确认且无有错」，退回要「无待确认且至少一条有错」。
 */
export function isOpenHeld(hit: FieldHit): boolean {
  return hit.status === "待人工确认" && hit.decision !== "confirm" && hit.decision !== "issue" && hit.decision !== "ignore";
}

/** 待确认刚清完、还留着待人工确认时展开那一组。已经是 0 时不再打开，避免盖住人手动收起。 */
export function openHeldAfterPending(previousPending: number, pending: number, held: number): boolean {
  return previousPending > 0 && pending === 0 && held > 0;
}

/** 一条待确认在拦截文案里填的词：按状态要结论的写状态，只因认字存疑要结论的写「认字存疑」，其余写原状态。 */
function pendingWordFor(hit: FieldHit): string {
  return blockingStatusWord(hit) ?? (hasReadingDoubt(hit) ? REVIEW_COPY.readingDoubtWord : String(hit.status || "未决"));
}

/**
 * 待确认按词分开数，词序按条目首次出现（与服务端 `completeGate` 同序）。条目口径与 `submitGate` 的 pending 相同：
 * 没下结论的疑点（`partitionReviewHits` 的 issues，同 `verdictCounts`），加上非逐字单（`releaseHeld` 为 false）未决的「待人工确认」。
 */
export function pendingTally(hits: FieldHit[], releaseHeld = false): Array<{ word: string; count: number }> {
  const open = new Set(partitionReviewHits(hits).issues.filter(({ hit }) => isPendingDecision(hit.decision)).map(({ index }) => index));
  const counts = new Map<string, number>();
  hits.forEach((hit, index) => {
    const word = isOpenHeld(hit) ? (releaseHeld ? null : "待人工确认") : open.has(index) ? pendingWordFor(hit) : null;
    if (word !== null) counts.set(word, (counts.get(word) ?? 0) + 1);
  });
  return [...counts].map(([word, count]) => ({ word, count }));
}

export function submitGate(hits: FieldHit[], reviewable: boolean, locked = false, releaseHeld = false): SubmitGate {
  const c = verdictCounts(hits);
  const held = hits.filter(isOpenHeld).length;
  const pending = c.pending + (releaseHeld ? 0 : held);
  if (!reviewable || locked) return { canSign: false, canReject: false, hint: "", title: "", rejectTitle: "", pending };
  // 与服务端 completeGate 同序：先拦未知状态，再看待确认。
  // 状态异常：右上留短句，页头和悬停用服务端原话「有 N 条审核数据状态异常，请重新对照」。
  const invalid = invalidReviewStateCount(hits);
  const invalidDetail = REVIEW_COPY.invalidHitStatusDetail(invalid);
  if (hasInvalidHitStatus(hits)) {
    return { canSign: false, canReject: false, hint: REVIEW_COPY.invalidHitStatus, title: invalidDetail, rejectTitle: invalidDetail, pending };
  }
  // 只有 decision 非法（状态都认得）：按钮照规则表仍按待确认摆（签字灰、退回可点、确认框挡），文案用服务端原话。
  if (pending > 0 && invalid > 0) {
    return { canSign: false, canReject: true, hint: REVIEW_COPY.invalidHitStatus, title: invalidDetail, rejectTitle: invalidDetail, pending };
  }
  if (pending > 0) {
    const msg = REVIEW_COPY.pendingUnresolved(pendingTally(hits, releaseHeld));
    return {
      canSign: false,
      // 老板 2026-10-11 已批：签字禁用时退回不禁用。服务端 /complete 仍要求先下完结论，
      // 确认框里「确认退回」会挡住。退回按钮的悬停用同一句，不写「才能签字」。
      canReject: true,
      // 签字旁提示和悬停与服务端 /complete 拦截同一句：按状态分开数。
      hint: msg,
      title: msg,
      rejectTitle: REVIEW_COPY.rejectBlockedByPending(pending),
      pending,
    };
  }
  if (c.issue > 0) return { canSign: false, canReject: true, hint: "", title: REVIEW_COPY.signBlockedByIssue(c.issue), rejectTitle: "", pending: 0 };
  return { canSign: true, canReject: false, hint: "", title: "", rejectTitle: "", pending: 0 };
}

type ThumbState = "err" | "done" | "new";
export type ThumbMark = { index: number; page: number; state: ThumbState; symbol: string; word: string; label: string };

/** 缩略图条状态：✗N 有错 / ✓ 看完 / • 未看；符号 + 文字，不只靠颜色。 */
export function thumbMarks(pages: TaskPage[], hits: FieldHit[], seen: ReadonlySet<number>): ThumbMark[] {
  return pages.map((p, index) => {
    const page = Number(p.page || index + 1);
    const errs = hits.filter((h) => h.decision === "issue" && Number(h.page) === page).length;
    const held = hits.filter((h) => isOpenHeld(h) && Number(h.page) === page).length;
    const state: ThumbState = errs ? "err" : held ? "new" : seen.has(page) ? "done" : "new";
    const word = errs ? "有错" : held ? "待人工" : state === "done" ? "看完" : "未看";
    const symbol = errs ? `✗${errs}` : held ? `?${held}` : state === "done" ? "✓" : "•";
    const label = `第${page}页，${state === "err" ? `${errs} 处有错` : word}`;
    return { index, page, state, symbol, word, label };
  });
}

/** 标完一致/忽略后跳到下一条待确认（先往后找，再从头绕回）；有错留在本条写原因。 */
export function nextPendingAfter(hits: FieldHit[], from: number, decided: Decision): number | null {
  if (decided === "issue") return null;
  const { issues } = partitionReviewHits(hits);
  const pending = issues.filter(({ hit, index }) => index !== from && isPendingDecision(hit.decision));
  return (pending.find(({ index }) => index > from) || pending[0])?.index ?? null;
}

/** 键盘 1/2/3 → 一致/有错/忽略。 */
export function verdictForKey(key: string): Decision | null {
  if (key === "1") return "confirm";
  if (key === "2") return "issue";
  if (key === "3") return "ignore";
  return null;
}

/** 正在打字时不响应快捷键。 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null };
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return el.getAttribute?.("role") === "textbox";
}

export type RejectRow = { index: number; no: number; field: string; reason: string; missingReason: boolean };

export type PhonePendingLine = { key: string; text: string };

/** 手机不能逐条下结论。待确认只列状态和页码，不带稿句。逐字单的待人工确认另有自己的列表。 */
export function phonePendingLines(hits: FieldHit[], releaseHeld = false): PhonePendingLine[] {
  const { issues, held } = partitionReviewHits(hits);
  const rows = [
    ...issues.filter(({ hit }) => isPendingDecision(hit.decision)),
    ...(releaseHeld ? [] : held.filter(({ hit }) => isOpenHeld(hit))),
  ];
  return rows.map(({ hit, index }) => ({
    key: hit.id || String(index),
    text: `${hit.status || "未决"} · 第${hit.page ?? "?"}页`,
  }));
}

/** 退回确认框预填的有错清单；没写原因只提醒，不挡提交。 */
export function rejectRows(hits: FieldHit[], notes: Record<string, string>): RejectRow[] {
  return hits
    .map((hit, index) => ({ hit, index }))
    .filter(({ hit }) => hit.decision === "issue")
    .map(({ hit, index }) => {
      const reason = ((hit.id && notes[hit.id] != null ? notes[hit.id] : hit.note) || "").trim();
      return { index, no: index + 1, field: hit.field || "项目", reason, missingReason: !reason };
    });
}

/**
 * 服务端 /complete 要求非空 conclusion；确认框里「补充说明」选填。审核人写了就原样用他的，
 * 不再拼自动文案；空时才补固定结论（签字「无改稿项」/ 退回「退回：N 条有错，见清单」）。
 * 签字且还有待人工确认时，默认结论后面带「另有 N 处机器没读准」。审核人自己写了补充说明就原样保留。
 */
export function conclusionFor(kind: "sign" | "reject", extra: string, rows: RejectRow[], held = 0): string {
  const text = extra.trim();
  if (kind === "sign") {
    const base = text || REVIEW_COPY.signConclusion;
    if (held > 0 && !text) return `${base} ${REVIEW_COPY.heldLine(held)}`;
    return base;
  }
  return text || REVIEW_COPY.rejectConclusion(rows.length);
}

/** 已被别人签字/退回：只用现有 completed_by / complete_kind 字段，不新增接口。 */
/** completed_at → 用户时区（Asia/Shanghai）的「18:20」/「10月9日 18:20」/「2025年10月9日 18:20」；缺或坏就不写时间（绝不拿当前时间顶）。 */
export function completedAtLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const parts = (d: Date) => {
    const o: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d)) o[p.type] = p.value;
    return o;
  };
  const a = parts(at), n = parts(now);
  const hm = `${a.hour}:${a.minute}`;
  if (a.year === n.year && a.month === n.month && a.day === n.day) return hm;
  if (a.year === n.year) return `${a.month}月${a.day}日 ${hm}`;
  return `${a.year}年${a.month}月${a.day}日 ${hm}`;
}

type DoneTask = Pick<TaskDetail, "status" | "completed_by" | "complete_kind" | "completed_at">;

/** 已被别人完成时的锁页文案：签字 / 退回（等新稿）/ 没写种类就「处理」，后面带完成时间。 */
export function completedByText(task: DoneTask, now: Date = new Date()): string {
  const who = (task.completed_by || "").trim();
  if (!who) return REVIEW_COPY.lockedUnknown;
  const head = task.complete_kind === "rework" ? REVIEW_COPY.lockedRework(who)
    : task.complete_kind === "signed" ? REVIEW_COPY.lockedSign(who)
    : REVIEW_COPY.lockedOther(who);
  const at = completedAtLabel(task.completed_at, now);
  return at ? `${head} ${at}` : head;
}

export function lockedBy(task: DoneTask | null, me: string | null, now: Date = new Date()): string | null {
  if (!task || task.status !== "completed") return null;
  const who = (task.completed_by || "").trim();
  if (who && me && who === me) return null;
  return completedByText(task, now);
}

/** 断网或请求没到服务器 → 「没连上网，这条没存上」；不排队、不自动重发。 */
export function decisionFailureText(err: unknown, online: boolean): string {
  if (!online) return REVIEW_COPY.offline;
  if (err instanceof TypeError) return REVIEW_COPY.offline;
  // api.ts 把没到服务器的请求包成 status 0 的 ApiError。
  if (err && typeof err === "object" && (err as { status?: unknown }).status === 0) return REVIEW_COPY.offline;
  return err instanceof Error && err.message ? err.message : REVIEW_COPY.saveFailed;
}

export type PctBox = { left: number; top: number; width: number; height: number };

/**
 * 标记放在框外角，不压框里的字：默认右上角外侧；靠右边缘翻到左上，靠顶翻到下方。
 * 单位都是页面百分比；marker 是标记直径占页宽/页高的百分比。
 */
export function markerOutsideCorner(box: PctBox, marker: { w: number; h: number }): { left: number; top: number } {
  const r = marker.w / 2;
  const v = marker.h / 2;
  let left = box.left + box.width + r;
  if (left + r > 100) left = box.left - r;
  let top = box.top - v;
  if (top - v < 0) top = box.top + box.height + v;
  return { left: Math.min(100 - r, Math.max(r, left)), top: Math.min(100 - v, Math.max(v, top)) };
}

/**
 * 编号钉跟着页图缩放，画布又裁掉溢出。外角落到可见区域外时，把钉心拉回视口内。
 * pad 是屏幕像素，对应 28px 钉的半径。坐标仍写回页面百分比。
 */
export function clampPinToView(
  pin: { left: number; top: number },
  laid: { imgW: number; imgH: number; offsetX: number; offsetY: number },
  zoom: { scale: number; x: number; y: number },
  view: { width: number; height: number },
  pad = 14,
): { left: number; top: number } {
  const scale = zoom.scale > 0 ? zoom.scale : 1;
  if (!(laid.imgW > 1) || !(laid.imgH > 1) || !(view.width > pad * 2) || !(view.height > pad * 2)) return pin;
  const viewX = laid.offsetX + zoom.x + (pin.left / 100) * laid.imgW * scale;
  const viewY = laid.offsetY + zoom.y + (pin.top / 100) * laid.imgH * scale;
  const nextX = Math.min(view.width - pad, Math.max(pad, viewX));
  const nextY = Math.min(view.height - pad, Math.max(pad, viewY));
  return {
    left: ((nextX - laid.offsetX - zoom.x) / (laid.imgW * scale)) * 100,
    top: ((nextY - laid.offsetY - zoom.y) / (laid.imgH * scale)) * 100,
  };
}

/** 右栏浮层打开后，当前标记若被盖住就把画布往左平移，留 margin 像素。返回需要的 dx（≤0）。 */
export function panToClearPanel(markerRight: number, panelLeft: number, margin = 24): number {
  const over = markerRight + margin - panelLeft;
  return over > 0 ? -over : 0;
}

const SHORTCUT_SEEN_KEY = "wb_review_shortcuts_seen_v1";

/** 浏览器禁用存储（隐私模式 SecurityError / 配额 QuotaExceededError）抛 DOMException；其他错误照常抛出。 */
function isStorageDenied(err: unknown): boolean {
  return typeof DOMException !== "undefined" && err instanceof DOMException;
}

export function shouldShowShortcutsOnOpen(store: Pick<Storage, "getItem"> | null): boolean {
  if (!store) return false;
  try {
    return !store.getItem(SHORTCUT_SEEN_KEY);
  } catch (err) {
    if (!isStorageDenied(err)) throw err;
    return false; // 读不了存储就不弹，避免每次打开都弹；点「?」仍可看
  }
}

export function markShortcutsSeen(store: Pick<Storage, "setItem"> | null): void {
  if (!store) return;
  try {
    store.setItem(SHORTCUT_SEEN_KEY, "1");
  } catch (err) {
    if (!isStorageDenied(err)) throw err;
    console.warn("快捷键条已看标记没存上，下次打开可能再弹一次", err);
  }
}

/** 退回门槛小字。失败但带上一轮条目时签字/退回按钮都不在，小字也不显示。 */
export function rejectNote(rejectTitle: string | undefined, failedWithHits: boolean, canComplete = true): string | null {
  // viewer（没有 complete）不签不退：叫人做事的句子不出（产品哥 2026-10-17），只读信息照常。
  return rejectTitle && !failedWithHits && canComplete ? rejectTitle : null;
}

/** 签字左侧提示（「仍有 …未处理」等）：viewer 不显示。 */
export function signHint(hint: string, canComplete = true): string | null {
  return hint && canComplete ? hint : null;
}

/**
 * 页头位置。有条目状态异常时不能写「全部已下结论」（异常条目不进待确认列表），改按全部条目计数，如「1/1」。
 */
export function reviewPositionLabel(hits: FieldHit[], list: number[], active: number, pendingLeft: number | undefined, held: number): string {
  if (hasInvalidHitStatus(hits)) return positionLabel(tabIndices(hits, "all", active), active);
  return positionLabel(list, active, pendingLeft, held);
}

/** 位置「3/9」：当前在该 tab 列表中的序号。 */
export function positionLabel(list: number[], active: number, pendingLeft?: number, held = 0): string {
  // 「待确认」tab 会把刚下完结论的当前条留在列表里不跳走；待确认已清零时不写「1/1」，写「全部已下结论」。
  // 还有未决待人工确认时，这个位置不能写成全部已下结论。
  if (held > 0) {
    if (!list.length) return "–";
    const k = list.indexOf(active);
    return `${k < 0 ? "–" : k + 1}/${list.length}`;
  }
  if (!list.length || pendingLeft === 0) return REVIEW_COPY.allDecided;
  const k = list.indexOf(active);
  return `${k < 0 ? "–" : k + 1}/${list.length}`;
}

export type FlatTab = "pending" | "issue" | "all";

export function tabIndices(hits: FieldHit[], tab: FlatTab, active: number): number[] {
  const { issues } = partitionReviewHits(hits);
  if (tab === "all") return hits.map((_, i) => i);
  if (tab === "issue") return hits.map((h, i) => ({ h, i })).filter(({ h, i }) => h.decision === "issue" || i === active).map(({ i }) => i);
  return issues.filter(({ hit, index }) => isPendingDecision(hit.decision) || index === active).map(({ index }) => index);
}

/**
 * 签字/退回失败的提示，只看 HTTP 状态 + 重读回来的任务（结构化字段），不匹配服务端原文。
 * 现有服务端 /complete（apps/web/server/src/index.ts）只回 status + detail 文本：
 * - 409 只在「对照还在排队或正在跑」时用 → 「这份稿还在检查，等一会儿再提交」；
 * - 400 有三种（已完成 / 还有疑点没处理 / 结论为空），文本区分不了，调用方重读任务后按状态判断；
 * - 其他一律通用文案，原文只打 console.error。
 * TODO(TODOS.md)：后端补错误码（后端第 1、6 项）后改成按 code 映射。
 */
export function submitFailureText(
  status: number | null,
  fresh: DoneTask | null,
  freshPending: number,
): string {
  if (status === 409) return REVIEW_COPY.submitStillChecking;
  if (status === 400 && fresh) {
    if (fresh.status === "completed") {
      return completedByText(fresh);
    }
    if (freshPending > 0) return REVIEW_COPY.submitPending(freshPending);
  }
  return REVIEW_COPY.submitFailed;
}

/** 核对页「上传新稿」发请求前的大小预检：超限返回按当前账号上限生成的统一提示，不超返回 null。 */
export function reworkUploadBlocked(file: Pick<File, "size"> | null | undefined): string | null {
  return file && bytesTooLarge(file.size) ? uploadTooLargeText() : null;
}

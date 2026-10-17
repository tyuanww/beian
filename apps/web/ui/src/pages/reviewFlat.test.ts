import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FieldHit } from "../api";
import { PUBLIC_UPLOAD_BYTES, UPLOAD_TOO_LARGE, setUploadLimitFromMe } from "../uploadLimit";
import {
  rejectNote,
  clampPinToView, completedAtLabel, completedByText, conclusionFor, decisionFailureText, reworkUploadBlocked, submitFailureText, flatLayout, isTypingTarget, lockedBy, markerOutsideCorner, nextPendingAfter,
  openHeldAfterPending, panToClearPanel, pendingTally, phonePendingLines, positionLabel, rejectRows, reviewPositionLabel, shouldShowShortcutsOnOpen, signHint, submitGate, tabIndices, thumbMarks, verdictCounts, verdictForKey,
} from "./reviewFlat.js";

const hit = (id: string, decision = "pending", page = 1, status = "疑点", note = ""): FieldHit => ({ id, field: id, status, decision, page, note });

describe("reviewFlat", () => {
  it("断点：1440 常驻、<1440 浮层、<720 手机", () => {
    assert.equal(flatLayout(1440), "wide");
    assert.equal(flatLayout(1280), "overlay");
    assert.equal(flatLayout(719), "phone");
  });
  it("签字门：有待确认时都禁用并提示 N 条；有错只能退回；全一致才可签", () => {
    const pend = [hit("a"), hit("b", "confirm")];
    assert.deepEqual(verdictCounts(pend), { pending: 1, issue: 0, total: 2 });
    const g = submitGate(pend, true);
    assert.equal(g.canSign, false); assert.equal(g.canReject, true); assert.equal(g.hint, "仍有 1 条疑点未处理");
    assert.equal(g.title, "仍有 1 条疑点未处理");
    assert.equal(g.rejectTitle, "仍有 1 条疑点未处理");
    assert.equal(g.pending, 1);
    assert.equal(rejectNote(g.rejectTitle, { sign: "disabled", reject: "enabled" }), "仍有 1 条疑点未处理");
    assert.equal(rejectNote(g.rejectTitle, { sign: "hidden", reject: "hidden" }), null, "失败单：按钮都不在，小字也不显示");
    assert.deepEqual([submitGate([hit("a", "issue")], true).canSign, submitGate([hit("a", "issue")], true).canReject], [false, true]);
    assert.equal(submitGate([hit("a", "ignore")], true).canSign, true);
    assert.equal(submitGate([], true).canSign, true, "零疑点可直接签字");
    assert.equal(submitGate([], true, true).canSign, false, "锁定后不可签");
    const held = [hit("h", "pending", 1, "待人工确认")];
    assert.equal(submitGate(held, true).canSign, false, "四条可见条件没齐就不放开");
    assert.equal(submitGate(held, true, false, true).canSign, true, "待人工确认不挡签字");
    assert.equal(submitGate(held, true, false, true).pending, 0);
    assert.equal(submitGate([hit("e", "pending", 1, "漏字")], true, false, true).canSign, false, "漏字仍挡签字");
    assert.equal(openHeldAfterPending(2, 0, 1), true);
    assert.equal(openHeldAfterPending(0, 0, 1), false);
    assert.equal(openHeldAfterPending(1, 0, 0), false);
  });
  it("缩略图符号不只靠颜色", () => {
    const m = thumbMarks([{ page: 1 }, { page: 2 }, { page: 3 }], [hit("a", "issue", 2), hit("b", "issue", 2)], new Set([1]));
    assert.deepEqual(m.map((x) => x.symbol), ["✓", "✗2", "•"]);
    assert.equal(m[1].label, "第2页，2 处有错");
    const heldMark = thumbMarks([{ page: 1 }], [hit("h", "pending", 1, "待人工确认")], new Set([1]));
    assert.equal(heldMark[0].symbol, "?1");
    assert.equal(heldMark[0].word, "待人工");
  });
  it("一致/忽略自动跳下一条待确认并绕回；有错停留", () => {
    const hs = [hit("a"), hit("b", "confirm"), hit("c"), hit("d")];
    assert.equal(nextPendingAfter(hs, 2, "confirm"), 3);
    assert.equal(nextPendingAfter(hs, 3, "ignore"), 0);
    assert.equal(nextPendingAfter(hs, 0, "issue"), null);
  });
  it("快捷键 1/2/3，打字时不响应", () => {
    assert.deepEqual(["1", "2", "3", "4"].map(verdictForKey), ["confirm", "issue", "ignore", null]);
    assert.equal(isTypingTarget({ tagName: "textarea" }), true);
    assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  });
  it("手机待确认只列状态和页码", () => {
    const lines = phonePendingLines([
      hit("a", "pending", 2, "漏字"),
      hit("b", "issue", 1, "多字"),
      hit("c", "pending", 3, "待人工确认"),
      { ...hit("d", "pending", 4, "多空格"), pdf: "不该出现的句子", excel: "也不该出现" },
    ], true);
    assert.deepEqual(lines.map((line) => line.text), ["漏字 · 第2页", "多空格 · 第4页"]);
    assert.deepEqual(phonePendingLines([hit("c", "pending", 3, "待人工确认")]).map((line) => line.text), ["待人工确认 · 第3页"]);
    assert.equal(JSON.stringify(lines).includes("不该出现"), false);
  });
  it("退回清单：没写原因只提醒；结论自动补齐", () => {
    const rows = rejectRows([hit("a", "issue"), hit("b", "issue", 1, "疑点", "错字"), hit("c", "confirm")], { a: "" });
    assert.deepEqual(rows.map((r) => r.missingReason), [true, false]);
    assert.equal(conclusionFor("reject", "", rows), "退回：2 条有错，见清单");
    assert.equal(conclusionFor("reject", "找受委托方", rows), "找受委托方");
    assert.equal(conclusionFor("sign", " ", []), "无改稿项");
    assert.equal(conclusionFor("sign", "", [], 1), "无改稿项 另有 1 处机器没读准，签了表示人认这些字。");
    assert.equal(conclusionFor("sign", "看过了", [], 1), "看过了");
  });
  it("已被他人签字锁定只看 completed_by", () => {
    assert.equal(lockedBy({ status: "completed", completed_by: "天元", complete_kind: "signed" }, "籽烨"), "这一单已被天元签字");
    assert.equal(lockedBy({ status: "completed", completed_by: "天元", complete_kind: "rework" }, "籽烨"), "这一单已被天元退回，等新稿");
    assert.equal(lockedBy({ status: "completed", completed_by: "籽烨" }, "籽烨"), null);
    assert.equal(lockedBy({ status: "in_review" }, "籽烨"), null);
  });
  it("离线提示不排队", () => {
    assert.equal(decisionFailureText(new Error("x"), false), "没连上网，这条没存上");
    assert.equal(decisionFailureText(new TypeError("Failed to fetch"), true), "没连上网，这条没存上");
    assert.equal(decisionFailureText(new Error("当前状态不可审核"), true), "当前状态不可审核");
    assert.equal(decisionFailureText(Object.assign(new Error("审稿服务连不上"), { status: 0 }), true), "没连上网，这条没存上");
  });
  it("标记放框外角，贴边翻转", () => {
    assert.deepEqual(markerOutsideCorner({ left: 10, top: 10, width: 20, height: 5 }, { w: 4, h: 3 }), { left: 32, top: 8.5 });
    const edge = markerOutsideCorner({ left: 80, top: 0, width: 19, height: 5 }, { w: 4, h: 3 });
    assert.equal(edge.left, 78); assert.equal(edge.top, 6.5);
  });
  it("放大后把钉心拉回可见画布", () => {
    const laid = { imgW: 400, imgH: 400, offsetX: 0, offsetY: 0 };
    const view = { width: 400, height: 400 };
    const inside = clampPinToView({ left: 50, top: 50 }, laid, { scale: 1, x: 0, y: 0 }, view);
    assert.equal(inside.left, 50);
    assert.equal(inside.top, 50);
    const clipped = clampPinToView({ left: 90, top: 10 }, laid, { scale: 2, x: -300, y: 0 }, view);
    assert.ok(clipped.left < 90);
    const screenX = laid.offsetX - 300 + (clipped.left / 100) * laid.imgW * 2;
    assert.ok(screenX <= view.width - 14);
    assert.ok(screenX >= 14);
  });
  it("浮层盖住标记时平移", () => {
    assert.equal(panToClearPanel(1000, 960), -64);
    assert.equal(panToClearPanel(500, 960), 0);
  });
  it("位置 3/9 与 tab 列表", () => {
    const hs = [hit("a"), hit("b", "issue"), hit("c"), hit("d", "1", 1, "一致")];
    assert.deepEqual(tabIndices(hs, "pending", 0), [0, 2]);
    assert.deepEqual(tabIndices(hs, "issue", 0), [0, 1]);
    assert.equal(positionLabel([0, 2], 2), "2/2");
    assert.equal(positionLabel([], 0), "全部已下结论");
    assert.equal(positionLabel([3], 3, 0), "全部已下结论");
    assert.equal(positionLabel([3], 3, 0, 2), "1/1");
    assert.equal(positionLabel([0, 3], 3, 1), "2/2");
  });
  it("快捷键条只在首次打开显示", () => {
    assert.equal(shouldShowShortcutsOnOpen({ getItem: () => null }), true);
    assert.equal(shouldShowShortcutsOnOpen({ getItem: () => "1" }), false);
    assert.equal(shouldShowShortcutsOnOpen(null), false);
    assert.equal(shouldShowShortcutsOnOpen({ getItem: () => { throw new DOMException("denied", "SecurityError"); } }), false);
    assert.throws(() => shouldShowShortcutsOnOpen({ getItem: () => { throw new TypeError("bug"); } }), TypeError);
  });
  it("提交失败只按状态码 + 重读任务映射文案", () => {
    assert.equal(submitFailureText(409, null, 0), "这份稿还在检查，等一会儿再提交");
    assert.equal(submitFailureText(400, { status: "completed", completed_by: "天元", complete_kind: "signed" }, 0), "这一单已被天元签字");
    assert.equal(submitFailureText(400, { status: "completed", completed_by: "" }, 0), "这份稿已经提交过了");
    assert.equal(submitFailureText(400, { status: "in_review" }, 2), "还有 2 条待确认，处理完才能签字");
    assert.equal(submitFailureText(400, { status: "in_review" }, 0), "没提交成功，请重试");
    assert.equal(submitFailureText(400, null, 3), "没提交成功，请重试");
    assert.equal(submitFailureText(500, null, 0), "没提交成功，请重试");
  });
  it("已被别人完成：签字/退回/未知种类 + 完成时间（上海时区，今天只写时分）", () => {
    const now = new Date("2026-10-11T10:30:00Z"); // 上海 18:30
    assert.equal(completedAtLabel("2026-10-11T10:20:00Z", now), "18:20");
    assert.equal(completedAtLabel("2026-10-09T10:20:00Z", now), "10月9日 18:20");
    assert.equal(completedAtLabel("2025-10-09T10:20:00Z", now), "2025年10月9日 18:20");
    assert.equal(completedAtLabel("2026-10-10T16:05:00Z", now), "00:05"); // 跨 UTC 日界，上海已是今天
    assert.equal(completedAtLabel(undefined, now), "");
    assert.equal(completedAtLabel("坏时间", now), "");
    const base = { status: "completed", completed_by: "天元", completed_at: "2026-10-11T10:20:00Z" };
    assert.equal(completedByText({ ...base, complete_kind: "signed" }, now), "这一单已被天元签字 18:20");
    assert.equal(completedByText({ ...base, complete_kind: "rework" }, now), "这一单已被天元退回，等新稿 18:20");
    assert.equal(completedByText({ ...base }, now), "这一单已被天元处理 18:20");
    assert.equal(completedByText({ status: "completed", completed_by: "天元", complete_kind: "signed" }, now), "这一单已被天元签字");
  });
  it("上传新稿按当前账号上限预检，提示里的 MB 数跟着变", () => {
    setUploadLimitFromMe({ upload_limit_bytes: 10_000_000 });
    try {
      assert.equal(reworkUploadBlocked({ size: 10_000_001 }), "文件太大，请压到 10MB 以内再传（多份合计）");
      assert.equal(reworkUploadBlocked({ size: 10_000_000 }), null);
    } finally {
      setUploadLimitFromMe(null);
    }
  });
  it("上传新稿超公网上限就挡下并给 UPLOAD_TOO_LARGE，不超放行", () => {
    assert.equal(reworkUploadBlocked({ size: PUBLIC_UPLOAD_BYTES + 1 }), UPLOAD_TOO_LARGE);
    assert.equal(reworkUploadBlocked({ size: PUBLIC_UPLOAD_BYTES }), null);
    assert.equal(reworkUploadBlocked({ size: 1024 }), null);
    assert.equal(reworkUploadBlocked(null), null);
  });
});

describe("签字门提示与服务端 /complete 拦截同一句", () => {
  const doubt = (id: string, status = "一致"): FieldHit => ({ id, field: id, status, page: 1, coverage: { miss: ["CAPSULE MIST"] } } as FieldHit);
  const held = (id: string, decision?: string): FieldHit => ({ id, field: id, status: "待人工确认", page: 1, ...(decision ? { decision } : {}) });

  it("只有一类：与原来一字不差", () => {
    assert.equal(submitGate([held("a"), held("b", "pending")], true).hint, "仍有 2 条待人工确认未处理");
    assert.equal(submitGate([hit("m", "pending", 1, "多空格")], true).hint, "仍有 1 条多空格未处理");
  });
  it("认字存疑（状态本是「一致」）写「认字存疑」；签字悬停同一句", () => {
    const g = submitGate([doubt("a")], true);
    assert.deepEqual([g.hint, g.title, g.canSign], ["仍有 1 条认字存疑未处理", "仍有 1 条认字存疑未处理", false]);
    // 缺空格没标 pending、只因认字存疑要结论：写「认字存疑」不写「缺空格」。
    const spaceDoubt = { id: "s", field: "s", status: "缺空格", page: 1, sequence_diff: { only_in_excel: ["香柠檬"] } } as FieldHit;
    assert.equal(submitGate([spaceDoubt], true).hint, "仍有 1 条认字存疑未处理");
  });
  it("多类：分开数，词序按首次出现，「、」连接", () => {
    assert.equal(submitGate([held("a"), doubt("b"), held("c")], true).hint, "仍有 2 条待人工确认、1 条认字存疑未处理");
    assert.equal(submitGate([hit("a"), hit("b", "pending", 1, "缺失"), hit("c")], true).hint, "仍有 2 条疑点、1 条缺失未处理");
    const mixed = submitGate([held("a"), doubt("b"), held("c"), hit("d")], true);
    assert.equal(mixed.hint, "仍有 2 条待人工确认、1 条认字存疑、1 条疑点未处理");
    assert.equal(mixed.pending, 4, "各类条数之和等于确认框用的 pending");
  });
  it("已下结论的不计；逐字单的待人工确认不计", () => {
    assert.equal(submitGate([held("a", "ignore"), doubt("b"), { ...doubt("c"), decision: "confirm" }], true).hint, "仍有 1 条认字存疑未处理");
    assert.equal(submitGate([held("a"), doubt("b")], true, false, true).hint, "仍有 1 条认字存疑未处理");
    assert.deepEqual(pendingTally([held("a"), doubt("b"), held("c")]), [{ word: "待人工确认", count: 2 }, { word: "认字存疑", count: 1 }]);
    assert.deepEqual(pendingTally([held("a")], true), []);
  });
});

describe("签字和退回都做不了：右上和页头叫人做事的句子不出", () => {
  it("两个按钮都不在才藏；有一个在（哪怕灰着）就照常说明", () => {
    const g = submitGate([hit("a")], true);
    const none = { sign: "hidden", reject: "hidden" } as const;
    assert.equal(signHint(g.hint, none), null);
    assert.equal(rejectNote(g.rejectTitle, none), null);
    for (const b of [{ sign: "disabled", reject: "enabled" }, { sign: "disabled", reject: "disabled" }, { sign: "enabled", reject: "hidden" }] as const) {
      assert.equal(signHint(g.hint, b), g.hint, JSON.stringify(b));
      assert.equal(rejectNote(g.rejectTitle, b), g.rejectTitle, JSON.stringify(b));
    }
    assert.equal(signHint("", { sign: "disabled", reject: "enabled" }), null);
  });
});

describe("审核数据状态异常", () => {
  const odd = (id: string, extra: Partial<FieldHit> = {}): FieldHit => ({ id, field: id, status: "未知状态", page: 1, ...extra });
  it("未知状态：右上短句，页头和悬停用服务端原话；两个按钮都灰", () => {
    const g = submitGate([odd("a"), hit("b", "maybe")], true);
    assert.deepEqual([g.canSign, g.canReject, g.hint, g.title, g.rejectTitle], [false, false, "审核数据状态异常", "有 2 条审核数据状态异常，请重新对照", "有 2 条审核数据状态异常，请重新对照"]);
  });
  it("只有 decision 非法：文案同服务端原话，按钮仍按待确认（签字灰、退回可点）", () => {
    const g = submitGate([hit("a", "maybe")], true);
    assert.deepEqual([g.canSign, g.canReject, g.hint, g.title, g.rejectTitle], [false, true, "审核数据状态异常", "有 1 条审核数据状态异常，请重新对照", "有 1 条审核数据状态异常，请重新对照"]);
  });
  it("导航：有异常状态时不写「全部已下结论」，按全部条目计数", () => {
    const hits = [odd("a")];
    assert.equal(positionLabel([], 0), "全部已下结论", "对照：不看异常时会写全部已下结论");
    assert.equal(reviewPositionLabel(hits, [], 0, 0, 0), "1/1");
    assert.equal(reviewPositionLabel([hit("a", "confirm"), odd("b")], [], 1, 0, 0), "2/2");
    assert.equal(reviewPositionLabel([hit("a", "confirm")], [], 0, 0, 0), "全部已下结论");
  });
});

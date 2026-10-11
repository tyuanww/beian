import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FieldHit } from "../api";
import {
  conclusionFor, decisionFailureText, flatLayout, isTypingTarget, lockedBy, markerOutsideCorner, nextPendingAfter,
  panToClearPanel, positionLabel, rejectRows, shouldShowShortcutsOnOpen, submitGate, tabIndices, thumbMarks, verdictCounts, verdictForKey,
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
    assert.equal(g.canSign, false); assert.equal(g.canReject, true); assert.equal(g.hint, "还有 1 条没下结论");
    assert.deepEqual([submitGate([hit("a", "issue")], true).canSign, submitGate([hit("a", "issue")], true).canReject], [false, true]);
    assert.equal(submitGate([hit("a", "ignore")], true).canSign, true);
    assert.equal(submitGate([], true).canSign, true, "零疑点可直接签字");
    assert.equal(submitGate([], true, true).canSign, false, "锁定后不可签");
  });
  it("缩略图符号不只靠颜色", () => {
    const m = thumbMarks([{ page: 1 }, { page: 2 }, { page: 3 }], [hit("a", "issue", 2), hit("b", "issue", 2)], new Set([1]));
    assert.deepEqual(m.map((x) => x.symbol), ["✓", "✗2", "•"]);
    assert.equal(m[1].label, "第2页，2 处有错");
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
  it("退回清单：没写原因只提醒；结论自动补齐", () => {
    const rows = rejectRows([hit("a", "issue"), hit("b", "issue", 1, "疑点", "错字"), hit("c", "confirm")], { a: "" });
    assert.deepEqual(rows.map((r) => r.missingReason), [true, false]);
    assert.equal(conclusionFor("reject", "", rows), "退回：2 条有错，见清单");
    assert.equal(conclusionFor("reject", "找受委托方", rows), "找受委托方");
    assert.equal(conclusionFor("sign", " ", []), "无改稿项");
  });
  it("已被他人签字锁定只看 completed_by", () => {
    assert.equal(lockedBy({ status: "completed", completed_by: "天元", complete_kind: "signed" }, "籽烨"), "已被天元签字");
    assert.equal(lockedBy({ status: "completed", completed_by: "天元", complete_kind: "rework" }, "籽烨"), "已被天元退回");
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
  });
  it("快捷键条只在首次打开显示", () => {
    assert.equal(shouldShowShortcutsOnOpen({ getItem: () => null }), true);
    assert.equal(shouldShowShortcutsOnOpen({ getItem: () => "1" }), false);
  });
});

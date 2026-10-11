import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NAV_LABEL, REVIEW_STATUS_LABEL, WAIT_TITLE, reviewCompletedLabel } from "./labels.js";
import { statusLabel } from "../pages/TasksPage.js";
import { reviewVersionToggle, statusLead } from "../pages/reviewStatus.js";
import { historyTaskRow } from "../pages/historyRows.js";

const done = (complete_kind?: string) => ({
  id: "t1",
  title: "花盒",
  type: "pack",
  status: "completed",
  ...(complete_kind === undefined ? {} : { complete_kind }),
});

describe("reviewCompletedLabel", () => {
  it("splits the completed review by complete_kind", () => {
    assert.equal(reviewCompletedLabel("signed"), "已签字");
    assert.equal(reviewCompletedLabel("rework"), "已退回");
  });

  it("keeps 已提交 for legacy records without complete_kind or with an unknown value", () => {
    assert.equal(reviewCompletedLabel(undefined), "已提交");
    assert.equal(reviewCompletedLabel(null), "已提交");
    assert.equal(reviewCompletedLabel(""), "已提交");
    assert.equal(reviewCompletedLabel("approved"), "已提交");
    assert.equal(REVIEW_STATUS_LABEL.completed, "已提交");
  });
});

describe("completed review labels on every surface", () => {
  for (const [kind, text] of [["signed", "已签字"], ["rework", "已退回"], [undefined, "已提交"], ["weird", "已提交"]] as const) {
    it(`complete_kind=${String(kind)} → ${text}`, () => {
      assert.equal(statusLabel(done(kind)).text, text);
      assert.equal(historyTaskRow(done(kind)).status, text);
      assert.match(statusLead({ ...done(kind), pages: [{ url: "/p.png", page: 1 }] }, 0, [{ url: "/p.png", page: 1 }]), new RegExp(`${text}$`));
    });
  }

  it("does not use complete_kind for a task that is not completed", () => {
    assert.equal(statusLabel({ ...done("signed"), status: "in_review" }).text, REVIEW_STATUS_LABEL.pending);
  });
});

describe("WAIT_TITLE", () => {
  it("stays 3 characters because the wait loader splits it per character", () => {
    for (const title of Object.values(WAIT_TITLE)) assert.equal(Array.from(title).length, 3);
  });
});

describe("NAV_LABEL", () => {
  it("has a label for every menu key", () => {
    assert.deepEqual(Object.keys(NAV_LABEL), ["review", "mockup", "compression", "history", "settings"]);
  });
});

describe("reviewVersionToggle", () => {
  it("labels the button with the destination and the tag with the version being viewed", () => {
    assert.deepEqual(reviewVersionToggle(true), { button: "看旧稿", current: "当前：新稿" });
    assert.deepEqual(reviewVersionToggle(false), { button: "看新稿", current: "当前：旧稿" });
  });
});

describe("API rows straight from /api/tasks", () => {
  it("accepts rows with signed / rework / missing / null complete_kind without throwing", () => {
    const rows = [
      { id: "a", title: "x", type: "pack", status: "completed", complete_kind: "signed" },
      { id: "b", title: "x", type: "pack", status: "completed", complete_kind: "rework" },
      { id: "c", title: "x", type: "pack", status: "completed" },
      JSON.parse('{"id":"d","title":"x","type":"pack","status":"completed","complete_kind":null}'),
    ];
    assert.deepEqual(rows.map((row) => statusLabel(row).text), ["已签字", "已退回", "已提交", "已提交"]);
    assert.deepEqual(rows.map((row) => historyTaskRow(row).status), ["已签字", "已退回", "已提交", "已提交"]);
  });
});

describe("REVIEW_COPY（老板 2026-10-11 已批文案）", () => {
  it("确认框标题、正文、按钮一字不差", async () => {
    const { REVIEW_COPY } = await import("./labels");
    assert.equal(REVIEW_COPY.rejectTitle, "退回这份稿？");
    assert.equal(REVIEW_COPY.rejectBody(2), "有错的 2 条会随退回一起发出，并通知「已退回」。提交后不能撤回。");
    assert.equal(REVIEW_COPY.rejectConfirm, "确认退回");
    assert.equal(REVIEW_COPY.signConclusion, "无改稿项");
    assert.equal(REVIEW_COPY.rejectBlockedByPending(4), "还有 4 条待确认，处理完才能退回");
    assert.equal(REVIEW_COPY.noBox, "没找到位置，请看整页");
    assert.equal(REVIEW_COPY.pendingEmpty, "没有待确认的了");
    assert.equal(REVIEW_COPY.rejectConclusion(3), "退回：3 条有错，见清单");
    assert.equal(REVIEW_COPY.signTitle, "签字这份稿？");
    assert.equal(REVIEW_COPY.signBody, "签字后会通知「已签字」，不能撤回。");
    assert.equal(REVIEW_COPY.signConfirm, "确认签字");
    assert.equal(REVIEW_COPY.cancel, "再看看");
    assert.equal(REVIEW_COPY.missingReason, "没写原因");
    assert.equal(REVIEW_COPY.extraNote, "补充说明（选填）");
  });
  it("命名：核对要点 / 标记 / 忽略 / 收起 / 撤销提示", async () => {
    const { REVIEW_COPY } = await import("./labels");
    assert.equal(REVIEW_COPY.lead, "核对要点");
    assert.equal(REVIEW_COPY.marker, "标记");
    assert.equal(REVIEW_COPY.verdict.ignore, "忽略");
    assert.equal(REVIEW_COPY.collapse, "收起");
    assert.equal(REVIEW_COPY.undoToast("有错") + REVIEW_COPY.undo, "已标为有错，撤销");
    assert.equal(REVIEW_COPY.pendingHint(3), "还有 3 条没下结论");
    assert.equal(REVIEW_COPY.offline, "没连上网，这条没存上");
  });
});

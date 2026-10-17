import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FieldHit, TaskDetail } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import { reviewErrorCopy, type FailedWithHitsKind } from "./reviewErrorCopy";
import { rejectNote, signHint, submitGate } from "./reviewFlat";
import { canAccessTaskOwner, canReuploadFailed, isDeadCompareFailed, reviewPageHits, reviewSubmitButtons, type ReuploadViewer } from "./reviewActions";

/**
 * 复核失败按 B：红条（复核失败）、黄条（复核超页）、检查中断条（方案 A）里给自己的单「重新上传这一单」。
 */
const HITS: FieldHit[] = [{ id: "h0", field: "中文品名", status: "疑点", decision: "confirm" }];

const BARS: ReadonlyArray<{ name: string; kind: FailedWithHitsKind; code?: string; task: Partial<TaskDetail> }> = [
  { name: "红条：复核失败", kind: "rework", task: { status: "pending_review", job_kind: "rework", job_status: "failed", job_error: "对照中断" } },
  { name: "黄条：复核超页", kind: "rework", code: "page_over", task: { status: "pending_review", job_kind: "rework", job_status: "failed", job_error_code: "page_over" } },
  { name: "检查中断带上一轮条目", kind: "compare", task: { status: "compare_failed", job_kind: "compare", job_status: "failed", error: "对照中断" } },
];
const COMPARE_BAR = BARS[2];

const task = (extra: Partial<TaskDetail>, owner: string | null = "ou_me"): TaskDetail =>
  ({ id: "e5969b58cd99", title: "合成失败单", type: "pack", owner, hits: HITS, ...extra }) as TaskDetail;

const reviewer: ReuploadViewer = { canCreate: true, admin: false, openId: "ou_me", displayName: "审核员甲" };
const admin: ReuploadViewer = { canCreate: true, admin: true, openId: "ou_admin", displayName: "管理员" };
const viewer: ReuploadViewer = { canCreate: false, admin: false, openId: "ou_me", displayName: "审核员甲" };

describe("失败条里的「重新上传这一单」", () => {
  for (const bar of BARS) {
    it(`${bar.name}：文案不再叫人联系管理员，结尾引导重新上传；自己的单有按钮`, () => {
      const text = reviewErrorCopy("对照中断", bar.code, bar.kind, true);
      assert.doesNotMatch(text, /请联系管理员/u);
      assert.ok(text.endsWith("重新上传这一单"), text);
      assert.match(text, /下面是上一轮的结果/u);
      const t = task(bar.task);
      assert.equal(canReuploadFailed(t, reviewPageHits(t, false), reviewer), true);
    });

    it(`${bar.name}：别人的单、viewer、没有 owner 都不给按钮；管理员按服务端权限给`, () => {
      const others = task(bar.task, "ou_other");
      assert.equal(canReuploadFailed(others, HITS, reviewer), false, "别人的单");
      assert.equal(canReuploadFailed(task(bar.task), HITS, viewer), false, "viewer 没有 create");
      assert.equal(canReuploadFailed(task(bar.task, null), HITS, reviewer), false, "老单没有 owner");
      assert.equal(canReuploadFailed(others, HITS, admin), true, "管理员 /rework 不看归属");
    });

    it(`${bar.name}：签字和退回照旧不显示`, () => {
      const t = task(bar.task);
      const b = reviewSubmitButtons(t, reviewPageHits(t, false), { locked: false, orderHeldConfirm: false, busy: false, hasUnsavedNotes: false });
      assert.deepEqual([b.sign, b.reject], ["hidden", "hidden"]);
    });
  }

  it("owner 是显示名时按显示名认（同服务端 canAccessOwner：open_id 或显示名）", () => {
    const t = task(BARS[0].task, "审核员甲");
    assert.equal(canReuploadFailed(t, HITS, reviewer), true);
    assert.equal(canReuploadFailed(t, HITS, { ...reviewer, displayName: "审核员乙" }), false);
  });

  it("检查中断只剩工艺说明这类工艺表条目：服务端 activeHits 为空回 400，不给按钮", () => {
    const sheetOnly = task({ ...COMPARE_BAR.task, hits: [{ id: "h0", field: "工艺说明", status: "疑点", decision: "pending" }, { id: "h1", field: "版本号：V2", status: "疑点" }] });
    assert.equal(canReuploadFailed(sheetOnly, reviewPageHits(sheetOnly, false), reviewer), false);
    assert.equal(canReuploadFailed(sheetOnly, HITS, admin), false, "按任务自己的有效条目算，不看传进来的列表");
  });

  it("检查中断但不是对照作业失败（job_kind 不是 compare）：同服务端不放行", () => {
    assert.equal(canReuploadFailed(task({ ...COMPARE_BAR.task, job_kind: "rework" }), HITS, reviewer), false);
  });

  it("已有新稿（pages_v2）：服务端 isReworkableTask 为假，不给按钮", () => {
    assert.equal(canReuploadFailed(task({ ...BARS[0].task, pages_v2: [{ url: "x", page: 1 }] } as Partial<TaskDetail>), HITS, reviewer), false);
  });

  it("不是失败单、或检查中断且没有条目时不在失败条给按钮", () => {
    assert.equal(canReuploadFailed(task({ status: "in_review" }), HITS, reviewer), false);
    const empty = task({ ...COMPARE_BAR.task, hits: [] });
    assert.equal(canReuploadFailed(empty, reviewPageHits(empty, false), reviewer), false);
    assert.equal(canReuploadFailed(null, HITS, reviewer), false);
    assert.equal(REVIEW_COPY.reupload, "重新上传这一单");
  });
});

describe("复核（对红）失败且没有剩余条目", () => {
  const noHits = (owner: string | null = "ou_me") =>
    ({ id: "e5969b58cd9a", title: "合成失败单", type: "pack", owner, status: "pending_review", job_kind: "rework", job_status: "failed", job_error: "对照中断", hits: [] }) as unknown as TaskDetail;

  it("自己的单给「重新上传这一单」，别人的单和 viewer 不给，签字退回不显示", () => {
    assert.equal(canReuploadFailed(noHits(), [], reviewer), true);
    assert.equal(canReuploadFailed(noHits("ou_other"), [], reviewer), false);
    assert.equal(canReuploadFailed(noHits(), [], viewer), false);
    const b = reviewSubmitButtons(noHits(), [], { locked: false, orderHeldConfirm: false, busy: false, hasUnsavedNotes: false });
    assert.deepEqual([b.sign, b.reject], ["hidden", "hidden"]);
  });

  it("认字失败、没有剩余条目：自己的单（rework 不要求有条目）有按钮，带「再不行请联系管理员」退路；别人的单、viewer 是原句", () => {
    const ocr = (owner: string | null = "ou_me") => ({ ...noHits(owner), job_error: "认字组件没装上，没有结果" }) as TaskDetail;
    const copyFor = (t: TaskDetail, v: ReuploadViewer) => reviewErrorCopy(String(t.job_error), t.job_error_code, undefined, canReuploadFailed(t, [], v));
    assert.equal(canReuploadFailed(ocr(), [], reviewer), true);
    assert.equal(copyFor(ocr(), reviewer), "认字出了问题，可以重新上传这一单，再不行请联系管理员");
    assert.equal(copyFor(ocr("ou_other"), admin), REVIEW_COPY.ocrFailedReupload, "管理员按钮在，句子跟着按钮");
    assert.equal(copyFor(ocr("ou_other"), reviewer), "认字出了问题，请联系管理员");
    assert.equal(copyFor(ocr(), viewer), "认字出了问题，请联系管理员");
  });

  it("首轮认字失败、没有上一轮结果：原句「认字出了问题，请联系管理员」，不出「下面是上一轮的结果」", () => {
    const first = { ...noHits(), status: "compare_failed", job_kind: "compare", job_error: "认字组件没装上，没有结果" } as TaskDetail;
    const hits = reviewPageHits(first, false);
    assert.equal(hits.length, 0);
    const text = reviewErrorCopy(String(first.job_error), first.job_error_code, undefined, canReuploadFailed(first, hits, reviewer));
    assert.equal(text, "认字出了问题，请联系管理员");
    assert.doesNotMatch(text, /下面是上一轮的结果/u);
  });

  it("复核认字失败、带上一轮条目：仍显示红条「复核出了问题…」", () => {
    const t = task({ ...BARS[0].task, job_error: "认字组件没装上，没有结果" });
    const copyFor = (v: ReuploadViewer) => reviewErrorCopy(String(t.job_error), t.job_error_code, "rework", canReuploadFailed(t, reviewPageHits(t, false), v));
    assert.equal(copyFor(reviewer), "复核出了问题，下面是上一轮的结果，可以重新上传这一单");
    assert.equal(copyFor(viewer), "复核出了问题，下面是上一轮的结果");
  });

  it("首次检查失败、没有条目：不走 /rework，不给按钮", () => {
    const first = { ...noHits(), status: "compare_failed", job_kind: "compare" } as TaskDetail;
    assert.equal(canReuploadFailed(first, [], reviewer), false);
  });
});

describe("对照失败且没有有效条目：请回首页新建一单（产品 10/17 选 1）", () => {
  const sheet = (field: string): FieldHit => ({ id: field, field, status: "疑点", decision: "pending" });
  it("没有条目、只剩工艺表条目、认字单 hits_v2 为空：都算没法接着核，也不给重新上传", () => {
    for (const extra of [
      { hits: [] },
      { hits: [sheet("工艺说明"), sheet("颜色要求：专色")] },
      { verbatim_check: true, hits_v2: [], hits: HITS },
      { job_kind: undefined, job_status: undefined, hits: [] },
    ] as Partial<TaskDetail>[]) {
      const t = task({ ...COMPARE_BAR.task, ...extra });
      assert.equal(isDeadCompareFailed(t), true, JSON.stringify(extra));
      assert.equal(canReuploadFailed(t, reviewPageHits(t, false), reviewer), false);
      assert.equal(canReuploadFailed(t, reviewPageHits(t, false), admin), false);
    }
  });
  it("还有有效条目的检查中断单、红条黄条、待审单都不算", () => {
    assert.equal(isDeadCompareFailed(task(COMPARE_BAR.task)), false);
    assert.equal(isDeadCompareFailed(task({ ...COMPARE_BAR.task, hits: [sheet("备案版本号")] })), false);
    for (const bar of BARS.slice(0, 2)) assert.equal(isDeadCompareFailed(task({ ...bar.task, hits: [] })), false, bar.name);
    assert.equal(isDeadCompareFailed(task({ status: "pending_review", hits: [] })), false);
    assert.equal(isDeadCompareFailed(null), false);
  });
  it("文案：不叫人联系管理员，不写重新上传；链接只写「回首页」", () => {
    assert.equal(REVIEW_COPY.compareFailedNoHits, "这一单没法接着核了，请回首页重新新建一单");
    assert.equal(REVIEW_COPY.backHome, "回首页");
    assert.doesNotMatch(REVIEW_COPY.compareFailedNoHits, /请联系管理员|重新上传/u);
  });
});

describe("不给重新上传的失败条：句尾不写重新上传（别人的单、viewer）", () => {
  const READ_ONLY: Record<string, string> = {
    "红条：复核失败": "复核出了问题，下面是上一轮的结果",
    "黄条：复核超页": "稿件超过 1 页，这次复核没做，下面是上一轮的结果",
    "检查中断带上一轮条目": "检查中断了，下面是上一轮的结果",
  };
  for (const bar of BARS) {
    it(`${bar.name}：自己的单带「可以重新上传这一单」句尾，别人的单和 viewer 没有`, () => {
      const own = task(bar.task);
      const others = task(bar.task, "ou_other");
      const copyFor = (t: TaskDetail, v: ReuploadViewer) => reviewErrorCopy("对照中断", bar.code, bar.kind, canReuploadFailed(t, reviewPageHits(t, false), v));
      assert.match(copyFor(own, reviewer), /重新上传这一单$/u);
      assert.equal(copyFor(others, reviewer), READ_ONLY[bar.name]);
      assert.equal(copyFor(own, viewer), READ_ONLY[bar.name]);
      assert.equal(canReuploadFailed(others, reviewPageHits(others, false), admin), true);
      assert.equal(copyFor(others, admin), reviewErrorCopy("对照中断", bar.code, bar.kind, true), "管理员看别人的单：按钮在，句尾跟着留");
      assert.doesNotMatch(READ_ONLY[bar.name], /重新上传|请联系管理员/u);
    });
  }
  it("文案逐字（页数仍用上限常量）", () => {
    assert.equal(REVIEW_COPY.reworkFailedReadOnly, "复核出了问题，下面是上一轮的结果");
    assert.equal(REVIEW_COPY.reworkPageOverReadOnly, "稿件超过 1 页，这次复核没做，下面是上一轮的结果");
    assert.equal(REVIEW_COPY.compareFailedWithHitsReadOnly, "检查中断了，下面是上一轮的结果");
    assert.ok(REVIEW_COPY.reworkFailed.startsWith(REVIEW_COPY.reworkFailedReadOnly));
    assert.ok(REVIEW_COPY.reworkPageOver.startsWith(REVIEW_COPY.reworkPageOverReadOnly));
    assert.ok(REVIEW_COPY.compareFailedWithHits.startsWith(REVIEW_COPY.compareFailedWithHitsReadOnly));
  });
});

describe("签字和退回都做不了就不叫人去处理：右上和页头那句跟着按钮走", () => {
  const opts = (canComplete: boolean) => ({ locked: false, orderHeldConfirm: false, busy: false, hasUnsavedNotes: false, canComplete });
  /** 同 ReviewPage：有 complete 且这单自己能动（canAccessTaskOwner）才算能签退。 */
  const lines = (t: TaskDetail, canComplete: boolean, who: ReuploadViewer = reviewer) => {
    const hits = reviewPageHits(t, false);
    const g = submitGate(hits, true);
    const b = reviewSubmitButtons(t, hits, opts(canComplete && canAccessTaskOwner(t, who)));
    return { hint: signHint(g.hint, b), note: rejectNote(g.rejectTitle, b), pending: g.pending };
  };
  const PENDING: FieldHit[] = [{ id: "p0", field: "中文品名", status: "疑点", decision: "pending" }];
  for (const bar of BARS) {
    it(`${bar.name}：本人单、别人的单都没有「仍有 …未处理」；待确认条数照常算`, () => {
      for (const [t, who] of [[task({ ...bar.task, hits: PENDING }), reviewer], [task({ ...bar.task, hits: PENDING }, "ou_other"), reviewer], [task({ ...bar.task, hits: PENDING }, "ou_other"), admin]] as const) {
        const l = lines(t, true, who);
        assert.equal(l.hint, null);
        assert.equal(l.note, null);
        assert.equal(l.pending, 1, "疑点列表里的条目数照常");
      }
    });
  }
  it("viewer 看正常待审单：没有；审核员看自己正常待审单：签字灰、退回可点，照常显示", () => {
    const normal = task({ status: "in_review", hits: PENDING });
    assert.deepEqual(lines(normal, false), { hint: null, note: null, pending: 1 });
    const l = lines(normal, true);
    assert.equal(l.hint, "仍有 1 条疑点未处理");
    assert.equal(l.note, "仍有 1 条疑点未处理");
  });
  it("别人的正常待审单：审核员两个按钮都不在、那句也没有（服务端 /complete 403）；管理员能签能退，照常显示", () => {
    const others = task({ status: "in_review", hits: PENDING }, "ou_other");
    assert.deepEqual(lines(others, true, reviewer), { hint: null, note: null, pending: 1 });
    assert.equal(lines(task({ status: "in_review", hits: PENDING }, null), true, reviewer).hint, null, "没有 owner 的老单同服务端：非管理员不能动");
    const l = lines(others, true, admin);
    assert.equal(l.hint, "仍有 1 条疑点未处理");
    assert.equal(l.note, "仍有 1 条疑点未处理");
  });
});

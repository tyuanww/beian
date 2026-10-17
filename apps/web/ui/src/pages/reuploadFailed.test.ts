import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FieldHit, TaskDetail } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import { reviewErrorCopy, type FailedWithHitsKind } from "./reviewErrorCopy";
import { canReuploadFailed, reviewPageHits, reviewSubmitButtons, type ReuploadViewer } from "./reviewActions";

/** 复核失败按 B：三种失败条（红条复核失败、黄条复核超页、检查中断）里给自己的单「重新上传这一单」。 */
const HITS: FieldHit[] = [{ id: "h0", field: "中文品名", status: "疑点", decision: "confirm" }];

const BARS: ReadonlyArray<{ name: string; kind: FailedWithHitsKind; code?: string; task: Partial<TaskDetail> }> = [
  { name: "红条：复核失败", kind: "rework", task: { status: "pending_review", job_kind: "rework", job_status: "failed", job_error: "对照中断" } },
  { name: "黄条：复核超页", kind: "rework", code: "page_over", task: { status: "pending_review", job_kind: "rework", job_status: "failed", job_error_code: "page_over" } },
  { name: "检查中断带上一轮条目", kind: "compare", task: { status: "compare_failed", job_kind: "compare", job_status: "failed", error: "对照中断" } },
];

const task = (extra: Partial<TaskDetail>, owner: string | null = "ou_me"): TaskDetail =>
  ({ id: "e5969b58cd99", title: "合成失败单", type: "pack", owner, hits: HITS, ...extra }) as TaskDetail;

const reviewer: ReuploadViewer = { canCreate: true, admin: false, openId: "ou_me", displayName: "审核员甲" };
const admin: ReuploadViewer = { canCreate: true, admin: true, openId: "ou_admin", displayName: "管理员" };
const viewer: ReuploadViewer = { canCreate: false, admin: false, openId: "ou_me", displayName: "审核员甲" };

describe("失败条里的「重新上传这一单」", () => {
  for (const bar of BARS) {
    it(`${bar.name}：文案不再叫人联系管理员，结尾引导重新上传；自己的单有按钮`, () => {
      const text = reviewErrorCopy("对照中断", bar.code, bar.kind);
      assert.doesNotMatch(text, /请联系管理员/u);
      assert.ok(text.endsWith("下面是上一轮的结果，可以重新上传这一单"), text);
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

  it("不是失败单、或检查中断且没有条目时不在失败条给按钮", () => {
    assert.equal(canReuploadFailed(task({ status: "in_review" }), HITS, reviewer), false);
    assert.equal(canReuploadFailed(task(BARS[2].task), [], reviewer), false);
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

  it("首次检查失败、没有条目：不走 /rework，不给按钮", () => {
    const first = { ...noHits(), status: "compare_failed", job_kind: "compare" } as TaskDetail;
    assert.equal(canReuploadFailed(first, [], reviewer), false);
  });
});

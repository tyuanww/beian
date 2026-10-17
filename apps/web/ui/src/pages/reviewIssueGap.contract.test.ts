import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FieldHit, TaskDetail } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import { reviewGate, reviewPageHits } from "./reviewActions";
import { partitionReviewHits } from "./reviewEvidence";

/** 走 `partitionReviewHits`（内部用 `isReviewIssue`）：前端是否把这一条当疑点。 */
const isReviewIssue = (hit: FieldHit) => partitionReviewHits([hit]).issues.length === 1;

/**
 * 加码 Q2 服务端已跟上：缺空格没结论一律要结论。原「差异一」已对齐；仍钉死「无存疑字段的缺空格」两侧分歧，前端哥对齐 isReviewIssue 后改掉。
 */
const dataDir = mkdtempSync(join(tmpdir(), "beian-ui-issue-gap-"));
process.once("exit", () => rmSync(dataDir, { recursive: true, force: true }));
process.env.WB_DATA_DIR = dataDir;
const { completeGate } = await import("../../../server/src/completeGate.ts");
const { VERBATIM_STATUSES, isValidHitReviewState } = await import("../../../server/src/tasks.ts");
/** 服务端认得的状态（tasks.ts `HIT_STATUSES` 未导出：同样四个基础状态 + verbatim_statuses.json）；用 isValidHitReviewState 反向核过。 */
const KNOWN_STATUSES = ["一致", "疑点", "缺失", "跳过", ...VERBATIM_STATUSES.statuses];

function bothSides(hit: FieldHit) {
  const task = { id: "e5969b58cd9a", title: "差异合成单", status: "in_review", hits: [hit] } as TaskDetail;
  const ui = reviewGate(task, reviewPageHits(task, false), false);
  const gate = completeGate(task as Parameters<typeof completeGate>[0], undefined);
  return { ui, server: gate.ok ? null : gate.message };
}

describe("isReviewIssue 与服务端 hitNeedsDecision（加码 Q2 后）", () => {
  it("已对齐：缺空格没标 pending、只靠核对要点有内容——两边都拦（服务端写「仍有 1 条缺空格未处理」）", () => {
    const hit: FieldHit = { id: "h0", field: "中文品名", status: "缺空格", evidence: "稿件「香柠檬精油」少一个空格" };
    assert.equal(isReviewIssue(hit), true);
    const { ui, server } = bothSides(hit);
    assert.equal(server, "仍有 1 条缺空格未处理");
    assert.equal(ui.canSign, false);
    assert.equal(ui.canReject, true);
    assert.equal(ui.pending, 1);
    assert.equal(ui.hint, REVIEW_COPY.pendingUnresolved([{ word: "缺空格", count: 1 }]));
  });

  it("仍有差异：缺空格无 decision、也无存疑字段——服务端拦、前端不算待确认（见 SIGN_RETURN_DISPUTED；前端哥对齐 isReviewIssue 后删）", () => {
    const hit: FieldHit = { id: "h0", field: "中文品名", status: "缺空格" };
    assert.equal(isReviewIssue(hit), false, "前端仍看核对要点有无内容");
    const { ui, server } = bothSides(hit);
    assert.equal(server, "仍有 1 条缺空格未处理");
    assert.equal(ui.canSign, true);
    assert.equal(ui.canReject, false);
  });

  it("正则 /不清|误/ 在已知状态里一个都不命中，只会撞上未知状态——两边都按状态异常拦，不产生实际分歧", () => {
    for (const status of KNOWN_STATUSES) {
      assert.equal(isValidHitReviewState({ status }), true, `${status} 服务端认得`);
      assert.doesNotMatch(status, /不清|误/u, status);
    }
    const { ui, server } = bothSides({ id: "h0", field: "中文品名", status: "看不清" });
    assert.equal(server, REVIEW_COPY.invalidHitStatusDetail(1));
    assert.equal(ui.title, server);
    assert.equal(ui.canSign, false);
  });
});

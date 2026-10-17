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
 * 锁住已知差异（TODOS「isReviewIssue 比 hitNeedsDecision 多拦」，产品哥 10/17：以前端为准、服务端在加码 PR 跟上）。
 * 这里不改任何一边，只把差异钉死：哪一边先动了，这里就变红，提醒同时改 TODOS 和这份测试。
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

describe("isReviewIssue 与服务端 hitNeedsDecision 的已知差异", () => {
  it("差异一：缺空格没标 pending、只靠核对要点（evidence）有内容——前端算待确认、签字灰；服务端放行", () => {
    const hit: FieldHit = { id: "h0", field: "中文品名", status: "缺空格", evidence: "稿件「香柠檬精油」少一个空格" };
    assert.equal(isReviewIssue(hit), true);
    const { ui, server } = bothSides(hit);
    assert.equal(server, null, "服务端 pendingWord 只在缺空格标 pending 时拦");
    assert.equal(ui.canSign, false);
    assert.equal(ui.canReject, true);
    assert.equal(ui.pending, 1);
    assert.equal(ui.hint, REVIEW_COPY.pendingUnresolved([{ word: "缺空格", count: 1 }]));
  });

  it("差异二：正则 /不清|误/ 在已知状态里一个都不命中，只会撞上未知状态——两边都按状态异常拦，不产生实际分歧", () => {
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

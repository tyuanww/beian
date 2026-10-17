import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FieldHit, TaskDetail } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import { reviewGate, reviewPageHits } from "./reviewActions";
import { partitionReviewHits } from "./reviewEvidence";
import { isReviewIssue as sharedIsReviewIssue } from "../../../server/src/reviewIssue.ts";

/** 走 `partitionReviewHits`（内部用 `isReviewIssue`）：前端是否把这一条当疑点。 */
const isReviewIssue = (hit: FieldHit) => partitionReviewHits([hit]).issues.length === 1;

/**
 * 锁住已对齐：前端 `isReviewIssue`（reviewEvidence.ts）与服务端 `/complete` 的待确认口径用同一份共用 `server/src/reviewIssue.ts`（加码 §6）。
 * 原「差异一」（缺空格只靠核对要点有内容）、「仍有差异」（缺空格无结论无存疑字段）已对齐；「差异二」（状态正则 /不清|误/）前端已删。
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

describe("isReviewIssue 与服务端 /complete 已对齐（共用 reviewIssue.ts）", () => {
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

  it("已对齐：缺空格无 decision、也无存疑字段——两边都拦（加码 Q2，原 SIGN_RETURN_DISPUTED 唯一一行已挪回主表）", () => {
    const hit: FieldHit = { id: "h0", field: "中文品名", status: "缺空格" };
    assert.equal(isReviewIssue(hit), true);
    const { ui, server } = bothSides(hit);
    assert.equal(server, "仍有 1 条缺空格未处理");
    assert.equal(ui.canSign, false);
    assert.equal(ui.canReject, true);
    assert.equal(ui.hint, server);
  });

  it("差异二已对齐：前端 isReviewIssue 不再有状态文字正则，只认共用 reviewIssue.ts 的状态集合", () => {
    const src = readFileSync(new URL("./reviewEvidence.ts", import.meta.url), "utf8");
    assert.match(src, /from "\.\.\/\.\.\/\.\.\/server\/src\/reviewIssue\.ts"/u, "isReviewIssue 改 import 共用文件");
    assert.doesNotMatch(src, /不清|\/\[\^\/\]\*误/u, "不再有 /不清|误/");
    assert.doesNotMatch(src, /\.test\(String\(hit\.status/u, "不再对 hit.status 做正则");
    assert.doesNotMatch(src, /doubtLines\(hit\)\.length/u, "不再用核对要点有无内容兜底");
    // 已知状态 × 各种结论 × 有无存疑字段：前端与共用规则逐例相同。
    for (const status of KNOWN_STATUSES) {
      for (const decision of [undefined, "pending", "confirm", "issue", "ignore"]) {
        for (const extra of [{}, { coverage: { miss: ["CAPSULE"] } }, { evidence: "稿件少一个空格" }, { doubt_bucket: "ocr_graphic" }]) {
          const hit = { id: "h0", field: "中文品名", status, decision, ...extra } as FieldHit;
          assert.equal(isReviewIssue(hit), sharedIsReviewIssue(hit) && status !== "待人工确认", `${status} ${decision} ${JSON.stringify(extra)}`);
        }
      }
    }
  });

  it("未知状态（如「看不清」）两边都按状态异常拦", () => {
    for (const status of KNOWN_STATUSES) assert.equal(isValidHitReviewState({ status }), true, `${status} 服务端认得`);
    const { ui, server } = bothSides({ id: "h0", field: "中文品名", status: "看不清" });
    assert.equal(server, REVIEW_COPY.invalidHitStatusDetail(1));
    assert.equal(ui.title, server);
    assert.equal(ui.canSign, false);
  });
});

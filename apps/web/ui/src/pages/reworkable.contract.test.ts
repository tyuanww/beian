import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TaskDetail } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import { isDeadCompareFailed, isReworkableTask } from "./reviewActions";

/**
 * 前后端合同：核对页给不给「重新上传这一单」/「上传新稿」，与服务端 `/rework` 的 `isReworkableTask`（tasks.ts）逐例一致。
 * 服务端那份不是零依赖（读 DATA_DIR），前端照抄一份；这里同一批任务形状喂给两边，任一边改了就变红。
 */
const dataDir = mkdtempSync(join(tmpdir(), "beian-ui-reworkable-"));
process.once("exit", () => rmSync(dataDir, { recursive: true, force: true }));
process.env.WB_DATA_DIR = dataDir;
const server = await import("../../../server/src/tasks.ts");

const hit = (field = "中文品名") => ({ id: field, field, status: "疑点", decision: "pending" });
const failedCompare = { status: "compare_failed", job_kind: "compare", job_status: "failed" };
/** expected = 服务端；uiExpected 缺省同 expected。加码 Q4 服务端已放开无条目，前端 isReworkable 归前端哥对齐前两侧可暂不一致。 */
const CASES: ReadonlyArray<{ name: string; task: Record<string, unknown>; expected: boolean; uiExpected?: boolean }> = [
  { name: "待审", task: { status: "pending_review", hits: [hit()] }, expected: true },
  { name: "审核中", task: { status: "in_review" }, expected: true },
  { name: "待审但已有 pages_v2", task: { status: "pending_review", pages_v2: [{ url: "x" }] }, expected: false },
  { name: "红条：待审 + 对红失败", task: { status: "pending_review", job_kind: "rework", job_status: "failed", hits: [hit()] }, expected: true },
  { name: "已完成退回", task: { status: "completed", complete_kind: "rework" }, expected: true },
  { name: "已完成签字", task: { status: "completed", complete_kind: "sign" }, expected: false },
  { name: "检查中断带上一轮条目", task: { ...failedCompare, hits: [hit()] }, expected: true },
  { name: "检查中断带条目但有 pages_v2", task: { ...failedCompare, hits: [hit()], pages_v2: [{ url: "x" }] }, expected: false },
  // Q4：服务端 true；前端仍看条目数 → false，待前端哥去掉 activeHitCount 条件后两侧都 true、删 uiExpected
  { name: "检查中断没有条目", task: { ...failedCompare, hits: [] }, expected: true, uiExpected: false },
  { name: "检查中断只剩工艺表条目", task: { ...failedCompare, hits: [hit("工艺说明"), hit("颜色要求：专色"), hit("版本号"), hit("更新内容")] }, expected: true, uiExpected: false },
  { name: "检查中断：备案版本号不算工艺表", task: { ...failedCompare, hits: [hit("备案版本号")] }, expected: true },
  { name: "检查中断：非认字单 hits_v2 为空回落到 hits", task: { ...failedCompare, hits_v2: [], hits: [hit()] }, expected: true },
  // 认字单 hits_v2=[]：activeHits 空；Q4 服务端仍放行（只看 compare+failed），前端仍 false
  { name: "检查中断：认字单 hits_v2 为空数组就看它", task: { ...failedCompare, verbatim_check: true, hits_v2: [], hits: [hit()] }, expected: true, uiExpected: false },
  { name: "检查中断：认字单没有 hits_v2 看 hits", task: { ...failedCompare, verbatim_check: true, hits: [hit()] }, expected: true },
  { name: "检查中断：作业还在跑", task: { ...failedCompare, job_status: "running", hits: [hit()] }, expected: false },
  { name: "检查中断：作业不是对照", task: { ...failedCompare, job_kind: "rework", hits: [hit()] }, expected: false },
  { name: "检查中断：没有作业字段的老单", task: { status: "compare_failed", hits: [hit()] }, expected: false },
  { name: "对照中", task: { status: "comparing", hits: [hit()] }, expected: false },
];

describe("isReworkableTask 前后端一致（加码 Q4 暂允许 uiExpected 与 expected 不同）", () => {
  for (const c of CASES) {
    it(c.name, () => {
      assert.equal(server.isReworkableTask(c.task as Parameters<typeof server.isReworkableTask>[0]), c.expected, "服务端");
      assert.equal(isReworkableTask(c.task as unknown as TaskDetail), c.uiExpected ?? c.expected, "前端");
    });
  }
});

describe("对照失败没有有效条目：前端 isDeadCompareFailed 仍与 activeHits 空对齐；服务端 Q4 已放行 /rework", () => {
  for (const c of CASES.filter((x) => x.task.status === "compare_failed")) {
    it(c.name, () => {
      const t = c.task as Parameters<typeof server.isReworkableTask>[0];
      const serverEmpty = server.activeHits(t as Parameters<typeof server.activeHits>[0]).length === 0;
      assert.equal(isDeadCompareFailed(c.task as unknown as TaskDetail), serverEmpty);
      // Q4：无有效条目不再挡 /rework；仍要求 compare + failed（本表 expected 已体现）
      if (serverEmpty && c.expected) {
        assert.equal(server.isReworkableTask(t), true, "加码 Q4：无有效条目的对照失败单服务端放行 /rework");
      }
    });
  }
  it("文案逐字（前端哥会把回首页改成可以重新上传这一单）", () => {
    assert.equal(REVIEW_COPY.compareFailedNoHits, "这一单没法接着核了，请回首页重新新建一单");
    assert.equal(REVIEW_COPY.backHome, "回首页");
  });
});

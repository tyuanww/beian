import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeGate } from "./completeGate.js";
import { makeTestTempDir } from "./testTemp.js";
import type { Task } from "./tasks.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-complete-gate-");

function task(hits: Task["hits"]): Task {
  return {
    id: "c0de00000001",
    title: "工艺说明",
    product_name: "工艺说明",
    type: "excel_pdf",
    status: "in_review",
    hits,
  } as Task;
}

describe("completeGate 工艺说明过滤（加码 Q6）", () => {
  it("只剩工艺说明条目未决：activeHits 已滤掉，签字放行（行为与重复 filter 时相同）", () => {
    const gate = completeGate(
      task([
        { id: "ok", field: "净含量", status: "一致", decision: "confirm" },
        { id: "proc", field: "工艺说明", status: "疑点", decision: "pending" },
      ]),
      undefined,
    );
    assert.equal(gate.ok, true);
    if (gate.ok) assert.equal(gate.kind, "signed");
  });

  it("只有工艺说明条目、没有其它 hits：同样放行", () => {
    const gate = completeGate(
      task([{ id: "proc", field: "工艺说明", status: "疑点", decision: "pending" }]),
      undefined,
    );
    assert.equal(gate.ok, true);
  });
});

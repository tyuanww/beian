import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CREATOR_UNRECORDED, creatorLabel } from "../copy/labels.js";
import { filterHistoryRows, historyActors, historyMockRow, historyTaskRow } from "./historyRows.js";

describe("生成人为 null", () => {
  it("creatorLabel：null / 缺省 / 空白显示「未记录」，有名字原样", () => {
    assert.equal(CREATOR_UNRECORDED, "未记录");
    assert.equal(creatorLabel(null), "未记录");
    assert.equal(creatorLabel(undefined), "未记录");
    assert.equal(creatorLabel("  "), "未记录");
    assert.equal(creatorLabel(" 籽烨 "), "籽烨");
  });

  it("历史行：owner 为 null 不报错，显示「未记录」，可筛选、可排序", () => {
    const task = historyTaskRow({ id: "t1", title: "花盒", type: "pack", status: "in_review", owner: null });
    const mock = historyMockRow({ id: "m1", status: "done", owner: null, files: [] });
    const named = historyTaskRow({ id: "t2", title: "瓶", type: "pack", status: "in_review", owner: "籽烨" });
    assert.equal(task.actor, "未记录");
    assert.equal(mock.actor, "未记录");
    assert.deepEqual(historyActors([task, mock, named]).sort(), ["未记录", "籽烨"].sort());
    const rows = filterHistoryRows([task, mock, named], { kind: "all", time: "all", actor: "未记录" });
    assert.deepEqual(rows.map((row) => row.id), ["t1", "m1"]);
  });
});

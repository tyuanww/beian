import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CREATOR_UNRECORDED, creatorLabel } from "../copy/labels.js";
import { matchesDeskQuery } from "./uploadDesk.js";
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
    // 排序：historyActors 按 zh-CN 排，「未记录」与真名一起参与排序，结果与输入顺序无关。
    const expected = ["未记录", "籽烨"].sort((a, b) => a.localeCompare(b, "zh-CN"));
    assert.deepEqual(historyActors([task, mock, named]), expected);
    assert.deepEqual(historyActors([named, mock, task]), expected);
    // 搜索：按「未记录」能搜到、按真名搜不到 null 行。
    assert.equal(matchesDeskQuery("未记录", task.actor), true);
    assert.equal(matchesDeskQuery("籽烨", task.actor), false);
    assert.deepEqual([task, mock, named].filter((row) => matchesDeskQuery("未记录", row.actor)).map((row) => row.id), ["t1", "m1"]);
    const rows = filterHistoryRows([task, mock, named], { kind: "all", time: "all", actor: "未记录" });
    assert.deepEqual(rows.map((row) => row.id), ["t1", "m1"]);
  });
});

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-ts-");

const { activeHits, boardColumn, deleteTask, hasReworkPages, hitNeedsDecision, isHitDecision, isReviewableStatus, isReworkableStatus, isReworkableTask, isValidHitReviewState, listTasks, loadTask, pendingWord, saveTask } = await import("./tasks.js");

const admin = { id: "ou_admin", name: "管理员", admin: true };

describe("listTasks", () => {
  before(() => {
    saveTask({
      id: "aaaaaaaaaaaa",
      title: "某某精华",
      product_name: "某某精华",
      type: "excel_pdf",
      status: "in_review",
      created_at: "2026-08-19T10:00:00Z",
    });
    saveTask({
      id: "bbbbbbbbbbbb",
      title: "另一支霜",
      product_name: "另一支霜",
      type: "excel_pdf",
      status: "completed",
      created_at: "2026-08-19T09:00:00Z",
    });
  });

  it("待签在前", () => {
    const rows = listTasks("", admin);
    assert.equal(rows[0]?.product_name, "某某精华");
    assert.equal(rows[1]?.product_name, "另一支霜");
  });

  it("按品名搜", () => {
    const rows = listTasks("精华", admin);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "aaaaaaaaaaaa");
  });

  it("搜不到为空", () => {
    assert.deepEqual(listTasks("没有这个品", admin), []);
  });

  it("对照失败不进对照中列", () => {
    assert.equal(boardColumn("compare_failed"), "failed");
    assert.equal(boardColumn("comparing", "failed"), "failed");
    assert.equal(boardColumn("comparing", "running"), "comparing");
  });

  it("deleteTask removes the json", () => {
    saveTask({
      id: "cccccccccccc",
      title: "删我",
      product_name: "删我",
      type: "excel_pdf",
      status: "compare_failed",
      created_at: "2026-08-19T08:00:00Z",
    });
    deleteTask("cccccccccccc");
    assert.throws(() => loadTask("cccccccccccc"), /任务不存在/);
  });

  it("reviewer only sees own owner rows", () => {
    saveTask({
      id: "eeeeeeeeeeee",
      title: "爱丽丝",
      product_name: "爱丽丝",
      type: "excel_pdf",
      status: "pending_review",
      created_at: "2026-08-19T11:00:00Z",
      owner: "ou_alice",
      created_by: "同名",
    });
    const alice = { id: "ou_alice", name: "同名", admin: false };
    const bob = { id: "ou_bob", name: "同名", admin: false };
    assert.equal(listTasks("", alice).some((r) => r.id === "eeeeeeeeeeee"), true);
    assert.equal(listTasks("", bob).some((r) => r.id === "eeeeeeeeeeee"), false);
    assert.equal(listTasks("", alice).some((r) => r.id === "aaaaaaaaaaaa"), false);
  });

  it("deleteTask refuses a running compare", () => {
    saveTask({
      id: "dddddddddddd",
      title: "跑着",
      product_name: "跑着",
      type: "excel_pdf",
      status: "comparing",
      job_status: "running",
      created_at: "2026-08-19T08:01:00Z",
    });
    assert.throws(() => deleteTask("dddddddddddd"), /还在跑/);
    assert.equal(loadTask("dddddddddddd").id, "dddddddddddd");
  });
});

describe("review gates", () => {
  it("only pending_review and in_review are reviewable", () => {
    assert.equal(isReviewableStatus("pending_review"), true);
    assert.equal(isReviewableStatus("in_review"), true);
    assert.equal(isReviewableStatus("compare_failed"), false);
    assert.equal(isReviewableStatus("comparing"), false);
    assert.equal(isReviewableStatus("completed"), false);
  });

  it("only confirm issue ignore are hit decisions", () => {
    assert.equal(isHitDecision("confirm"), true);
    assert.equal(isHitDecision("issue"), true);
    assert.equal(isHitDecision("ignore"), true);
    assert.equal(isHitDecision("pending"), false);
    assert.equal(isHitDecision("ai_pass"), false);
    assert.equal(isHitDecision(""), false);
  });

  it("fails closed for unknown hit statuses and decisions", () => {
    assert.equal(isValidHitReviewState({ status: "疑点", decision: "pending" }), true);
    assert.equal(isValidHitReviewState({ status: "一致", decision: "confirm" }), true);
    assert.equal(isValidHitReviewState({ status: "新状态", decision: "pending" }), false);
    assert.equal(isValidHitReviewState({ status: "疑点", decision: "confirmed" }), false);
    assert.equal(hitNeedsDecision({ status: "疑点", decision: "confirmed" }), true);
    assert.equal(hitNeedsDecision({ status: "缺失", decision: "pending" }), true);
    assert.equal(hitNeedsDecision({ status: "疑点", decision: "ignore" }), false);
    assert.equal(hitNeedsDecision({ status: "一致" }), false);
    assert.equal(hitNeedsDecision({ status: "一致", coverage: { miss: ["CAPSULE MIST"] } }), true);
    assert.equal(hitNeedsDecision({ status: "一致", coverage: { miss: ["CAPSULE MIST"] }, decision: "confirm" }), false);
    assert.equal(hitNeedsDecision({ status: "一致", coverage: { miss: ["  "] } }), false);
    // 认字存疑走共用 hasReadingDoubt：已标记条目才看 sequence_diff / doubt_bucket，不看说明文字。
    assert.equal(hitNeedsDecision({ status: "缺空格", sequence_diff: { only_in_excel: ["香柠檬"] } }), true);
    assert.equal(hitNeedsDecision({ status: "缺空格", doubt_bucket: "ocr_graphic" }), true);
    assert.equal(hitNeedsDecision({ status: "一致", sequence_diff: { only_in_excel: ["香柠檬"] } }), false);
    assert.equal(hitNeedsDecision({ status: "一致", doubt_bucket: "ocr_smallprint" }), false);
    assert.equal(hitNeedsDecision({ status: "一致", note: "认字存疑" }), false);
    // 拦截文案填的词：按状态要结论的写状态，只因认字存疑要结论的写「认字存疑」。
    assert.equal(pendingWord({ status: "疑点", decision: "pending", coverage: { miss: ["x"] } }), "疑点");
    assert.equal(pendingWord({ status: "多空格", decision: "pending" }), "多空格");
    assert.equal(pendingWord({ status: "一致", coverage: { miss: ["x"] } }), "认字存疑");
    assert.equal(pendingWord({ status: "缺空格", doubt_bucket: "ocr_graphic" }), "认字存疑");
    assert.equal(pendingWord({ status: "一致", coverage: { miss: ["x"] }, decision: "confirm" }), null);
    assert.equal(pendingWord({ status: "待人工确认" }), null);
  });

  it("lets signed tasks and interrupted compares with hits rework, but not other failed or comparing ones", () => {
    assert.equal(isReworkableStatus("pending_review"), true);
    assert.equal(isReworkableStatus("in_review"), true);
    assert.equal(isReworkableStatus("completed"), true);
    assert.equal(isReworkableStatus("compare_failed"), false);
    assert.equal(isReworkableStatus("comparing"), false);
    assert.equal(hasReworkPages({}), false);
    assert.equal(hasReworkPages({ pages_v2: [] }), false);
    assert.equal(hasReworkPages({ pages_v2: [{ url: "/x.png" }] }), true);
    assert.equal(isReworkableTask({ status: "pending_review" }), true);
    assert.equal(isReworkableTask({ status: "in_review" }), true);
    assert.equal(isReworkableTask({ status: "completed", complete_kind: "rework" }), true);
    assert.equal(isReworkableTask({ status: "completed", complete_kind: "signed" }), false);
    const interrupted = { status: "compare_failed", job_kind: "compare" as const, job_status: "failed" as const, hits: [{ id: "h1", field: "净含量", status: "疑点" }] };
    assert.equal(isReworkableTask(interrupted), true);
    assert.equal(isReworkableTask({ ...interrupted, hits: [] }), false);
    assert.equal(isReworkableTask({ ...interrupted, pages_v2: [{ url: "/x.png" }] }), false);
    assert.equal(isReworkableTask({ ...interrupted, job_kind: "rework" as const }), false);
    assert.equal(isReworkableTask({ ...interrupted, job_status: "succeeded" as const }), false);
    assert.equal(
      isReworkableTask({ status: "completed", complete_kind: "rework", pages_v2: [{ url: "/x.png" }] }),
      false,
    );
    assert.deepEqual(
      activeHits({
        id: "aaaaaaaaaaaa",
        title: "x",
        type: "excel_pdf",
        status: "in_review",
        hits: [{ id: "h1" }],
        hits_v2: [
          { id: "v2_h1", field: "中文品名" },
          { id: "v2_h2", field: "更新内容：第二版" },
        ],
      }).map((hit) => hit.id),
      ["v2_h1"],
    );
    assert.equal(
      activeHits({
        id: "aaaaaaaaaaaa",
        title: "x",
        type: "excel_pdf",
        status: "in_review",
        hits: [{ id: "h1" }],
        hits_v2: [],
      })[0]?.id,
      "h1",
    );
    assert.deepEqual(
      activeHits({
        id: "aaaaaaaaaaaa",
        title: "x",
        type: "excel_pdf",
        status: "in_review",
        hits: [
          { id: "h1", field: "中文品名" },
          { id: "h2", field: "更新内容：第二版" },
          { id: "h3", field: "备案版本号" },
          { id: "h4", field: "执行标准版本号" },
        ],
      }).map((hit) => hit.id),
      ["h1", "h3", "h4"],
    );
  });
});

describe("listTasks complete_kind", () => {
  it("exposes complete_kind on signed and returned rows, null while open", () => {
    saveTask({ id: "c1c1c1c1c1c1", title: "签字件", type: "excel_pdf", status: "completed", complete_kind: "signed", created_at: "2026-08-18T09:00:00Z" });
    saveTask({ id: "c2c2c2c2c2c2", title: "退回件", type: "excel_pdf", status: "completed", complete_kind: "rework", created_at: "2026-08-18T08:00:00Z" });
    const rows = listTasks("", admin);
    assert.equal(rows.find((r) => r.id === "c1c1c1c1c1c1")?.complete_kind, "signed");
    assert.equal(rows.find((r) => r.id === "c2c2c2c2c2c2")?.complete_kind, "rework");
    assert.equal(rows.find((r) => r.id === "aaaaaaaaaaaa")?.complete_kind, null);
  });

  it("hides a stale complete_kind once a returned task is reopened for rework", () => {
    saveTask({ id: "c3c3c3c3c3c3", title: "改稿中", type: "excel_pdf", status: "in_review", complete_kind: "rework", created_at: "2026-08-18T07:00:00Z" });
    assert.equal(listTasks("", admin).find((r) => r.id === "c3c3c3c3c3c3")?.complete_kind, null);
  });

  it("normalizes unknown or legacy complete_kind to null like history", () => {
    saveTask({ id: "c4c4c4c4c4c4", title: "怪值", type: "excel_pdf", status: "completed", complete_kind: "approved", created_at: "2026-08-18T06:00:00Z" });
    saveTask({ id: "c5c5c5c5c5c5", title: "旧件", type: "excel_pdf", status: "completed", created_at: "2026-08-18T05:00:00Z" });
    const rows = listTasks("", admin);
    assert.equal(rows.find((r) => r.id === "c4c4c4c4c4c4")?.complete_kind, null);
    assert.equal(rows.find((r) => r.id === "c5c5c5c5c5c5")?.complete_kind, null);
  });
});

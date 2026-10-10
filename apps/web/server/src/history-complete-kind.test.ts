import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-history-kind-");
const { DATA_DIR } = await import("./config.js");
const { HistoryProblem, noteHistoryReview, queryHistory } = await import("./historyIndex.js");
const viewer = { id: "ou_kind", name: "合成用户", admin: false };
const indexPath = join(DATA_DIR, "history", "index.json");
const review = { type: ["review"] };

function writeTask(task: Record<string, unknown>): void {
  mkdirSync(join(DATA_DIR, "tasks"), { recursive: true });
  writeFileSync(join(DATA_DIR, "tasks", `${String(task.id)}.json`), JSON.stringify(task));
}

function settle(): ReturnType<typeof queryHistory> {
  for (let i = 0; i < 20; i++) {
    try { return queryHistory(viewer, review); } catch (error) { if (!(error instanceof HistoryProblem) || error.status !== 503) throw error; }
  }
  throw new Error("history index did not settle");
}

it("adds complete_kind to review history items and rebuilds legacy summaries without it", () => {
  const base = { type: "excel_pdf", created_at: "2026-10-01T00:00:00.000Z", owner: viewer.id, created_by: viewer.name };
  writeTask({ ...base, id: "a00000000001", title: "签字件", status: "completed", complete_kind: "signed" });
  writeTask({ ...base, id: "a00000000002", title: "退回件", status: "completed", complete_kind: "rework" });
  writeTask({ ...base, id: "a00000000003", title: "待审件", status: "in_review" });
  // Legacy trusted summary: review records carry no complete_kind key.
  const legacy = ["a00000000001", "a00000000002", "a00000000003"].map((id) => ({ id, type: "review", title: id, product_name: "",
    status: id.endsWith("3") ? "in_review" : "completed", created_at: base.created_at, creator_id: viewer.id, creator_name: viewer.name,
    names: [], visibility: "owner", access_owner: viewer.id, expires_at: null }));
  mkdirSync(join(DATA_DIR, "history"), { recursive: true });
  writeFileSync(indexPath, JSON.stringify({ schema_version: 1, trusted: true, records: legacy, overlay: [], scan: null }));

  const page = settle();
  const kind = (id: string) => page.items.find((item) => item.id === id)?.complete_kind;
  assert.equal(page.total, 3);
  assert.equal(kind("a00000000001"), "signed");
  assert.equal(kind("a00000000002"), "rework");
  assert.equal(kind("a00000000003"), null);
  const stored = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(stored.records.every((record: Record<string, unknown>) => "complete_kind" in record), true);

  noteHistoryReview({ ...base, id: "a00000000003", title: "待审件", status: "completed", complete_kind: "rework" });
  assert.equal(queryHistory(viewer, review).items.find((item) => item.id === "a00000000003")?.complete_kind, "rework");
  // Unknown values never leak into the API.
  noteHistoryReview({ ...base, id: "a00000000001", title: "签字件", status: "completed", complete_kind: "bogus" });
  assert.equal(queryHistory(viewer, review).items.find((item) => item.id === "a00000000001")?.complete_kind, null);
});

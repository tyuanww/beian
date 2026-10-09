import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-history-filter-");
const { DATA_DIR } = await import("./config.js");
const { HISTORY_SEGMENT_SIZE, HistoryProblem, noteHistoryCompression, queryHistory } = await import("./historyIndex.js");
const viewer = { id: "ou_history", name: "合成用户", admin: false };
const indexPath = join(DATA_DIR, "history", "index.json");
const query = { type: ["compression"], status: ["unmet_target"] };

it("filters unmet PDF targets from private summaries without changing the batch status or rereading sources", () => {
  const records = Array.from({ length: HISTORY_SEGMENT_SIZE + 1 }, (_, number) => {
    const id = number.toString(16).padStart(12, "0");
    const source = { id, title: `合成压缩 ${number}`, status: "partial", created_at: "2026-10-01T00:00:00.000Z", owner_id: viewer.id,
      files: [{ name: "/private/artwork/target.pdf", status: "unmet_target" }, { name: "ok.jpg", status: "succeeded" }] };
    const dir = join(DATA_DIR, "compressions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "batch.json"), JSON.stringify(source));
    // Legacy trusted summaries did not carry the private target marker.
    return { id, type: "compression", title: source.title, product_name: "", status: source.status, created_at: source.created_at,
      creator_id: viewer.id, creator_name: viewer.id, names: ["target.pdf", "ok.jpg"], visibility: "team", access_owner: viewer.id, expires_at: null };
  });
  mkdirSync(join(DATA_DIR, "history"), { recursive: true });
  writeFileSync(indexPath, JSON.stringify({ schema_version: 1, trusted: true, records, overlay: [], scan: null }));
  assert.throws(() => queryHistory(viewer, query), (error: unknown) => error instanceof HistoryProblem && error.status === 503);
  const rebuilding = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(rebuilding.trusted, false);
  assert.equal(rebuilding.records.length, HISTORY_SEGMENT_SIZE);
  assert.throws(() => queryHistory(viewer, query), (error: unknown) => error instanceof HistoryProblem && error.status === 503);
  const page = queryHistory(viewer, query);
  assert.equal(page.total, HISTORY_SEGMENT_SIZE + 1);
  assert.equal(page.facets.status.unmet_target, HISTORY_SEGMENT_SIZE + 1);
  assert.equal(page.facets.status.partial, HISTORY_SEGMENT_SIZE + 1);
  assert.equal(page.items.every(item => item.status === "partial"), true);
  assert.equal(JSON.stringify(page).includes("has_unmet_target"), false);
  assert.equal(JSON.stringify(page).includes("/private/artwork"), false);
  assert.equal(queryHistory(viewer, { status: ["unmet_target"] }).total, HISTORY_SEGMENT_SIZE + 1);
  assert.throws(() => queryHistory(viewer, { type: ["review"], status: ["unmet_target"] }), HistoryProblem);
  assert.throws(() => queryHistory(viewer, { type: ["mockup"], status: ["unmet_target"] }), HistoryProblem);

  const id = records[0].id;
  const path = join(DATA_DIR, "compressions", id, "batch.json");
  const batch = JSON.parse(readFileSync(path, "utf8"));
  batch.files[0].status = "failed";
  writeFileSync(path, JSON.stringify(batch));
  // Trusted queries stay on the index until the persistence hook updates it.
  assert.equal(queryHistory(viewer, query).total, HISTORY_SEGMENT_SIZE + 1);
  noteHistoryCompression(batch);
  assert.equal(queryHistory(viewer, query).total, HISTORY_SEGMENT_SIZE);
  const summary = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(summary.records.find((record: { id: string }) => record.id === id).has_unmet_target, false);
});

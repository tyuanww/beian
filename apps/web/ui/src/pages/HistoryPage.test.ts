import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HISTORY_STORAGE_VERSION, historyRowAction, historyStorageKey, restore } from "./HistoryPage.js";
import { emptyHistoryFilters } from "./historyQuery.js";
import type { HistoryRow } from "./historyRows.js";

function row(kind: HistoryRow["kind"], color: HistoryRow["color"] = "success"): HistoryRow {
  return {
    resource: kind === "compare" ? "task" : "mockup",
    kind,
    id: `${kind}-1`,
    title: "花盒",
    status: color === "processing" ? "检查中" : "已完成",
    color,
    at: "2026-08-26T00:00:00.000Z",
    actor: "籽烨",
    live: color === "processing" ? "认字" : null,
  };
}

describe("historyRowAction", () => {
  it("opens either desk outside batch-edit mode", () => {
    assert.equal(historyRowAction(row("compare"), false), "open-task");
    assert.equal(historyRowAction(row("mockup"), false), "open-mockup");
  });

  it("selects deletable rows but blocks running rows in batch-edit mode", () => {
    assert.equal(historyRowAction(row("compare"), true), "toggle");
    assert.equal(historyRowAction(row("compare", "processing"), true), "blocked");
  });
});

describe("history filter storage v3", () => {
  const store = (entries: Record<string, string>) => ({ getItem: (key: string) => entries[key] ?? null });
  const saved = (filters: Record<string, unknown>) =>
    JSON.stringify({ filters, cursors: [""], page: 0, scroll: 0 });

  it("bumps the session key from v2 to v3", () => {
    assert.equal(HISTORY_STORAGE_VERSION, "v3");
    assert.equal(historyStorageKey("籽烨"), "beian:history:v3:籽烨");
  });

  it("ignores a v2 entry so old saved Chinese filters never reach the API", () => {
    const storage = store({ "beian:history:v2:籽烨": saved({ type: "审稿台", status: "已完成" }) });
    const state = restore(historyStorageKey("籽烨"), storage);
    assert.deepEqual(state.filters, emptyHistoryFilters);
  });

  it("falls back to 全部 when an old Chinese filter value is restored, without throwing", () => {
    const storage = store({
      [historyStorageKey("籽烨")]: saved({ q: "花盒", type: "审稿台", status: "已完成", time_mode: "近 7 天" }),
    });
    assert.doesNotThrow(() => restore(historyStorageKey("籽烨"), storage));
    const state = restore(historyStorageKey("籽烨"), storage);
    assert.equal(state.filters.type, "");
    assert.equal(state.filters.status, "");
    assert.equal(state.filters.time_mode, "all");
    assert.equal(state.filters.q, "花盒");
  });

  it("keeps valid English keys", () => {
    const storage = store({ [historyStorageKey("a")]: saved({ type: "mockup", status: "unmet_target", time_mode: "all" }) });
    const state = restore(historyStorageKey("a"), storage);
    assert.equal(state.filters.type, "mockup");
    assert.equal(state.filters.status, "unmet_target");
  });

  it("survives broken JSON and a missing storage", () => {
    assert.deepEqual(restore("k", store({ k: "{oops" })).filters, emptyHistoryFilters);
    assert.deepEqual(restore("k", null).filters, emptyHistoryFilters);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueNavigation, readReviewSession, readSidebar, reviewSessionKey, sidebarWidth, writeReviewSession, writeSidebar } from "./reviewWorkspaceState.js";

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("fixed review sidebar", () => {
  it("keeps the canvas usable without overwriting the preferred desktop width", () => {
    const store = storage();
    store.setItem("wb_review_dock_size_v2", '{"w":900}');
    assert.deepEqual(readSidebar(store, "a"), { width: 448, open: true });
    writeSidebar(store, "a", { width: 560, open: false });
    assert.equal(sidebarWidth(readSidebar(store, "a").width, 808), 320);
    assert.deepEqual(readSidebar(store, "a"), { width: 560, open: false });
    assert.deepEqual(readSidebar(store, "b"), { width: 448, open: true });
    assert.equal(sidebarWidth(Number.NaN, 1500), 448);
    assert.equal(sidebarWidth(9999, 1500), 560);
    assert.equal(sidebarWidth(-1, 1500), 320);
  });
  it("handles corrupt/denied storage and does not persist unidentified users", () => {
    const store = storage();
    writeSidebar(store, null, { width: 500, open: false });
    assert.equal(store.values.size, 0);
    assert.equal(readSidebar({ getItem() { throw new Error("denied"); }, setItem() {} }, "a").width, 448);
    store.setItem("wb_review_sidebar_v1:a", "{");
    assert.equal(readSidebar(store, "a").width, 448);
  });
  it("isolates drafts by identity, task and artwork version", () => {
    const store = storage();
    const key = reviewSessionKey("a", "task", false);
    writeReviewSession(store, key, { activeId: "h2", drafts: { h2: "unsaved note" } });
    assert.deepEqual(readReviewSession(store, key), { activeId: "h2", drafts: { h2: "unsaved note" } });
    for (const other of [reviewSessionKey("b", "task", false), reviewSessionKey("a", "other", false), reviewSessionKey("a", "task", true)]) {
      assert.deepEqual(readReviewSession(store, other).drafts, {});
    }
    assert.equal(reviewSessionKey(null, "task", false), null);
    store.setItem(key!, '{"drafts":{"h2":1},"activeId":2}');
    assert.deepEqual(readReviewSession(store, key), { activeId: undefined, drafts: {} });
  });
  it("navigates a long pending directory, skips resolved items and wraps next pending", () => {
    const hits = Array.from({ length: 24 }, (_, i) => ({ id: String(i), field: `field ${i}`, status: "疑点", decision: i % 2 ? "confirm" : "pending" }));
    const nav = issueNavigation(hits, 4, true);
    assert.equal(nav.visible.length, 12);
    assert.equal(nav.previous, 2);
    assert.equal(nav.next, 6);
    assert.equal(nav.nextPending, 6);
    assert.equal(issueNavigation(hits, 23, true).nextPending, 0);
    assert.equal(issueNavigation(hits.map((h) => ({ ...h, decision: "ignore" })), 0, true).nextPending, null);
    assert.equal(issueNavigation([], 0, true).previous, null);
  });
});

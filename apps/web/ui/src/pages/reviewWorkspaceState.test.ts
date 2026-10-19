import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issueNavigation, readReviewSession, reviewSessionKey, writeReviewSession } from "./reviewWorkspaceState.js";

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("review session", () => {
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

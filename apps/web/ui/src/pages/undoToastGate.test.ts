import assert from "node:assert/strict";
import test from "node:test";
import { createFlagStore } from "./undoToastGate";

test("FlagStore：值变化才通知，取消订阅后不再通知", () => {
  const store = createFlagStore();
  let calls = 0;
  const off = store.subscribe(() => { calls += 1; });
  assert.equal(store.get(), false);
  store.set(false);
  assert.equal(calls, 0);
  store.set(true);
  assert.equal(store.get(), true);
  assert.equal(calls, 1);
  off();
  store.set(false);
  assert.equal(calls, 1);
  assert.equal(store.get(), false);
});

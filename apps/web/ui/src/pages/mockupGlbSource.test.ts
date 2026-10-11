import assert from "node:assert/strict";
import test from "node:test";
import { glbAttempts, glbSourceUrls, glbVersions, whenIdle } from "./mockupGlbSource";

const base = "/api/mockups/m1/files/glb?generation_id=g1-abc";
const files = [{ key: "white_a" }, { key: "glb", glb_version: "aaaa1111bbbb2222", glb_original_version: "cccc3333dddd4444" }];

test("两个地址都带各自的 ?v=，地址不同所以缓存分开（找茬哥 b）", () => {
  const urls = glbSourceUrls(base, glbVersions(files));
  assert.equal(urls.primary, "/api/mockups/m1/files/glb?generation_id=g1-abc&v=aaaa1111bbbb2222");
  assert.equal(urls.original, "/api/mockups/m1/files/glb?generation_id=g1-abc&variant=original&v=cccc3333dddd4444");
  assert.notEqual(urls.primary, urls.original);
});

test("没有版本字段时不带 v，原始地址仍带 variant=original", () => {
  const urls = glbSourceUrls("/api/mockups/m1/files/glb", glbVersions([{ key: "glb" }]));
  assert.equal(urls.primary, "/api/mockups/m1/files/glb");
  assert.equal(urls.original, "/api/mockups/m1/files/glb?variant=original");
  assert.deepEqual(glbVersions(undefined), { glb_version: undefined, glb_original_version: undefined });
  assert.deepEqual(glbVersions([{ key: "glb", glb_version: " ", glb_original_version: 3 } as never]), { glb_version: undefined, glb_original_version: undefined });
});

test("两版本不同：WebP 本机解码不了直接拉原始；能解码先默认再退原始；探测中先不拉", () => {
  const v = glbVersions(files); const urls = glbSourceUrls(base, v);
  assert.deepEqual(glbAttempts("fallback", urls, v), [urls.original]);
  assert.deepEqual(glbAttempts("load", urls, v), [urls.primary, urls.original]);
  assert.equal(glbAttempts("detecting", urls, v), null);
});

test("开关关着（没有版本字段）或两版本相同：只拉默认地址，不做 WebP 版退原始", () => {
  for (const v of [glbVersions([{ key: "glb" }]), glbVersions([{ key: "glb", glb_version: "eeee", glb_original_version: "eeee" } as never])]) {
    const urls = glbSourceUrls(base, v);
    assert.deepEqual(glbAttempts("load", urls, v), [urls.primary]);
    assert.deepEqual(glbAttempts("fallback", urls, v), []);
  }
  assert.equal(glbSourceUrls(base, glbVersions([{ key: "glb" }])).primary, base);
});

test("whenIdle 优先 requestIdleCallback（带 timeout），没有时退 setTimeout，且可取消", () => {
  const calls: string[] = [];
  const idle = { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => { calls.push(`idle:${o?.timeout}`); cb(); return 7; },
    cancelIdleCallback: (id: number) => calls.push(`cancel:${id}`), setTimeout: () => 0, clearTimeout: () => undefined };
  const stop = whenIdle(() => calls.push("run"), 1500, idle); stop();
  assert.deepEqual(calls, ["idle:1500", "run", "cancel:7"]);
  const timers: Array<() => void> = []; let cleared = false;
  const plain = { setTimeout: (cb: () => void) => { timers.push(cb); return 1; }, clearTimeout: () => { cleared = true; } };
  let ran = false; const cancel = whenIdle(() => { ran = true; }, 1500, plain);
  timers[0](); assert.equal(ran, true); cancel(); assert.equal(cleared, true);
});

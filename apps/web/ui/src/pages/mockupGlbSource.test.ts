import assert from "node:assert/strict";
import test from "node:test";
import { glbAttempts, glbSourceUrls, glbVersions } from "./mockupGlbSource";

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

test("WebP 本机解码不了直接拉原始；能解码先默认再退原始；探测中先不拉", () => {
  const urls = glbSourceUrls(base, glbVersions(files));
  assert.deepEqual(glbAttempts("fallback", urls), [urls.original]);
  assert.deepEqual(glbAttempts("load", urls), [urls.primary, urls.original]);
  assert.deepEqual(glbAttempts("detecting", urls), []);
});

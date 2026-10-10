import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  glbPosterKey, glbProgressFromBytes, glbProgressFromFraction, parseContentLength, readGlbWithProgress,
  type GlbProgress,
} from "./mockupGlbProgress.js";

function streamed(chunks: number[], headers: Record<string, string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(7));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

describe("GLB 加载进度", () => {
  it("total 未知时为 indeterminate", () => {
    assert.deepEqual(glbProgressFromBytes(1000, null), { kind: "indeterminate" });
    assert.deepEqual(glbProgressFromBytes(1000, 0), { kind: "indeterminate" });
    assert.deepEqual(glbProgressFromBytes(NaN, 10), { kind: "indeterminate" });
  });
  it("total 已知时给出 0–100 的百分比", () => {
    assert.deepEqual(glbProgressFromBytes(0, 200), { kind: "percent", percent: 0 });
    assert.deepEqual(glbProgressFromBytes(101, 200), { kind: "percent", percent: 50 });
    assert.deepEqual(glbProgressFromBytes(300, 200), { kind: "percent", percent: 100 });
  });
  it("model-viewer 的 0/1/非法值不当作真实进度", () => {
    for (const value of [0, 1, -1, 2, NaN, undefined, "0.5"]) {
      assert.deepEqual(glbProgressFromFraction(value), { kind: "indeterminate" });
    }
    assert.deepEqual(glbProgressFromFraction(0.426), { kind: "percent", percent: 42 });
  });
  it("只接受正整数 Content-Length", () => {
    assert.equal(parseContentLength(null), null);
    assert.equal(parseContentLength("abc"), null);
    assert.equal(parseContentLength("0"), null);
    assert.equal(parseContentLength(" 3450714 "), 3450714);
  });
  it("有 Content-Length 时流式回报百分比并拼回完整字节", async () => {
    const seen: GlbProgress[] = [];
    const bytes = await readGlbWithProgress(streamed([30, 70], { "content-length": "100" }), (p) => seen.push(p));
    assert.equal(bytes.byteLength, 100);
    assert.equal(bytes[99], 7);
    assert.deepEqual(seen.map((p) => p.kind === "percent" ? p.percent : -1), [0, 30, 100]);
  });
  it("无 Content-Length 或带 Content-Encoding 时保持 indeterminate", async () => {
    for (const headers of [{} as Record<string, string>, { "content-length": "50", "content-encoding": "gzip" }]) {
      const seen: GlbProgress[] = [];
      const bytes = await readGlbWithProgress(streamed([20, 30], headers), (p) => seen.push(p));
      assert.equal(bytes.byteLength, 50);
      assert.ok(seen.every((p) => p.kind === "indeterminate"));
    }
  });
  it("流读取出错时向上抛出，由调用方切到 error", async () => {
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("net")); } });
    await assert.rejects(readGlbWithProgress(new Response(body), () => undefined), /net/);
  });
});

describe("GLB poster 选择", () => {
  it("白桌白墙优先桌墙审阅卡，其他背景用白底图，没有则 null", () => {
    const files = [{ key: "white_a" }, { key: "white_a_card" }, { key: "white_a_set" }];
    assert.equal(glbPosterKey(files, "white_set"), "white_a_set");
    assert.equal(glbPosterKey(files, "white"), "white_a_card");
    assert.equal(glbPosterKey([{ key: "glb" }], "silver"), null);
    assert.equal(glbPosterKey(undefined, "white_set"), null);
  });
});

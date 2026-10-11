import assert from "node:assert/strict";
import test from "node:test";
import {
  GLB_TEXTURE_FORMAT_FIELD, GLB_WEBP_UNSUPPORTED_TEXT, createWebpSupport, glbTextureFormat, glbTextureGate, probeWebpDecode, webpProbeBlob,
  type WebpDecoder,
} from "./mockupGlbTexture";

const glb = (extra: Record<string, unknown> = {}) => [{ key: "white_a" }, { key: "glb", ...extra }];
const gateFor = (files: ReturnType<typeof glb>, supported: boolean | null) => glbTextureGate(glbTextureFormat(files), supported);

test("缺 texture_format 的旧单照常加载 3D，不等探测", () => {
  assert.equal(gateFor(glb(), null), "load");
  assert.equal(gateFor(glb(), false), "load");
  assert.equal(glbTextureGate(glbTextureFormat(undefined), false), "load");
});

test("png 贴图照常加载 3D", () => {
  assert.equal(gateFor(glb({ [GLB_TEXTURE_FORMAT_FIELD]: "png" }), false), "load");
});

test("webp 贴图且本机能解码时加载 3D，探测中先不挂模型", () => {
  const files = glb({ [GLB_TEXTURE_FORMAT_FIELD]: "webp" });
  assert.equal(gateFor(files, null), "detecting");
  assert.equal(gateFor(files, true), "load");
});

test("webp 贴图且本机解码失败时显示效果图降级", () => {
  assert.equal(gateFor(glb({ [GLB_TEXTURE_FORMAT_FIELD]: "webp" }), false), "fallback");
});

test("未知取值按旧单处理，只读 glb 文件上的字段", () => {
  assert.equal(gateFor(glb({ [GLB_TEXTURE_FORMAT_FIELD]: "ktx2" }), false), "load");
  assert.equal(glbTextureFormat([{ key: "white_a", [GLB_TEXTURE_FORMAT_FIELD]: "webp" }, { key: "glb" }]), undefined);
});

const bitmap = (w = 1, h = 1) => async () => ({ width: w, height: h, close() {} });

test("探测真解码：createImageBitmap 成功即支持", async () => {
  assert.equal(await probeWebpDecode({ createImageBitmap: bitmap() }), true);
});

test("createImageBitmap 失败退 Image.decode", async () => {
  const fail = async () => { throw new Error("decode"); };
  assert.equal(await probeWebpDecode({ createImageBitmap: fail, decodeImage: async () => ({ width: 1, height: 1 }) }), true);
  assert.equal(await probeWebpDecode({ createImageBitmap: fail, decodeImage: fail }), false);
  assert.equal(await probeWebpDecode({ decodeImage: async () => ({ width: 0, height: 0 }) }), false);
  assert.equal(await probeWebpDecode({}), false);
});

test("探测不调用 fetch，交给解码器的是本地 image/webp Blob", async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("no fetch"); }) as typeof fetch;
  try {
    const seen: Blob[] = [];
    const fail = async (b: Blob) => { seen.push(b); throw new Error("decode"); };
    assert.equal(await probeWebpDecode({ createImageBitmap: fail, decodeImage: fail }), false);
    assert.equal(await probeWebpDecode({ createImageBitmap: async (b) => { seen.push(b); return bitmap()(); } }), true);
    assert.equal(fetched, 0);
    assert.equal(seen.length, 3);
    for (const b of seen) { assert.equal(b.type, "image/webp"); assert.equal(b.size, 34); }
    const head = new Uint8Array(await webpProbeBlob().arrayBuffer());
    assert.equal(String.fromCharCode(...head.slice(0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...head.slice(8, 12)), "WEBP");
  } finally {
    globalThis.fetch = original;
  }
});

test("每个会话只探测一次", async () => {
  let calls = 0;
  const support = createWebpSupport((): WebpDecoder => ({ createImageBitmap: async () => { calls++; return bitmap()(); } }));
  assert.equal(support.known(), null);
  const [a, b] = [support.detect(), support.detect()];
  assert.equal(a, b);
  assert.equal(await a, true);
  await support.detect();
  assert.equal(calls, 1);
  assert.equal(support.known(), true);
});

test("降级说明不含禁用词", () => {
  for (const banned of ["已过审", "已发送", "AI 已确认", "AI 已过审", "Generating"]) assert.ok(!GLB_WEBP_UNSUPPORTED_TEXT.includes(banned));
});

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

// 镜像 apps/web/server/src/renderGenerationBridge.ts 的 RENDER_GENERATION_OUTPUT_KEYS 中 front_right* 的映射值
// （与 renderGenerations.ts OPTIONAL_KEYS、mockup.ts stillKeyFromName 一致）。服务端改名时这里必须同步。
const FRONT_RIGHT_JOB_KEYS = ["white_a", "white_a_card", "white_a_ground", "white_a_ground_card", "white_a_set", "white_a_set_card"];
const BACK_LEFT_JOB_KEYS = ["white_b", "white_b_card", "white_b_ground", "white_b_ground_card", "white_b_set", "white_b_set_card"];
const completed = [{ key: "glb" }, ...[...FRONT_RIGHT_JOB_KEYS, ...BACK_LEFT_JOB_KEYS].map((key) => ({ key }))];
const without = (...drop: string[]) => completed.filter((file) => !drop.includes(file.key));

describe("GLB poster 选择", () => {
  it("完整出图：白桌白墙用正面桌墙审阅卡，白底/银灰用正面审阅卡", () => {
    assert.equal(glbPosterKey(completed, "white_set"), "white_a_set_card");
    assert.equal(glbPosterKey(completed, "white"), "white_a_card");
    assert.equal(glbPosterKey(completed, "silver"), "white_a_card");
  });
  it("缺审阅卡或桌墙图时逐级回退到原图", () => {
    assert.equal(glbPosterKey(without("white_a_set_card"), "white_set"), "white_a_set");
    assert.equal(glbPosterKey(without("white_a_set_card", "white_a_set"), "white_set"), "white_a_card");
    assert.equal(glbPosterKey(without("white_a_card"), "white"), "white_a");
  });
  it("渲染器原始输出名 front_right* 不会出现在 job.files，不被误用；没有正面图时为 null", () => {
    assert.equal(glbPosterKey([{ key: "front_right" }, { key: "front_right_set_card" }], "white_set"), null);
    assert.equal(glbPosterKey(without(...FRONT_RIGHT_JOB_KEYS), "white"), null);
    assert.equal(glbPosterKey(undefined, "white_set"), null);
  });
});

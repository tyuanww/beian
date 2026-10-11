/**
 * 内存探针：合成与真实打样 GLB 同布局的 6 张 RGBA 贴图（不含任何客户数据），
 * 转 WebP q90，采样峰值 RSS 并打印。CI windows-2022 与本机对照用。
 * 用法：tsx apps/web/server/src/glbWebpMemoryProbe.ts [--glb <已有 GLB 路径>]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressGlbTexturesToWebp } from "./glbWebp.js";

/** 与 cc99285d384c 相同的贴图尺寸，前三张大图模拟细节丰富的印刷面。 */
const LAYOUT: { width: number; height: number; detail: number }[] = [
  { width: 986, height: 3616, detail: 3 },
  { width: 986, height: 970, detail: 0 },
  { width: 986, height: 3616, detail: 1 },
  { width: 970, height: 3616, detail: 2 },
  { width: 970, height: 3616, detail: 1 },
  { width: 986, height: 970, detail: 0 },
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

async function syntheticPng(width: number, height: number, detail: number, seed: number): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  const rand = rng(seed);
  const raw = Buffer.alloc(width * height * 4);
  const noisy = [0, 0.005, 0.03, 0.07][detail];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const text = detail > 0 && (y % 24) < 10 && ((x >> 3) + (y >> 5)) % 3 !== 0 && ((x * 7 + y * 3) % 11) < 6;
      const base = text ? 30 : 200 + Math.round(40 * Math.sin(x / 97) * Math.cos(y / 131));
      const n = noisy && rand() < noisy ? Math.round((rand() - 0.5) * 24) : 0;
      raw[i] = Math.max(0, Math.min(255, base + n));
      raw[i + 1] = Math.max(0, Math.min(255, base - 20 + n));
      raw[i + 2] = Math.max(0, Math.min(255, base + 10 + n));
      raw[i + 3] = 255;
    }
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer());
}

async function buildSyntheticGlb(): Promise<{ bytes: Uint8Array; pngBytes: number[] }> {
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const uv = doc.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
  const mesh = doc.createMesh("box");
  const pngBytes: number[] = [];
  for (const [index, face] of LAYOUT.entries()) {
    const png = await syntheticPng(face.width, face.height, face.detail, index + 1);
    pngBytes.push(png.byteLength);
    const texture = doc.createTexture(`face${index}`).setImage(png).setMimeType("image/png");
    const material = doc.createMaterial(`face${index}`).setBaseColorTexture(texture);
    mesh.addPrimitive(doc.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv).setMaterial(material));
  }
  doc.createScene().addChild(doc.createNode("box").setMesh(mesh));
  return { bytes: await new NodeIO().writeBinary(doc), pngBytes };
}

const mib = (n: number) => (n / 1048576).toFixed(1);

async function measure(path: string, source: string): Promise<void> {
  global.gc?.();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const started = performance.now();
  const before = statSync(path).size;
  const result = await compressGlbTexturesToWebp(path);
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);
  if (result.status !== "converted") throw new Error(`glb webp memory probe not converted: ${JSON.stringify(result)}`);
  console.log(`GLB_WEBP_MEMORY source=${source} platform=${process.platform}-${process.arch} node=${process.version} `
    + `bytes=${before}->${statSync(path).size} textures=${result.textures} `
    + `rss_baseline_mib=${mib(baseline)} rss_peak_mib=${mib(peak)} rss_delta_mib=${mib(peak - baseline)} ms=${Math.round(performance.now() - started)}`);
}

const argIndex = process.argv.indexOf("--glb");
const dir = mkdtempSync(join(tmpdir(), "beian-glb-webp-mem-"));
try {
  const path = join(dir, "probe.glb");
  if (argIndex > 0) {
    copyFileSync(process.argv[argIndex + 1], path);
    const label = process.argv.indexOf("--label");
    await measure(path, label > 0 ? process.argv[label + 1] : "file");
  } else {
    const { bytes, pngBytes } = await buildSyntheticGlb();
    writeFileSync(path, bytes);
    console.log(`synthetic png bytes: ${pngBytes.join(",")}`);
    // 在干净子进程里测，避免合成贴图的内存算进基线。
    execFileSync(process.execPath, [...process.execArgv, process.argv[1], "--glb", path, "--label", "synthetic"], { stdio: "inherit" });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 发版/CI 探针：离线生成一个 PNG 贴图小 GLB，转 EXT_texture_webp q90，校验结果。
 * 用法：tsx apps/web/server/src/glbWebpProbe.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPngTexturedGlbForProbe, compressGlbTexturesToWebp, readGlbJson, textureFormatOfGlbJson } from "./glbWebp.js";

const dir = mkdtempSync(join(tmpdir(), "beian-glb-webp-probe-"));
try {
  const path = join(dir, "probe.glb");
  writeFileSync(path, await buildPngTexturedGlbForProbe(256));
  const result = await compressGlbTexturesToWebp(path);
  const json = readGlbJson(path);
  if (result.status !== "converted" || !json || textureFormatOfGlbJson(json) !== "webp") {
    throw new Error(`glb webp probe failed: ${JSON.stringify(result)}`);
  }
  console.log(`glb webp probe ok ${result.beforeBytes} -> ${result.afterBytes} bytes`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

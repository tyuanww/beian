/**
 * 新生成的打样 GLB 后处理：把贴图转成 EXT_texture_webp（quality 90）。
 *
 * 纯 JS（@gltf-transform）+ 已有的 sharp。任何失败都保留原 PNG GLB，
 * 只记日志，绝不让打样失败。只处理本次新生成的文件，不回头转换旧文件。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";

const GLB_WEBP_QUALITY = 90;
const EXT_TEXTURE_WEBP = "EXT_texture_webp";

export type GlbTextureFormat = "webp" | "png";

export type GlbWebpResult =
  | { status: "converted"; beforeBytes: number; afterBytes: number; textures: number }
  | { status: "skipped"; reason: "no_textures" | "already_webp" | "not_smaller"; beforeBytes: number; afterBytes?: number }
  | { status: "failed"; reason: string };

/** 读 GLB JSON chunk；不是合法 GLB 返回 null。只读文件头和 JSON，不读 BIN。 */
export function readGlbJson(path: string): Record<string, unknown> | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) !== 20) return null;
    if (head.toString("latin1", 0, 4) !== "glTF" || head.readUInt32LE(4) !== 2) return null;
    const jsonLen = head.readUInt32LE(12);
    if (head.readUInt32LE(16) !== 0x4e4f534a || jsonLen <= 0 || jsonLen > 64 * 1024 * 1024) return null;
    const json = Buffer.alloc(jsonLen);
    if (readSync(fd, json, 0, jsonLen, 20) !== jsonLen) return null;
    const parsed: unknown = JSON.parse(json.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function textureFormatOfGlbJson(json: Record<string, unknown>): GlbTextureFormat {
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
  return used.includes(EXT_TEXTURE_WEBP) ? "webp" : "png";
}

const formatCache = new Map<string, GlbTextureFormat | null>();
const FORMAT_CACHE_MAX = 2000;

/**
 * GLB 贴图格式，按 path+size+mtime 缓存，不在每次请求里重新解析。
 * 读不出时返回 undefined（字段不输出），不猜。
 */
export function glbTextureFormat(path: string | undefined): GlbTextureFormat | undefined {
  if (!path) return undefined;
  let key: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    key = `${path}|${st.size}|${st.mtimeMs}`;
  } catch {
    return undefined;
  }
  if (formatCache.has(key)) return formatCache.get(key) ?? undefined;
  const json = readGlbJson(path);
  const format = json ? textureFormatOfGlbJson(json) : null;
  if (formatCache.size >= FORMAT_CACHE_MAX) formatCache.clear();
  formatCache.set(key, format);
  return format ?? undefined;
}

export function resetGlbTextureFormatCacheForTest(): void {
  formatCache.clear();
}

/** 把 GLB 内贴图转成 WebP，内存中完成；不写盘。 */
export async function convertGlbBytesToWebp(input: Uint8Array, quality = GLB_WEBP_QUALITY): Promise<{ bytes: Uint8Array; textures: number }> {
  const [{ NodeIO }, { ALL_EXTENSIONS }, { textureCompress }, sharpMod] = await Promise.all([
    import("@gltf-transform/core"),
    import("@gltf-transform/extensions"),
    import("@gltf-transform/functions"),
    import("sharp"),
  ]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(input);
  const textures = doc.getRoot().listTextures().length;
  if (textures === 0) return { bytes: input, textures: 0 };
  await doc.transform(textureCompress({ encoder: sharpMod.default, targetFormat: "webp", quality }));
  const bytes = await io.writeBinary(doc);
  return { bytes, textures };
}

/**
 * 原地转换一个新生成的 GLB。成功才原子替换；失败、无贴图、已是 WebP 或没变小都保留原文件。
 */
export async function compressGlbTexturesToWebp(
  path: string,
  opts: { quality?: number; convert?: typeof convertGlbBytesToWebp } = {},
): Promise<GlbWebpResult> {
  const tmp = join(dirname(path), `.${basename(path)}.webp-${process.pid}-${Date.now()}.tmp`);
  try {
    if (!existsSync(path)) return { status: "failed", reason: "missing" };
    const json = readGlbJson(path);
    if (!json) return { status: "failed", reason: "not_glb" };
    const input = readFileSync(path);
    const beforeBytes = input.length;
    if (textureFormatOfGlbJson(json) === "webp") return { status: "skipped", reason: "already_webp", beforeBytes };
    const { bytes, textures } = await (opts.convert || convertGlbBytesToWebp)(input, opts.quality ?? GLB_WEBP_QUALITY);
    if (textures === 0) return { status: "skipped", reason: "no_textures", beforeBytes };
    if (bytes.length >= beforeBytes) return { status: "skipped", reason: "not_smaller", beforeBytes, afterBytes: bytes.length };
    writeFileSync(tmp, bytes);
    const check = readGlbJson(tmp);
    if (!check || textureFormatOfGlbJson(check) !== "webp") {
      rmSync(tmp, { force: true });
      return { status: "failed", reason: "output_not_webp" };
    }
    renameSync(tmp, path);
    return { status: "converted", beforeBytes, afterBytes: bytes.length, textures };
  } catch (err) {
    rmSync(tmp, { force: true });
    return { status: "failed", reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

export function logGlbWebpResult(label: string, result: GlbWebpResult): void {
  if (result.status === "converted") {
    console.log(`${label} glb webp q${GLB_WEBP_QUALITY}: ${result.beforeBytes} -> ${result.afterBytes} bytes, textures=${result.textures}`);
  } else if (result.status === "skipped") {
    console.log(`${label} glb webp skipped: ${result.reason}`);
  } else {
    console.warn(`${label} glb webp failed, keep original PNG GLB: ${result.reason}`);
  }
}

/** 生成一个带 PNG 贴图的小 GLB（测试与发版探针用）。 */
export async function buildPngTexturedGlbForProbe(size = 64): Promise<Uint8Array> {
  const [{ Document, NodeIO }, sharpMod] = await Promise.all([import("@gltf-transform/core"), import("sharp")]);
  const raw = Buffer.alloc(size * size * 3);
  // 平滑渐变 + 细线，近似包装稿：WebP 应明显小于 PNG。
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const line = y % 16 === 0 ? 0 : 1;
      raw[i] = Math.round((x / size) * 255) * line;
      raw[i + 1] = Math.round((y / size) * 255) * line;
      raw[i + 2] = Math.round(((x + y) / (2 * size)) * 255) * line;
    }
  }
  const png = await sharpMod.default(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
  const doc = new Document();
  const buffer = doc.createBuffer();
  const texture = doc.createTexture("probe").setImage(new Uint8Array(png)).setMimeType("image/png");
  const material = doc.createMaterial("probe").setBaseColorTexture(texture);
  const position = doc.createAccessor().setType("VEC3").setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const uv = doc.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 0, 1]));
  const prim = doc.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv).setMaterial(material);
  const mesh = doc.createMesh("probe").addPrimitive(prim);
  doc.createScene().addChild(doc.createNode("probe").setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

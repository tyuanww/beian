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
let formatParseCount = 0;

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
  formatParseCount += 1;
  const json = readGlbJson(path);
  const format = json ? textureFormatOfGlbJson(json) : null;
  if (formatCache.size >= FORMAT_CACHE_MAX) formatCache.clear();
  formatCache.set(key, format);
  return format ?? undefined;
}

export function resetGlbTextureFormatCacheForTest(): void {
  formatCache.clear();
  formatParseCount = 0;
}

/** 测试用：glbTextureFormat 实际解析 GLB 的次数（命中缓存不计）。 */
export function glbTextureFormatParseCountForTest(): number {
  return formatParseCount;
}

/** 把 GLB 内贴图转成 WebP，内存中完成；不写盘。 */
/**
 * 必须传 encoder=sharp：@gltf-transform/functions 4.5.1 的 compressTexture 在 encoder 存在时只走
 * _encodeWithSharp（含 resize 也是 sharp），不调用 ndarray-pixels 的 getPixels/savePixels。
 * 因此根 overrides 把 ndarray-pixels 的 sharp ^0.35 压到 0.34.4 不影响本路径（glb-webp.test.ts 钉住）。
 */
export async function convertGlbBytesToWebp(
  input: Uint8Array,
  quality = GLB_WEBP_QUALITY,
  encoderOverride?: unknown,
): Promise<{ bytes: Uint8Array; textures: number }> {
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
  await doc.transform(textureCompress({ encoder: (encoderOverride ?? sharpMod.default) as typeof sharpMod.default, targetFormat: "webp", quality }));
  const bytes = await io.writeBinary(doc);
  return { bytes, textures };
}

type GlbStructure = { meshes: number; primitives: number; materials: number; textures: number; images: number };

/** GLB 容器严格校验：chunk 首尾相接、总长一致、bufferView 不越过 BIN。gltf-transform 读取较宽松，不能单靠它。 */
function assertGlbContainer(bytes: Uint8Array): void {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 20 || buf.toString("latin1", 0, 4) !== "glTF" || buf.readUInt32LE(4) !== 2) throw new Error("glb_header");
  if (buf.readUInt32LE(8) !== buf.length) throw new Error("glb_length");
  let offset = 12;
  let json: { bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number }[] } | null = null;
  let binLength = 0;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new Error("glb_chunk_header");
    const length = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    if (offset + 8 + length > buf.length) throw new Error("glb_chunk_length");
    if (type === 0x4e4f534a) json = JSON.parse(buf.toString("utf8", offset + 8, offset + 8 + length));
    else if (type === 0x004e4942) binLength = length;
    offset += 8 + length;
  }
  if (offset !== buf.length || !json) throw new Error("glb_chunks");
  for (const view of json.bufferViews || []) {
    if ((view.buffer ?? 0) === 0 && (view.byteOffset ?? 0) + view.byteLength > binLength) throw new Error("glb_buffer_view");
  }
}

/** 严格校验容器后完整 readBinary 一遍并数结构；读不出抛错。images 取 GLB JSON 的 images 数组长度。 */
async function readGlbStructure(bytes: Uint8Array): Promise<GlbStructure> {
  assertGlbContainer(bytes);
  const [{ NodeIO }, { ALL_EXTENSIONS }] = await Promise.all([import("@gltf-transform/core"), import("@gltf-transform/extensions")]);
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes);
  const root = doc.getRoot();
  const json = await new NodeIO().registerExtensions(ALL_EXTENSIONS).binaryToJSON(bytes);
  return {
    meshes: root.listMeshes().length,
    primitives: root.listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().length, 0),
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    images: (json.json.images || []).length,
  };
}

/**
 * 原地转换一个新生成的 GLB。成功才原子替换；失败、无贴图、已是 WebP 或没变小都保留原文件。
 */
/** 进程内串行锁：同一时刻只跑一个 GLB 压缩，限制服务进程的解码内存峰值。 */
let compressionTail: Promise<unknown> = Promise.resolve();

export function compressGlbTexturesToWebp(
  path: string,
  opts: { quality?: number; convert?: typeof convertGlbBytesToWebp } = {},
): Promise<GlbWebpResult> {
  const run = compressionTail.then(() => compressGlbTexturesToWebpUnlocked(path, opts));
  compressionTail = run.catch(() => undefined);
  return run;
}

async function compressGlbTexturesToWebpUnlocked(
  path: string,
  opts: { quality?: number; convert?: typeof convertGlbBytesToWebp },
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
    // 改名前把落盘的临时文件完整读回，结构计数必须与原文件一致。
    let structureOk = false;
    try {
      const [before, after] = await Promise.all([readGlbStructure(input), readGlbStructure(readFileSync(tmp))]);
      structureOk = JSON.stringify(before) === JSON.stringify(after);
    } catch {
      structureOk = false;
    }
    if (!structureOk) {
      rmSync(tmp, { force: true });
      return { status: "failed", reason: "output_structure_mismatch" };
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

#!/usr/bin/env node
/**
 * 独立图片进程。父进程不加载 sharp。
 * EXIF 1–8（含镜像）先归一到像素，再去掉方向标记，避免下次打开时转第二次。
 * ICC 和 alpha 保留。多帧、超像素或解码预算直接拒绝，不取第一帧。
 */
import { unlinkSync } from "node:fs";
import sharp from "sharp";

const MAX_PIXELS = 32_000_000;
const MAX_DECODE_BYTES = 128 * 1024 * 1024;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function fail(code) {
  const output = arg("--output");
  try {
    if (output) unlinkSync(output);
  } catch {
    /* 还没有写出文件 */
  }
  process.exit(code);
}

const input = arg("--input");
const output = arg("--output");
const media = arg("--media");
if (!input || !output || !media) fail(2);

const formats = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

try {
  const header = await sharp(input, { animated: true, limitInputPixels: false, pages: -1 }).metadata();
  if (!formats[media] || header.format !== formats[media]) fail(2);
  if ((header.pages || 1) > 1) fail(4);
  const width = header.width || 0;
  const height = header.height || 0;
  const pixels = width * height;
  if (!width || !height || pixels > MAX_PIXELS || pixels * 4 > MAX_DECODE_BYTES) fail(3);

  let pipeline = sharp(input, {
    animated: false,
    pages: 1,
    limitInputPixels: MAX_PIXELS,
    sequentialRead: true,
    failOn: "error",
  }).rotate().withMetadata({ orientation: undefined });
  if (media === "image/jpeg") pipeline = pipeline.jpeg({ quality: 85, mozjpeg: false });
  else if (media === "image/png") pipeline = pipeline.png({ compressionLevel: 9 });
  else pipeline = pipeline.webp({ quality: 85, alphaQuality: 100 });
  const info = await pipeline.toFile(output);
  if (!info || !info.size) fail(2);
  process.stdout.write(`${JSON.stringify({ bytes: info.size, width: info.width, height: info.height })}\n`);
} catch {
  fail(2);
}

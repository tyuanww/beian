import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { composeStudioPng, type StudioStillAppearance } from "./studioStill.js";

type Pixel = readonly [number, number, number, number];

const defaultAppearance: StudioStillAppearance = { backdrop: "white_set", productLight: 1, backgroundLight: 1 };
const transparent: Pixel = [255, 0, 255, 0];

function rgbaPng(pixels: readonly Pixel[]): Promise<Buffer> {
  return sharp(Buffer.from(pixels.flat()), { raw: { width: pixels.length, height: 1, channels: 4 } }).png().toBuffer();
}

function solidPng(width: number, height: number, [r, g, b, alpha]: Pixel): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha: alpha / 255 } } }).png().toBuffer();
}

async function inspectPng(png: Buffer) {
  const image = sharp(png);
  const { format, hasAlpha } = await image.metadata();
  assert.equal(format, "png");
  assert.equal(hasAlpha, false);
  const { data, info: { width, height, channels } } = await image.raw().toBuffer({ resolveWithObject: true });
  assert.equal(channels, 3);
  return {
    width, height,
    at(x: number, y: number) {
      const start = (y * width + x) * channels;
      return [...data.subarray(start, start + channels)];
    },
  };
}

test("white and silver preserve the product size and coverage without reading any background layer", async () => {
  const product = await rgbaPng([[200, 70, 30, 255], [10, 200, 100, 128], transparent]);
  const unused = Buffer.from("invalid image");
  const white = await inspectPng(await composeStudioPng(product, { kind: "ground", bytes: unused }, {
    ...defaultAppearance, backdrop: "white",
  }));
  const silver = await inspectPng(await composeStudioPng(product, { kind: "set", bytes: unused }, {
    ...defaultAppearance, backdrop: "silver",
  }));

  assert.deepEqual([white.width, white.height], [3, 1]);
  assert.deepEqual(white.at(0, 0), [202, 67, 26]);
  assert.deepEqual(white.at(1, 0), [121, 220, 168]);
  assert.deepEqual(white.at(2, 0), [238, 238, 238]);
  assert.deepEqual(silver.at(0, 0), [202, 67, 26]);
  assert.deepEqual(silver.at(1, 0), [100, 202, 153]);
  assert.deepEqual(silver.at(2, 0), [196, 201, 208]);
});

test("white_set draws the wall and horizon, then multiplies the lit translucent ground", async () => {
  const product = await solidPng(2, 500, transparent);
  const ground = await solidPng(2, 500, [128, 64, 255, 128]);
  const flat = await inspectPng(await composeStudioPng(product, null, defaultAppearance));
  assert.deepEqual(flat.at(0, 289), [238, 238, 236]);
  assert.deepEqual(flat.at(0, 290), [205, 204, 211]);
  assert.deepEqual(flat.at(0, 291), [205, 204, 211]);
  assert.deepEqual(flat.at(0, 292), [228, 228, 232]);

  const plottedGround = { kind: "ground", bytes: ground } satisfies Parameters<typeof composeStudioPng>[1];
  const shadow = await inspectPng(await composeStudioPng(product, plottedGround, defaultAppearance));
  assert.deepEqual(shadow.at(1, 0), [179, 149, 236]);
  assert.deepEqual(shadow.at(1, 290), [154, 127, 211]);
  assert.deepEqual(shadow.at(1, 499), [171, 142, 232]);

  const dimmed = await inspectPng(await composeStudioPng(product, plottedGround, {
    ...defaultAppearance, backgroundLight: 0.6,
  }));
  assert.deepEqual(dimmed.at(1, 499), [89, 78, 111]);
});

test("the set replaces the synthetic wall and ground, scales to the product, and stays behind it", async () => {
  const product = await rgbaPng([transparent, [200, 70, 30, 255], [10, 200, 100, 128]]);
  const set = await solidPng(3, 1, [100, 150, 200, 128]);
  const got = await inspectPng(await composeStudioPng(product, { kind: "set", bytes: set }, defaultAppearance));
  assert.deepEqual([got.width, got.height], [3, 1]);
  assert.deepEqual(got.at(0, 0), [164, 189, 216]);
  assert.deepEqual(got.at(1, 0), [202, 67, 26]);
  assert.deepEqual(got.at(2, 0), [84, 196, 157]);

  const smallSet = await solidPng(1, 1, [100, 150, 200, 255]);
  const scaled = await inspectPng(await composeStudioPng(product, { kind: "set", bytes: smallSet }, defaultAppearance));
  assert.deepEqual(scaled.at(0, 0), [100, 150, 200]);
  assert.deepEqual(scaled.at(2, 0), [52, 176, 149]);
});

test("dimming and highlight protection transfer each illumination independently", async () => {
  const product = await rgbaPng([[170, 220, 249, 255], transparent]);
  const set = await solidPng(2, 1, [100, 180, 230, 255]);
  const printedSet = { kind: "set", bytes: set } satisfies Parameters<typeof composeStudioPng>[1];

  const productDim = await inspectPng(await composeStudioPng(product, printedSet, {
    ...defaultAppearance, productLight: 0.1, backgroundLight: 1.8,
  }));
  assert.deepEqual(productDim.at(0, 0), [102, 133, 151]);
  assert.deepEqual(productDim.at(1, 0), [131, 199, 237]);

  const productBright = await inspectPng(await composeStudioPng(product, printedSet, {
    ...defaultAppearance, productLight: 1.4, backgroundLight: 0.6,
  }));
  assert.deepEqual(productBright.at(0, 0), [192, 232, 254]);
  assert.deepEqual(productBright.at(1, 0), [60, 108, 138]);
});

test("corrupt PNGs, non-PNGs and layers exceeding 32M pixels reject the composition", async () => {
  const image = await solidPng(1, 1, transparent);
  const jpeg = await sharp(image).jpeg().toBuffer();
  const corrupt = image.subarray(0, 40);
  // A valid IHDR CRC describing 8000 × 4001. The limit must reject before decoding its IDAT.
  const ihdr = Buffer.from("89504e470d0a1a0a0000000d4948445200001f4000000fa10806000000bc37f91d", "hex");
  const oversized = Buffer.concat([ihdr, image.subarray(ihdr.length)]);
  await assert.rejects(composeStudioPng(jpeg, null, defaultAppearance), /not a PNG/);
  await assert.rejects(composeStudioPng(corrupt, null, defaultAppearance));
  await assert.rejects(composeStudioPng(oversized, null, defaultAppearance), /pixel limit/i);
  await assert.rejects(composeStudioPng(image, { kind: "set", bytes: oversized }, defaultAppearance), /pixel limit/i);
  await assert.rejects(composeStudioPng(image, { kind: "ground", bytes: corrupt }, defaultAppearance));
});

import { setImmediate } from "node:timers/promises";

export type StudioStillAppearance = {
  backdrop: "white" | "silver" | "white_set";
  productLight: number;
  backgroundLight: number;
};

type BackgroundInput = { kind: "ground" | "set"; bytes: Buffer };
type Size = { width: number; height: number };
type RGB = readonly [number, number, number];

const MAX_IMAGE_PIXELS = 32_000_000; // Packaging worker's per-image limit.
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const BACKDROP_RGB = {
  white: [238, 238, 238],
  silver: [196, 201, 208],
  white_set: [228, 228, 232],
} satisfies Record<StudioStillAppearance["backdrop"], RGB>;
const PIXELS_PER_TICK = 262_144;

async function openPng(bytes: Buffer) {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Studio layer is not a PNG");
  }
  const { default: sharp } = await import("sharp");
  const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning" });
  const { width, height } = await image.metadata();
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
    throw new Error("Studio layer exceeds the pixel limit or has no dimensions");
  }
  return { image, width, height };
}

function readRgba({ image, width, height }: Awaited<ReturnType<typeof openPng>>, size: Size): Promise<Buffer> {
  if (width !== size.width || height !== size.height) {
    image.resize(size.width, size.height, { fit: "fill", kernel: "linear" });
  }
  return image.toColourspace("srgb").ensureAlpha().raw().toBuffer();
}

function clampLight(light: number): number {
  return Number.isFinite(light) ? Math.min(1.4, Math.max(0.6, light)) : 1;
}

function sourceOver(base: number, source: number, alpha: number): number {
  return Math.round(base + (source - base) * alpha);
}

function backdropRows({ height }: Size, { backdrop, backgroundLight }: StudioStillAppearance, useSet: boolean) {
  const light = clampLight(backgroundLight);
  const fill = ([r, g, b]: RGB): RGB =>
    [Math.min(255, Math.round(r * light)), Math.min(255, Math.round(g * light)), Math.min(255, Math.round(b * light))];
  const table = fill(BACKDROP_RGB[backdrop]);
  if (backdrop !== "white_set" || useSet) return () => table;
  const wall = fill([238, 238, 236]);
  const horizon = Math.round(height * 0.58);
  const shadowBottom = horizon + Math.max(1, Math.round(height * 0.004));
  const shadow: RGB = [sourceOver(table[0], 40, 0.12), sourceOver(table[1], 24, 0.12), sourceOver(table[2], 56, 0.12)];
  return (y: number) => y < horizon ? wall : y < shadowBottom ? shadow : table;
}

function layerTransfer(light: number, product: boolean): Uint8Array {
  const next = clampLight(light);
  // Like the Canvas path: quantize each CSS filter, then apply the highlight LUT
  // instead of linear brightness above 1. Alpha never enters the transfer.
  return Uint8Array.from({ length: 256 }, (_, value) => {
    const contrasted = product ? Math.floor(Math.min(255, Math.max(0, value * 1.04 - 5.1))) : value;
    return next > 1
      ? Math.round(255 * (contrasted / 255) ** (1 / next))
      : Math.floor(contrasted * next);
  });
}

function blendGround(base: number, source: number, alpha: number): number {
  return sourceOver(base, base * source / 255, alpha);
}

async function paintPixels(
  product: Buffer,
  background: { rgba: Buffer; kind: BackgroundInput["kind"] } | null,
  size: Size,
  appearance: StudioStillAppearance,
): Promise<Buffer> {
  const baseAt = backdropRows(size, appearance, background?.kind === "set");
  const productLut = layerTransfer(appearance.productLight, true);
  const backgroundLut = layerTransfer(appearance.backgroundLight, false);
  const blendBackground = background?.kind === "ground" ? blendGround : sourceOver;
  let pixel = 0;
  let nextYield = PIXELS_PER_TICK;
  for (let y = 0; y < size.height; y++) {
    const base = baseAt(y);
    const end = pixel + size.width;
    while (pixel < end) {
      const limit = Math.min(end, nextYield);
      for (; pixel < limit; pixel++) {
        const rgba = pixel * 4;
        const rgb = pixel * 3;
        const productAlpha = product[rgba + 3] / 255;
        const backdropAlpha = background && productAlpha < 1 ? background.rgba[rgba + 3] / 255 : 0;
        for (let channel = 0; channel < 3; channel++) {
          const behind = background && backdropAlpha > 0
            ? blendBackground(base[channel], backgroundLut[background.rgba[rgba + channel]], backdropAlpha)
            : base[channel];
          const box = productLut[product[rgba + channel]];
          product[rgb + channel] = sourceOver(behind, box, productAlpha);
        }
      }
      if (pixel === nextYield) {
        nextYield += PIXELS_PER_TICK;
        await setImmediate();
      }
    }
  }
  return product.subarray(0, pixel * 3);
}

/**
 * Compose at the product's native resolution. Run one composition at a time:
 * the JS pixel buffers total at most 8 bytes/pixel plus Sharp's native
 * workspace and compressed buffers. RGB is packed into the product buffer in
 * place, and long pixel loops yield to the event loop between chunks.
 */
export async function composeStudioPng(
  product: Buffer,
  background: BackgroundInput | null,
  appearance: StudioStillAppearance,
): Promise<Buffer> {
  const input = await openPng(product);
  const { width, height } = input;
  const size = { width, height };
  const selected = appearance.backdrop === "white_set" ? background : null;
  const productRgba = await readRgba(input, size);
  const backdrop = selected
    ? { kind: selected.kind, rgba: await readRgba(await openPng(selected.bytes), size) }
    : null;
  const rgb = await paintPixels(productRgba, backdrop, size, appearance);
  // All backdrop modes are opaque. Lossless truecolour PNG has no alpha band.
  const { default: sharp } = await import("sharp");
  return sharp(rgb, { raw: { ...size, channels: 3 } }).png().toBuffer();
}

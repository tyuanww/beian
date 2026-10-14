export type ZoomState = { scale: number; x: number; y: number };

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;

export function resetZoom(): ZoomState {
  return { scale: 1, x: 0, y: 0 };
}

export function clampScale(s: number): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

/** Zoom toward a point in view pixels (origin = canvas top-left). Keep pan at 1x. */
export function zoomAt(state: ZoomState, nextScale: number, originX: number, originY: number): ZoomState {
  const scale = clampScale(nextScale);
  if (scale <= ZOOM_MIN) return { scale: ZOOM_MIN, x: state.x, y: state.y };
  const k = scale / (state.scale || 1);
  return {
    scale,
    x: originX - (originX - state.x) * k,
    y: originY - (originY - state.y) * k,
  };
}

export function panBy(state: ZoomState, dx: number, dy: number): ZoomState {
  return { scale: state.scale, x: state.x + dx, y: state.y + dy };
}

export function zoomCss(state: ZoomState): string {
  if (state.scale === ZOOM_MIN && state.x === 0 && state.y === 0) return "none";
  return `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
}

export type PixelBox = { left: number; top: number; width: number; height: number };

/** Contain the page in the view and park it on the right (empty left for the dock). */
export function fittedPage(
  page: { width: number; height: number },
  view: { width: number; height: number },
): { imgW: number; imgH: number; offsetX: number; offsetY: number } {
  const pw = Number(page.width);
  const ph = Number(page.height);
  const vw = Number(view.width);
  const vh = Number(view.height);
  if (!(pw > 1) || !(ph > 1) || !(vw > 1) || !(vh > 1)) {
    return { imgW: 0, imgH: 0, offsetX: 0, offsetY: 0 };
  }
  const fit = Math.min(vw / pw, vh / ph);
  const imgW = pw * fit;
  const imgH = ph * fit;
  return { imgW, imgH, offsetX: Math.max(0, vw - imgW), offsetY: Math.max(0, (vh - imgH) / 2) };
}

/** Fit a page-pixel box into the visible canvas (~62% of the view). */
export function zoomToBox(
  box: PixelBox,
  page: { width: number; height: number },
  view: { width: number; height: number },
  fit = 0.62,
): ZoomState {
  const pw = Number(page.width);
  const ph = Number(page.height);
  const vw = Number(view.width);
  const vh = Number(view.height);
  if (!(pw > 1) || !(ph > 1) || !(vw > 1) || !(vh > 1)) return resetZoom();
  const laid = fittedPage(page, view);
  const boxW = Math.max((Number(box.width) / pw) * laid.imgW, 8);
  const boxH = Math.max((Number(box.height) / ph) * laid.imgH, 8);
  const cx = (Number(box.left) + Number(box.width) / 2) / pw * laid.imgW;
  const cy = (Number(box.top) + Number(box.height) / 2) / ph * laid.imgH;
  const scale = clampScale(Math.min((vw * fit) / boxW, (vh * fit) / boxH));
  return {
    scale,
    x: vw / 2 - laid.offsetX - cx * scale,
    y: vh / 2 - laid.offsetY - cy * scale,
  };
}

/**
 * 就地对照：把这条范围框进视口，并在右侧留出对照窗。
 * 范围已经铺满画面时保持整页。
 */
export function frameRangeForCard(
  box: PixelBox,
  page: { width: number; height: number },
  view: { width: number; height: number },
  reserve: { width: number; gap: number },
): ZoomState {
  const pw = Number(page.width);
  const ph = Number(page.height);
  const vw = Number(view.width);
  const vh = Number(view.height);
  if (!(pw > 1) || !(ph > 1) || !(vw > 1) || !(vh > 1)) return resetZoom();
  const laid = fittedPage(page, view);
  const boxW = Math.max((Number(box.width) / pw) * laid.imgW, 8);
  const boxH = Math.max((Number(box.height) / ph) * laid.imgH, 8);
  const roomW = Math.max(80, vw - reserve.width - reserve.gap - 32);
  const roomH = Math.max(80, vh - 32);
  const scale = clampScale(Math.min((roomW * 0.72) / boxW, (roomH * 0.72) / boxH));
  if (!(scale > ZOOM_MIN)) return resetZoom();
  const cx = (Number(box.left) + Number(box.width) / 2) / pw * laid.imgW;
  const cy = (Number(box.top) + Number(box.height) / 2) / ph * laid.imgH;
  const rightLaid = (Number(box.left) + Number(box.width)) / pw * laid.imgW;
  const leftLaid = Number(box.left) / pw * laid.imgW;
  const targetRight = vw - reserve.width - reserve.gap;
  let x = targetRight - laid.offsetX - rightLaid * scale;
  let y = vh / 2 - laid.offsetY - cy * scale;
  const boxLeft = laid.offsetX + leftLaid * scale + x;
  if (boxLeft < 16) x += 16 - boxLeft;
  const boxRight = laid.offsetX + rightLaid * scale + x;
  if (boxRight > vw - 16) {
    x = vw / 2 - laid.offsetX - cx * scale;
    y = vh / 2 - laid.offsetY - cy * scale;
  }
  return { scale, x, y };
}

/** 保持当前缩放，只平移让框居中（默认整页适配，用户放大后才跟着框走）。 */
export function panToBoxAt(
  box: PixelBox,
  page: { width: number; height: number },
  view: { width: number; height: number },
  scale: number,
): ZoomState {
  if (!(scale > 1)) return resetZoom();
  const z = zoomToBox(box, page, view);
  if (!(z.scale > 0)) return resetZoom();
  const laid = fittedPage(page, view);
  const cx = (view.width / 2 - laid.offsetX - z.x) / z.scale;
  const cy = (view.height / 2 - laid.offsetY - z.y) / z.scale;
  return { scale, x: view.width / 2 - laid.offsetX - cx * scale, y: view.height / 2 - laid.offsetY - cy * scale };
}

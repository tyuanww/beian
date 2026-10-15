/** 核对页框：OCR 像素 bbox 叠到页图上。页宽高 ≤1 不画，也不编造顶排钉。 */

export type OverlayBox = {
  left: string;
  top: string;
  width: string;
  height: string;
  pinLeft: string;
  pinTop: string;
  kind: "hit" | "warn";
};

export type PageMetrics = { width: number; height: number };

export type PixelBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  role: string;
  page: number;
};

export function resolvePageMetrics(
  page?: { width?: number; height?: number } | null,
  natural?: { width: number; height: number } | null,
): PageMetrics | null {
  const fromPageW = Number(page?.width);
  const fromPageH = Number(page?.height);
  const w = fromPageW > 1 ? fromPageW : Number(natural?.width) || 0;
  const h = fromPageH > 1 ? fromPageH : Number(natural?.height) || 0;
  if (!(w > 1) || !(h > 1)) return null;
  return { width: w, height: h };
}

type LocatedHit = {
  page?: number | string;
  bboxes?: unknown;
  qrcode_boxes?: unknown;
};

function recordBoxes(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (box): box is Record<string, unknown> => Boolean(box) && typeof box === "object" && !Array.isArray(box),
  );
}

/** 普通文字框决定主页面；没有文字框时，二维码几何框可提供页面定位。 */
export function locationPageForHit(hit: LocatedHit): number {
  const declared = Number(hit.page);
  const textBoxes = recordBoxes(hit.bboxes);
  const qrBoxes = recordBoxes(hit.qrcode_boxes);
  const firstTextPage = Number(textBoxes.find((box) => Number(box.page) > 0)?.page || 0);
  const firstQrPage = Number(qrBoxes.find((box) => Number(box.page) > 0)?.page || 0);
  if (textBoxes.length && Number.isFinite(declared) && declared > 0) return declared;
  if (firstTextPage > 0) return firstTextPage;
  if (firstQrPage > 0) return firstQrPage;
  return Number.isFinite(declared) && declared > 0 ? declared : 0;
}

export function hitOnPage(hit: LocatedHit, pageNo: number): boolean {
  const p = locationPageForHit(hit);
  const n = Number(pageNo);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (!Number.isFinite(n) || n <= 0) return false;
  return p === n;
}

export type PinHitGroup<T> = { h: T; i: number; indices: number[] };

/** 只亮当前字段（含双语共钉）。全页淡钉已废。 */
export function visiblePinGroups<T>(
  groups: Array<PinHitGroup<T>>,
  active: number,
): Array<PinHitGroup<T>> {
  if (!Number.isFinite(active) || active < 0) return [];
  return groups.filter((g) => g.indices.includes(active));
}

function boxAreaRatio(box: PixelBox, page: PageMetrics): number {
  if (!(page.width > 1) || !(page.height > 1)) return 0;
  return (Math.max(box.width, 0) * Math.max(box.height, 0)) / (page.width * page.height);
}

export function boxTooLarge(box: PixelBox, page: PageMetrics, ratio = 0.3): boolean {
  return boxAreaRatio(box, page) >= ratio;
}

/** 漏字框豁免 30% 面积限制。宽和高都超过页的 90% 才不画。 */
export function missBoxUnusable(box: PixelBox, page: PageMetrics): boolean {
  if (!(page.width > 1) || !(page.height > 1)) return false;
  return box.width > page.width * 0.9 && box.height > page.height * 0.9;
}

function rejectBox(box: PixelBox, page: PageMetrics): boolean {
  if (box.role === "miss_anchor") return missBoxUnusable(box, page);
  return boxTooLarge(box, page);
}

function pct(n: number): string {
  const clamped = Math.min(100, Math.max(0, n));
  return `${clamped}%`;
}

/** 中英文品名可共享同一个联合框；保留两条审核字段，只在画布上画一个钉。 */
export function pinHitGroupsForPage<
  T extends LocatedHit & { bilingual_pair_id?: string },
>(hits: T[], pageNo: number): Array<PinHitGroup<T>> {
  const out: Array<PinHitGroup<T>> = [];
  const pairIndex = new Map<string, number>();
  hits.forEach((h, i) => {
    if (!hitOnPage(h, pageNo)) return;
    const pairId = String(h.bilingual_pair_id || "").trim();
    const existing = pairId ? pairIndex.get(pairId) : undefined;
    if (existing != null) {
      out[existing].indices.push(i);
      return;
    }
    if (pairId) pairIndex.set(pairId, out.length);
    out.push({ h, i, indices: [i] });
  });
  return out;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function boxPixels(b: Record<string, unknown> | null | undefined): PixelBox | null {
  if (!b || typeof b !== "object") return null;
  if (typeof b.bbox_space === "string" && b.bbox_space !== "page_px") return null;
  const left = num(b.left ?? b.x);
  const top = num(b.top ?? b.y);
  const width = num(b.width);
  const height = num(b.height);
  if (width <= 0 && height <= 0 && left === 0 && top === 0) return null;
  if (width < 0 || height < 0) return null;
  return {
    left,
    top,
    width,
    height,
    role: String(b.role || ""),
    page: num(b.page),
  };
}

const ROLE_RANK: Record<string, number> = {
  check: 0,
  miss_anchor: 1,
  hit: 2,
};

function usableBoxes(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page?: PageMetrics | null,
): PixelBox[] {
  return (bboxes || [])
    .map(boxPixels)
    .filter((b): b is PixelBox => {
      if (!b) return false;
      if (b.page && pageNo && b.page !== pageNo) return false;
      if (page && rejectBox(b, page)) return false;
      return true;
    });
}

export function pickHitBox(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page?: PageMetrics | null,
): PixelBox | null {
  const boxes = usableBoxes(bboxes, pageNo, page);
  if (!boxes.length) return null;
  boxes.sort((a, b) => (ROLE_RANK[a.role] ?? 8) - (ROLE_RANK[b.role] ?? 8));
  return boxes[0];
}

/** 一条疑点的全部分框合成一个范围。合成后铺得太大就退回原来的主框。 */
export function unionHitBox(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page?: PageMetrics | null,
): PixelBox | null {
  const boxes = usableBoxes(bboxes, pageNo, page);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + Math.max(box.width, 0)));
  const bottom = Math.max(...boxes.map((box) => box.top + Math.max(box.height, 0)));
  const ranked = [...boxes].sort((a, b) => (ROLE_RANK[a.role] ?? 8) - (ROLE_RANK[b.role] ?? 8));
  const union: PixelBox = {
    left,
    top,
    width: right - left,
    height: bottom - top,
    role: ranked[0]?.role || "hit",
    page: pageNo,
  };
  if (page && boxTooLarge(union, page)) return pickHitBox(bboxes, pageNo, page);
  return union;
}

export function missLineUnboxed(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page?: PageMetrics | null,
): boolean {
  if (!page) return false;
  return (bboxes || []).some((raw) => {
    const box = boxPixels(raw);
    if (!box || box.role !== "miss_anchor") return false;
    if (box.page && pageNo && box.page !== pageNo) return false;
    return missBoxUnusable(box, page);
  });
}

export function overlayFromBox(box: PixelBox, page: PageMetrics): OverlayBox | null {
  if (page.width <= 1 || page.height <= 1) return null;
  const w = Math.max(box.width, 8);
  const h = Math.max(box.height, 8);
  const cx = box.left + (box.width > 0 ? box.width / 2 : 0);
  const cy = box.top + (box.height > 0 ? box.height / 2 : 0);
  const kind = box.role === "check" || box.role === "miss_anchor" ? "warn" : "hit";
  return {
    left: pct((box.left / page.width) * 100),
    top: pct((box.top / page.height) * 100),
    width: pct((w / page.width) * 100),
    height: pct((h / page.height) * 100),
    pinLeft: pct((cx / page.width) * 100),
    pinTop: pct((cy / page.height) * 100),
    kind,
  };
}

/** 引导语框 + 码图框。码图只作定位，不改结论。 */
export function locateBoxesForHit(hit: {
  bboxes?: unknown;
  qrcode_boxes?: unknown;
}): Array<Record<string, unknown>> {
  const extra = recordBoxes(hit.qrcode_boxes).map((box) => ({ ...box, role: box.role || "hit" }));
  return [...recordBoxes(hit.bboxes), ...extra];
}

export function boxesExceptRange(
  bboxes: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
  return (bboxes || []).filter((box) => String(box.role || "") !== "range");
}

/** 段落框：宽和高同时超过页的 90% 才不画。不套 hit 的 30% 面积。 */
export function drawableRange(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page?: PageMetrics | null,
): PixelBox | null {
  const range = (bboxes || [])
    .map(boxPixels)
    .find((box): box is PixelBox => {
      if (!box || box.role !== "range") return false;
      if (box.page && pageNo && box.page !== pageNo) return false;
      return true;
    });
  if (!range) return null;
  if (page && missBoxUnusable(range, page)) return null;
  return range;
}

/** 画框、镜头、未拖动贴边共用这一只。没有会画的 range 时退回错点框。 */
export function spotFrameBox(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page?: PageMetrics | null,
): PixelBox | null {
  return drawableRange(bboxes, pageNo, page) ?? pickHitBox(boxesExceptRange(bboxes), pageNo, page);
}

export function spotDrawBoxes(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page?: PageMetrics | null,
): Array<{ box: PixelBox; frame: boolean }> {
  const range = drawableRange(bboxes, pageNo, page);
  const hit = pickHitBox(boxesExceptRange(bboxes), pageNo, page);
  const rows: Array<{ box: PixelBox; frame: boolean }> = [];
  if (range) rows.push({ box: range, frame: true });
  if (hit) rows.push({ box: hit, frame: !range });
  return rows;
}

/** 标记钉错点。check、miss_anchor 和 hit 都算，段落框不钉。 */
export function spotMarkerBox(draws: Array<{ box: PixelBox }>): PixelBox | null {
  return draws.find((draw) => draw.box.role !== "range")?.box ?? null;
}

/** 悬浮打开时只留当前下标。双语组里的另一条也不画。 */
export function groupsForSpot<T extends { indices: number[]; i: number }>(groups: T[], active: number): T[] {
  if (!Number.isFinite(active) || active < 0) return [];
  return groups
    .filter((group) => group.indices.includes(active))
    .map((group) => ({ ...group, i: active, indices: [active] }));
}

export function overlaysForHit(
  bboxes: Array<Record<string, unknown>> | undefined,
  pageNo: number,
  page: PageMetrics | null,
): OverlayBox[] {
  if (!page) return [];
  const out: OverlayBox[] = [];
  for (const raw of bboxes || []) {
    const box = boxPixels(raw);
    if (!box) continue;
    if (box.role === "range") continue;
    if (box.page && pageNo && box.page !== pageNo) continue;
    if (page && rejectBox(box, page)) continue;
    const ov = overlayFromBox(box, page);
    if (ov) out.push(ov);
  }
  return out;
}

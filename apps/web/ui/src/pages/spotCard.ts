/** 对照窗。未拖动时贴在大框空档较大的一侧，不压住大框。拖开后留在放下处。坐标是屏幕坐标，不跟稿件缩放。 */

export const SPOT_CARD_WIDTH = 440;
export const SPOT_CARD_MIN_WIDTH = 240;
export const SPOT_CARD_MIN_HEIGHT = 200;
export const SPOT_CARD_GAP = 12;
export const SPOT_CARD_MARGIN = 8;
/** 抬头移动满 4px 才算拖，小于 4px 算点击。 */
const SPOT_DRAG_PX = 4;

export type SpotSide = "right" | "left";
/** 左右都放不下时改贴到大框上沿或下沿，避免压住正在看的字。 */
export type SpotDock = SpotSide | "below" | "above";

type Rect = { left: number; top: number; width: number; height: number };

/** 页上哪一侧离纸边更远，镜头就往另一侧让出对照窗。 */
export function spotLane(box: { left: number; width: number }, pageWidth: number): SpotSide {
  const roomRight = pageWidth - (box.left + box.width);
  const roomLeft = box.left;
  return roomRight >= roomLeft ? "right" : "left";
}

/** 屏幕上大框左右还剩多少空档。空档大的一侧放窗。 */
export function spotSideRoom(
  box: Rect,
  view: { width: number; height: number },
  gap = SPOT_CARD_GAP,
  margin = SPOT_CARD_MARGIN,
): { side: SpotSide; room: number } {
  const spaceRight = Math.max(0, view.width - margin - (box.left + box.width + gap));
  const spaceLeft = Math.max(0, box.left - gap - margin);
  const side: SpotSide = spaceRight >= spaceLeft ? "right" : "left";
  return { side, room: side === "right" ? spaceRight : spaceLeft };
}

export function placeSpotCard(
  box: Rect,
  card: { width: number; height: number },
  view: { width: number; height: number },
  gap = SPOT_CARD_GAP,
  margin = SPOT_CARD_MARGIN,
): { left: number; top: number; side: SpotDock; width: number; maxHeight?: number } {
  const { side, room } = spotSideRoom(box, view, gap, margin);
  const maxTop = Math.max(margin, view.height - card.height - margin);
  const top = Math.min(maxTop, Math.max(margin, box.top));
  const spaceBelow = Math.max(0, view.height - margin - (box.top + box.height + gap));
  const spaceAbove = Math.max(0, box.top - gap - margin);
  const band = Math.max(spaceBelow, spaceAbove);
  // 左右空档不够时，改贴更大的那条上下空档。多窄都缩进去，不把窗铺到字上。
  if (room < 80 && band > room) {
    const vSide: SpotDock = spaceBelow >= spaceAbove ? "below" : "above";
    const width = Math.round(Math.min(card.width, Math.max(80, view.width - margin * 2)));
    const centered = (view.width - width) / 2;
    const left = Math.min(Math.max(margin, view.width - width - margin), Math.max(margin, centered));
    const height = Math.min(card.height, band);
    const vTop = vSide === "below" ? box.top + box.height + gap : box.top - gap - height;
    return {
      left: Math.round(left),
      top: Math.round(Math.max(margin, vTop)),
      side: vSide,
      width,
      maxHeight: Math.round(band),
    };
  }
  const width = Math.round(Math.min(card.width, Math.max(0, room)));
  const left = side === "right" ? box.left + box.width + gap : box.left - gap - width;
  return { left: Math.round(left), top: Math.round(top), side, width };
}

export type SpotObstacle = { left: number; top: number; right: number; bottom: number };

function hitsSpotObstacle(
  left: number,
  top: number,
  card: { width: number; height: number },
  obstacle: SpotObstacle,
): boolean {
  return left < obstacle.right
    && left + card.width > obstacle.left
    && top < obstacle.bottom
    && top + card.height > obstacle.top;
}

function coversFrame(
  left: number,
  top: number,
  card: { width: number; height: number },
  frame: Rect,
  gap: number,
): boolean {
  return left + card.width > frame.left - gap
    && left < frame.left + frame.width + gap
    && top + card.height > frame.top - gap
    && top < frame.top + frame.height + gap;
}

/** 先夹进视口。和展开钮重叠时先往左让，左边不够再往下让。不改层级，也不压住大框。 */
export function avoidSpotObstacle(
  pos: { left: number; top: number },
  card: { width: number; height: number },
  view: { width: number; height: number },
  obstacle: SpotObstacle | null,
  margin = SPOT_CARD_MARGIN,
  gap = SPOT_CARD_GAP,
  clear: Rect | null = null,
): { left: number; top: number } {
  const clamped = clampSpotCard(pos, card, view, margin);
  const blocked = (left: number, top: number) =>
    (obstacle ? hitsSpotObstacle(left, top, card, obstacle) : false)
    || (clear ? coversFrame(left, top, card, clear, gap) : false);
  if (!blocked(clamped.left, clamped.top)) return clamped;
  const candidates = [
    { left: obstacle ? obstacle.left - gap - card.width : clamped.left, top: clamped.top },
    { left: clamped.left, top: obstacle ? obstacle.bottom + gap : clamped.top },
  ];
  for (const candidate of candidates) {
    const next = clampSpotCard(candidate, card, view, margin);
    if (!blocked(next.left, next.top)) return next;
  }
  if (clear && coversFrame(clamped.left, clamped.top, card, clear, gap) && !coversFrame(pos.left, pos.top, card, clear, gap)) {
    return pos;
  }
  return clamped;
}

/** 只把已放下的位置夹进同一套 margin，不重选左右。 */
function clampSpotCard(
  pos: { left: number; top: number },
  card: { width: number; height: number },
  view: { width: number; height: number },
  margin = SPOT_CARD_MARGIN,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, view.width - card.width - margin);
  const maxTop = Math.max(margin, view.height - card.height - margin);
  return {
    left: Math.min(maxLeft, Math.max(margin, pos.left)),
    top: Math.min(maxTop, Math.max(margin, pos.top)),
  };
}

/** 拖过之后忽略框的新位置。未拖动仍走 placeSpotCard。 */
export function resolveSpotPosition(
  dragged: { left: number; top: number } | null,
  box: Rect,
  card: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number; side: SpotDock | "held"; width: number; maxHeight?: number } {
  if (dragged) {
    const held = clampSpotCard(dragged, card, view);
    return { left: held.left, top: held.top, side: "held", width: card.width };
  }
  return placeSpotCard(box, card, view);
}

export function spotDragStarted(dx: number, dy: number, threshold = SPOT_DRAG_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

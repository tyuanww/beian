/** 就地对照窗。未拖动贴在当前框旁；拖开后留在放下处。坐标是屏幕坐标，不跟稿件缩放。 */

export const SPOT_CARD_WIDTH = 440;
export const SPOT_CARD_GAP = 12;
export const SPOT_CARD_MARGIN = 8;
/** 抬头移动满 4px 才算拖，小于 4px 算点击。 */
const SPOT_DRAG_PX = 4;

export type SpotSide = "right" | "left" | "below";

type Rect = { left: number; top: number; width: number; height: number };

export function placeSpotCard(
  box: Rect,
  card: { width: number; height: number },
  view: { width: number; height: number },
  gap = SPOT_CARD_GAP,
  margin = SPOT_CARD_MARGIN,
): { left: number; top: number; side: SpotSide } {
  const maxLeft = Math.max(margin, view.width - card.width - margin);
  const maxTop = Math.max(margin, view.height - card.height - margin);
  const fits = (left: number, top: number) =>
    left >= margin
    && top >= margin
    && left + card.width <= view.width - margin
    && top + card.height <= view.height - margin;
  const right = { left: box.left + box.width + gap, top: box.top, side: "right" as const };
  const leftSide = { left: box.left - gap - card.width, top: box.top, side: "left" as const };
  const below = { left: box.left, top: box.top + box.height + gap, side: "below" as const };
  const preferBelow = right.top < margin && leftSide.top < margin;
  const order = preferBelow ? [below, right, leftSide] : [right, leftSide, below];
  for (const spot of order) {
    if (fits(spot.left, spot.top)) return spot;
  }
  let chosen: { left: number; top: number; side: SpotSide } = below;
  if (right.left + card.width <= view.width - margin) chosen = right;
  else if (leftSide.left >= margin) chosen = leftSide;
  return {
    left: Math.min(maxLeft, Math.max(margin, chosen.left)),
    top: Math.min(maxTop, Math.max(margin, chosen.top)),
    side: chosen.side,
  };
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

/** 先夹进视口。和展开钮重叠时先往左让，左边不够再往下让。不改层级。 */
export function avoidSpotObstacle(
  pos: { left: number; top: number },
  card: { width: number; height: number },
  view: { width: number; height: number },
  obstacle: SpotObstacle | null,
  margin = SPOT_CARD_MARGIN,
  gap = SPOT_CARD_GAP,
): { left: number; top: number } {
  const clamped = clampSpotCard(pos, card, view, margin);
  if (!obstacle || !hitsSpotObstacle(clamped.left, clamped.top, card, obstacle)) return clamped;
  const candidates = [
    { left: obstacle.left - gap - card.width, top: clamped.top },
    { left: clamped.left, top: obstacle.bottom + gap },
  ];
  for (const candidate of candidates) {
    const next = clampSpotCard(candidate, card, view, margin);
    if (!hitsSpotObstacle(next.left, next.top, card, obstacle)) return next;
  }
  return clamped;
}

/** 只把已放下的位置夹进同一套 margin，不重选左右或上下。 */
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
): { left: number; top: number; side: SpotSide | "held" } {
  if (dragged) {
    const held = clampSpotCard(dragged, card, view);
    return { left: held.left, top: held.top, side: "held" };
  }
  return placeSpotCard(box, card, view);
}

export function spotDragStarted(dx: number, dy: number, threshold = SPOT_DRAG_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

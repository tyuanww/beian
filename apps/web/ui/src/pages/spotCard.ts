/** 就地对照窗：贴在范围框外侧，屏幕坐标，不跟着稿件缩放。 */

export const SPOT_CARD_WIDTH = 300;
export const SPOT_CARD_GAP = 12;
export const SPOT_CARD_MARGIN = 8;

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

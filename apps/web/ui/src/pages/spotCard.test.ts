import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placeSpotCard, resolveSpotPosition, SPOT_CARD_WIDTH, spotDragStarted } from "./spotCard.js";

describe("placeSpotCard", () => {
  it("贴在框的右侧", () => {
    const pos = placeSpotCard(
      { left: 20, top: 30, width: 40, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.deepEqual(pos, { side: "right", left: 72, top: 30 });
  });

  it("靠右边缘翻到左侧", () => {
    const pos = placeSpotCard(
      { left: 320, top: 40, width: 50, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.equal(pos.side, "left");
    assert.equal(pos.left, 208);
    assert.equal(pos.top, 40);
  });

  it("靠顶翻到框的下方", () => {
    const pos = placeSpotCard(
      { left: 20, top: 0, width: 40, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.equal(pos.side, "below");
    assert.equal(pos.left, 20);
    assert.equal(pos.top, 32);
  });

  it("放不下时夹进视口", () => {
    const pos = placeSpotCard(
      { left: 10, top: 10, width: 20, height: 20 },
      { width: 500, height: 500 },
      { width: 200, height: 200 },
    );
    assert.equal(pos.left, 8);
    assert.equal(pos.top, 8);
  });
});

describe("resolveSpotPosition", () => {
  it("uses a 440px card", () => {
    assert.equal(SPOT_CARD_WIDTH, 440);
  });

  it("stays where it was dropped when the frame or the height changes", () => {
    const held = resolveSpotPosition(
      { left: 40, top: 50 },
      { left: 280, top: 10, width: 20, height: 20 },
      { width: 440, height: 200 },
      { width: 800, height: 600 },
    );
    assert.deepEqual(held, { side: "held", left: 40, top: 50 });
    const taller = resolveSpotPosition(
      { left: 40, top: 50 },
      { left: 0, top: 0, width: 10, height: 10 },
      { width: 440, height: 580 },
      { width: 800, height: 600 },
    );
    assert.deepEqual(taller, { side: "held", left: 40, top: 12 });
  });

  it("clamps a dropped card into the same margin", () => {
    const pos = resolveSpotPosition(
      { left: -20, top: 900 },
      { left: 0, top: 0, width: 1, height: 1 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.deepEqual(pos, { side: "held", left: 8, top: 272 });
  });

  it("places an undragged card beside the frame", () => {
    const pos = resolveSpotPosition(
      null,
      { left: 20, top: 30, width: 40, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.deepEqual(pos, { side: "right", left: 72, top: 30 });
  });

  it("counts a drag only at 4px", () => {
    assert.equal(spotDragStarted(3, 0), false);
    assert.equal(spotDragStarted(0, 3.9), false);
    assert.equal(spotDragStarted(2, 2), false);
    assert.equal(spotDragStarted(4, 0), true);
    assert.equal(spotDragStarted(3, 3), true);
  });
});

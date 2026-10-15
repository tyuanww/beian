import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avoidSpotObstacle, placeSpotCard, resolveSpotPosition, SPOT_CARD_WIDTH, spotDragStarted, spotLane } from "./spotCard.js";

describe("placeSpotCard", () => {
  it("贴在框的右侧", () => {
    const pos = placeSpotCard(
      { left: 20, top: 30, width: 40, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.deepEqual(pos, { side: "right", left: 72, top: 30, width: 100 });
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

  it("贴顶时仍留在空档较大的一侧", () => {
    const pos = placeSpotCard(
      { left: 20, top: 0, width: 40, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.equal(pos.side, "right");
    assert.equal(pos.left, 72);
    assert.equal(pos.top, 8);
    assert.equal(pos.width, 100);
  });

  it("宽过空档时缩进空档，不压住大框", () => {
    const pos = placeSpotCard(
      { left: 10, top: 10, width: 20, height: 20 },
      { width: 500, height: 500 },
      { width: 200, height: 200 },
    );
    assert.equal(pos.side, "right");
    assert.equal(pos.left, 42);
    assert.equal(pos.width, 150);
    assert.ok(pos.left >= 10 + 20);
    assert.equal(pos.top, 8);
  });

  it("大框靠右时把窗放在左边，右缘贴着框", () => {
    const pos = placeSpotCard(
      { left: 300, top: 40, width: 80, height: 40 },
      { width: 440, height: 200 },
      { width: 500, height: 400 },
    );
    assert.equal(pos.side, "left");
    assert.equal(pos.width, 280);
    assert.equal(pos.left + pos.width, 300 - 12);
  });

  it("左右都贴满时改放到大框下方，不压住字", () => {
    const box = { left: 10, top: 200, width: 760, height: 100 };
    const pos = placeSpotCard(box, { width: 440, height: 240 }, { width: 800, height: 600 });
    assert.equal(pos.side, "below");
    assert.equal(pos.top, 312);
    assert.equal(pos.width, 440);
    assert.equal(pos.maxHeight, 280);
    assert.ok(pos.top >= box.top + box.height);
  });

  it("只剩窄空档时缩进去，不盖住大框", () => {
    const box = { left: 8, top: 8, width: 740, height: 580 };
    const card = { width: 440, height: 240 };
    const pos = placeSpotCard(box, card, { width: 800, height: 600 });
    assert.equal(pos.side, "right");
    assert.equal(pos.width, 32);
    assert.equal(pos.left, 760);
    assert.ok(pos.left >= box.left + box.width);
  });

  it("上下只剩一条缝时也贴在缝里", () => {
    const box = { left: 8, top: 8, width: 784, height: 560 };
    const pos = placeSpotCard(box, { width: 440, height: 240 }, { width: 800, height: 600 });
    assert.equal(pos.side, "below");
    assert.equal(pos.maxHeight, 12);
    assert.equal(pos.top, 580);
    assert.ok(pos.top >= box.top + box.height);
  });

  it("大框铺满画面时不把窗铺开", () => {
    const pos = placeSpotCard(
      { left: 0, top: 0, width: 800, height: 600 },
      { width: 440, height: 240 },
      { width: 800, height: 600 },
    );
    assert.equal(pos.width, 0);
  });

  it("下方没地方时改放到大框上方", () => {
    const pos = placeSpotCard(
      { left: 10, top: 480, width: 760, height: 80 },
      { width: 440, height: 240 },
      { width: 800, height: 600 },
    );
    assert.equal(pos.side, "above");
    assert.equal(pos.maxHeight, 460);
    assert.equal(pos.top, 228);
    assert.ok(pos.top + 240 <= 480 - 12);
  });
});

describe("spotLane", () => {
  it("页上靠右的大框把空档算在左边", () => {
    assert.equal(spotLane({ left: 800, width: 100 }, 1000), "left");
    assert.equal(spotLane({ left: 100, width: 100 }, 1000), "right");
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
    assert.deepEqual(held, { side: "held", left: 40, top: 50, width: 440 });
    const taller = resolveSpotPosition(
      { left: 40, top: 50 },
      { left: 0, top: 0, width: 10, height: 10 },
      { width: 440, height: 580 },
      { width: 800, height: 600 },
    );
    assert.deepEqual(taller, { side: "held", left: 40, top: 12, width: 440 });
  });

  it("clamps a dropped card into the same margin", () => {
    const pos = resolveSpotPosition(
      { left: -20, top: 900 },
      { left: 0, top: 0, width: 1, height: 1 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.deepEqual(pos, { side: "held", left: 8, top: 272, width: 100 });
  });

  it("places an undragged card beside the frame", () => {
    const pos = resolveSpotPosition(
      null,
      { left: 20, top: 30, width: 40, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
    );
    assert.deepEqual(pos, { side: "right", left: 72, top: 30, width: 100 });
  });

  it("lets a card clear the collapsed expand tab without changing z-index", () => {
    const moved = avoidSpotObstacle(
      { left: 280, top: 8 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
      { left: 300, top: 0, right: 390, bottom: 60 },
    );
    assert.deepEqual(moved, { left: 188, top: 8 });
    const dropped = avoidSpotObstacle(
      { left: 12, top: 8 },
      { width: 180, height: 80 },
      { width: 200, height: 360 },
      { left: 40, top: 0, right: 190, bottom: 60 },
    );
    assert.deepEqual(dropped, { left: 12, top: 72 });
    const clear = avoidSpotObstacle(
      { left: 20, top: 80 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
      { left: 300, top: 0, right: 390, bottom: 60 },
    );
    assert.deepEqual(clear, { left: 20, top: 80 });
  });

  it("框下方的窗不算压住大框", () => {
    const kept = avoidSpotObstacle(
      { left: 180, top: 312 },
      { width: 440, height: 240 },
      { width: 800, height: 600 },
      null,
      8,
      12,
      { left: 10, top: 200, width: 760, height: 100 },
    );
    assert.deepEqual(kept, { left: 180, top: 312 });
  });

  it("让开展开钮时不压回大框", () => {
    const kept = avoidSpotObstacle(
      { left: 250, top: 8 },
      { width: 100, height: 80 },
      { width: 400, height: 360 },
      { left: 300, top: 0, right: 390, bottom: 60 },
      8,
      12,
      { left: 40, top: 20, width: 180, height: 80 },
    );
    assert.deepEqual(kept, { left: 250, top: 72 });
  });

  it("counts a drag only at 4px", () => {
    assert.equal(spotDragStarted(3, 0), false);
    assert.equal(spotDragStarted(0, 3.9), false);
    assert.equal(spotDragStarted(2, 2), false);
    assert.equal(spotDragStarted(4, 0), true);
    assert.equal(spotDragStarted(3, 3), true);
  });
});

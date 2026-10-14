import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placeSpotCard } from "./spotCard.js";

describe("placeSpotCard", () => {
  it("贴在框的右侧", () => {
    const pos = placeSpotCard(
      { left: 20, top: 30, width: 40, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 300 },
    );
    assert.deepEqual(pos, { side: "right", left: 72, top: 30 });
  });

  it("靠右边缘翻到左侧", () => {
    const pos = placeSpotCard(
      { left: 320, top: 40, width: 50, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 300 },
    );
    assert.equal(pos.side, "left");
    assert.equal(pos.left, 208);
    assert.equal(pos.top, 40);
  });

  it("靠顶翻到框的下方", () => {
    const pos = placeSpotCard(
      { left: 20, top: 0, width: 40, height: 20 },
      { width: 100, height: 80 },
      { width: 400, height: 300 },
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

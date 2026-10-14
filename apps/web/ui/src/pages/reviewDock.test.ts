import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readPinsOn, readBoxesOn, readSpotOn, writePinsOn, writeBoxesOn, writeSpotOn, skipPackSheetField } from "./reviewDock.js";

describe("review markers", () => {
  it("preserves independent pin and box visibility", () => {
    const values = new Map<string, string>();
    const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    assert.equal(readPinsOn(null), true);
    assert.equal(readBoxesOn(null), true);
    writePinsOn(store, false);
    assert.equal(readPinsOn(store), false);
    assert.equal(readBoxesOn(store), true);
    writeBoxesOn(store, false);
    writePinsOn(store, true);
    assert.equal(readPinsOn(store), true);
    assert.equal(readBoxesOn(store), false);
    assert.equal(readSpotOn(null), true);
    assert.equal(readSpotOn(store), true);
    writeSpotOn(store, false);
    assert.equal(readSpotOn(store), false);
    writeSpotOn(store, true);
    assert.equal(readSpotOn(store), true);
  });
  it("skips only pack-sheet metadata fields", () => {
    assert.equal(skipPackSheetField("工艺说明"), true);
    assert.equal(skipPackSheetField("颜色要求"), true);
    assert.equal(skipPackSheetField("版本号"), true);
    assert.equal(skipPackSheetField("更新内容：调整净含量"), true);
    assert.equal(skipPackSheetField("中文品名"), false);
    assert.equal(skipPackSheetField("备案版本号"), false);
    assert.equal(skipPackSheetField("执行标准版本号"), false);
    assert.equal(skipPackSheetField(""), false);
  });
});

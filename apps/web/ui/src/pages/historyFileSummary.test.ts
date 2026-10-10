import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFile, expandLabel, HISTORY_NAME_LIMIT, splitHit, summarizeFiles } from "./historyFileSummary";

const P = "cc99285d_pack";
const real = [
  `${P}.glb`, `${P}_3D包装展示.pptx`,
  `${P}_front_right.png`, `${P}_back_left.png`, `${P}_front_right_ground.png`, `${P}_back_left_ground.png`,
  `${P}_front_right_white.png`, `${P}_back_left_white.png`, `${P}_front_right_ground_white.png`, `${P}_set_white.png`,
  `${P}_front_right_card.png`, `${P}_back_left_card.png`, `${P}_front_right_ground_card.png`, `${P}_back_left_ground_card.png`,
  "cc99285d_white_sheet.pdf", "转曲 D 达肤妍原B5.ai", `${P}_set.png`, `${P}_set_ground.png`,
];

describe("classifyFile", () => {
  it("按真实文件名归类", () => {
    assert.equal(classifyFile(`${P}.glb`), "model");
    assert.equal(classifyFile(`${P}_3D包装展示.pptx`), "ppt");
    assert.equal(classifyFile(`${P}_back_left_ground.png`), "effect");
    assert.equal(classifyFile(`${P}_set.png`), "effect");
    assert.equal(classifyFile(`${P}_front_right_card.png`), "card");
    assert.equal(classifyFile(`${P}_back_left_white.png`), "white");
    assert.equal(classifyFile("转曲 D 达肤妍原B5.ai"), "source");
  });
  it("_white_sheet.pdf 先于白底图规则，归平面图", () => {
    assert.equal(classifyFile("cc99285d_white_sheet.pdf"), "sheet");
  });
  it("_ground_card 同时命中时归卡片图", () => {
    assert.equal(classifyFile(`${P}_back_left_ground_card.png`), "card");
  });
  it("大写扩展名、多点名、无扩展名", () => {
    assert.equal(classifyFile("A.GLB"), "model");
    assert.equal(classifyFile(`${P}_BACK_LEFT_GROUND.PNG`), "effect");
    assert.equal(classifyFile("a.final.v2.png"), "image");
    assert.equal(classifyFile("README"), "other");
    assert.equal(classifyFile("确认表.XLSX"), "confirm");
    assert.equal(classifyFile("target.pdf"), "pdf");
    assert.equal(classifyFile("box_top.png"), "face");
    assert.equal(classifyFile("scene.blend"), "other");
  });
  it("whiteboard/cardboard 之类不算白底/卡片", () => {
    assert.equal(classifyFile("whiteboard.png"), "image");
    assert.equal(classifyFile("x_cardboard.png"), "image");
  });
});

describe("summarizeFiles", () => {
  it("效果图/白底图/卡片图分开计数，单件类不写数字", () => {
    const s = summarizeFiles(real);
    assert.equal(s.summary, "3D 模型 · 展示 PPT · 效果图 6 · 白底图 4 · 卡片图 4 · 平面图 PDF · 源稿");
    assert.equal(s.total, 18);
    assert.equal(s.truncated, false);
    assert.equal(s.matched, 0);
    assert.equal(expandLabel(s, false), "展开 18 个文件");
    assert.equal(expandLabel(s, true), "收起");
  });
  it("搜索命中：计数、命中排各组最前、其余仍保留", () => {
    const hit = [`${P}_back_left_ground.png`, `${P}_back_left_ground_card.png`];
    const s = summarizeFiles(real, hit);
    assert.equal(s.matched, 2);
    assert.equal(s.total, 18);
    const effect = s.groups.find(g => g.kind === "effect")!;
    assert.equal(effect.files[0], `${P}_back_left_ground.png`);
    assert.equal(effect.files.length, 6);
    assert.equal(s.groups.find(g => g.kind === "card")!.files[0], `${P}_back_left_ground_card.png`);
  });
  it("没有文件时摘要为空", () => {
    const s = summarizeFiles([]);
    assert.equal(s.summary, ""); assert.equal(s.total, 0); assert.deepEqual(s.groups, []);
  });
  it("names 达到上限视为截断", () => {
    const names = Array.from({ length: HISTORY_NAME_LIMIT }, (_, i) => `p_${i}.png`);
    const s = summarizeFiles(names);
    assert.equal(s.truncated, true);
    assert.equal(s.summary, "图片 40 等");
    assert.equal(expandLabel(s, false), "展开前 40 个文件（还有更多）");
  });
  it("去重并合并不在 names 里的命中文件", () => {
    const s = summarizeFiles(["a.png", "a.png"], ["b.pdf"]);
    assert.equal(s.total, 2); assert.equal(s.matched, 1);
  });
});

describe("splitHit", () => {
  it("不区分大小写切出命中片段", () => {
    assert.deepEqual(splitHit("X_Back_Left.png", "back_left"), [{ text: "X_", hit: false }, { text: "Back_Left", hit: true }, { text: ".png", hit: false }]);
    assert.deepEqual(splitHit("a.png", ""), [{ text: "a.png", hit: false }]);
  });
});

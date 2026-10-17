import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hitTextOf, isAccountingCopy, withHitText } from "./hitText.js";

describe("hit_text 投影", () => {
  it("Python 原句样本：fields.py 低覆盖 / 仅覆盖带未见缺失、cross_spec.py score 句进 accounting", () => {
    const low = "覆盖偏低 1/6 · 定位 0 区 · 未见缺失：香柠檬、甜橙";
    const partial = "仅覆盖 3/5 关键短语 · 定位 2 区 · 未见缺失：植物精油";
    const score = "严格同文 · score=92·ratio=88·rlen=1.02";
    for (const ev of [low, partial, score]) {
      const t = hitTextOf({ evidence: ev });
      assert.deepEqual(t.accounting, [ev], ev);
      assert.equal(t.evidence, null, ev);
    }
  });

  it("规则逐字照搬前端：「整段覆盖…」「仅覆盖…（没有未见缺失）」不算核算说明，原样给 evidence", () => {
    // 前端 isAccountingCopy 的正则不认这两种；投影不改显示行为（设计稿偏差记在汇报里）。
    for (const ev of ["整段覆盖 5/5 关键短语 · 定位 2 区 · 例「香柠檬精油」", "仅覆盖 3/5 关键短语 · 定位 2 区"]) {
      assert.equal(isAccountingCopy(ev), false, ev);
      assert.equal(hitTextOf({ evidence: ev }).evidence, ev);
    }
  });

  it("coverage.miss 拆成人话漏读词和核算说明，去掉空白", () => {
    const t = hitTextOf({ coverage: { miss: ["CAPSULE MIST", "  ", "score=0.42 覆盖偏低", "稿上命中 2/5"] } });
    assert.deepEqual(t.miss, ["CAPSULE MIST"]);
    assert.deepEqual(t.accounting, ["score=0.42 覆盖偏低", "稿上命中 2/5"]);
  });

  it("人话 evidence 原样（已过旧句替换的入参不再改写）；空 evidence 为 null", () => {
    assert.equal(hitTextOf({ evidence: "确认单要的净含量，这一面没读到，请核对" }).evidence, "确认单要的净含量，这一面没读到，请核对");
    assert.equal(hitTextOf({ evidence: "   " }).evidence, null);
    assert.equal(hitTextOf({}).evidence, null);
  });

  it("observed：pdf → found → coverage.hit 拼接 → null", () => {
    assert.equal(hitTextOf({ pdf: " 50g ", found: "x" }).observed, "50g");
    assert.equal(hitTextOf({ found: "50 g" }).observed, "50 g");
    assert.equal(hitTextOf({ coverage: { hit: ["香柠檬", " ", "精油"] } }).observed, "香柠檬 精油");
    assert.equal(hitTextOf({}).observed, null);
  });

  it("located：两种框都明确为空才算没定位；没有框字段按已定位（同前端 hitIsLocated）", () => {
    assert.equal(hitTextOf({ bboxes: [], qrcode_boxes: [] }).located, false);
    assert.equal(hitTextOf({ bboxes: [] }).located, false);
    assert.equal(hitTextOf({ bboxes: [{}] }).located, true);
    assert.equal(hitTextOf({ bboxes: [], qrcode_boxes: [{}] }).located, true);
    assert.equal(hitTextOf({}).located, true);
  });

  it("旧单没有 coverage：miss / accounting 为空数组，v=1", () => {
    assert.deepEqual(hitTextOf({ evidence: "旧单说明" }), { v: 1, miss: [], accounting: [], evidence: "旧单说明", observed: null, located: true });
  });

  it("withHitText 不改入参", () => {
    const hits = [{ id: "h1", evidence: "score=1" }];
    const out = withHitText(hits);
    assert.equal("hit_text" in hits[0], false);
    assert.deepEqual((out[0] as unknown as { hit_text: unknown }).hit_text, hitTextOf(hits[0]));
  });

  it("防漂移：前端 hitText.ts 还留着 isAccountingCopy 时，正则必须和这里一致（前端改读 hit_text 删掉后自动跳过）", () => {
    const ui = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../ui/src/pages/hitText.ts"), "utf8");
    const m = ui.match(/function isAccountingCopy[\s\S]*?return (\/.*\/[a-z]*)\.test\(text\)/);
    if (!m) return;
    assert.equal(m[1], "/score\\s*=|覆盖偏低|稿上命中\\s*\\d+\\s*\\/\\s*\\d+|best score|未见缺失/i");
    assert.equal(String(/score\s*=|覆盖偏低|稿上命中\s*\d+\s*\/\s*\d+|best score|未见缺失/i), m[1]);
    assert.equal(isAccountingCopy("best score 12"), true);
  });
});

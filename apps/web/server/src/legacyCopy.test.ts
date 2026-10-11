import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
const DATA = makeTestTempDir("beian-legacy-copy-");
process.env.WB_DATA_DIR = DATA;

const { rewriteLegacyCopy, rewriteLegacyHits, LEGACY_FIRST_PERSON_COPY } = await import("./legacyCopy.js");
const { loadTask, saveTask } = await import("./tasks.js");
const { publicTask } = await import("./jobs.js");

const OLD_NET = "确认单要的净含量，我在这一面没读到。";
const OLD_BAR = "确认单要的毫升和条码，我在这一面没读全。";

describe("legacy first-person copy", () => {
  it("maps every old sentence to impersonal copy", () => {
    assert.equal(rewriteLegacyCopy(OLD_NET), "确认单要的净含量，这一面没读到，请核对");
    assert.equal(rewriteLegacyCopy(OLD_BAR), "确认单要的毫升和条码，这一面没读全，请核对");
    assert.equal(rewriteLegacyCopy("净含量和条码都在这一面读到了。"), "净含量和条码都在这一面读到了");
    assert.equal(rewriteLegacyCopy("净含量和条码没有都读全，请对着这一面看毫升和条码。"), "净含量和条码没有都读全，请对着这一面看毫升和条码");
    assert.equal(rewriteLegacyCopy("这条是法规小字，必须印。"), "这条是法规小字，必须印。");
    assert.equal(rewriteLegacyCopy(`规格/条码类可能分支 · ${OLD_NET}`), "规格/条码类可能分支 · 确认单要的净含量，这一面没读到，请核对");
    for (const [, to] of LEGACY_FIRST_PERSON_COPY) {
      assert.doesNotMatch(to, /我/);
      assert.doesNotMatch(to, /。$/);
    }
  });

  it("leaves other text and input objects untouched", () => {
    const hits = [{ evidence: "稿上少了净含量" }, { evidence: OLD_NET }];
    const snapshot = JSON.stringify(hits);
    const out = rewriteLegacyHits(hits);
    assert.equal(JSON.stringify(hits), snapshot);
    assert.equal(out[0], hits[0]);
    assert.notEqual(out[1], hits[1]);
    const clean = [{ evidence: "一致" }];
    assert.equal(rewriteLegacyHits(clean), clean);
  });

  it("publicTask rewrites hits and hits_v2 on read but the stored task JSON is unchanged", () => {
    const id = "abcdefabcdef";
    saveTask({
      id,
      title: "老单",
      type: "excel_pdf",
      status: "pending_review",
      owner: "籽烨",
      hits: [{ id: "h1", field: "净含量", status: "疑点", evidence: `规格/条码类可能分支 · ${OLD_NET}` }],
      hits_v2: [
        { id: "h2", field: "净含量&条形码", status: "疑点", evidence: OLD_BAR },
        { id: "h3", field: "净含量&条形码", status: "疑点", evidence: "净含量和条码没有都读全，请对着这一面看毫升和条码。" },
        { id: "h4", field: "净含量&条形码", status: "一致", evidence: "净含量和条码都在这一面读到了。" },
      ],
    } as never);
    const path = join(DATA, "tasks", `${id}.json`);
    const before = readFileSync(path, "utf8");
    const pub = publicTask(loadTask(id), { id: "ou_ziye", name: "籽烨", admin: false }) as {
      hits: Array<{ evidence: string }>;
      hits_v2: Array<{ evidence: string }>;
    };
    assert.equal(pub.hits[0].evidence, "规格/条码类可能分支 · 确认单要的净含量，这一面没读到，请核对");
    assert.equal(pub.hits_v2[0].evidence, "确认单要的毫升和条码，这一面没读全，请核对");
    assert.equal(pub.hits_v2[1].evidence, "净含量和条码没有都读全，请对着这一面看毫升和条码");
    assert.equal(pub.hits_v2[2].evidence, "净含量和条码都在这一面读到了");
    assert.equal(readFileSync(path, "utf8"), before);
    assert.match(before, /我在这一面没读到/);
    assert.match(before, /都在这一面读到了。/);
    assert.match(before, /看毫升和条码。/);
    assert.equal((loadTask(id).hits as Array<{ evidence: string }>)[0].evidence.includes(OLD_NET), true);
  });
});

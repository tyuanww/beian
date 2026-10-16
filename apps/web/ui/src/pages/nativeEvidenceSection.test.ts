import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

describe("文字来源证据", () => {
  it("对照卡和右栏共用同一个组件，展开项只写一份且默认收起", () => {
    const src = readFileSync(resolve(here, "ReviewHitDetail.tsx"), "utf8");
    assert.equal(src.match(/<NativeEvidenceSection /g)?.length, 2);
    assert.equal(src.match(/<summary>查看文字来源<\/summary>/g)?.length, 1);
    assert.equal(src.match(/aria-label="文字来源证据"/g)?.length, 1);
    assert.doesNotMatch(src, /<details[^>]*\bopen\b/);
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
import { countLegacyPageOverTasks, legacyPageOverCode } from "./legacyPageOver.js";

const OLD = "稿件超过 1 页，暂不支持核对，请联系管理员";

describe("legacy page_over", () => {
  it("only old failed records without a stored code match", () => {
    assert.equal(legacyPageOverCode({ id: "a", job_status: "failed", job_error: OLD } as never), "page_over");
    assert.equal(legacyPageOverCode({ id: "a", job_status: "failed", job_error: OLD, job_error_code: "page_over" } as never), undefined);
    assert.equal(legacyPageOverCode({ id: "a", job_status: "running", job_error: OLD } as never), undefined);
    assert.equal(legacyPageOverCode({ id: "a", job_status: "failed", job_error: `${OLD}。` } as never), undefined);
  });

  it("counts records still relying on the text match, via function and npm script", () => {
    const dir = join(makeTestTempDir("beian-legacy-page-over-"), "tasks");
    mkdirSync(dir);
    const put = (id: string, t: object) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, ...t }));
    put("000000000001", { job_status: "failed", job_error: OLD });
    put("000000000002", { status: "compare_failed", job_error: "这一单页数超过可核对页数" });
    put("000000000003", { job_status: "failed", job_error: OLD, job_error_code: "page_over" });
    put("000000000004", { job_status: "failed", job_error: "对照中断" });
    writeFileSync(join(dir, "broken.json"), "{");
    assert.equal(countLegacyPageOverTasks(dir).total, 2);
    const out = execFileSync("npx", ["tsx", "src/legacyPageOver.ts", dir], { encoding: "utf8" });
    assert.equal(JSON.parse(out.trim()).legacy_page_over, 2);
  });
});

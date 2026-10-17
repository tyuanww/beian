import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRenderActorAccountId } from "./renderGenerations.js";
import { jobErrorCodeOf, type Task } from "./tasks.js";

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/contracts");

function sampleRows(file: string, name: string): string[][] {
  const text = readFileSync(join(CONTRACTS, file), "utf8");
  const start = text.indexOf(`<!-- contract-samples:${name} -->`);
  assert.ok(start >= 0, `${file} 缺少样例表 ${name}`);
  const end = text.indexOf("<!-- /contract-samples -->", start);
  assert.ok(end > start, `${file} 的样例表 ${name} 没有结束标记`);
  const rows = text.slice(start, end).split("\n").filter((line) => line.startsWith("|")).slice(2);
  assert.ok(rows.length > 0, `${file} 的样例表 ${name} 是空的`);
  return rows.map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim().replace(/^`(.*)`$/, "$1")));
}

test("jobs.md 的账号 id 样例与 isRenderActorAccountId 一致", () => {
  for (const [value, verdict] of sampleRows("jobs.md", "account-id")) {
    assert.ok(verdict === "账号 id" || verdict === "人名", `未知判定：${verdict}`);
    assert.equal(isRenderActorAccountId(value), verdict === "账号 id", value);
  }
});

test("review.md 的旧超页单样例与 jobErrorCodeOf 一致", () => {
  for (const [jobStatus, jobError, code] of sampleRows("review.md", "legacy-page-over")) {
    const task = { job_status: jobStatus, job_error: jobError } as unknown as Task;
    assert.equal(jobErrorCodeOf(task), code === "无" ? undefined : code, `${jobStatus} / ${jobError}`);
  }
});

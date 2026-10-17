import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASELINE_PATH, checkL0, parseL0Log } from "./check-l0-counts.mjs";

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const [serverSkipA, serverSkipB, serverSkipC] = baseline.node_suites[0].allowed_skips;

function nodeSuite({ tests, pass, fail = 0, skips = [] }) {
  return [
    ...skips.map((name, i) => `ok ${i + 1} - ${name} # SKIP`),
    `# tests ${tests}`, "# suites 1", `# pass ${pass}`, `# fail ${fail}`, "# cancelled 0",
    `# skipped ${skips.length}`, "# todo 0", "# duration_ms 1.5",
  ].join("\n");
}

function log({ server = {}, ui = {}, pytest = "1393 passed, 9 skipped, 10 deselected in 677.94s" } = {}) {
  return [
    nodeSuite({ tests: 1120, pass: 1117, skips: [serverSkipA, serverSkipB, serverSkipC], ...server }),
    nodeSuite({ tests: 586, pass: 586, ...ui }),
    pytest === null ? "" : `========== ${pytest} ==========`,
  ].join("\n");
}

const check = (text) => checkL0(parseL0Log(text), baseline);

describe("check-l0-counts", () => {
  it("passes when every suite matches the baseline", () => {
    assert.deepEqual(check(log()), []);
  });

  it("reads GitHub log lines that carry a timestamp prefix", () => {
    const stamped = log().split("\n").map((l) => `2026-10-17T03:30:00.1234567Z ${l}`).join("\n");
    assert.deepEqual(check(stamped), []);
  });

  it("fails on a node test failure", () => {
    assert.match(check(log({ ui: { tests: 586, pass: 585, fail: 1 } })).join("\n"), /ui：失败 1 条/);
  });

  it("fails when a skip is swapped for one outside the baseline, even with the same count", () => {
    const problems = check(log({ server: { skips: [serverSkipA, serverSkipB, "new flaky test"] } }));
    assert.match(problems.join("\n"), /基线外的跳过「new flaky test」/);
  });

  it("fails when pytest skips or deselects more than the baseline", () => {
    const problems = check(log({ pytest: "1390 passed, 10 skipped, 11 deselected in 600.00s" })).join("\n");
    assert.match(problems, /跳过 10 条，基线最多 9/);
    assert.match(problems, /排除 11 条，基线最多 10/);
  });

  it("fails on pytest failures or errors", () => {
    const problems = check(log({ pytest: "1390 passed, 2 failed, 9 skipped, 1 error in 600.00s" })).join("\n");
    assert.match(problems, /pytest：失败 2 条/);
    assert.match(problems, /pytest：报错 1 条/);
  });

  it("still passes when fewer tests are skipped than the baseline allows", () => {
    assert.deepEqual(check(log({ server: { tests: 1120, pass: 1118, skips: [serverSkipA, serverSkipB] }, pytest: "1395 passed, 7 skipped in 600.00s" })), []);
  });

  it("fails when a suite summary is missing", () => {
    const problems = check(nodeSuite({ tests: 1, pass: 1 })).join("\n");
    assert.match(problems, /应有 2 段/);
    assert.match(problems, /pytest：找不到汇总行/);
  });
});

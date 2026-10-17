import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASELINE_PATH, checkL0, parseL0Log } from "./check-l0-counts.mjs";

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const [serverSkipA, serverSkipB, serverSkipC] = baseline.node_suites[0].allowed_skips;
const [serverMin, uiMin] = baseline.node_suites.map((s) => s.min_tests);
const pySkips = baseline.pytest.allowed_skips;
const pySkipTotal = pySkips.reduce((n, s) => n + s.count, 0);
const pyPassed = baseline.pytest.min_tests - pySkipTotal;

function nodeSuite({ tests, pass, fail = 0, todo = 0, skips = [] }) {
  return [
    ...skips.map((name, i) => `ok ${i + 1} - ${name} # SKIP`),
    `# tests ${tests}`, "# suites 1", `# pass ${pass}`, `# fail ${fail}`, "# cancelled 0",
    `# skipped ${skips.length}`, `# todo ${todo}`, "# duration_ms 1.5",
  ].join("\n");
}

function skippedLines(list) {
  return list.map(({ skip, count }, i) => {
    const cut = skip.indexOf(": ");
    return `SKIPPED [${count}] ${skip.slice(0, cut)}:${10 + i}: ${skip.slice(cut + 2)}`;
  });
}

function log({ server = {}, ui = {}, pySkipList = pySkips, pytest } = {}) {
  const skipped = pySkipList.reduce((n, s) => n + s.count, 0);
  const summary = pytest ?? `${pyPassed} passed, ${skipped} skipped, 10 deselected in 677.94s`;
  return [
    nodeSuite({ tests: serverMin, pass: serverMin - 3, skips: [serverSkipA, serverSkipB, serverSkipC], ...server }),
    nodeSuite({ tests: uiMin, pass: uiMin, ...ui }),
    "=========================== short test summary info ============================",
    ...skippedLines(pySkipList),
    `========== ${summary} ==========`,
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
    assert.match(check(log({ ui: { tests: uiMin, pass: uiMin - 1, fail: 1 } })).join("\n"), /ui：失败 1 条/);
  });

  it("fails on node todo tests", () => {
    assert.match(check(log({ ui: { tests: uiMin, pass: uiMin - 1, todo: 1 } })).join("\n"), /ui：todo 1 条/);
  });

  it("fails when a node skip is swapped for one outside the baseline, even with the same count", () => {
    const problems = check(log({ server: { skips: [serverSkipA, serverSkipB, "new flaky test"] } }));
    assert.match(problems.join("\n"), /基线外的跳过「new flaky test」/);
  });

  it("fails when a pytest skip is swapped for one outside the baseline, even with the same count", () => {
    const swapped = [...pySkips.slice(0, -1), { skip: "tests/test_new.py: flaky", count: pySkips.at(-1).count }];
    assert.match(check(log({ pySkipList: swapped })).join("\n"), /pytest：基线外的跳过「tests\/test_new\.py: flaky」/);
  });

  it("fails when one pytest skip reason covers more tests than the baseline", () => {
    const more = [{ ...pySkips[0], count: pySkips[0].count + 1 }, ...pySkips.slice(1)];
    assert.match(check(log({ pySkipList: more })).join("\n"), /跳过 \d+ 条，基线最多/);
  });

  it("fails when pytest skips are not itemised by -rs", () => {
    const text = log().split("\n").filter((l) => !l.startsWith("SKIPPED [")).join("\n");
    assert.match(check(text).join("\n"), /-rs 列出 0 条/);
  });

  it("fails when pytest deselects more than the baseline", () => {
    const problems = check(log({ pytest: `${pyPassed} passed, ${pySkipTotal} skipped, 11 deselected in 600.00s` })).join("\n");
    assert.match(problems, /排除 11 条，基线最多 10/);
  });

  it("fails on pytest failures or errors", () => {
    const problems = check(log({ pytest: `${pyPassed} passed, 2 failed, ${pySkipTotal} skipped, 1 error in 600.00s` })).join("\n");
    assert.match(problems, /pytest：失败 2 条/);
    assert.match(problems, /pytest：报错 1 条/);
  });

  it("fails when a suite drops below its minimum test count", () => {
    const problems = check(log({
      server: { tests: serverMin - 1, pass: serverMin - 4 },
      pytest: `${pyPassed - 1} passed, ${pySkipTotal} skipped, 10 deselected in 600.00s`,
    })).join("\n");
    assert.match(problems, /server：用例 \d+ 条，少于基线最低/);
    assert.match(problems, /pytest：用例 \d+ 条，少于基线最低/);
  });

  it("passes when suites grow and fewer tests are skipped", () => {
    const text = log({
      server: { tests: serverMin + 5, pass: serverMin + 3, skips: [serverSkipA, serverSkipB] },
      ui: { tests: uiMin + 2, pass: uiMin + 2 },
      pySkipList: pySkips.slice(1),
      pytest: `${pyPassed + 10} passed, ${pySkipTotal - pySkips[0].count} skipped in 600.00s`,
    });
    assert.deepEqual(check(text), []);
  });

  it("fails when a suite summary is missing and points at the TAP reporter", () => {
    const problems = check(nodeSuite({ tests: 1, pass: 1 })).join("\n");
    assert.match(problems, /应有 2 段.*--test-reporter=tap/);
    assert.match(problems, /pytest：找不到汇总行/);
  });
});

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../config/quality/l0-baseline.json");

const NODE_FIELDS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s/;

function stripLine(line) {
  return line.replace(TIMESTAMP, "").replace(/\r$/, "");
}

export function parseL0Log(text) {
  const nodeSuites = [];
  let skips = [];
  let summary = null;
  let pytest = null;
  const pytestSkips = [];
  for (const raw of text.split("\n")) {
    const line = stripLine(raw);
    const skip = line.match(/^\s*ok \d+ - (.*?) # SKIP\b/);
    if (skip) skips.push(skip[1].trim());
    const field = line.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/);
    if (field) {
      if (field[1] === "tests") summary = {};
      if (summary) summary[field[1]] = Number(field[2]);
      if (field[1] === "duration_ms" && summary) {
        nodeSuites.push({ ...summary, skip_names: skips });
        summary = null;
        skips = [];
      }
      continue;
    }
    const pySkip = line.match(/^SKIPPED \[(\d+)\] (.+?):\d+: (.*)$/);
    if (pySkip) pytestSkips.push({ skip: `${pySkip[2]}: ${pySkip[3].trim()}`, count: Number(pySkip[1]) });
    const py = line.match(/^=*\s*(\d+ passed.*?) in [\d.]+s/);
    if (py) {
      pytest = {};
      for (const m of py[1].matchAll(/(\d+) (passed|failed|errors?|skipped|deselected|xfailed|xpassed)/g)) {
        pytest[m[2] === "error" ? "errors" : m[2]] = Number(m[1]);
      }
    }
  }
  if (pytest) pytest.skip_list = pytestSkips;
  return { nodeSuites, pytest };
}

export function checkL0(parsed, baseline) {
  const problems = [];
  const expected = baseline.node_suites;
  if (parsed.nodeSuites.length !== expected.length) {
    problems.push(`node 测试汇总应有 ${expected.length} 段（${expected.map((s) => s.name).join("、")}），日志里有 ${parsed.nodeSuites.length} 段。`
      + "server、UI 的 test 脚本必须带 --test-reporter=tap，换成别的输出格式这里认不出来");
  }
  expected.forEach((suite, i) => {
    const got = parsed.nodeSuites[i];
    if (!got) return;
    for (const f of NODE_FIELDS) {
      if (typeof got[f] !== "number") problems.push(`${suite.name}：汇总缺少 ${f}`);
    }
    if (got.fail !== 0) problems.push(`${suite.name}：失败 ${got.fail} 条`);
    if (got.cancelled !== 0) problems.push(`${suite.name}：取消 ${got.cancelled} 条`);
    if (got.todo !== 0) problems.push(`${suite.name}：todo ${got.todo} 条，todo 用例失败也不会变红，不允许`);
    if (got.tests < suite.min_tests) problems.push(`${suite.name}：用例 ${got.tests} 条，少于基线最低 ${suite.min_tests} 条`);
    if (got.skipped !== got.skip_names.length) {
      problems.push(`${suite.name}：汇总写跳过 ${got.skipped} 条，日志里认出 ${got.skip_names.length} 条 # SKIP`);
    }
    for (const name of got.skip_names) {
      if (!suite.allowed_skips.includes(name)) problems.push(`${suite.name}：基线外的跳过「${name}」`);
    }
  });
  const py = parsed.pytest;
  if (!py) {
    problems.push("pytest：找不到汇总行");
  } else {
    if (py.failed) problems.push(`pytest：失败 ${py.failed} 条`);
    if (py.errors) problems.push(`pytest：报错 ${py.errors} 条`);
    const collected = (py.passed ?? 0) + (py.skipped ?? 0) + (py.failed ?? 0) + (py.xfailed ?? 0) + (py.xpassed ?? 0);
    if (collected < baseline.pytest.min_tests) problems.push(`pytest：用例 ${collected} 条，少于基线最低 ${baseline.pytest.min_tests} 条`);
    const listed = py.skip_list.reduce((n, s) => n + s.count, 0);
    if ((py.skipped ?? 0) !== listed) {
      problems.push(`pytest：汇总写跳过 ${py.skipped ?? 0} 条，-rs 列出 ${listed} 条（L0 的 PYTEST_ADDOPTS 要带 -rs）`);
    }
    const allowed = new Map(baseline.pytest.allowed_skips.map((s) => [s.skip, s.count]));
    const seen = new Map();
    for (const s of py.skip_list) seen.set(s.skip, (seen.get(s.skip) ?? 0) + s.count);
    for (const [skip, count] of seen) {
      if (!allowed.has(skip)) problems.push(`pytest：基线外的跳过「${skip}」`);
      else if (count > allowed.get(skip)) problems.push(`pytest：「${skip}」跳过 ${count} 条，基线最多 ${allowed.get(skip)}`);
    }
    if ((py.deselected ?? 0) > baseline.pytest.max_deselected) problems.push(`pytest：排除 ${py.deselected} 条，基线最多 ${baseline.pytest.max_deselected}`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error("用法：node scripts/quality/check-l0-counts.mjs <L0 日志>");
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const parsed = parseL0Log(readFileSync(logPath, "utf8"));
  const problems = checkL0(parsed, baseline);
  const counts = parsed.nodeSuites.map((s, i) => `${baseline.node_suites[i]?.name ?? i}: ${s.pass}/${s.tests} 跳过 ${s.skipped}`);
  if (parsed.pytest) counts.push(`pytest: ${parsed.pytest.passed} 通过 跳过 ${parsed.pytest.skipped ?? 0} 排除 ${parsed.pytest.deselected ?? 0}`);
  console.log(counts.join("；"));
  if (problems.length) {
    console.error("L0 数字与基线不一致：");
    for (const p of problems) console.error(`- ${p}`);
    console.error(`基线在 config/quality/l0-baseline.json，改动要经评审。`);
    process.exit(1);
  }
  console.log("L0 数字与基线一致");
}

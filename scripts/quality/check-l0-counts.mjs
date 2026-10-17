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
    const py = line.match(/^=*\s*(\d+ passed.*?) in [\d.]+s/);
    if (py) {
      pytest = {};
      for (const m of py[1].matchAll(/(\d+) (passed|failed|errors?|skipped|deselected|xfailed|xpassed)/g)) {
        pytest[m[2] === "error" ? "errors" : m[2]] = Number(m[1]);
      }
    }
  }
  return { nodeSuites, pytest };
}

export function checkL0(parsed, baseline) {
  const problems = [];
  const expected = baseline.node_suites;
  if (parsed.nodeSuites.length !== expected.length) {
    problems.push(`node 测试汇总应有 ${expected.length} 段（${expected.map((s) => s.name).join("、")}），日志里有 ${parsed.nodeSuites.length} 段`);
  }
  expected.forEach((suite, i) => {
    const got = parsed.nodeSuites[i];
    if (!got) return;
    for (const f of NODE_FIELDS) {
      if (typeof got[f] !== "number") problems.push(`${suite.name}：汇总缺少 ${f}`);
    }
    if (got.fail !== 0) problems.push(`${suite.name}：失败 ${got.fail} 条`);
    if (got.cancelled !== 0) problems.push(`${suite.name}：取消 ${got.cancelled} 条`);
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
    if (!(py.passed > 0)) problems.push("pytest：通过数为 0");
    if ((py.skipped ?? 0) > baseline.pytest.max_skipped) problems.push(`pytest：跳过 ${py.skipped} 条，基线最多 ${baseline.pytest.max_skipped}`);
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

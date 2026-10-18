import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPROVED_ANTD_CLI_VERSION = "6.6.1";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");

const COMMANDS = new Map([
  ["list", { min: 0, max: 0 }],
  ["info", { min: 1, max: 1 }],
  ["doc", { min: 1, max: 1 }],
  ["demo", { min: 1, max: 2 }],
  ["token", { min: 0, max: 1 }],
  ["design.md", { min: 0, max: 0 }],
  ["semantic", { min: 1, max: 1 }],
  ["changelog", { min: 0, max: 3 }],
  ["doctor", { min: 0, max: 0 }],
  ["usage", { min: 0, max: 1 }],
  ["lint", { min: 0, max: 1 }],
  ["migrate", { min: 2, max: 2 }],
  ["env", { min: 0, max: 1 }],
]);

const GLOBAL_VALUE_FLAGS = new Set(["--format", "--version", "--lang"]);
const GLOBAL_BOOLEAN_FLAGS = new Set(["--detail", "--help", "-h"]);
const COMMAND_VALUE_FLAGS = new Map([
  ["usage", new Set(["--filter", "-f"])],
  ["lint", new Set(["--only", "--antd-alias"])],
  ["migrate", new Set(["--component"])],
]);
const COMMAND_BOOLEAN_FLAGS = new Map([
  ["lint", new Set(["--staged"])],
]);

const HELP = `用法（只读，不改本机工具链）：
  node scripts/quality/antd-readonly.mjs --help
  node scripts/quality/antd-readonly.mjs --cli-version
  node scripts/quality/antd-readonly.mjs info <组件> --lang zh --format json
  node scripts/quality/antd-readonly.mjs demo <组件> <示例> --format json

已审核子命令：list、info、doc、demo、token、design.md、semantic、changelog、doctor、usage、lint、migrate、env。
CLI 必须是 @ant-design/cli@${APPROVED_ANTD_CLI_VERSION}。包装器优先用仓库根 node_modules/.bin/antd。
拒绝 setup、upgrade、--fix 和仓库外路径。参数错误退出码 2，stderr 含 code 和下一命令。`;

function repoAntdBin() {
  const bin = resolve(REPO_ROOT, "node_modules/.bin/antd");
  return existsSync(bin) ? bin : null;
}

function withinRepo(path) {
  const rel = relative(REPO_ROOT, resolve(REPO_ROOT, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 缺少参数`);
  return value;
}

export function validateReadonlyArgs(args) {
  if (args.length === 1 && (args[0] === "-V" || args[0] === "--cli-version")) return;
  const command = args[0] || "";
  const spec = COMMANDS.get(command);
  if (!spec) throw new Error(`不允许的 antd 子命令：${command || "(空)"}`);

  const positionals = [];
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token.includes("\0")) throw new Error("参数含非法字符");
    if (token.includes("=")) throw new Error(`参数必须使用分隔形式：${token}`);
    if (GLOBAL_BOOLEAN_FLAGS.has(token) || COMMAND_BOOLEAN_FLAGS.get(command)?.has(token)) continue;
    if (GLOBAL_VALUE_FLAGS.has(token) || COMMAND_VALUE_FLAGS.get(command)?.has(token)) {
      const value = valueAfter(args, index, token);
      if (token === "--format" && !new Set(["json", "text", "markdown"]).has(value)) {
        throw new Error(`不允许的输出格式：${value}`);
      }
      if (token === "--lang" && value !== "en" && value !== "zh") {
        throw new Error(`不允许的语言：${value}`);
      }
      index += 1;
      continue;
    }
    if (command === "lint" && token === "--diff") {
      if (args[index + 1] && !args[index + 1].startsWith("-")) index += 1;
      continue;
    }
    if (token.startsWith("-")) throw new Error(`不允许的参数：${token}`);
    positionals.push(token);
  }

  if (positionals.length < spec.min || positionals.length > spec.max) {
    throw new Error(`${command} 的位置参数数量不合法`);
  }
  if (["usage", "lint", "env"].includes(command) && positionals[0] && !withinRepo(positionals[0])) {
    throw new Error(`${command} 只能读取当前仓库内路径`);
  }
}

function readonlyEnvironment(base = process.env) {
  return { ...base, CI: "1", NO_UPDATE_CHECK: "1" };
}

export function runReadonlyCli(args, options = {}) {
  validateReadonlyArgs(args);
  const bin = options.bin || repoAntdBin() || "antd";
  const env = readonlyEnvironment(options.env || process.env);
  const version = spawnSync(bin, ["-V"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (version.error) {
    throw new Error([
      `找不到已批准的 antd CLI：${version.error.message}`,
      "code: ANTD_CLI_MISSING",
      "下一步：在仓库根运行 npm install。包装器只用依赖里的 @ant-design/cli@6.6.1，不改 PATH 上的其他 antd。",
    ].join("\n"));
  }
  if (version.status !== 0) throw new Error(`antd CLI 版本探测失败（退出码 ${version.status ?? "unknown"}）\ncode: ANTD_CLI_PROBE\n下一步：node scripts/quality/antd-readonly.mjs --help`);
  const actual = String(version.stdout || "").trim();
  if (actual !== APPROVED_ANTD_CLI_VERSION) {
    throw new Error([
      `antd CLI 版本不匹配：需要 ${APPROVED_ANTD_CLI_VERSION}，实际 ${actual || "unknown"}`,
      "code: ANTD_CLI_VERSION",
      "下一步：在仓库根运行 npm install，让包装器使用 node_modules/.bin/antd。不要把 PATH 上的其他版本当成查询结果。升级 CLI 要单独批准。",
    ].join("\n"));
  }

  const result = spawnSync(bin, args, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    stdio: options.stdio || "inherit",
  });
  if (result.error) throw new Error(`antd CLI 执行失败：${result.error.message}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
  } else {
    try {
      const result = runReadonlyCli(args, process.env.ANTD_READONLY_BIN ? { bin: process.env.ANTD_READONLY_BIN } : {});
      process.exitCode = result.status ?? 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      if (!message.includes("code:")) {
        console.error("code: ANTD_READONLY_ARGS");
        console.error("下一步：node scripts/quality/antd-readonly.mjs --help");
      }
      process.exitCode = 2;
    }
  }
}

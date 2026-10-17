#!/usr/bin/env node
/**
 * 真后端自检：临时数据目录 + 真 Hono 服务（serve 已构建的 UI）+ 无头浏览器。
 *
 * 用法（在 apps/web/ui 下）：
 *   npm run verify:real-backend -- --scenario legacy-page-over --out /tmp/verify-out
 *   node scripts/verify-real-backend.mjs --scenario ./scripts/verify-scenarios/legacy-page-over.json --out <dir> [--no-build] [--keep-data]
 *
 * 场景 JSON：tasks（写进 <临时数据目录>/tasks/<id>.json 的任务记录）、
 * api（要导出的接口 + 字段断言；pick 用来从列表里挑一条）、pages（要截图的页面 + 选择器断言）、login（本机显示名，默认「管理员」）。
 * 输出：<out>/server.log、各接口 JSON、截图、summary.json。任一断言失败 → 退出码 1；环境/启动问题 → 退出码 2。
 *
 * 只用 mkdtemp 新建的临时目录当 WB_DATA_DIR，永不指向 runtime/ 或 apps/web/backend/data；
 * 只结束本脚本自己拉起的服务进程组（按 PID），退出时删掉临时目录（--keep-data 保留）。
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(UI_ROOT, "../../..");
const SERVER_ROOT = resolve(REPO_ROOT, "apps/web/server");
const SCENARIO_DIR = join(HERE, "verify-scenarios");
const FORBIDDEN_DIRS = [resolve(REPO_ROOT, "runtime"), resolve(REPO_ROOT, "apps/web/backend/data")];
const TID = /^[0-9a-f]{12}$/;

class SetupError extends Error {}

function parseArgs(argv) {
  const opts = { scenario: "", out: "", build: true, keepData: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--scenario") opts.scenario = argv[++i] || "";
    else if (a === "--out") opts.out = argv[++i] || "";
    else if (a === "--no-build") opts.build = false;
    else if (a === "--keep-data") opts.keepData = true;
    else if (a === "-h" || a === "--help") {
      console.log("用法：verify-real-backend.mjs --scenario <名字|JSON 路径> --out <输出目录> [--no-build] [--keep-data]");
      process.exit(0);
    } else throw new SetupError(`未知参数：${a}`);
  }
  if (!opts.scenario || !opts.out) throw new SetupError("必须给 --scenario 和 --out");
  return opts;
}

function within(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 防线：数据目录和输出目录都不能落在 runtime/ 或后端默认数据目录里。 */
export function assertSafeDir(path, label) {
  const abs = resolve(path);
  let real = abs;
  try { real = realpathSync(abs); } catch { /* 还没建 */ }
  for (const bad of FORBIDDEN_DIRS) {
    if (within(abs, bad) || within(real, bad)) throw new SetupError(`${label} 不能在 ${bad} 里：${abs}`);
  }
  return abs;
}

function loadScenario(arg) {
  const file = arg.endsWith(".json") ? resolve(arg) : join(SCENARIO_DIR, `${arg}.json`);
  if (!existsSync(file)) throw new SetupError(`找不到场景：${file}`);
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(s.tasks) || !Array.isArray(s.api ?? []) || !Array.isArray(s.pages ?? [])) throw new SetupError("场景格式不对：tasks/api/pages 要是数组");
  for (const t of s.tasks) if (!TID.test(String(t.id))) throw new SetupError(`任务 id 必须是 12 位小写十六进制：${t.id}`);
  return { file, name: s.name || arg, login: s.login || "管理员", tasks: s.tasks, api: s.api || [], pages: s.pages || [] };
}

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

/** 取 a.b.c 形式的字段。 */
function field(obj, path) {
  return String(path).split(".").reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

export function pickRecord(body, pick) {
  if (!pick) return body;
  const list = Array.isArray(body) ? body : Object.values(body || {}).find(Array.isArray) || [];
  return list.find((item) => Object.entries(pick).every(([k, v]) => field(item, k) === v));
}

export function checkFields(record, expect, where) {
  const failures = [];
  if (record == null) return [`${where}: 没找到要检查的记录`];
  for (const [k, want] of Object.entries(expect || {})) {
    const got = field(record, k);
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${where}: ${k} 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }
  return failures;
}

async function waitHealthy(base, child, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode != null) throw new SetupError(`后端提前退出，exit=${child.exitCode}，见 server.log`);
    try {
      const r = await fetch(`${base}/api/auth/me`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new SetupError(`后端 ${ms / 1000}s 内没起来，见 server.log`);
}

function stopServer(child) {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise((ok) => {
    const done = () => { clearTimeout(hard); ok(); };
    child.once("exit", done);
    // detached=true：子进程自成进程组，按 PID 结束这一组（tsx 及其 node 子进程），不碰别的进程。
    try { process.kill(-child.pid, "SIGTERM"); } catch { done(); return; }
    const hard = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ }
      setTimeout(ok, 500);
    }, 5_000);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scenario = loadScenario(opts.scenario);
  const out = assertSafeDir(opts.out, "输出目录");
  mkdirSync(out, { recursive: true });

  if (opts.build || !existsSync(join(UI_ROOT, "dist/index.html"))) {
    const b = spawnSync("npm", ["run", "build"], { cwd: UI_ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    writeFileSync(join(out, "build.log"), `${b.stdout}\n${b.stderr}`);
    if (b.status !== 0) throw new SetupError(`UI 构建失败，见 ${join(out, "build.log")}`);
  }

  const dataDir = assertSafeDir(mkdtempSync(join(tmpdir(), "beian-verify-")), "数据目录");
  mkdirSync(join(dataDir, "tasks"), { recursive: true });
  for (const t of scenario.tasks) writeFileSync(join(dataDir, "tasks", `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("WB_")));
  Object.assign(env, { WB_PORT: String(port), WB_HOST: "127.0.0.1", WB_DATA_DIR: dataDir, WB_PUBLIC: "0", WB_DEV_DISPLAY_LOGIN: "true" });
  const tsxCli = createRequire(join(SERVER_ROOT, "package.json")).resolve("tsx/cli");
  const log = createWriteStream(join(out, "server.log"));
  const child = spawn(process.execPath, [tsxCli, "src/index.ts"], { cwd: SERVER_ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  console.log(`[verify] 场景 ${scenario.name}；后端 PID ${child.pid}，${base}；数据目录 ${dataDir}`);

  const failures = [];
  const results = { scenario: scenario.name, scenario_file: relative(REPO_ROOT, scenario.file), base, server_pid: child.pid, data_dir: dataDir, api: [], pages: [] };
  let browser;
  const cleanup = async () => {
    await browser?.close().catch(() => {});
    await stopServer(child);
    log.end();
    if (!opts.keepData) rmSync(dataDir, { recursive: true, force: true });
  };
  const onSignal = () => { void cleanup().then(() => process.exit(130)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await waitHealthy(base, child);
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
    const login = await context.request.post("/api/auth/login", { data: { display_name: scenario.login } });
    if (!login.ok()) throw new SetupError(`显示名登录失败：HTTP ${login.status()} ${await login.text()}`);

    for (const item of scenario.api) {
      const r = await context.request.get(item.path);
      const body = await r.json().catch(() => null);
      if (item.save) writeFileSync(join(out, item.save), `${JSON.stringify(body, null, 2)}\n`);
      const where = `API ${item.path}`;
      const f = r.ok() ? checkFields(pickRecord(body, item.pick), item.expect, where) : [`${where}: HTTP ${r.status()}`];
      failures.push(...f);
      results.api.push({ path: item.path, status: r.status(), save: item.save, ok: f.length === 0, failures: f });
    }

    const page = await context.newPage();
    for (const item of scenario.pages) {
      const f = [];
      await page.goto(item.path);
      await page.waitForLoadState("networkidle").catch(() => {});
      for (const e of item.expect || []) {
        const loc = page.locator(e.selector);
        const where = `页面 ${item.path} ${e.selector}`;
        if (e.visible) {
          const target = e.hasText ? loc.filter({ hasText: e.hasText }) : loc;
          const seen = await target.first().waitFor({ state: "visible", timeout: e.timeout ?? 10_000 }).then(() => true, () => false);
          if (!seen) f.push(`${where}: 没看到${e.hasText ? `含「${e.hasText}」的` : ""}可见元素`);
        }
        if (typeof e.count === "number") {
          const n = await loc.count();
          if (n !== e.count) f.push(`${where}: 数量期望 ${e.count}，实际 ${n}`);
        }
      }
      if (item.screenshot) await page.screenshot({ path: join(out, item.screenshot), fullPage: true });
      failures.push(...f);
      results.pages.push({ path: item.path, screenshot: item.screenshot, ok: f.length === 0, failures: f });
    }
  } finally {
    await cleanup();
    results.data_dir_removed = !opts.keepData && !existsSync(dataDir);
    results.server_exited = child.exitCode != null || child.signalCode != null;
    results.failures = failures;
    results.ok = failures.length === 0;
    writeFileSync(join(out, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
  }

  for (const f of failures) console.error(`[verify] FAIL ${f}`);
  console.log(`[verify] ${failures.length ? "FAIL" : "PASS"} ${scenario.name}：API ${results.api.length} 项，页面 ${results.pages.length} 个；输出 ${out}`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`[verify] ${err instanceof SetupError ? "环境/启动问题" : "脚本异常"}：${err?.message || err}`);
    process.exit(2);
  });
}

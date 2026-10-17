#!/usr/bin/env node
/**
 * 前端「按报错文案判断状态」静态检查（仓库没有 ESLint，按 antd-readonly / check-project-skills 的做法用自带脚本）。
 *
 * 判状态要认后端的机读码（如 job_error_code），不认文案：文案可改，判断不能跟着变。
 * 本检查扫 apps/web/ui/src 下非测试的 .ts/.tsx，找出对「报错文本」做 includes / startsWith / endsWith /
 * indexOf / match / matchAll / search / test / exec 的调用：
 *   - 被匹配的对象名像报错：message / msg / error / err / detail(s) / reason / job_error，或以 Message / Error / Detail /
 *     _error / _message 结尾（含 r.message、String(err) 等写法）；
 *   - 或名字是 raw / text，且它由报错字段赋值（同文件里的初始化引用了 message / error / err / detail），
 *     或匹配用的字符串/正则是人话（含汉字，或两个以上英文单词）。
 * 允许的例外：紧挨在调用上一行写 `// error-text-match-allow -- <理由>`。例外总数只减不增，
 * 由 scripts/quality/error-text-match.test.mjs 里的 ALLOWED 基线按文件锁定。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const UI_ROOT = join(REPO_ROOT, "apps/web/ui");
export const SCAN_ROOT = join(UI_ROOT, "src");
export const ALLOW_MARKER = "error-text-match-allow";

// 用 UI 工作区自己的 TypeScript 解析，不给根目录新增依赖。
const ts = createRequire(join(UI_ROOT, "package.json"))("typescript");

const METHODS = new Set(["includes", "startsWith", "endsWith", "indexOf", "match", "matchAll", "search", "test", "exec"]);
const REGEX_OWNER_METHODS = new Set(["test", "exec"]);
const STRONG_NAME = /^(message|msg|error|err|detail|details|reason|job_error|errorText|errText)$|(Message|Error|Detail|_error|_message)$/u;
const WEAK_NAME = /^(raw|text)$/u;
const ERRORISH_INIT = /\b(message|error|err|detail|job_error)\b/u;
const PROSE = /\p{Script=Han}|[A-Za-z]{2,}\s+[A-Za-z]{2,}/u;

function subjectName(node) {
  if (!node) return "";
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return subjectName(node.expression);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "String") return subjectName(node.arguments[0]);
  if (ts.isBinaryExpression(node)) return subjectName(node.left);
  return "";
}

function collectDeclarations(source) {
  const decls = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = decls.get(node.name.text) || [];
      list.push(node.initializer);
      decls.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return decls;
}

function patternText(node, decls) {
  if (!node) return "";
  if (ts.isRegularExpressionLiteral(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return (decls.get(node.text) || []).map((init) => patternText(init, decls)).join(" ");
  if (ts.isNewExpression(node) && node.arguments?.[0]) return patternText(node.arguments[0], decls);
  return "";
}

function errorDerived(name, decls) {
  return (decls.get(name) || []).some((init) => ERRORISH_INIT.test(init.getText()));
}

/** 扫一段源码，返回疑似「按报错文案判断」的调用及是否带了例外标记。 */
export function scanSource(code, file = "inline.ts") {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const decls = collectDeclarations(source);
  const lines = code.split(/\r?\n/u);
  const hits = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && METHODS.has(node.expression.name.text)) {
      const method = node.expression.name.text;
      const owner = node.expression.expression;
      const subject = REGEX_OWNER_METHODS.has(method) ? node.arguments[0] : owner;
      const pattern = REGEX_OWNER_METHODS.has(method) ? owner : node.arguments[0];
      const name = subjectName(subject);
      const flagged = STRONG_NAME.test(name) || (WEAK_NAME.test(name) && (errorDerived(name, decls) || PROSE.test(patternText(pattern, decls))));
      if (flagged) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const prev = lines[line - 2] || "";
        hits.push({ file, line, name, method, allowed: prev.includes(ALLOW_MARKER), snippet: node.getText(source).slice(0, 100) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function listSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listSources(path));
    else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry) && !entry.endsWith(".d.ts")) out.push(path);
  }
  return out.sort();
}

/** 扫整个 UI src：violations 是没标记的命中，allowed 是带标记的例外，staleMarkers 是标记下一行已经没有命中。 */
export function scanRepo(root = SCAN_ROOT) {
  const violations = [];
  const allowed = [];
  const staleMarkers = [];
  for (const path of listSources(root)) {
    const file = relative(REPO_ROOT, path).split(sep).join("/");
    const code = readFileSync(path, "utf8");
    const hits = scanSource(code, file);
    for (const hit of hits) (hit.allowed ? allowed : violations).push(hit);
    const hitLines = new Set(hits.map((h) => h.line));
    code.split(/\r?\n/u).forEach((text, index) => {
      if (text.includes(ALLOW_MARKER) && !hitLines.has(index + 2)) staleMarkers.push({ file, line: index + 1 });
    });
  }
  return { violations, allowed, staleMarkers };
}

/** 每个文件里「带标记的例外所在行」计数（同一行多个调用只算一处）。 */
export function allowedLinesByFile(allowed) {
  const lines = new Map();
  for (const hit of allowed) {
    const set = lines.get(hit.file) || new Set();
    set.add(hit.line);
    lines.set(hit.file, set);
  }
  return Object.fromEntries([...lines].map(([file, set]) => [file, set.size]).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const { violations, allowed, staleMarkers } = scanRepo();
  for (const v of violations) console.error(`${v.file}:${v.line} 按报错文案判断（${v.name}.${v.method}）：${v.snippet}`);
  for (const s of staleMarkers) console.error(`${s.file}:${s.line} ${ALLOW_MARKER} 标记下一行已没有命中，请删掉标记并缩小基线`);
  console.log(`error-text-match: ${violations.length} 处违规，${staleMarkers.length} 个失效标记，${allowed.length} 处已登记例外`);
  process.exit(violations.length || staleMarkers.length ? 1 : 0);
}

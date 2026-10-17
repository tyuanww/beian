import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOW_MARKER, allowedLinesByFile, scanRepo, scanSource } from "./error-text-match.mjs";

/**
 * 「按报错文案判断状态」的存量例外基线：只减不增。
 * 清掉一处就把对应数字减 1（为 0 就删掉这一行）；任何新增或调大都会让本测试失败。
 * 前三个文件是批次 4 指派时已知的三处；SettingsPage / setupBoard 是本检查首次扫描新发现的存量，同样只减不增。
 * hitText.ts 认的是后端 OCR 核对文本，不是报错文案，只为存量登记，不作为新增例外的先例。
 */
const ALLOWED = Object.freeze({
  "apps/web/ui/src/App.tsx": 3,
  "apps/web/ui/src/pages/SettingsPage.tsx": 1,
  "apps/web/ui/src/pages/hitText.ts": 1,
  "apps/web/ui/src/pages/reviewErrorCopy.ts": 1,
  "apps/web/ui/src/pages/setupBoard.ts": 4,
});
const MAX_TOTAL = 10;

test("新的 err.message.includes(...) 会被拦下", () => {
  const hits = scanSource('export function f(err: Error) { if (err.message.includes("x")) return 1; return 0; }');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].allowed, false);
  assert.equal(hits[0].name, "message");
  assert.equal(hits[0].method, "includes");
});

test("各种报错文本写法都算：detail.startsWith、正则 test(error)、String(err).match、由 err.message 赋值的 raw", () => {
  const code = [
    'declare const detail: string; declare const error: string; declare const err: unknown;',
    'detail.startsWith("合成");',
    '/超时/.test(error);',
    'String(err).match(/x y/);',
    'const raw = err instanceof Error ? err.message : "";',
    '/fetch/.test(raw);',
    'declare const text: string;',
    'text.includes("伸美");',
  ].join("\n");
  assert.deepEqual(scanSource(code).map((h) => `${h.name}.${h.method}`), ["detail.startsWith", "error.test", "err.match", "raw.test", "text.includes"]);
});

test("非报错文本不误报：任务 id 正则、普通名字、无人话模式的 text", () => {
  const code = [
    'const TASK = /^[0-9a-f]{12}$/;',
    'const raw = sessionStorage.getItem("k") || "";',
    'TASK.test(raw);',
    'declare const name: string; declare const text: string;',
    'name.includes("伸美");',
    'text.startsWith("/");',
  ].join("\n");
  assert.deepEqual(scanSource(code), []);
});

test(`紧挨上一行写 ${ALLOW_MARKER} 才算登记例外`, () => {
  const code = [
    'declare const message: string;',
    `// ${ALLOW_MARKER} -- 待后端错误码`,
    'message.includes("取消");',
    '',
    `// ${ALLOW_MARKER} -- 隔了一行不算`,
    '',
    'message.includes("过期");',
  ].join("\n");
  assert.deepEqual(scanSource(code).map((h) => h.allowed), [true, false]);
});

test("仓库现状：没有未登记的按文案判断，例外只在基线文件里且只减不增", () => {
  const { violations, allowed, staleMarkers } = scanRepo();
  assert.deepEqual(violations.map((v) => `${v.file}:${v.line} ${v.snippet}`), [], "新增的按报错文案判断：请改用后端错误码");
  assert.deepEqual(staleMarkers, [], "例外标记下一行已没有命中：删掉标记并把 ALLOWED 减小");
  const actual = allowedLinesByFile(allowed);
  const total = Object.values(ALLOWED).reduce((a, b) => a + b, 0);
  assert.ok(total <= MAX_TOTAL, `基线总数只减不增：${total} > ${MAX_TOTAL}`);
  for (const [file, count] of Object.entries(actual)) {
    assert.ok(file in ALLOWED, `${file} 不在例外基线里：不能新增例外文件`);
    assert.ok(count <= ALLOWED[file], `${file} 例外 ${count} 处，超过基线 ${ALLOWED[file]}`);
  }
  // 清掉了就同步缩小基线，避免留出可再加回去的空位。
  assert.deepEqual(actual, ALLOWED, "实际例外比基线少：请把 ALLOWED（和 MAX_TOTAL）同步减小");
});

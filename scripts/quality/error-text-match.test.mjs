import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOW_MARKER, allowedLinesByFile, scanRepo, scanSource } from "./error-text-match.mjs";

/**
 * 「按报错文案判断状态」的存量例外基线：只减不增。
 * 清掉一处就把对应数字减 1（为 0 就删掉这一行）；任何新增或调大都会让本测试失败。
 * 批次 4 指派时已知三处：App.tsx 已于第 5 批改按 feishu_error 码清掉；reviewErrorCopy 已于加码改按 job_error_code（ocr_failed 等）清掉，剩 hitText；
 * SettingsPage / setupBoard 是本检查首次扫描新发现的存量，同样只减不增。
 * hitText.ts 认的是后端 OCR 核对文本，不是报错文案，只为存量登记，不作为新增例外的先例。
 * setupBoard.ts 中 probeErrorMessage 那 1 行是永久例外：认浏览器 fetch 自己抛的报错，后端给不了码；同样不作先例。
 */
const ALLOWED = Object.freeze({
  "apps/web/ui/src/pages/SettingsPage.tsx": 1,
  "apps/web/ui/src/pages/hitText.ts": 1,
  "apps/web/ui/src/pages/setupBoard.ts": 4,
});
const MAX_TOTAL = 6;

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

test("先剥掉无参字符串规整调用再取名字：toLowerCase / toUpperCase / toLocale*Case / trim / trimStart / trimEnd / trimLeft / trimRight 都拦", () => {
  const forms = [
    'err.message.toLowerCase().includes("x");',
    'r.message.trim().startsWith("超时");',
    'err.message.toUpperCase().endsWith("X");',
    'err.message.toLocaleLowerCase().indexOf("x");',
    'err.message.toLocaleUpperCase().includes("X");',
    'r.message.trimStart().startsWith("未启用");',
    'r.message.trimEnd().endsWith("失败");',
    'r.message.trimLeft().includes("x");',
    'r.message.trimRight().includes("x");',
    '/超时/.test(r.message.trim().toLowerCase());',
  ];
  for (const form of forms) {
    const hits = scanSource(`declare const err: Error; declare const r: { message: string };\n${form}`);
    assert.equal(hits.length, 1, form);
    assert.equal(hits[0].name, "message", form);
  }
});

test("规整调用不改变非报错名字的结论；带参数的调用不剥", () => {
  const code = [
    'declare const name: string; declare const err: Error;',
    'name.toLowerCase().includes("x");',
    'name.trim().startsWith("伸美");',
    'err.message.split(":")[0];',
  ].join("\n");
  assert.deepEqual(scanSource(code), []);
});

test("报错名字与字符串字面量直接比较：=== / !== / == / != 左右颠倒都拦", () => {
  const forms = [
    'err.message === "Failed to fetch";',
    '"Failed to fetch" === err.message;',
    'r.message !== "超时";',
    '"超时" !== r.message;',
    'error == "登录已过期";',
    '"登录已过期" == error;',
    'detail != "当前状态不可审核";',
    '"当前状态不可审核" != detail;',
    'err.message.trim() === "timeout";',
    'raw === "服务没连上";',
  ];
  for (const form of forms) {
    const hits = scanSource(`declare const err: Error; declare const r: { message: string }; declare const error: string; declare const detail: string; declare const raw: string;\n${form}`);
    assert.equal(hits.length, 1, form);
  }
});

test("比较的正例：机读码、空串、非报错名字不拦", () => {
  const code = [
    'declare const reason: string; declare const error: string; declare const status: string; declare const caps: { legacy_relight: { reason: string } };',
    'caps.legacy_relight.reason !== "permission_denied";',
    'reason === "native_coverage";',
    'error === "";',
    'status === "failed";',
    'status === "已签字";',
  ].join("\n");
  assert.deepEqual(scanSource(code), []);
});

test("报错字段与下划线形字面量比较也拦：err.message === \"network_error\"", () => {
  const hits = scanSource('declare const err: Error;\nif (err.message === "network_error") {}\nif (err.message.trim().toLowerCase() !== "timeout_error") {}');
  assert.deepEqual(hits.map((h) => `${h.name}.${h.method}`), ["message.===", "message.!=="]);
});

test("码字段与码形字面量比较放过：reason === \"denied\"、job_error_code / errorCode；码字段比人话照拦", () => {
  const ok = [
    'declare const reason: string; declare const t: { job_error_code?: string; errorCode?: string; code?: string };',
    'reason === "denied";',
    '"denied" !== reason;',
    't.job_error_code === "page_over";',
    't.errorCode == "auth_failed";',
    't.code != "timeout";',
  ].join("\n");
  assert.deepEqual(scanSource(ok), []);
  const bad = scanSource('declare const reason: string;\nreason === "Permission denied";');
  assert.deepEqual(bad.map((h) => `${h.name}.${h.method}`), ["reason.==="]);
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

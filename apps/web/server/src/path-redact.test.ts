import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-path-redact-");

const { redactLocalPaths } = await import("./pathRedact.js");
const { saveSettings } = await import("./settings.js");

const r = redactLocalPaths;

describe("redactLocalPaths regression baseline", () => {
  it("forward slash and lowercase / other drives", () => {
    assert.equal(r("读不到 C:/supply/data/a.pdf"), "读不到 a.pdf");
    assert.equal(r("读不到 c:\\supply\\a.pdf"), "读不到 a.pdf");
    assert.equal(r("读不到 D:\\work\\x\\b.ai"), "读不到 b.ai");
  });
  it("quoted and JSON", () => {
    assert.equal(r('打开 "C:\\data\\a.pdf" 失败'), '打开 "a.pdf" 失败');
    assert.equal(r('{"path":"/home/bob/x/b.json"}'), '{"path":"b.json"}');
  });
  it("multiple paths", () => {
    assert.equal(r("C:\\a\\x.pdf 和 /Users/bob/y.ai 都打不开"), "x.pdf 和 y.ai 都打不开");
  });
  it("long-path prefix and UNC", () => {
    assert.equal(r("\\\\?\\C:\\supply\\a.pdf 打不开"), "a.pdf 打不开");
    assert.equal(r("\\\\nas\\share\\c.pdf 打不开"), "c.pdf 打不开");
  });
  it("other unix roots", () => {
    assert.equal(r("见 /private/var/folders/x/a.png"), "见 a.png");
    assert.equal(r("见 /opt/blender/blender"), "见 本机路径");
    assert.equal(r("见 /root/x/a.pdf"), "见 a.pdf");
  });
  it("python traceback", () => {
    assert.equal(r('File "/home/runner/app/cli.py", line 3, in main'), 'File "cli.py", line 3, in main');
  });
  it("configured paths with spaces", () => {
    saveSettings({ BLENDER_EXECUTABLE: "C:\\Program Files\\Blender Foundation\\blender.exe" });
    assert.equal(r("启动 C:\\Program Files\\Blender Foundation\\blender.exe 失败"), "启动 blender.exe 失败");
  });
  it("single-level root stays", () => {
    assert.equal(r("目录 /tmp 不可写"), "目录 /tmp 不可写");
  });
});

describe("redactLocalPaths: path glued to CJK", () => {
  it("path right after CJK text is redacted and trailing CJK kept", () => {
    assert.equal(r("找不到文件/Users/bob/a.pdf"), "找不到文件 a.pdf");
    assert.equal(r("打开/tmp/abc/a.pdf失败"), "打开 a.pdf 失败");
    assert.equal(r("读取C:\\data\\客户\\b.ai出错"), "读取 b.ai 出错");
    assert.equal(r("打开/tmp/abc失败"), "打开 本机路径 失败");
    assert.equal(r("打开 /tmp/abc/a.pdf 失败"), "打开 a.pdf 失败");
    assert.equal(r("见：/home/bob/a.pdf，请检查"), "见：a.pdf，请检查");
  });
});

describe("redactLocalPaths: spaces in directory names", () => {
  it("Windows directories with spaces are consumed up to the last separator", () => {
    assert.equal(r("C:\\Program Files\\客户 新品\\a.ai 打不开"), "a.ai 打不开");
    assert.equal(r("读不到 D:\\My Work\\Q4 稿\\b.pdf"), "读不到 b.pdf");
    assert.equal(r("\\\\nas\\共享 盘\\c.pdf 打不开"), "c.pdf 打不开");
  });
  it("paths do not run into each other or swallow relative paths", () => {
    assert.equal(r("C:\\a\\b.pdf 和 D:\\c\\d.pdf"), "b.pdf 和 d.pdf");
    assert.equal(r("C:\\a\\b c\\d.pdf D:\\e\\f.pdf"), "d.pdf f.pdf");
    assert.equal(r("目录 /a/b 不可写，见 docs/x.md"), "目录 本机路径 不可写，见 docs/x.md");
    assert.equal(r("/home/a/b.pdf failed at step 2/3"), "b.pdf failed at step 2/3");
  });
});

describe("redactLocalPaths: URL-encoded separators", () => {
  it("decodes %5C / %2F before redaction", () => {
    assert.equal(r("C:%5Cusers%5Cbob%5Ca.pdf"), "a.pdf");
    assert.equal(r("%2FUsers%2Fbob%2Fa.pdf"), "a.pdf");
    assert.equal(r("读不到 c:%5cdata%5cb.ai"), "读不到 b.ai");
  });
});

describe("redactLocalPaths: file:// and drive-letter boundary", () => {
  it("file:// URLs keep only the file name", () => {
    assert.equal(r("file:///Users/bob/a.pdf"), "a.pdf");
    assert.equal(r("打开 file:///C:/data/b.ai 失败"), "打开 b.ai 失败");
    assert.equal(r("FILE://C:\\data\\c.pdf"), "c.pdf");
  });
  it("drive letter must not match inside a word", () => {
    assert.equal(r("abc:/x/y.pdf"), "abc:y.pdf");
    assert.equal(r("abc:\\x\\y.pdf"), "abc:\\x\\y.pdf");
    assert.equal(r("ratio:\\n\\t"), "ratio:\\n\\t");
  });
});

describe("redactLocalPaths: stack trace locations", () => {
  it("keeps file:line:col but drops directories", () => {
    assert.equal(r("at main (/home/bob/app/src/x.ts:12:5)"), "at main (x.ts:12:5)");
    assert.equal(r("at C:\\app\\src\\y.js:3"), "at y.js:3");
    assert.equal(r("at /Users/bob/app/z.mjs:7:1"), "at z.mjs:7:1");
  });
});

describe("redactLocalPaths: home-relative paths", () => {
  it("~/ and ~user/ keep only the file name", () => {
    assert.equal(r("~/Desktop/a.ai"), "a.ai");
    assert.equal(r("~bob/a.ai"), "a.ai");
    assert.equal(r("打开~/稿件/b.pdf失败"), "打开 b.pdf 失败");
    assert.equal(r("约 ~3 秒"), "约 ~3 秒");
  });
});

describe("redactLocalPaths: ReDoS / performance", () => {
  const inputs: Record<string, string> = {
    "spaces+backslashes": "C:\\" + "a \\".repeat(3000),
    "spaces+slashes": "/x/" + "a /".repeat(3000),
    "space-continuation miss": "C:\\" + "a b ".repeat(3000) + "c",
    "many drive starts": "C:\\a ".repeat(2000),
    "slashes only": "/".repeat(8000),
    "backslashes only": "\\".repeat(8000),
    "tilde names": "~" + "a".repeat(6000) + " ~",
    "encoded": "%5C a%2F".repeat(1000),
    "mixed cjk": "打开/a 客 \\b C:\\c ".repeat(500),
  };
  for (const [name, input] of Object.entries(inputs)) {
    it(`${name} (${input.length} chars) < 50ms`, () => {
      assert.ok(input.length >= 5000);
      r(input); // warm-up
      const t0 = performance.now();
      r(input);
      const ms = performance.now() - t0;
      assert.ok(ms < 50, `${name}: ${ms.toFixed(1)}ms`);
    });
  }
});

describe("redactLocalPaths: URLs are left alone", () => {
  it("http(s) URLs with port, IPv6, query and fragment stay untouched", () => {
    for (const u of [
      "http://x/a/b",
      "https://example.com/api/v1/x.json",
      "http://localhost:8787/api/tasks?id=1&x=/a/b#frag",
      "http://[::1]:8787/api/settings",
      "https://user@example.com:443/a/b/c.pdf?q=%2Fx",
    ]) assert.equal(r(u), u);
    assert.equal(r("https://example.com/api/v1/x.json 返回 500"), "https://example.com/api/v1/x.json 返回 500");
    assert.equal(r("请求http://x/a/b失败"), "请求http://x/a/b失败");
    assert.equal(r("见 https://x/a，然后读 /home/bob/a.pdf"), "见 https://x/a，然后读 a.pdf");
  });
  it("file:// is still redacted", () => {
    assert.equal(r("file:///Users/bob/a.pdf"), "a.pdf");
  });
});

describe("redactLocalPaths: root-relative backslash paths", () => {
  it("\\Users\\bob\\a.pdf (incl. decoded %5C) keeps only the file name", () => {
    assert.equal(r("%5CUsers%5Cbob%5Ca.pdf"), "a.pdf");
    assert.equal(r("读取\\Users\\bob\\a.pdf失败"), "读取 a.pdf 失败");
    assert.equal(r("at \\app\\src\\x.ts:3:1"), "at x.ts:3:1");
  });
  it("escape-like backslash runs without a file name stay", () => {
    assert.equal(r("ratio:\\n\\t"), "ratio:\\n\\t");
    assert.equal(r("\\a.pdf"), "\\a.pdf");
  });
});

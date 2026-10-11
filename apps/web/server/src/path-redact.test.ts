import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-path-redact-");

const { redactLocalPaths, redactLocalPathsUncapped } = await import("./pathRedact.js");
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
    assert.equal(r("abc:\\x\\y.pdf"), "abc:y.pdf");
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
      // 取 5 次最快值：整套并行跑时单次计时会被 GC / 调度拖慢，最快值才反映算法本身。
      let ms = Infinity;
      for (let k = 0; k < 5; k += 1) {
        const t0 = performance.now();
        r(input);
        ms = Math.min(ms, performance.now() - t0);
      }
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

describe("redactLocalPaths: length cap and linear time", () => {
  const MARK = "（后面省略）";
  it("short messages are not capped", () => {
    const s = "a".repeat(8000);
    assert.equal(r(s), s);
  });
  it("Windows path straddling position 8000 leaves no directory segment", () => {
    const pre = "x".repeat(7990) + " ";
    const out = r(pre + "C:\\Users\\bob\\docs\\a.pdf 后面还有");
    assert.ok(out.endsWith(MARK), out.slice(-30));
    assert.ok(!/Users|\\bo|C:\\/.test(out), out.slice(-30));
    assert.equal(out, pre + "本机路径" + MARK);
  });
  it("UNC path straddling position 8000 leaves no directory segment", () => {
    const pre = "x".repeat(7992) + " ";
    const out = r(pre + "\\\\nas\\share\\bob\\a.pdf");
    assert.ok(!/nas|\\\\/.test(out), out.slice(-30));
    assert.equal(out, pre + "本机路径" + MARK);
  });
  it("URL-encoded input is capped after decoding", () => {
    const out = r("%5Cab".repeat(3000)); // 15000 raw chars, 9000 after decoding
    assert.ok(out.endsWith(MARK));
    assert.ok(!out.includes("%5C"));
    assert.ok(out.length <= 8000 + MARK.length);
  });
  for (const [name, input] of [
    ["C:\\a b repeated", "C:\\a b ".repeat(43000)],
    ["\\\\a repeated", "\\\\a ".repeat(75000)],
  ] as const) {
    it(`${name} (${input.length} chars) < 200ms`, () => {
      assert.ok(input.length >= 300000);
      let ms = Infinity;
      for (let k = 0; k < 3; k += 1) {
        const t0 = performance.now();
        r(input);
        ms = Math.min(ms, performance.now() - t0);
      }
      assert.ok(ms < 200, `${name}: ${ms.toFixed(1)}ms`);
    });
  }
});

describe("redactLocalPaths: only http/https count as URLs", () => {
  const noDirs = (out: string) => assert.ok(!/Users|bob/.test(out), out);
  it("other schemes get normal path scanning", () => {
    noDirs(r("x://Users/bob/a.pdf"));
    noDirs(r("foo:///Users/bob"));
    noDirs(r("git+ssh://host/Users/bob/a.pdf"));
    assert.ok(r("git+ssh://host/Users/bob/a.pdf").includes("a.pdf"));
  });
  it("http/https are case-insensitive", () => {
    assert.equal(r("HTTPS://example.com/api/v1/x.json"), "HTTPS://example.com/api/v1/x.json");
    assert.equal(r("Http://x/a/b"), "Http://x/a/b");
  });
});

describe("redactLocalPaths: local paths embedded in http(s) URLs", () => {
  it("embedded path segment becomes 本机路径, scheme+host kept", () => {
    assert.equal(r("http://x/?p=C:\\Users\\bob\\a.pdf"), "http://x/?p=本机路径");
    assert.equal(r("http://x/?p=C:\\Users\\bob\\a.pdf&q=1"), "http://x/?p=本机路径&q=1");
    assert.equal(r("http://x/C:/Users/bob/a.pdf"), "http://x/本机路径");
    assert.equal(r("http://x/?p=C:%5CUsers%5Cbob%5Ca.pdf"), "http://x/?p=本机路径");
    assert.equal(r("http://x/?p=%5CUsers%5Cbob"), "http://x/?p=本机路径");
    assert.equal(r("https://h:8787/open/Users/bob/a.pdf"), "https://h:8787/open/本机路径");
    assert.equal(r("https://h/f?path=/home/bob/a.pdf#x"), "https://h/f?path=/本机路径#x");
  });
  it("normal URLs unchanged", () => {
    assert.equal(r("https://example.com/api/v1/x.json"), "https://example.com/api/v1/x.json");
    assert.equal(r("http://[::1]:8787/api/settings?id=1#f"), "http://[::1]:8787/api/settings?id=1#f");
  });
});

describe("redactLocalPaths: cap keeps surrogate pairs intact", () => {
  it("does not split an emoji at position 8000", () => {
    const out = r("a".repeat(7999) + "😀" + "b");
    assert.equal(out, "a".repeat(7999) + "（后面省略）");
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out));
  });
});

describe("redactLocalPathsUncapped: linear without the length cap", () => {
  const inputs: [string, string][] = [
    ["C:\\a b repeated", "C:\\a b ".repeat(43000)],
    ["\\\\a repeated", "\\\\a ".repeat(75000)],
    ["spaces+slashes", "/x/" + "a /".repeat(100000)],
    ["backslash run", "\\".repeat(300000)],
    ["http urls", "http://x/?p=C:\\a ".repeat(20000)],
    ["mixed cjk", "打开/a 客 \\b C:\\c ".repeat(20000)],
  ];
  for (const [name, input] of inputs) {
    it(`${name} (${input.length} chars, uncapped) < 300ms`, () => {
      assert.ok(input.length >= 300000);
      let ms = Infinity;
      for (let k = 0; k < 3; k += 1) {
        const t0 = performance.now();
        const out = redactLocalPathsUncapped(input);
        ms = Math.min(ms, performance.now() - t0);
        assert.ok(!out.includes("（后面省略）"));
      }
      assert.ok(ms < 300, `${name}: ${ms.toFixed(1)}ms`);
    });
  }
});

describe("redactLocalPaths: root-relative backslash directories", () => {
  it("directory-only \\Users\\bob\\Desktop becomes 本机路径", () => {
    assert.equal(r("\\Users\\bob\\Desktop"), "本机路径");
    assert.equal(r("目录 \\Users\\bob\\Desktop 不可写"), "目录 本机路径 不可写");
    assert.equal(r("%5CUsers%5Cbob"), "本机路径");
  });
  it("one-letter escape runs still stay", () => {
    assert.equal(r("ratio:\\n\\t"), "ratio:\\n\\t");
    assert.equal(r("a\\b\\c"), "a\\b\\c");
  });
});

describe("redactLocalPaths: Windows/UNC file names containing a space", () => {
  it("keeps 'a b.pdf' when the word after the space ends in an extension", () => {
    assert.equal(r("\\\\nas\\share x\\a b.pdf"), "a b.pdf");
    assert.equal(r("C:\\x\\客户 稿.ai 打不开"), "客户 稿.ai 打不开");
    assert.equal(r("读不到 C:\\x\\a b.pdf，请检查"), "读不到 a b.pdf，请检查");
  });
  it("does not glue unrelated words", () => {
    assert.equal(r("C:\\x\\a.ai 打不开"), "a.ai 打不开");
    assert.equal(r("C:\\a\\b.pdf 和 D:\\c\\d.pdf"), "b.pdf 和 d.pdf");
  });
});

describe("redactLocalPaths: configured dirs inside http(s) URLs keep the leading slash", () => {
  it("unix configured dir -> /本机路径, rest of the segment dropped up to & # ?", () => {
    saveSettings({ BLENDER_EXECUTABLE: "/srv/tools/bin/blender" });
    assert.equal(r("http://x/srv/tools/bin/blender"), "http://x/本机路径");
    assert.equal(r("http://x/srv/tools/bin/blender/a.pdf"), "http://x/本机路径");
    assert.equal(r("http://x/open?f=/srv/tools/bin/blender/a.pdf&q=1#h"), "http://x/open?f=/本机路径&q=1#h");
    const data = String(process.env.WB_DATA_DIR);
    assert.equal(r(`https://x${data}/a.pdf?v=2`), "https://x/本机路径?v=2");
  });
  it("Windows configured dir -> 本机路径 (no slash, same as drive rule)", () => {
    saveSettings({ BLENDER_EXECUTABLE: "D:\\Tools\\blender.exe" });
    assert.equal(r("http://x/?p=D:\\Tools\\blender.exe&q=1"), "http://x/?p=本机路径&q=1");
  });
});

describe("redactLocalPaths: URL-embedded paths continue through CJK / emoji", () => {
  it("replaces up to & # ? whitespace or quotes, not stopping at non-ASCII", () => {
    assert.equal(r("http://x/Users/张三/a.pdf"), "http://x/本机路径");
    assert.equal(r("http://x/?p=/Users/bob/项目/合同.pdf"), "http://x/?p=/本机路径");
    assert.equal(r("http://x/?p=/Users/bob/项目😀/合同.pdf&q=1"), "http://x/?p=/本机路径&q=1");
    assert.equal(r("http://x/?p=C:\\客户\\合同.pdf#f 打不开"), "http://x/?p=本机路径#f 打不开");
    assert.equal(r("见 \"http://x/?p=/home/张三/a.pdf\" 失败"), "见 \"http://x/?p=/本机路径\" 失败");
    assert.equal(r("请求http://x/a/b失败"), "请求http://x/a/b失败");
  });
});

describe("redactLocalPaths: URL userinfo is replaced", () => {
  it("user:pass@ and user@ become ***@", () => {
    assert.equal(r("http://bob:s3cr3t@x/Users/bob/a.pdf"), "http://***@x/本机路径");
    assert.equal(r("https://bob@x/a"), "https://***@x/a");
    assert.equal(r("https://user@example.com:443/a/b/c.pdf?q=1"), "https://***@example.com:443/a/b/c.pdf?q=1");
    assert.equal(r("https://a:b@c@h:8787/api?x=1"), "https://***@h:8787/api?x=1");
    assert.equal(r("https://example.com/api?mail=a@b.com"), "https://example.com/api?mail=a@b.com");
  });
});

describe("redactLocalPaths: multi-layer URL encoding of separators", () => {
  it("decodes %25-wrapped separators up to 3 layers", () => {
    assert.equal(r("http://x/?f=%252FUsers%252Fbob%252Fa.pdf"), "http://x/?f=/本机路径");
    assert.equal(r("%252Fhome%252Fbob%252Fa.pdf"), "a.pdf");
    assert.equal(r("C:%255Cusers%255Cbob%255Ca.pdf"), "a.pdf");
    assert.equal(r("%25252Fhome%25252Fbob%25252Fa.pdf"), "a.pdf");
  });
  it("other %25 sequences are left alone", () => {
    assert.equal(r("进度 50%25 完成"), "进度 50%25 完成");
  });
});

describe("redactLocalPaths: URL-embedded Windows paths with spaces", () => {
  it("aligned with the rule outside URLs", () => {
    assert.equal(r("http://x/?f=C:\\Program Files\\x\\a.pdf"), "http://x/?f=本机路径");
    assert.equal(r("http://x/?f=C:\\Program Files\\x\\a.pdf 打不开"), "http://x/?f=本机路径 打不开");
    assert.equal(r("http://x/?f=C:\\x\\a b.pdf&q=1"), "http://x/?f=本机路径&q=1");
    assert.equal(r("http://x/?f=C:\\x\\a.pdf failed"), "http://x/?f=本机路径 failed");
    assert.equal(r("http://x/?f=C:\\a\\b.pdf D:\\c\\d.pdf"), "http://x/?f=本机路径 d.pdf");
  });
});

describe("redactLocalPaths: slash paths with spaces in directory names", () => {
  it("continues when the part after the space still has a / before the next whitespace", () => {
    assert.equal(r("http://x/?p=/Users/bob/my docs/secret/a.pdf"), "http://x/?p=/本机路径");
    assert.equal(r("/Users/bob/my docs/secret/a.pdf"), "a.pdf");
    assert.equal(r("/home/bob/客户 资料/a.pdf 打不开"), "a.pdf 打不开");
  });
  it("plain words after a path are not swallowed", () => {
    assert.equal(r("/Users/bob/a.pdf step 2/3"), "a.pdf step 2/3");
    assert.equal(r("/home/a/b.pdf failed at step 2/3"), "b.pdf failed at step 2/3");
    assert.equal(r("http://x/?p=/Users/bob/a.pdf step 2/3"), "http://x/?p=/本机路径 step 2/3");
  });
});

describe("redactLocalPaths: stack line under a directory with a space", () => {
  it("/home/bob/My Project/x.ts:12:5 keeps only x.ts:12:5", () => {
    assert.equal(r("at /home/bob/My Project/x.ts:12:5"), "at x.ts:12:5");
    assert.equal(r("at f (/home/bob/My Project/src/x.ts:12:5)"), "at f (x.ts:12:5)");
  });
});

describe("redactLocalPaths: CJK punctuation inside directory names", () => {
  it("continues past CJK punctuation when a separator follows before whitespace", () => {
    assert.equal(r("/Users/bob/【内部】/a.pdf"), "a.pdf");
    assert.equal(r("/Users/bob/a，b/c.pdf"), "c.pdf");
    assert.equal(r("http://x/?p=/Users/bob/【内部】/a.pdf"), "http://x/?p=/本机路径");
    assert.equal(r("http://x/?p=/Users/bob/a，b/c.pdf"), "http://x/?p=/本机路径");
    assert.equal(r("C:\\客户\\【内部】\\a.pdf"), "a.pdf");
  });
  it("still stops at CJK punctuation that ends the sentence", () => {
    assert.equal(r("见：/home/bob/a.pdf，请检查"), "见：a.pdf，请检查");
    assert.equal(r("目录 /a/b 不可写，见 docs/x.md"), "目录 本机路径 不可写，见 docs/x.md");
    assert.equal(r("（/home/bob/a.pdf）"), "（a.pdf）");
  });
});

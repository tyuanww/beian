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

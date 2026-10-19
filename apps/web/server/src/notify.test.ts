import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "beian-notify-"));
process.env.WB_DATA_DIR = dataDir;
process.env.VITEST = "1";

after(() => rmSync(dataDir, { recursive: true, force: true }));

const { saveSettings } = await import("./settings.js");
const { createTextSender, illustratorWatchdogText, watchdogEventFromStdout, jobOpenPath, sendText, taskCompleteHeadline, taskCompleteText } = await import("./notify.js");

function isolatedSender() {
  const calls = { cli: 0, app: 0 };
  const sendText = createTextSender({
    findCli: () => null,
    sendCli: async () => {
      calls.cli += 1;
      return { ok: false, reason: "test cli disabled" };
    },
    sendApp: async () => {
      calls.app += 1;
      return { ok: false, reason: "test app disabled" };
    },
  });
  return { calls, sendText };
}

describe("jobOpenPath", () => {
  it("opens review and mockup desks by path", () => {
    assert.equal(jobOpenPath("compare", "aabbccddeeff"), "/review/aabbccddeeff");
    assert.equal(jobOpenPath("rework", "aabbccddeeff"), "/review/aabbccddeeff");
    assert.equal(jobOpenPath("mockup", "aabbccddeeff"), "/mockup/aabbccddeeff");
  });
});

describe("sendText", () => {
  it("fails closed at the production boundary during L0", async () => {
    saveSettings({ FEISHU_ENABLED: "true", FEISHU_OPEN_ID: "ou_real-looking-test" });
    const r = await sendText("synthetic review complete");
    assert.deepEqual(r, {
      ok: false,
      skipped: true,
      reason: "test notifications disabled",
    });
  });

  it("skips when push is off unless forced", async () => {
    const { calls, sendText } = isolatedSender();
    saveSettings({ FEISHU_ENABLED: "false", FEISHU_OPEN_ID: "ou_test" });
    const skipped = await sendText("hi", "ou_test");
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, true);
    assert.deepEqual(calls, { cli: 0, app: 0 });
  });

  it("force still needs an open_id", async () => {
    const { calls, sendText } = isolatedSender();
    saveSettings({ FEISHU_ENABLED: "false", FEISHU_OPEN_ID: "" });
    const r = await sendText("hi", "", { force: true });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.deepEqual(calls, { cli: 0, app: 0 });
  });

  it("force uses only injected transports and fails closed", async () => {
    const { calls, sendText } = isolatedSender();
    saveSettings({
      FEISHU_ENABLED: "false",
      FEISHU_OPEN_ID: "ou_force",
    });
    const r = await sendText("hi", "ou_force", { force: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "test app disabled");
    assert.deepEqual(calls, { cli: 0, app: 1 });
  });

  it("returns after an injected CLI succeeds", async () => {
    const calls = { cli: 0, app: 0 };
    const sender = createTextSender({
      findCli: () => "/test/lark-cli",
      sendCli: async () => {
        calls.cli += 1;
        return { ok: true };
      },
      sendApp: async () => {
        calls.app += 1;
        return { ok: true };
      },
    });
    saveSettings({ FEISHU_ENABLED: "true", FEISHU_OPEN_ID: "ou_cli" });
    assert.deepEqual(await sender("hi"), { ok: true, via: "cli" });
    assert.deepEqual(calls, { cli: 1, app: 0 });
  });

  // Value: protects=app routing code stays with the app reason when CLI also failed; fails_when=CLI reason drops app.code; why_new=production CLI failures always have a reason; seam=none; no_claim=does not call Feishu
  it("keeps the app code when CLI fails and the app fallback has a code", async () => {
    const sender = createTextSender({
      findCli: () => "/test/lark-cli",
      sendCli: async () => ({ ok: false, reason: "cli failed first" }),
      sendApp: async () => ({ ok: false, reason: "app failed", code: "feishu_credentials" }),
    });
    saveSettings({ FEISHU_ENABLED: "true", FEISHU_OPEN_ID: "ou_cli_only" });
    assert.deepEqual(await sender("hi"), {
      ok: false,
      reason: "app failed",
      code: "feishu_credentials",
    });
  });

  it("keeps the CLI reason when the app fallback has no code", async () => {
    const sender = createTextSender({
      findCli: () => "/test/lark-cli",
      sendCli: async () => ({ ok: false, reason: "cli failed first" }),
      sendApp: async () => ({ ok: false, reason: "app failed" }),
    });
    saveSettings({ FEISHU_ENABLED: "true", FEISHU_OPEN_ID: "ou_cli_plain" });
    assert.deepEqual(await sender("hi"), { ok: false, reason: "cli failed first" });
  });

  it("falls back from an injected CLI failure to the injected app", async () => {
    const calls = { cli: 0, app: 0 };
    const sender = createTextSender({
      findCli: () => "/test/lark-cli",
      sendCli: async () => {
        calls.cli += 1;
        return { ok: false, reason: "test cli failed" };
      },
      sendApp: async () => {
        calls.app += 1;
        return { ok: true };
      },
    });
    saveSettings({ FEISHU_ENABLED: "true", FEISHU_OPEN_ID: "ou_app" });
    assert.deepEqual(await sender("hi"), { ok: true, via: "app" });
    assert.deepEqual(calls, { cli: 1, app: 1 });
  });

  // Value: protects=no-cli app failure keeps app.code; fails_when=the no-cli return drops code; why_new=CLI-present tests do not take findCli null; seam=none; no_claim=does not call Feishu
  it("returns app code when this machine has no lark-cli", async () => {
    const sender = createTextSender({
      findCli: () => null,
      sendCli: async () => ({ ok: false, reason: "unused" }),
      sendApp: async () => ({ ok: false, reason: "还没填飞书 App ID 或 Secret", code: "feishu_credentials" }),
    });
    saveSettings({ FEISHU_ENABLED: "true", FEISHU_OPEN_ID: "ou_no_cli" });
    assert.deepEqual(await sender("hi"), {
      ok: false,
      reason: "还没填飞书 App ID 或 Secret",
      code: "feishu_credentials",
    });
  });

  // Value: protects=notify exposes app.code when CLI fails without reason; fails_when=app branch drops code spread; why_new=CLI-only failure test above; seam=none; no_claim=none beyond protects
  it("returns app code when CLI fails without a reason", async () => {
    const sender = createTextSender({
      findCli: () => "/test/lark-cli",
      sendCli: async () => ({ ok: false }),
      sendApp: async () => ({ ok: false, reason: "还没填飞书 App ID 或 Secret", code: "feishu_credentials" }),
    });
    saveSettings({ FEISHU_ENABLED: "true", FEISHU_OPEN_ID: "ou_app_code" });
    assert.deepEqual(await sender("hi"), {
      ok: false,
      reason: "还没填飞书 App ID 或 Secret",
      code: "feishu_credentials",
    });
  });
});

describe("taskCompleteText", () => {
  it("titles signed tasks 已签字 and returned tasks 已退回", () => {
    assert.equal(taskCompleteHeadline({ complete_kind: "signed" }), "已签字");
    assert.equal(taskCompleteHeadline({ complete_kind: "rework" }), "已退回");
    const signed = taskCompleteText({ id: "t1", title: "某精华", conclusion: "通过", complete_kind: "signed" }, "审核员");
    assert.match(signed, /^【备案审核】已签字\n/);
    assert.match(signed, /无改稿项/);
    const returned = taskCompleteText({ id: "t2", complete_kind: "rework", hits: [{ field: "净含量", decision: "issue" }] }, "审核员");
    assert.match(returned, /^【备案审核】已退回\n/);
    assert.match(returned, /改稿 1 条\n· 净含量/);
    assert.doesNotMatch(signed + returned, /待设计改稿|已通过/);
  });

  it("verbatim completion keeps type and page, not the manuscript", () => {
    const sentence = "合成整句不该进飞书";
    const row = { field: "江东四路漏了东", status: "漏字", decision: "issue", page: 1, pdf: "江四路", manuscript: sentence };
    const text = taskCompleteText({
      id: "t3",
      title: "某喷雾",
      verbatim_check: true,
      complete_kind: "rework",
      conclusion: "稿上印了不该出现的句子",
      hits: [{ field: "漏字", status: "一致", decision: "confirm" }],
      hits_v2: [row],
    }, "审核员");
    assert.match(text, /漏字 第1页/);
    assert.equal(text.includes("江东"), false);
    assert.equal(text.includes("江四路"), false);
    assert.equal(text.includes(sentence), false);
    assert.equal(text.includes("稿上印了"), false);
    assert.match(text, /结论已记下/);
  });

  it("names unread glyphs by count when a verbatim sign accepts them", () => {
    const text = taskCompleteText({
      id: "t4",
      title: "某喷雾",
      verbatim_check: true,
      complete_kind: "signed",
      hits_v2: [
        { status: "待人工确认", decision: "", page: 1, pdf: "不该出现的句子" },
        { status: "漏字", decision: "ignore", page: 1, pdf: "另一句" },
      ],
    }, "审核员");
    assert.match(text, /另有 1 处机器没读准，签了表示人认这些字。/);
    assert.equal(text.includes("不该出现"), false);
    assert.equal(text.includes("另一句"), false);
  });

  it("falls back to issue hits for legacy tasks without complete_kind", () => {
    assert.equal(taskCompleteHeadline({}), "已签字");
    assert.equal(taskCompleteHeadline({ hits: [{ decision: "confirm" }] }), "已签字");
    assert.equal(taskCompleteHeadline({ hits: [{ decision: "issue" }] }), "已退回");
  });
});

describe("illustratorWatchdogText", () => {
  it("names the task and OCR fallback without private paths or pids", () => {
    const text = illustratorWatchdogText({ id: "aabbccddeeff", title: "某精华" });
    assert.match(text, /Illustrator 保存卡住，已自动结束并重启/);
    assert.match(text, /任务：某精华/);
    assert.match(text, /图像识别/);
    assert.match(text, /\/review\/aabbccddeeff/);
    assert.equal(/[A-Z]:\\|pid|sha256/i.test(text), false);
  });
});

describe("watchdog events", () => {
  it("source change and restart cap say so explicitly", () => {
    assert.match(illustratorWatchdogText({ id: "aabbccddeeff" }, "save_source_changed"), /原稿可能被改动/);
    assert.match(illustratorWatchdogText({ id: "aabbccddeeff" }, "save_source_changed"), /不回退图像识别/);
    assert.match(illustratorWatchdogText({ id: "aabbccddeeff" }, "watchdog_restart_cap"), /1 小时内已自动重启 2 次/);
    assert.match(illustratorWatchdogText({ id: "m1" }, "save_timeout", "mockup"), /\/mockup\/m1/);
  });
  it("parses only known reasons from the last stdout line", () => {
    assert.equal(watchdogEventFromStdout('noise\n{"reason":"save_timeout"}'), "save_timeout");
    assert.equal(watchdogEventFromStdout('{"reason":"export_failed"}'), undefined);
    assert.equal(watchdogEventFromStdout("not json"), undefined);
  });
});

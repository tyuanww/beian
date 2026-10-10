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
const { createTextSender, jobOpenPath, sendText, taskCompleteHeadline, taskCompleteText } = await import("./notify.js");

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

  it("falls back to issue hits for legacy tasks without complete_kind", () => {
    assert.equal(taskCompleteHeadline({}), "已签字");
    assert.equal(taskCompleteHeadline({ hits: [{ decision: "confirm" }] }), "已签字");
    assert.equal(taskCompleteHeadline({ hits: [{ decision: "issue" }] }), "已退回");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

const DATA_DIR = makeTestTempDir("beian-settings-role-");
process.env.VITEST = "1";
process.env.WB_DATA_DIR = DATA_DIR;
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { saveSettings, pythonBin } = await import("./settings.js");
const { resetBillingCache, resetBillingHooksForTest, setBillingHooksForTest } = await import("./billing.js");

type Field = { key: string; kind: string; set: boolean; value?: string; last4?: string; adminOnly?: boolean };
type View = {
  groups: { title: string; fields: Field[] }[];
  probes: { id: string }[];
  derived?: Record<string, unknown>;
  health?: Record<string, { ok: boolean; detail: string }>;
};

// 用一个真实存在的可执行文件当 Blender，让健康卡片走“已配置”分支（会带路径）。
const BLENDER = process.execPath;
saveSettings({
  FEISHU_APP_ID: "cli_role_trim_app",
  FEISHU_APP_SECRET: "role-trim-secret-7777",
  FEISHU_TENANT_KEY: "tenant_role_trim_key",
  FEISHU_OPEN_ID: "ou_role_trim_push",
  FEISHU_ALLOW_OPEN_IDS: "ou_role_trim_allow",
  WB_PUBLIC_BASE: "https://role-trim.example.test",
  BAIDU_OCR_API_KEY: "baidu-role-trim-aaaa",
  WB_PYTHON: "/Users/someone/role-trim/.venv/bin/python",
  BLENDER_EXECUTABLE: BLENDER,
  ILLUSTRATOR_EXECUTABLE: "C:\\Program Files\\Adobe\\Illustrator.exe",
  WB_MAX_UPLOAD_MB: "150",
  WB_PUBLIC: "false",
});

const VISIBLE_VALUE = new Set(["WB_PUBLIC", "WB_DEV_DISPLAY_LOGIN", "FEISHU_ENABLED", "MINIMAX_ENABLED", "WB_MAX_UPLOAD_MB"]);

function auth(role: "admin" | "reviewer" | "viewer") {
  const s = issueSessionForTest(`角色-${role}`, role, `ou_role_trim_${role}`);
  return { authorization: `Bearer ${s.token}`, "content-type": "application/json" };
}

async function getSettings(role: "admin" | "reviewer" | "viewer"): Promise<{ raw: string; view: View }> {
  const res = await app.request("/api/settings", { headers: auth(role) });
  assert.equal(res.status, 200);
  const raw = await res.text();
  return { raw, view: JSON.parse(raw) as View };
}

const fieldsOf = (v: View) => v.groups.flatMap((g) => g.fields);

describe("settings role trim", () => {
  it("admin view keeps values, last4, derived paths and health detail", async () => {
    const { view } = await getSettings("admin");
    const fields = fieldsOf(view);
    for (const f of fields) {
      assert.ok("value" in f, `${f.key} value`);
      assert.ok("last4" in f, `${f.key} last4`);
    }
    assert.equal(fields.find((f) => f.key === "FEISHU_TENANT_KEY")?.value, "tenant_role_trim_key");
    assert.equal(fields.find((f) => f.key === "WB_PYTHON")?.value, "/Users/someone/role-trim/.venv/bin/python");
    assert.equal(fields.find((f) => f.key === "FEISHU_APP_SECRET")?.value, "");
    assert.match(String(fields.find((f) => f.key === "FEISHU_APP_SECRET")?.last4), /7777/);
    assert.ok(view.derived && "redirect_uri" in view.derived && "python" in view.derived);
    assert.equal(view.derived?.tenant_key_filled, true);
    assert.equal(view.health?.mockup.ok, true);
    assert.ok(view.health?.mockup.detail.includes(BLENDER));
  });

  for (const role of ["reviewer", "viewer"] as const) {
    it(`${role} view omits value/last4 keys except toggles and upload cap`, async () => {
      const { view } = await getSettings(role);
      const fields = fieldsOf(view);
      assert.ok(fields.length > 0);
      for (const f of fields) {
        for (const meta of ["key", "label", "kind", "help", "restart", "adminOnly", "set"]) {
          assert.ok(meta in f, `${f.key} keeps ${meta}`);
        }
        if (VISIBLE_VALUE.has(f.key)) {
          assert.ok("value" in f, `${f.key} keeps value`);
        } else {
          assert.ok(!("value" in f), `${f.key} value omitted`);
          assert.ok(!("last4" in f), `${f.key} last4 omitted`);
        }
      }
      assert.equal(fields.find((f) => f.key === "WB_MAX_UPLOAD_MB")?.value, "150");
      assert.equal(fields.find((f) => f.key === "WB_PUBLIC")?.value, "false");
      assert.equal(fields.find((f) => f.key === "FEISHU_APP_SECRET")?.set, true);
      assert.equal(fields.find((f) => f.key === "FEISHU_TENANT_KEY")?.set, true);
      assert.ok(view.probes.length > 0);
      assert.ok(view.derived);
      assert.ok(!("redirect_uri" in view.derived!));
      assert.ok(!("python" in view.derived!));
      assert.equal(view.derived!.tenant_key_filled, true);
      assert.equal(view.health?.mockup.ok, true);
    });

    it(`${role} serialized settings carry no secrets, ids or paths`, async () => {
      const { raw } = await getSettings(role);
      const forbidden = [
        "C:\\\\",
        "/Users/",
        "/home/",
        "/var/folders",
        DATA_DIR,
        pythonBin(),
        BLENDER,
        "tenant_role_trim_key",
        "ou_role_trim_push",
        "ou_role_trim_allow",
        "cli_role_trim_app",
        "role-trim.example.test",
        "7777",
        "aaaa",
      ];
      for (const needle of forbidden) assert.equal(raw.includes(needle), false, `leaked ${needle}`);
      assert.doesNotMatch(raw, /[A-Za-z]:\\\\|\/(?:Users|home|opt|usr|var|private|tmp)\//);
    });

    it(`${role} gets 403 on probe and billing`, async () => {
      for (const id of ["python", "blender", "lark_send"]) {
        const res = await app.request("/api/settings/probe", {
          method: "POST",
          headers: auth(role),
          body: JSON.stringify({ id }),
        });
        assert.equal(res.status, 403, `probe ${id}`);
        assert.match(String(((await res.json()) as { detail?: string }).detail), /管理员/);
      }
      const bill = await app.request("/api/settings/billing", { headers: auth(role) });
      assert.equal(bill.status, 403);
      assert.match(String(((await bill.json()) as { detail?: string }).detail), /管理员/);
      const refresh = await app.request("/api/settings/billing/refresh", { method: "POST", headers: auth(role), body: "{}" });
      assert.equal(refresh.status, 403);
    });
  }

  it("admin can still read and refresh billing", async () => {
    setBillingHooksForTest({
      bceJson: async () => ({ ok: false, status: 0, data: null, error: "test-skip" }),
      fetch: async () => new Response("skip", { status: 500 }),
    });
    resetBillingCache();
    try {
      const bill = await app.request("/api/settings/billing", { headers: auth("admin") });
      assert.equal(bill.status, 200);
      const refresh = await app.request("/api/settings/billing/refresh", { method: "POST", headers: auth("admin"), body: "{}" });
      assert.equal(refresh.status, 200);
    } finally {
      resetBillingCache();
      resetBillingHooksForTest();
    }
  });
});

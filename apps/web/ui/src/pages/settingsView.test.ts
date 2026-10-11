import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialDraft, normalizeSettings, resolveGroup, secretPlaceholder, valuesToSave } from "./settingsView.js";

const field = { key: "A", label: "A", kind: "text", help: "", restart: false, set: false, last4: "", value: "x" };
const VIRTUAL = new Set(["外观", "开工板", "费用账单"]);

describe("normalizeSettings", () => {
  it("keeps a full admin payload", () => {
    const v = normalizeSettings({ groups: [{ title: "飞书登录", fields: [field] }], probes: [{ id: "p", label: "P" }], derived: { python: "py" } });
    assert.equal(v.groups.length, 1);
    assert.equal(v.probes.length, 1);
    assert.equal(v.derived?.python, "py");
  });

  it("drops groups whose fields were stripped", () => {
    const v = normalizeSettings({ groups: [{ title: "密钥", fields: [] }, { title: "B" }, { title: "C", fields: [field] }] });
    assert.deepEqual(v.groups.map((g) => g.title), ["C"]);
  });

  it("survives missing groups / probes / null body", () => {
    for (const raw of [{}, null, undefined, { groups: null, probes: "x" }]) {
      const v = normalizeSettings(raw);
      assert.deepEqual(v.groups, []);
      assert.deepEqual(v.probes, []);
      assert.equal(v.derived, undefined);
      assert.equal(v.health, undefined);
    }
  });
});

describe("resolveGroup", () => {
  it("falls back to 外观 when the requested group is gone", () => {
    const v = normalizeSettings({ groups: [{ title: "C", fields: [field] }] });
    assert.equal(resolveGroup("密钥", v, VIRTUAL), "外观");
    assert.equal(resolveGroup("C", v, VIRTUAL), "C");
    assert.equal(resolveGroup("开工板", v, VIRTUAL), "开工板");
  });
});

describe("stripped value / last4 (non-admin payload)", () => {
  const stripped = normalizeSettings({
    groups: [{ title: "飞书登录", fields: [
      { key: "FEISHU_APP_ID", label: "App ID", kind: "text", help: "", restart: false, set: true },
      { key: "FEISHU_APP_SECRET", label: "Secret", kind: "secret", help: "", restart: false, set: true },
      { key: "PLAIN", label: "Plain", kind: "text", help: "", restart: false, set: false, last4: "", value: "keep" },
    ] }],
    probes: [],
    derived: { tenant_key_filled: true },
  });

  it("drafts fall back to empty string, never undefined", () => {
    assert.deepEqual(initialDraft(stripped), { FEISHU_APP_ID: "", FEISHU_APP_SECRET: "", PLAIN: "keep" });
  });

  it("does not overwrite omitted values with empty strings on save", () => {
    assert.deepEqual(valuesToSave(stripped, initialDraft(stripped)), { PLAIN: "keep" });
    assert.deepEqual(valuesToSave(stripped, { ...initialDraft(stripped), FEISHU_APP_ID: "cli_new" }), { FEISHU_APP_ID: "cli_new", PLAIN: "keep" });
  });

  it("secret placeholder hides missing last4", () => {
    assert.equal(secretPlaceholder({ set: true }), "已填，留空不改");
    assert.equal(secretPlaceholder({ set: true, last4: "ab12" }), "已填 ab12，留空不改");
    assert.equal(secretPlaceholder({ set: false }), "未填");
  });

  it("derived without redirect_uri / python survives", () => {
    assert.equal(stripped.derived?.redirect_uri, undefined);
    assert.equal(stripped.derived?.python, undefined);
  });
});

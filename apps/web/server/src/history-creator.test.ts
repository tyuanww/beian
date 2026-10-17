import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-history-creator-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { DATA_DIR } = await import("./config.js");
const { saveTask } = await import("./tasks.js");

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(join(DATA_DIR, "users.json"), JSON.stringify({
  users: [
    { name: "管理员", role: "admin", open_id: "ou_admin" },
    { name: "生成人乙", role: "reviewer", open_id: "ou_known" },
  ],
}));

const admin = { authorization: `Bearer ${issueSessionForTest("管理员", "admin", "ou_admin").token}` };

async function items(): Promise<Array<Record<string, unknown>>> {
  let res = await app.request("/api/history", { headers: admin });
  for (let step = 0; step < 80 && res.status === 503; step += 1) res = await app.request("/api/history", { headers: admin });
  assert.equal(res.status, 200);
  return ((await res.json()) as { items: Array<Record<string, unknown>> }).items;
}

describe("history creator_name", { concurrency: false }, () => {
  it("no creator on record → null, never actor or a raw account id", async () => {
    saveTask({
      id: "c7c7c7c7c7c1", title: "旧单无生成人", product_name: "旧单", type: "excel_pdf",
      status: "completed", created_at: "2026-10-01T02:00:00.000Z",
      owner: "ou_ghost", actor: "审稿丙",
    });
    const row = (await items()).find((item) => item.id === "c7c7c7c7c7c1");
    assert.ok(row);
    assert.equal(row.creator_name, null);
    assert.notEqual(row.creator_name, "审稿丙");
    assert.notEqual(row.creator_name, "ou_ghost");
  });

  it("no created_by but owner is a known account → still null (never looked up via owner)", async () => {
    saveTask({
      id: "c7c7c7c7c7c2", title: "旧单有账号", product_name: "旧单", type: "excel_pdf",
      status: "completed", created_at: "2026-10-01T03:00:00.000Z",
      owner: "ou_known", actor: "审稿丙",
    });
    const row = (await items()).find((item) => item.id === "c7c7c7c7c7c2");
    assert.ok(row);
    assert.equal(row.creator_name, null);
  });

  it("created_by found in the account directory → its display name", async () => {
    saveTask({
      id: "c7c7c7c7c7c3", title: "新单", product_name: "新单", type: "excel_pdf",
      status: "pending_review", created_at: "2026-10-01T04:00:00.000Z",
      owner: "ou_known", created_by: "生成人乙", actor: "审稿丙",
    });
    const row = (await items()).find((item) => item.id === "c7c7c7c7c7c3");
    assert.ok(row);
    assert.equal(row.creator_name, "生成人乙");
  });

  it("created_by not in the account directory → null", async () => {
    saveTask({
      id: "c7c7c7c7c7c4", title: "目录外", product_name: "目录外", type: "excel_pdf",
      status: "pending_review", created_at: "2026-10-01T05:00:00.000Z",
      owner: "ou_known", created_by: "查无此人", actor: "审稿丙",
    });
    const row = (await items()).find((item) => item.id === "c7c7c7c7c7c4");
    assert.ok(row);
    assert.equal(row.creator_name, null);
  });
});

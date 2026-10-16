import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-mockup-owner-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { saveMockup } = await import("./mockup.js");

const headers = { authorization: `Bearer ${issueSessionForTest("样-admin", "admin", "ou_admin").token}` };

async function rows(): Promise<Array<Record<string, unknown>>> {
  return (await (await app.request("/api/mockups", { headers })).json()) as Array<Record<string, unknown>>;
}

describe("mockup list owner", () => {
  it("no created_by → owner is null, never the raw account id", async () => {
    saveMockup({ id: "d8d8d8d8d8d1", status: "failed", created_at: "2026-10-11T11:00:00.000Z", files: [], owner: "ou_raw_id" } as never);
    const row = (await rows()).find((m) => m.id === "d8d8d8d8d8d1");
    assert.ok(row);
    assert.equal(row.owner, null);
  });

  it("created_by present → owner is the creator", async () => {
    saveMockup({ id: "d8d8d8d8d8d2", status: "failed", created_at: "2026-10-11T12:00:00.000Z", files: [], owner: "ou_raw_id", created_by: "打样人" } as never);
    const row = (await rows()).find((m) => m.id === "d8d8d8d8d8d2");
    assert.equal(row?.owner, "打样人");
  });
});

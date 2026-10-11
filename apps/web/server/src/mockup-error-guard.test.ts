import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

const DATA_DIR = makeTestTempDir("beian-mockup-guard-");
process.env.VITEST = "1";
process.env.WB_DATA_DIR = DATA_DIR;
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { saveMockup } = await import("./mockup.js");

function auth(role: "admin" | "reviewer" | "viewer", openId: string) {
  const s = issueSessionForTest(`样-${role}`, role, openId);
  return { authorization: `Bearer ${s.token}` };
}

const INPUTS = {
  tilde: "读取 ~/secret/id_rsa 失败",
  bsUsers: "读取 \\users\\bob 失败",
  enc1: "读取 %2fUsers%2fbob 失败",
  enc2: "读取 %252fUsers%252fbob 失败",
};
const LEAK = /secret|id_rsa|users|bob|%2f|%25/i;

type Field = "error" | "job_error" | "render_mutation";
function save(id: string, field: Field, value: string) {
  saveMockup({
    id,
    status: "failed",
    created_at: "2026-10-11T11:00:00.000Z",
    files: [],
    job_kind: "mockup",
    job_status: "failed",
    ...(field === "error" ? { error: value } : {}),
    ...(field === "job_error" ? { job_error: value } : {}),
    ...(field === "render_mutation"
      ? { render_mutation: { id: "m1", mode: "upgrade", status: "failed", error: value } as never }
      : {}),
  });
}

function pick(obj: Record<string, unknown>, field: Field): unknown {
  return field === "render_mutation" ? (obj.render_mutation as Record<string, unknown> | undefined)?.error : obj[field];
}

async function views(id: string, headers: Record<string, string>) {
  const list = (await (await app.request("/api/mockups", { headers })).json()) as Array<Record<string, unknown>>;
  const row = list.find((m) => m.id === id);
  const detail = (await (await app.request(`/api/mockups/${id}`, { headers })).json()) as Record<string, unknown>;
  return { row: row as Record<string, unknown>, detail };
}

describe("mockup list/detail errors go through redact + guard for non-admins", () => {
  let n = 0;
  for (const field of ["error", "job_error", "render_mutation"] as const) {
    for (const [name, value] of Object.entries(INPUTS)) {
      it(`${field} / ${name}: reviewer and viewer see no local path; admin unchanged`, async () => {
        n += 1;
        const id = `0000000e${String(n).padStart(4, "0")}`;
        save(id, field, value);
        const admin = await views(id, auth("admin", "ou_mg_ad"));
        for (const [role, openId] of [["reviewer", "ou_mg_rv"], ["viewer", "ou_mg_vw"]] as const) {
          const v = await views(id, auth(role, openId));
          for (const obj of [v.row, v.detail]) {
            const shown = String(pick(obj, field) ?? "");
            assert.ok(shown.length > 0, `${role} ${field} shown`);
            assert.doesNotMatch(shown, LEAK, `${role} ${field}: ${shown}`);
            assert.ok(shown.length <= 80);
          }
        }
        // 管理员行为不变：仍是原来的 publicMockupError 结果（这几条输入原来就原样或半脱敏），且没有兜底标记。
        for (const obj of [admin.row, admin.detail]) {
          assert.equal("error_hidden" in obj, false);
          assert.equal(pick(obj, field), value);
        }
      });
    }
  }

  it("residue after redaction hides the field with error_hidden + error_ticket = job.id", async () => {
    const id = "0000000e0100";
    save(id, "job_error", "见 docs/root/x.md");
    const v = await views(id, auth("reviewer", "ou_mg_rv"));
    for (const obj of [v.row, v.detail]) {
      assert.equal(obj.job_error, `任务失败，请联系管理员（单号 ${id}）`);
      assert.equal(obj.error_hidden, true);
      assert.equal(obj.error_ticket, id);
    }
    const a = await views(id, auth("admin", "ou_mg_ad"));
    assert.equal("error_hidden" in a.detail, false);
  });

  it("non-admin text is still cut to 80 chars", async () => {
    const id = "0000000e0101";
    save(id, "job_error", "打样失败：" + "很长的原因".repeat(40));
    const v = await views(id, auth("reviewer", "ou_mg_rv"));
    assert.equal(String(v.detail.job_error).length, 80);
  });

  it("backslash + non-ASCII left by publicMockupError hides (D:\\客户 张三\\报价)", async () => {
    for (const [i, input] of ["读取 D:\\客户 张三\\报价 失败", "读取 D:\\张三 李四\\x\\y 失败"].entries()) {
      const id = `0000000e02${String(i).padStart(2, "0")}`;
      save(id, "job_error", input);
      const v = await views(id, auth("reviewer", "ou_mg_rv"));
      for (const obj of [v.row, v.detail]) {
        assert.equal(obj.job_error, `任务失败，请联系管理员（单号 ${id}）`, `${input} -> ${String(obj.job_error)}`);
        assert.equal(obj.error_hidden, true);
      }
    }
  });

  it("home user segment with spaces leaks neither bob nor smith", async () => {
    for (const [i, input] of ["读取 /Users/bob smith", "读取 /Users/bob smith/a.pdf 失败"].entries()) {
      const id = `0000000e03${String(i).padStart(2, "0")}`;
      save(id, "job_error", input);
      const v = await views(id, auth("reviewer", "ou_mg_rv"));
      for (const obj of [v.row, v.detail]) assert.doesNotMatch(String(obj.job_error), /bob|smith/, `${input} -> ${String(obj.job_error)}`);
    }
  });

  it("Basic base64 tokens hide; Basic settings / Settings stay", async () => {
    for (const [i, input] of ["上游 401：Basic dXNlcjpwYXNz", "上游 401：Basic dXNlcjpwYXNzMTIz"].entries()) {
      const id = `0000000e04${String(i).padStart(2, "0")}`;
      save(id, "job_error", input);
      const v = await views(id, auth("reviewer", "ou_mg_rv"));
      for (const obj of [v.row, v.detail]) {
        assert.equal(obj.job_error, `任务失败，请联系管理员（单号 ${id}）`, `${input} -> ${String(obj.job_error)}`);
        assert.equal(obj.error_ticket, id);
      }
    }
    for (const [i, input] of ["Basic settings 未填", "Basic Settings 未填"].entries()) {
      const id = `0000000e05${String(i).padStart(2, "0")}`;
      save(id, "job_error", input);
      const v = await views(id, auth("reviewer", "ou_mg_rv"));
      for (const obj of [v.row, v.detail]) assert.equal(obj.job_error, input);
    }
  });

  it("drive letter left before 本机稿件 with more text after hides (D:/客户 张三/报价)", async () => {
    const id = "0000000e0600";
    save(id, "job_error", "读取 D:/客户 张三/报价 失败");
    const v = await views(id, auth("reviewer", "ou_mg_rv"));
    for (const obj of [v.row, v.detail]) {
      assert.equal(obj.job_error, `任务失败，请联系管理员（单号 ${id}）`, String(obj.job_error));
      assert.equal(obj.error_hidden, true);
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

const DATA_DIR = makeTestTempDir("beian-job-redact-");
process.env.VITEST = "1";
process.env.WB_DATA_DIR = DATA_DIR;
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { saveTask } = await import("./tasks.js");
const { reclaimOnBoot, resetJobsTestHooks, setJobsTestHooks } = await import("./jobs.js");
const { redactLocalPaths } = await import("./pathRedact.js");

const RAW =
  "读不到 C:\\supply\\data\\uploads\\x\\a.pdf；worker /home/runner/beian/.venv/bin/python 退出；" +
  `临时 ${DATA_DIR}/uploads/x/b.xlsx`;
const DIR_PATTERNS = [/[A-Za-z]:\\/, /\/home\//, /\/Users\//, /\/var\/folders/, /\\supply\\/];

function assertRedacted(text: string) {
  for (const re of DIR_PATTERNS) assert.doesNotMatch(text, re, `leaked ${re}`);
  assert.equal(text.includes(DATA_DIR), false);
  assert.match(text, /a\.pdf/);
  assert.match(text, /b\.xlsx/);
}

function auth(role: "admin" | "reviewer", openId: string) {
  const s = issueSessionForTest(`红-${role}`, role, openId);
  return { authorization: `Bearer ${s.token}` };
}

describe("job error path redaction", () => {
  it("strips directories but keeps file names", () => {
    assert.equal(redactLocalPaths("C:\\supply\\data\\x\\a.pdf"), "a.pdf");
    assert.equal(redactLocalPaths("见 /var/folders/tz/T/x/page_01.png"), "见 page_01.png");
    assert.equal(redactLocalPaths("目录 /home/runner/work 不可写"), "目录 本机路径 不可写");
    assert.equal(redactLocalPaths("\\\\nas\\share\\c.pdf 打不开"), "c.pdf 打不开");
    assert.equal(redactLocalPaths("没有路径的报错"), "没有路径的报错");
    assertRedacted(redactLocalPaths(RAW));
  });

  it("reviewer sees redacted job_error in list and detail; admin sees original", async () => {
    const id = "0000000a0001";
    saveTask({
      id,
      title: "红",
      product_name: "某某精华",
      type: "excel_pdf",
      status: "compare_failed",
      job_kind: "compare",
      job_status: "failed",
      job_error: RAW,
      owner: "ou_redact_rv",
    });
    const rv = auth("reviewer", "ou_redact_rv");
    const list = await app.request("/api/tasks", { headers: rv });
    assert.equal(list.status, 200);
    const row = ((await list.json()) as Array<{ id: string; job_error?: string; error?: string }>).find((t) => t.id === id);
    assert.ok(row);
    assertRedacted(String(row.job_error));
    assertRedacted(String(row.error));
    const detail = await app.request(`/api/tasks/${id}`, { headers: rv });
    assert.equal(detail.status, 200);
    const raw = await detail.text();
    assertRedacted(String((JSON.parse(raw) as { job_error?: string }).job_error));
    for (const re of DIR_PATTERNS) assert.doesNotMatch(raw, re);

    const ad = auth("admin", "ou_redact_ad");
    const adminList = (await (await app.request("/api/tasks", { headers: ad })).json()) as Array<{ id: string; job_error?: string }>;
    assert.equal(adminList.find((t) => t.id === id)?.job_error, RAW);
    const adminDetail = (await (await app.request(`/api/tasks/${id}`, { headers: ad })).json()) as { job_error?: string };
    assert.equal(adminDetail.job_error, RAW);
  });

  it("Feishu failure notification text is redacted", async () => {
    const id = "0000000a0002";
    const seen: Array<string | undefined> = [];
    setJobsTestHooks({
      notify: async (opts) => {
        if (opts.tid === id) seen.push(opts.error);
        return { ok: true };
      },
    });
    try {
      saveTask({
        id,
        title: "红",
        product_name: "某某精华",
        type: "excel_pdf",
        status: "compare_failed",
        job_kind: "compare",
        job_status: "failed",
        job_error: RAW,
        notify_job_id: `${id}:compare:t`,
        notify_sent: false,
        owner: "ou_redact_rv",
      });
      reclaimOnBoot();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(seen.length, 1);
      assertRedacted(String(seen[0]));
    } finally {
      resetJobsTestHooks();
    }
  });
});

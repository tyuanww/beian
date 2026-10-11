import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

const DATA_DIR = makeTestTempDir("beian-error-guard-");
process.env.VITEST = "1";
process.env.WB_DATA_DIR = DATA_DIR;
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { saveTask } = await import("./tasks.js");
const { reclaimOnBoot, resetJobsTestHooks, setJobsTestHooks } = await import("./jobs.js");
const { guardPublicError, hasLeakResidue } = await import("./pathRedact.js");

// 相对路径里的 /Users/ 不会被脱敏规则改写，脱敏后仍残留，必须由兜底整条隐藏。
const RESIDUE = "读取 docs/Users/bob/a.pdf 失败";

function auth(role: "admin" | "reviewer" | "viewer", openId: string) {
  const s = issueSessionForTest(`兜-${role}`, role, openId);
  return { authorization: `Bearer ${s.token}` };
}

describe("leak residue detection", () => {
  it("matches the residue patterns", () => {
    for (const s of [
      "docs/Users/bob",
      "x/HOME/bob",
      "a\\users\\b",
      "1C:\\x",
      "1d:/x",
      "a%2Fb",
      "a%5cb",
      "ftp://bob:pw@h",
      "svn://u:@h",
    ]) assert.equal(hasLeakResidue(s), true, s);
  });
  it("does not match ordinary text or ports", () => {
    for (const s of [
      "http://host:8080/x 失败",
      "https://***@h:8787/api",
      "http://x/?p=/本机路径",
      "a.pdf 打不开",
      "step 2/3",
      "进度 50%",
    ]) assert.equal(hasLeakResidue(s), false, s);
  });
  it("guardPublicError hides the whole message with the task id", () => {
    assert.deepEqual(guardPublicError(RESIDUE, "0000000b0001"), {
      text: "任务失败，请联系管理员（单号 0000000b0001）",
      hidden: true,
    });
    assert.deepEqual(guardPublicError("读不到 C:\\a\\b.pdf", "x"), { text: "读不到 b.pdf", hidden: false });
    assert.deepEqual(guardPublicError("http://host:8080/x 失败", "x"), { text: "http://host:8080/x 失败", hidden: false });
  });
});

describe("leak safety net on every exit", () => {
  const FALLBACK = (id: string) => `任务失败，请联系管理员（单号 ${id}）`;

  it("reviewer/viewer list and detail get fallback text + error_hidden + error_ticket; admin unchanged", async () => {
    const id = "0000000b0002";
    saveTask({
      id,
      title: "兜",
      product_name: "某某精华",
      type: "excel_pdf",
      status: "compare_failed",
      job_kind: "compare",
      job_status: "failed",
      job_error: RESIDUE,
      owner: "ou_guard_rv",
    });
    for (const [role, openId] of [["reviewer", "ou_guard_rv"], ["viewer", "ou_guard_vw"]] as const) {
      const h = auth(role, openId);
      const list = (await (await app.request("/api/tasks", { headers: h })).json()) as Array<Record<string, unknown>>;
      const row = list.find((t) => t.id === id);
      if (role === "reviewer") {
        assert.ok(row, "reviewer owns the task");
      }
      if (row) {
        assert.equal(row.error, FALLBACK(id));
        assert.equal(row.job_error, FALLBACK(id));
        assert.equal(row.error_hidden, true);
        assert.equal(row.error_ticket, id);
        assert.doesNotMatch(JSON.stringify(row), /Users|bob/);
      }
      const res = await app.request(`/api/tasks/${id}`, { headers: h });
      if (res.status === 200) {
        const detail = (await res.json()) as Record<string, unknown>;
        assert.equal(detail.job_error, FALLBACK(id));
        assert.equal(detail.error_hidden, true);
        assert.equal(detail.error_ticket, id);
        assert.doesNotMatch(JSON.stringify(detail), /Users|bob/);
      } else {
        assert.equal(role, "viewer");
      }
    }
    const ad = auth("admin", "ou_guard_ad");
    const adminRow = ((await (await app.request("/api/tasks", { headers: ad })).json()) as Array<Record<string, unknown>>).find(
      (t) => t.id === id,
    );
    assert.equal(adminRow?.job_error, RESIDUE);
    assert.equal("error_hidden" in (adminRow || {}), false);
    assert.equal("error_ticket" in (adminRow || {}), false);
    const adminDetail = (await (await app.request(`/api/tasks/${id}`, { headers: ad })).json()) as Record<string, unknown>;
    assert.equal(adminDetail.job_error, RESIDUE);
    assert.equal("error_hidden" in adminDetail, false);
  });

  it("errors without residue are shown redacted, not hidden (incl. http://host:8080)", async () => {
    const id = "0000000b0003";
    saveTask({
      id,
      title: "兜",
      product_name: "某某精华",
      type: "excel_pdf",
      status: "compare_failed",
      job_kind: "compare",
      job_status: "failed",
      job_error: "请求 http://host:8080/x 失败，读不到 C:\\a\\b.pdf",
      owner: "ou_guard_rv",
    });
    const h = auth("reviewer", "ou_guard_rv");
    const row = ((await (await app.request("/api/tasks", { headers: h })).json()) as Array<Record<string, unknown>>).find(
      (t) => t.id === id,
    );
    assert.equal(row?.job_error, "请求 http://host:8080/x 失败，读不到 b.pdf");
    assert.equal("error_hidden" in (row || {}), false);
    const detail = (await (await app.request(`/api/tasks/${id}`, { headers: h })).json()) as Record<string, unknown>;
    assert.equal(detail.job_error, "请求 http://host:8080/x 失败，读不到 b.pdf");
    assert.equal("error_hidden" in detail, false);
  });

  it("Feishu failure notification uses the fallback text", async () => {
    const id = "0000000b0004";
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
        title: "兜",
        product_name: "某某精华",
        type: "excel_pdf",
        status: "compare_failed",
        job_kind: "compare",
        job_status: "failed",
        job_error: RESIDUE,
        notify_job_id: `${id}:compare:t`,
        notify_sent: false,
        owner: "ou_guard_rv",
      });
      reclaimOnBoot();
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(seen, [`任务失败，原文已隐藏，请到后台查看（单号 ${id}）`]);
      // 页面 / 接口给非管理员的文案不变。
      const page = (await (await app.request(`/api/tasks/${id}`, { headers: auth("reviewer", "ou_guard_rv") })).json()) as Record<string, unknown>;
      assert.equal(page.job_error, FALLBACK(id));
    } finally {
      resetJobsTestHooks();
    }
  });
});

describe("leak residue: more local roots, home shortcuts, UNC and configured dirs", () => {
  it("each class matches", () => {
    for (const s of [
      "/root/x",
      "/var/folders/tz/T",
      "/private/var/tmp",
      "~/Desktop/a.ai",
      "~bob/a.ai",
      "\\\\srv\\share",
      "\\\\192.168.1.9\\共享",
    ]) assert.equal(hasLeakResidue(s), true, s);
  });
  it("configured data / tool dirs match (read once per message)", async () => {
    const { saveSettings } = await import("./settings.js");
    saveSettings({ BLENDER_EXECUTABLE: "/srv/tools/bin/blender" });
    assert.equal(hasLeakResidue("x /srv/tools/bin/blender"), true);
    assert.equal(hasLeakResidue(`x ${DATA_DIR}`), true);
  });
  it("tradeoff: a /root/ segment inside a relative path or URL path also hides (safety over fidelity)", () => {
    assert.equal(hasLeakResidue("见 docs/root/a.md"), true);
    assert.equal(guardPublicError("见 docs/root/a.md", "0000000b0009").hidden, true);
  });
  it("ordinary text is not hit", () => {
    for (const s of ["~", "约 ~3 秒", "a~b", "rootkit/x", "/rooted 了", "http://x/a/b", "\\\\ 两个反斜杠", "共享盘\\\\"]) {
      assert.equal(hasLeakResidue(s), false, s);
    }
  });
});

describe("mockup Feishu failure notification is guarded", () => {
  it("residue in a mockup job_error is hidden with the job id as ticket", async () => {
    const { saveMockup } = await import("./mockup.js");
    const id = "0000000c0001";
    const seen: Array<string | undefined> = [];
    setJobsTestHooks({
      notify: async (opts) => {
        if (opts.tid === id) seen.push(opts.error);
        return { ok: true };
      },
    });
    try {
      saveMockup({
        id,
        status: "failed",
        created_at: "2026-10-11T10:00:00.000Z",
        files: [],
        job_kind: "mockup",
        job_status: "failed",
        job_error: RESIDUE,
        notify_job_id: `${id}:mockup:t`,
        notify_sent: false,
      });
      reclaimOnBoot();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(seen.length, 1);
      assert.doesNotMatch(String(seen[0]), /Users|bob|a\.pdf/);
      assert.match(String(seen[0]), new RegExp(`单号 ${id}`));
      assert.equal(seen[0], `任务失败，原文已隐藏，请到后台查看（单号 ${id}）`);
    } finally {
      resetJobsTestHooks();
    }
  });
});

describe("leak residue: backslash + letters left after redaction", () => {
  it("C:\\Documents and Settings\\bob is hidden", () => {
    assert.equal(guardPublicError("C:\\Documents and Settings\\bob", "0000000d0001").hidden, true);
    assert.equal(hasLeakResidue("本机路径 and Settings\\bob"), true);
  });
  it("one-letter escapes stay visible; tradeoff: literal \\nfoo also hides", () => {
    assert.equal(guardPublicError("用 \\n 换行", "x").hidden, false);
    assert.equal(guardPublicError("\\n\\t", "x").hidden, false);
    assert.equal(hasLeakResidue("a\\nfoo"), true);
  });
});

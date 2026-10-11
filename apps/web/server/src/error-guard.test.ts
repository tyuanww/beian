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

describe("leak residue: secret-looking query parameter names", () => {
  it("password/passwd/pwd/pw/token/secret/key (and *_key, *_token ...) hide", () => {
    for (const s of [
      "http://u@h/?password=pw",
      "http://h/?pw=secretpw",
      "http://h/?id=1&api_key=abc",
      "http://h/?access_token=t",
      "http://h/?PASSWD=1",
      "http://h/?client_secret=s",
      "?pwd=1 失败",
      "http://h/?key=1",
      "http://h/?x-token=1",
    ]) assert.equal(guardPublicError(s, "0000000d0002").hidden, true, s);
  });
  it("ordinary parameter names do not", () => {
    for (const s of ["http://h/?monkey=1", "http://h/?keyword=x", "http://h/?tokens_left=3", "http://h/?id=1&page=2"]) {
      assert.equal(guardPublicError(s, "x").hidden, false, s);
    }
  });
});

let chainSeq = 0;
/** 任务链路：列表、详情、飞书通知三处输出；返回给调用方断言。 */
async function taskChain(input: string) {
  chainSeq += 1;
  const id = `0000000f${String(chainSeq).padStart(4, "0")}`;
  const seen: Array<string | undefined> = [];
  setJobsTestHooks({ notify: async (opts) => { if (opts.tid === id) seen.push(opts.error); return { ok: true }; } });
  try {
    saveTask({
      id, title: "链", product_name: "某某精华", type: "excel_pdf", status: "compare_failed",
      job_kind: "compare", job_status: "failed", job_error: input,
      notify_job_id: `${id}:compare:t`, notify_sent: false, owner: "ou_chain_rv",
    });
    const h = auth("reviewer", "ou_chain_rv");
    const row = ((await (await app.request("/api/tasks", { headers: h })).json()) as Array<Record<string, unknown>>).find((t) => t.id === id);
    const detail = (await (await app.request(`/api/tasks/${id}`, { headers: h })).json()) as Record<string, unknown>;
    reclaimOnBoot();
    await new Promise((r) => setTimeout(r, 50));
    return { id, list: String(row?.job_error), listHidden: row?.error_hidden, detail: String(detail.job_error), detailTicket: detail.error_ticket, notify: String(seen[0]) };
  } finally {
    resetJobsTestHooks();
  }
}

async function assertTaskChainHidden(input: string) {
  const r = await taskChain(input);
  assert.equal(r.list, `任务失败，请联系管理员（单号 ${r.id}）`, `list: ${input} -> ${r.list}`);
  assert.equal(r.listHidden, true);
  assert.equal(r.detail, `任务失败，请联系管理员（单号 ${r.id}）`, `detail: ${input} -> ${r.detail}`);
  assert.equal(r.detailTicket, r.id);
  assert.equal(r.notify, `任务失败，原文已隐藏，请到后台查看（单号 ${r.id}）`, `notify: ${input} -> ${r.notify}`);
}

/** 不要求一定隐藏，但三处都不得残留给定片段。 */
async function assertTaskChainNoLeak(input: string, leak: RegExp) {
  const r = await taskChain(input);
  for (const [where, v] of [["list", r.list], ["detail", r.detail], ["notify", r.notify]] as const) {
    assert.doesNotMatch(v, leak, `${where}: ${input} -> ${v}`);
  }
}

describe("leak residue: backslash + non-ASCII", () => {
  it("D:\\客户 张三\\报价 and D:\\张三 李四\\x\\y leak nothing on list, detail and Feishu", async () => {
    await assertTaskChainNoLeak("读取 D:\\客户 张三\\报价 失败", /客户|张三|报价|\\/);
    await assertTaskChainNoLeak("读取 D:\\张三 李四\\x\\y 失败", /张三|李四|\\/);
    // 两个空格时脱敏只吃到第一段，剩「本机路径 张三 李四\报价」，必须由兜底整条隐藏。
    await assertTaskChainHidden("读取 D:\\客户 张三 李四\\报价 失败");
  });
  it("residue check itself; single-letter escapes still pass", () => {
    assert.equal(hasLeakResidue("本机稿件 张三\\报价"), true);
    assert.equal(hasLeakResidue("用 \\n 换行"), false);
    assert.equal(hasLeakResidue("\\t\\r"), false);
    assert.equal(hasLeakResidue("本机稿件 李四\\x\\y"), true);
    // 取舍：中文紧贴转义也会被隐藏。
    assert.equal(hasLeakResidue("换行\\n"), true);
  });
});

describe("leak residue: Authorization / Bearer / Basic", () => {
  it("Authorization header and JSON form hide on list, detail and Feishu", async () => {
    await assertTaskChainHidden("请求失败 Authorization: Bearer xxx");
    await assertTaskChainHidden('上游返回 {"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.e30.x"}');
  });
  it("token-looking Bearer / Basic values hide; any case of authorization hides", () => {
    for (const s of ["Bearer abc.def-123", "basic dXNlcjpwYXNz0=", "BEARER eyJ0eXAi.x", "header AUTHORIZATION missing"]) {
      assert.equal(guardPublicError(s, "x").hidden, true, s);
    }
  });
  it("ordinary words are not hit (tradeoff: all-letter short tokens after Bearer pass)", () => {
    for (const s of ["基本信息缺失", "bearer 字段为空", "Basic settings 未填", "the bearer of the bill", "Bearer abcdefgh"]) {
      assert.equal(guardPublicError(s, "x").hidden, false, s);
    }
  });
});

describe("home user segment with spaces (/Users/bob smith)", () => {
  it("task list, detail and Feishu leak neither bob nor smith", async () => {
    for (const input of ["读取 /Users/bob smith", "读取 /Users/bob smith/a.pdf 失败", "读取 /home/bob smith/a.pdf 失败"]) {
      await assertTaskChainNoLeak(input, /bob|smith/);
    }
  });
});

describe("Basic + base64 token", () => {
  it("Basic dXNlcjpwYXNz / dXNlcjpwYXNzMTIz hide on task list, detail and Feishu", async () => {
    await assertTaskChainHidden("上游 401：Basic dXNlcjpwYXNz");
    await assertTaskChainHidden("上游 401：Basic dXNlcjpwYXNzMTIz");
  });
  it("Basic settings / Basic Settings stay visible on task list, detail and Feishu", async () => {
    for (const input of ["Basic settings 未填", "Basic Settings 未填"]) {
      const r = await taskChain(input);
      assert.equal(r.list, input);
      assert.equal(r.detail, input);
      assert.equal(r.notify, input);
    }
  });
  it("rule edges: >=8 chars and (an uppercase after the first char, or a digit / + / =)", () => {
    for (const s of ["basic YWxhZGRpbjpvcGVuc2VzYW1l", "Basic QWxhZGRpbg==", "Basic abc+defgh", "Basic abcdefg1"]) {
      assert.equal(guardPublicError(s, "x").hidden, true, s);
    }
    for (const s of ["基本信息缺失", "Basic auth 未配置", "Basic information", "Basic Information", "Basic aB1"]) {
      assert.equal(guardPublicError(s, "x").hidden, false, s);
    }
  });
});

describe("leak residue: drive letter + placeholder + more text", () => {
  it("hits X:本机稿件 / X:本机路径 followed by content; a word before the colon does not", () => {
    assert.equal(hasLeakResidue("读取 D:本机稿件 张三/报价 失败"), true);
    assert.equal(hasLeakResidue("D:本机路径 x"), true);
    assert.equal(hasLeakResidue("open:本机稿件 失败"), false);
    assert.equal(hasLeakResidue("读取 本机稿件 失败"), false);
  });
});

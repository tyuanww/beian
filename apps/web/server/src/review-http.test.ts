import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = makeTestTempDir("beian-review-http-");
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSessionForTest } = await import("./auth.js");
const { hasValidTaskJobState, loadTask, saveTask, taskStoreSnapshot } = await import("./tasks.js");
const { queueSnapshot, resetJobsTestHooks, setJobsTestHooks } = await import("./jobs.js");
const { setVerbatimProbeForTest } = await import("./workers.js");
const { saveSettings } = await import("./settings.js");

type SeedHit = {
  id?: string;
  field?: string;
  status?: string;
  decision?: string;
  coverage?: { miss?: string[] };
};

type SeedTask = {
  id: string;
  title: string;
  product_name: string;
  type: string;
  status: string;
  job_kind?: "compare" | "rework";
  job_error?: string;
  status_before_job?: string;
  pages?: Array<{ url?: string }>;
  error?: string;
  conclusion?: string;
  complete_kind?: string;
  hits?: SeedHit[];
  hits_v2?: SeedHit[];
  pages_v2?: Array<{ url?: string }>;
  owner?: string;
  created_by?: string;
  actor?: string;
  job_status?: "queued" | "running" | "succeeded" | "failed";
  verbatim_check?: boolean;
  verbatim_warning?: string;
  job_error_code?: "page_over";
};

function authHeader() {
  const sess = issueSessionForTest("刘籽烨", "reviewer", "ou_review_http");
  return { authorization: `Bearer ${sess.token}` };
}

function seed(task: SeedTask) {
  saveTask({ owner: "ou_review_http", ...task });
  return task.id;
}

function hit(over: Partial<SeedHit> = {}) {
  return {
    id: "h1",
    field: "净含量",
    status: "疑点",
    decision: "pending",
    ...over,
  };
}

describe("review http", () => {
  it("does not expose parser or filesystem details for an unexpected 500", async () => {
    const tid = "efefefefefef";
    const tasksDir = join(process.env.WB_DATA_DIR as string, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, `${tid}.json`), "{broken-json", "utf8");

    const res = await app.request(`/api/tasks/${tid}`, { headers: authHeader() });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { detail?: string };
    assert.equal(body.detail, "服务器错误");
    assert.equal(JSON.stringify(body).includes("JSON"), false);
    assert.equal(JSON.stringify(body).includes(tasksDir), false);
  });

  it("rejects an illegal decision value", async () => {
    const tid = seed({
      id: "aaaaaaaaaaaa",
      title: "精华",
      product_name: "精华",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit()],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "ai_pass" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /非法审核结论/);
  });

  it("rejects signing a compare_failed task", async () => {
    const tid = seed({
      id: "bbbbbbbbbbbb",
      title: "失败单",
      product_name: "失败单",
      type: "excel_pdf",
      status: "compare_failed",
      error: "对照失败",
      hits: [],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "看起来没问题" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可签字/);
  });

  it("rejects signing a completed task again", async () => {
    const tid = seed({
      id: "cccccccccccc",
      title: "已签",
      product_name: "已签",
      type: "excel_pdf",
      status: "completed",
      conclusion: "先前结论",
      hits: [hit({ status: "一致", decision: "confirm" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "再签一次" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可签字/);
  });

  it("rejects signing while a compare is queued or running", async () => {
    for (const [tid, jobStatus] of [
      ["b1b1b1b1b1b1", "queued"],
      ["b2b2b2b2b2b2", "running"],
    ] as const) {
      seed({
        id: tid,
        title: `作业${jobStatus}`,
        product_name: `作业${jobStatus}`,
        type: "excel_pdf",
        status: "pending_review",
        job_status: jobStatus,
        hits: [hit({ status: "一致", decision: "confirm" })],
      });
      const res = await app.request(`/api/tasks/${tid}/complete`, {
        method: "POST",
        headers: { ...authHeader(), "content-type": "application/json" },
        body: JSON.stringify({ conclusion: "不能覆盖作业" }),
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { detail?: string };
      assert.match(String(body.detail || ""), /排队或正在跑/);
    }
  });

  it("reloads the task after a slow sign-off body so a queued rework wins the race", async () => {
    const tid = seed({
      id: "b3b3b3b3b3b3",
      title: "慢签字竞态",
      product_name: "慢签字竞态",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit({ status: "一致", decision: "confirm" })],
    });
    let markBodyRead!: () => void;
    let releaseBody!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          markBodyRead();
          await bodyGate;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ conclusion: "旧标签页签字" })));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(`http://localhost/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pendingResponse = app.request(request);

    await bodyRead;
    const concurrent = loadTask(tid);
    concurrent.status_before_job = concurrent.status;
    concurrent.status = "comparing";
    concurrent.job_kind = "rework";
    concurrent.job_status = "queued";
    saveTask(concurrent);
    releaseBody();

    const res = await pendingResponse;
    assert.equal(res.status, 409);
    const persisted = loadTask(tid);
    assert.equal(persisted.status, "comparing");
    assert.equal(persisted.job_kind, "rework");
    assert.equal(persisted.job_status, "queued");
    assert.equal(persisted.conclusion, undefined);
  });

  it("records a human sign-off on a pending_review task", async () => {
    const tid = seed({
      id: "dddddddddddd",
      title: "待签",
      product_name: "待签",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit({ status: "疑点", decision: "confirm" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "人看过了，一致" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string; conclusion?: string; complete_kind?: string };
    assert.equal(body.status, "completed");
    assert.equal(body.conclusion, "人看过了，一致");
    assert.equal(body.complete_kind, "signed");
  });

  it("blocks sign-off when persisted hit data has an unknown status or decision", async () => {
    const tid = seed({
      id: "dededededede",
      title: "异常审核数据",
      product_name: "异常审核数据",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit({ status: "疑点", decision: "confirmed" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "不应签字" }),
    });
    assert.equal(res.status, 400);
    assert.match(String(((await res.json()) as { detail?: string }).detail || ""), /审核数据状态异常/);

    const task = loadTask(tid);
    task.hits = [hit({ status: "新状态", decision: "pending" })];
    saveTask(task);
    const statusRes = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "仍不应签字" }),
    });
    assert.equal(statusRes.status, 400);
  });

  it("rejects a decision on a compare_failed task", async () => {
    const tid = seed({
      id: "ffffffffffff",
      title: "失败不可点",
      product_name: "失败不可点",
      type: "excel_pdf",
      status: "compare_failed",
      error: "对照失败",
      hits: [hit()],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "confirm" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可审核/);
  });

  it("rejects rework on a signed-clean task", async () => {
    const tid = seed({
      id: "333333333333",
      title: "干净签字",
      product_name: "干净签字",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "signed",
      conclusion: "人看过了",
      hits: [hit({ status: "一致", decision: "confirm" })],
    });
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可对红/);
  });

  it("lets a completed-rework task reach the rework pdf check", async () => {
    const tid = seed({
      id: "222222222222",
      title: "已签待对红",
      product_name: "已签待对红",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /需要改稿后的 PDF/);
  });

  it("stops a verbatim rework before writing the new pdf when glyphs are not ready", async () => {
    const tid = "232323232323";
    seed({
      id: tid,
      title: "认字退回",
      product_name: "认字退回",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      verbatim_check: true,
      hits: [hit({ decision: "issue" })],
    });
    const dir = join(process.env.WB_DATA_DIR as string, "uploads", tid);
    mkdirSync(dir, { recursive: true });
    const pdfPath = join(dir, "artwork_v2.pdf");
    writeFileSync(pdfPath, "keep");
    let calls = 0;
    setJobsTestHooks({ runRework: () => new Promise(() => { /* hang */ }) });
    setVerbatimProbeForTest(async () => {
      calls += 1;
      return "认字出了问题，请联系管理员";
    });
    try {
      const fd = new FormData();
      fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
      const res = await app.request(`/api/tasks/${tid}/rework`, { method: "POST", headers: authHeader(), body: fd });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { detail?: string };
      assert.equal(body.detail, "认字出了问题，请联系管理员");
      assert.equal(calls, 1);
      assert.equal(readFileSync(pdfPath, "utf8"), "keep");
      const saved = loadTask(tid);
      assert.equal(saved.status, "completed");
      assert.equal(saved.job_status, undefined);
    } finally {
      setVerbatimProbeForTest(null);
      resetJobsTestHooks();
    }
  });

  it("queues a verbatim rework after the glyph probe passes", async () => {
    const tid = "242424242424";
    seed({
      job_error_code: "page_over",
      id: tid,
      title: "认字对红",
      product_name: "认字对红",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      verbatim_check: true,
      hits: [hit({ decision: "issue" })],
    });
    let calls = 0;
    setJobsTestHooks({ runRework: () => new Promise(() => { /* hang */ }) });
    setVerbatimProbeForTest(async () => {
      calls += 1;
      return null;
    });
    try {
      const fd = new FormData();
      fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
      const res = await app.request(`/api/tasks/${tid}/rework`, { method: "POST", headers: authHeader(), body: fd });
      assert.equal(res.status, 200);
      assert.equal(calls, 1);
      const body = (await res.json()) as { status?: string; job_kind?: string };
      assert.equal(body.status, "comparing");
      assert.equal(body.job_kind, "rework");
      assert.equal("job_error_code" in body, false);
      assert.equal(existsSync(join(process.env.WB_DATA_DIR as string, "uploads", tid, "artwork_v2.pdf")), true);
    } finally {
      setVerbatimProbeForTest(null);
      resetJobsTestHooks();
    }
  });

  it("does not probe glyphs on a rework that is not verbatim", async () => {
    const tid = "252525252525";
    seed({
      id: tid,
      title: "旧对红",
      product_name: "旧对红",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    let calls = 0;
    setJobsTestHooks({ runRework: () => new Promise(() => { /* hang */ }) });
    setVerbatimProbeForTest(async () => {
      calls += 1;
      return "认字出了问题，请联系管理员";
    });
    try {
      const fd = new FormData();
      fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
      const res = await app.request(`/api/tasks/${tid}/rework`, { method: "POST", headers: authHeader(), body: fd });
      assert.equal(res.status, 200);
      assert.equal(calls, 0);
      const body = (await res.json()) as { job_kind?: string };
      assert.equal(body.job_kind, "rework");
    } finally {
      setVerbatimProbeForTest(null);
      resetJobsTestHooks();
    }
  });

  it("rejects rework on a compare_failed task", async () => {
    const tid = seed({
      id: "111111111111",
      title: "失败不可对红",
      product_name: "失败不可对红",
      type: "excel_pdf",
      status: "compare_failed",
      error: "对照失败",
      hits: [],
    });
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可对红/);
  });

  it("lets her sign when the only pending 疑点 is a pack-sheet field", async () => {
    const tid = seed({
      id: "c3c3c3c3c3c3",
      title: "工艺表假疑点",
      product_name: "工艺表假疑点",
      type: "excel_pdf",
      status: "pending_review",
      hits: [
        hit({ id: "ok", field: "净含量", status: "一致", decision: "confirm" }),
        hit({ id: "proc", field: "工艺说明", status: "疑点", decision: "pending" }),
      ],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "工艺表不审，其余过了" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string };
    assert.equal(body.status, "completed");
  });

  it("blocks sign-off when v2 hits still have pending 疑点", async () => {
    const tid = seed({
      id: "444444444444",
      title: "对红后",
      product_name: "对红后",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit({ status: "一致", decision: "confirm" })],
      hits_v2: [hit({ id: "v2_h1", status: "疑点", decision: "pending" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "第二轮也过了" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /仍有 1 条疑点/);
  });

  it("records a v2 hit decision", async () => {
    const tid = seed({
      id: "555555555555",
      title: "对红点字段",
      product_name: "对红点字段",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit({ status: "一致", decision: "confirm" })],
      hits_v2: [hit({ id: "v2_h1", status: "疑点", decision: "pending" })],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "v2_h1", decision: "confirm" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits_v2?: Array<{ id?: string; decision?: string }> };
    assert.equal(body.hits_v2?.[0]?.decision, "confirm");
  });

  it("rejects a decision on a missing hit", async () => {
    const tid = seed({
      id: "666666666666",
      title: "没有这个字段",
      product_name: "没有这个字段",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit()],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "nope", decision: "confirm" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /字段不存在/);
  });

  it("rejects sign-off without a conclusion", async () => {
    const tid = seed({
      id: "777777777777",
      title: "没写结论",
      product_name: "没写结论",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit({ status: "一致", decision: "confirm" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "   " }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /请写下结论/);
  });

  it("marks complete_kind rework when any hit is issue", async () => {
    const tid = seed({
      id: "888888888888",
      title: "有错待改",
      product_name: "有错待改",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit({ decision: "issue" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "待设计改稿" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { complete_kind?: string; status?: string };
    assert.equal(body.status, "completed");
    assert.equal(body.complete_kind, "rework");
  });

  it("rejects a second rework after pages_v2 already exist", async () => {
    const tid = seed({
      id: "999999999999",
      title: "已经对过红",
      product_name: "已经对过红",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit({ decision: "issue" })],
      hits_v2: [hit({ id: "v2_h1", decision: "pending" })],
      pages_v2: [{ url: "/x.png" }],
    });
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可对红/);
  });

  it("still records confirm on an in_review hit", async () => {
    const tid = seed({
      id: "eeeeeeeeeeee",
      title: "审核中",
      product_name: "审核中",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit()],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "confirm", note: "看过了" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string; hits?: Array<{ decision?: string; note?: string }> };
    assert.equal(body.status, "in_review");
    assert.equal(body.hits?.[0]?.decision, "confirm");
    assert.equal(body.hits?.[0]?.note, "看过了");
  });

  it("rejects confirm on 待人工确认 hits", async () => {
    const tid = seed({
      id: "a1a1a1a1a1a1",
      title: "待人工",
      product_name: "待人工",
      type: "excel_pdf",
      status: "pending_review",
      verbatim_check: true,
      hits: [hit({ id: "h1", status: "待人工确认", decision: "pending" })],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "confirm" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /待人工确认不能选一致/);
  });

  it("blocks signing a no-private-data order until order_held_confirm", async () => {
    const tid = seed({
      id: "b2b2b2b2b2b2",
      title: "无私有",
      product_name: "无私有",
      type: "excel_pdf",
      status: "pending_review",
      verbatim_check: true,
      verbatim_warning: "稿件未保留 Illustrator 编辑数据，定位精度下降，建议设计师重新导出",
      hits: [hit({ id: "h1", status: "待人工确认", decision: "pending" })],
    });
    const blocked = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "无改稿项" }),
    });
    assert.equal(blocked.status, 400);
    const blockedBody = (await blocked.json()) as { detail?: string };
    assert.equal(blockedBody.detail, "整单待人工确认，签字即认可");

    const ok = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "无改稿项", order_held_confirm: true }),
    });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { status?: string; complete_kind?: string };
    assert.equal(okBody.status, "completed");
    assert.equal(okBody.complete_kind, "signed");
  });

  it("allows returning an order with open held hits without order_held_confirm", async () => {
    const tid = seed({
      id: "b3b3b3b3b3b3",
      title: "无私有退回",
      product_name: "无私有退回",
      type: "excel_pdf",
      status: "pending_review",
      verbatim_check: true,
      verbatim_warning: "稿件未保留 Illustrator 编辑数据，定位精度下降，建议设计师重新导出",
      hits: [
        hit({ id: "h1", status: "待人工确认", decision: "pending" }),
        hit({ id: "h2", decision: "issue" }),
      ],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "退回改稿" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string; complete_kind?: string };
    assert.equal(body.status, "completed");
    assert.equal(body.complete_kind, "rework");
  });

  it("still blocks signing with open held hits when order_held_confirm is absent", async () => {
    const tid = seed({
      id: "b4b4b4b4b4b4",
      title: "无私有签字",
      product_name: "无私有签字",
      type: "excel_pdf",
      status: "pending_review",
      verbatim_check: true,
      verbatim_warning: "稿件未保留 Illustrator 编辑数据，定位精度下降，建议设计师重新导出",
      hits: [
        hit({ id: "h1", status: "待人工确认", decision: "pending" }),
        hit({ id: "h2", decision: "confirm" }),
      ],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "无改稿项" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.equal(body.detail, "整单待人工确认，签字即认可");
  });

  // 签字/退回共用表（signReturnRules.ts）第 1、2 条与认字存疑在 HTTP 入口的落点：仍是 400 + {detail}，不加错误码。
  async function completeAs(tid: string, conclusion: string) {
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  // 老板 10/17 定 B：对红失败、带上一轮条目的单签字退回都拦，出路是重新上传对红（/rework）。
  it("rejects signing and returning after a failed rework that kept last round's hits, and lets the same order rework again", async () => {
    const signTid = seed({
      id: "d7d7d7d7d7d7",
      title: "复核失败签字",
      product_name: "复核失败签字",
      type: "excel_pdf",
      status: "pending_review",
      job_kind: "rework",
      job_status: "failed",
      hits: [hit({ decision: "confirm" })],
    });
    const sign = await completeAs(signTid, "无改稿项");
    assert.equal(sign.status, 400);
    assert.deepEqual(sign.body, { detail: "当前状态不可签字" });
    assert.equal(loadTask(signTid).status, "pending_review");

    const retTid = seed({
      id: "d8d8d8d8d8d8",
      title: "复核失败退回",
      product_name: "复核失败退回",
      type: "excel_pdf",
      status: "in_review",
      job_kind: "rework",
      job_status: "failed",
      hits: [hit({ decision: "issue" })],
    });
    const ret = await completeAs(retTid, "退回改稿");
    assert.equal(ret.status, 400);
    assert.deepEqual(ret.body, { detail: "当前状态不可签字" });
    assert.equal(loadTask(retTid).status, "in_review");

    // 出路：同一单重新上传，走现有 /rework 入队。worker 立即失败，免得占住单槽。
    setJobsTestHooks({ runRework: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }) });
    try {
      const fd = new FormData();
      fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
      const res = await app.request(`/api/tasks/${signTid}/rework`, { method: "POST", headers: authHeader(), body: fd });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status?: string; job_kind?: string; job_status?: string };
      assert.equal(body.status, "comparing");
      assert.equal(body.job_kind, "rework");
      assert.ok(body.job_status === "queued" || body.job_status === "running");
      assert.equal(existsSync(join(process.env.WB_DATA_DIR as string, "uploads", signTid, "artwork_v2.pdf")), true);
    } finally {
      resetJobsTestHooks();
    }
  });

  it("a failed rework with no hits left is blocked too", async () => {
    const tid = seed({
      id: "dcdcdcdcdcdc",
      title: "复核失败无条目",
      product_name: "复核失败无条目",
      type: "excel_pdf",
      status: "pending_review",
      job_kind: "rework",
      job_status: "failed",
      hits: [],
    });
    const res = await completeAs(tid, "无改稿项");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { detail: "当前状态不可签字" });
    assert.equal(loadTask(tid).status, "pending_review");
  });

  // 核对页三种失败条对应的真实落盘形状（jobs.ts markOcrFailed / reclaimTask）。对红失败不写 pages_v2
  // （pages_v2 只由对红成功的 worker 结果合入），所以种子里不带；初审只写 pages。
  async function reworkAs(tid: string) {
    const fd = new FormData();
    fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
    const res = await app.request(`/api/tasks/${tid}/rework`, { method: "POST", headers: authHeader(), body: fd });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const failedRoundHits = () => [hit({ id: "h1", decision: "confirm" }), hit({ id: "h2", field: "中文品名", decision: "issue" })];

  for (const bar of [
    { name: "红条「复核出了问题」", id: "e1e1e1e1e1e1", job_error: "对照中断" },
    { name: "黄条「稿件超过 1 页，这次复核没做」", id: "e2e2e2e2e2e2", job_error: "稿件超过 1 页，暂不支持核对，请联系管理员", job_error_code: "page_over" as const },
  ]) {
    it(`${bar.name}：签字退回都 400，同一单可重新上传对红`, async () => {
      const tid = seed({
        id: bar.id,
        title: bar.name,
        product_name: bar.name,
        type: "excel_pdf",
        status: "in_review",
        status_before_job: "in_review",
        job_kind: "rework",
        job_status: "failed",
        job_error: bar.job_error,
        ...(bar.job_error_code ? { job_error_code: bar.job_error_code } : {}),
        pages: [{ url: `/api/tasks/${bar.id}/pages/p1.png` }],
        hits: failedRoundHits(),
      });
      assert.equal(loadTask(tid).pages_v2, undefined);
      for (const conclusion of ["无改稿项", "退回：1 条有错，见清单"]) {
        const res = await completeAs(tid, conclusion);
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { detail: "当前状态不可签字" });
      }
      setJobsTestHooks({ runRework: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }) });
      try {
        const res = await reworkAs(tid);
        assert.equal(res.status, 200);
        assert.equal(res.body.status, "comparing");
        assert.equal(res.body.job_kind, "rework");
        assert.ok(res.body.job_status === "queued" || res.body.job_status === "running");
        assert.equal("job_error_code" in res.body, false);
      } finally {
        resetJobsTestHooks();
      }
    });
  }

  // 「检查中断」单（产品 10/17 方案 A）：对照失败、还留着上一轮条目、没有 pages_v2 的单可重新上传对红。
  // 种子按 reclaimTask 把卡在 comparing 的复核改成 compare_failed 的真实落盘：job_kind 改写成 compare、
  // error/job_error「对照中断」、条目没清、上一轮的 status_before_job 还留着。
  function seedInterrupted(id: string, over: Partial<SeedTask> = {}) {
    const dir = join(process.env.WB_DATA_DIR as string, "uploads", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "source.xlsx"), "xlsx");
    writeFileSync(join(dir, "artwork.pdf"), "%PDF-1.4\nv1\n");
    return seed({
      id,
      title: "检查中断",
      product_name: "检查中断",
      type: "excel_pdf",
      status: "compare_failed",
      status_before_job: "in_review",
      job_kind: "compare",
      job_status: "failed",
      job_error: "对照中断",
      error: "对照中断",
      pages: [{ url: `/api/tasks/${id}/pages/p1.png` }],
      hits: failedRoundHits(),
      ...over,
    });
  }

  async function waitJobDone(tid: string) {
    for (let i = 0; i < 200; i++) {
      const t = loadTask(tid);
      if (t.job_status === "succeeded" || t.job_status === "failed") return t;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`job for ${tid} did not finish`);
  }

  async function assertSignAndReturnBlocked(tid: string) {
    for (const conclusion of ["无改稿项", "退回：1 条有错，见清单"]) {
      const res = await completeAs(tid, conclusion);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { detail: "当前状态不可签字" });
    }
  }

  it("「检查中断」单：签字退回仍 400；本人重新上传入队，复核拿原 Excel 对 artwork_v2.pdf、上一轮 hits 原样", async () => {
    const tid = seedInterrupted("e3e3e3e3e3e3");
    await assertSignAndReturnBlocked(tid);
    let seen: { pdf: string; tid: string; hits: unknown; artwork: string } | undefined;
    setJobsTestHooks({
      runRework: async (opts) => {
        seen = { pdf: opts.pdf, tid: opts.tid, hits: loadTask(opts.tid).hits, artwork: readFileSync(opts.pdf, "utf8") };
        return { code: 1, stdout: "", stderr: "", timedOut: false };
      },
    });
    try {
      const res = await reworkAs(tid);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "comparing");
      assert.equal(res.body.job_kind, "rework");
      assert.ok(res.body.job_status === "queued" || res.body.job_status === "running");
      assert.equal("error" in res.body, false);
      assert.equal("job_error" in res.body, false);
      const queued = loadTask(tid);
      assert.equal(queued.status_before_job, "pending_review");
      assert.equal(queued.error, undefined);
      await waitJobDone(tid);
    } finally {
      resetJobsTestHooks();
    }
    const uploads = join(process.env.WB_DATA_DIR as string, "uploads", tid);
    assert.ok(seen);
    assert.equal(seen.tid, tid);
    assert.equal(seen.pdf, join(uploads, "artwork_v2.pdf"));
    assert.equal(seen.artwork, "%PDF-1.4\n");
    assert.deepEqual(seen.hits, failedRoundHits());
    assert.equal(readFileSync(join(uploads, "artwork.pdf"), "utf8"), "%PDF-1.4\nv1\n");
    assert.equal(readFileSync(join(uploads, "source.xlsx"), "utf8"), "xlsx");
  });

  for (const flow of [
    { name: "签字", id: "e4e4e4e4e4e4", hits_v2: [{ id: "h1", field: "净含量", status: "一致" }], conclusion: "无改稿项", kind: "signed" },
    { name: "退回", id: "e5e5e5e5e5e5", hits_v2: [{ id: "h1", field: "净含量", status: "疑点", decision: "issue" }], conclusion: "退回：1 条有错，见清单", kind: "rework" },
  ]) {
    it(`「检查中断」单复核成功：进 in_review，${flow.name}回 200，旧「对照中断」已清，之后和所有单一样不能再上传`, async () => {
      const tid = seedInterrupted(flow.id);
      setJobsTestHooks({
        runRework: async () => ({
          code: 0,
          stdout: `${JSON.stringify({ status: "in_review", pages_v2: [{ url: `/api/tasks/${flow.id}/pages/v2/p1.png` }], hits_v2: flow.hits_v2 })}\n`,
          stderr: "",
          timedOut: false,
        }),
      });
      try {
        assert.equal((await reworkAs(tid)).status, 200);
        const done = await waitJobDone(tid);
        assert.equal(done.status, "in_review");
        assert.equal(done.job_kind, "rework");
        assert.equal(done.job_status, "succeeded");
        assert.equal(done.error, undefined);
        assert.equal(done.job_error, undefined);
      } finally {
        resetJobsTestHooks();
      }
      const detail = await app.request(`/api/tasks/${tid}`, { headers: authHeader() });
      assert.equal(detail.status, 200);
      const text = await detail.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(body.error, undefined);
      assert.equal(body.job_error, undefined);
      assert.equal(text.includes("对照中断"), false);
      assert.equal(text.includes("检查中断了"), false);

      const res = await completeAs(tid, flow.conclusion);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "completed");
      assert.equal(res.body.complete_kind, flow.kind);
      const again = await reworkAs(tid);
      assert.equal(again.status, 400);
      assert.deepEqual(again.body, { detail: "当前状态不可对红" });
    });
  }

  it("「检查中断」单复核失败：落到 pending_review + rework failed，单可读、列表可见、不挡调度；失败新写的错误留着；签字退回 400，可再次上传", async () => {
    const tid = seedInterrupted("e6e6e6e6e6e6");
    const unreadableBefore = taskStoreSnapshot().unreadable;
    const unknownBefore = queueSnapshot().unknown;
    setJobsTestHooks({ runRework: async () => ({ code: 0, stdout: "", stderr: "", timedOut: true }) });
    try {
      assert.equal((await reworkAs(tid)).status, 200);
      assert.equal(loadTask(tid).error, undefined);
      const failed = await waitJobDone(tid);
      assert.equal(failed.status, "pending_review");
      assert.equal(failed.job_kind, "rework");
      assert.equal(failed.job_status, "failed");
      assert.equal(failed.job_error, "超时");
      assert.equal(failed.error, undefined);
      assert.equal(hasValidTaskJobState(failed), true);
    } finally {
      resetJobsTestHooks();
    }
    const snap = taskStoreSnapshot();
    assert.equal(snap.unreadable, unreadableBefore);
    assert.ok(snap.tasks.some((t) => t.id === tid));
    assert.equal(queueSnapshot().unknown, unknownBefore);

    const list = await app.request("/api/tasks", { headers: authHeader() });
    assert.equal(list.status, 200);
    const row = ((await list.json()) as Array<Record<string, unknown>>).find((t) => t.id === tid);
    assert.ok(row);
    assert.equal(row.status, "pending_review");
    assert.equal(row.job_status, "failed");
    assert.equal(row.error, "超时");
    const detail = (await (await app.request(`/api/tasks/${tid}`, { headers: authHeader() })).json()) as Record<string, unknown>;
    assert.equal(detail.job_error, "超时");

    await assertSignAndReturnBlocked(tid);
    setJobsTestHooks({ runRework: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }) });
    try {
      const again = await reworkAs(tid);
      assert.equal(again.status, 200);
      assert.equal(again.body.job_kind, "rework");
      assert.ok(again.body.job_status === "queued" || again.body.job_status === "running");
      assert.equal(loadTask(tid).status_before_job, "pending_review");
      await waitJobDone(tid);
    } finally {
      resetJobsTestHooks();
    }
  });

  it("别人的「检查中断」单：403，不入队，不写 artwork_v2.pdf，单原样", async () => {
    const tid = seedInterrupted("e7e7e7e7e7e7");
    const other = issueSessionForTest("路人", "reviewer", "ou_interrupted_other");
    const fd = new FormData();
    fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
    const res = await app.request(`/api/tasks/${tid}/rework`, { method: "POST", headers: { authorization: `Bearer ${other.token}` }, body: fd });
    assert.equal(res.status, 403);
    const after = loadTask(tid);
    assert.equal(after.status, "compare_failed");
    assert.equal(after.job_kind, "compare");
    assert.equal(after.job_status, "failed");
    assert.equal(after.error, "对照中断");
    assert.equal(after.status_before_job, "in_review");
    assert.equal(existsSync(join(process.env.WB_DATA_DIR as string, "uploads", tid, "artwork_v2.pdf")), false);
  });

  it("对照失败且已没有条目：/rework 仍 400「当前状态不可对红」，不落盘", async () => {
    const tid = seedInterrupted("e8e8e8e8e8e8", { hits: [] });
    const res = await reworkAs(tid);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { detail: "当前状态不可对红" });
    assert.equal(loadTask(tid).status, "compare_failed");
    assert.equal(existsSync(join(process.env.WB_DATA_DIR as string, "uploads", tid, "artwork_v2.pdf")), false);
  });

  it("treats an open 待人工确认 on a non-verbatim order as pending", async () => {
    const tid = seed({
      id: "c7c7c7c7c7c7",
      title: "非逐字待人工",
      product_name: "非逐字待人工",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit({ status: "待人工确认", decision: "pending" })],
    });
    const res = await completeAs(tid, "无改稿项");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { detail: "仍有 1 条待人工确认未处理" });
  });

  it("treats a consistent hit with coverage.miss (认字存疑) as pending", async () => {
    const tid = seed({
      id: "c8c8c8c8c8c8",
      title: "认字存疑",
      product_name: "认字存疑",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit({ status: "一致", decision: undefined, coverage: { miss: ["CAPSULE MIST"] } })],
    });
    const res = await completeAs(tid, "无改稿项");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { detail: "仍有 1 条认字存疑未处理" });
  });

  it("counts 待人工确认 and 认字存疑 separately in one message, in first-seen order", async () => {
    const tid = seed({
      id: "d9d9d9d9d9d9",
      title: "两类都有",
      product_name: "两类都有",
      type: "excel_pdf",
      status: "pending_review",
      hits: [
        hit({ id: "h1", status: "待人工确认", decision: "pending" }),
        hit({ id: "h2", status: "一致", decision: undefined, coverage: { miss: ["CAPSULE MIST"] } }),
        hit({ id: "h3", status: "待人工确认", decision: undefined }),
      ],
    });
    const res = await completeAs(tid, "无改稿项");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { detail: "仍有 2 条待人工确认、1 条认字存疑未处理" });
  });

  it("old task without created_by returns null creator, never the actor, after a verdict", async () => {
    const tid = seed({
      id: "c5c5c5c5c5c5",
      title: "旧单",
      product_name: "旧单",
      type: "excel_pdf",
      status: "pending_review",
      actor: "老审稿",
      hits: [hit()],
    });
    const dec = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "issue" }),
    });
    assert.equal(dec.status, 200);
    const decBody = (await dec.json()) as { created_by?: unknown; actor?: string };
    assert.equal(decBody.actor, "刘籽烨");
    assert.equal(decBody.created_by, null);

    const one = await app.request(`/api/tasks/${tid}`, { headers: authHeader() });
    assert.equal(one.status, 200);
    const oneBody = (await one.json()) as Record<string, unknown>;
    assert.ok("created_by" in oneBody);
    assert.equal(oneBody.created_by, null);

    const list = await app.request("/api/tasks", { headers: authHeader() });
    const rows = (await list.json()) as Array<{ id: string; owner?: unknown }>;
    const row = rows.find((r) => r.id === tid);
    assert.ok(row);
    assert.equal(row.owner, null);
    assert.notEqual(row.owner, "刘籽烨");
    assert.notEqual(row.owner, "老审稿");
  });

  it("new task returns its creator as created_by", async () => {
    const tid = seed({
      id: "c6c6c6c6c6c6",
      title: "新单",
      product_name: "新单",
      type: "excel_pdf",
      status: "pending_review",
      created_by: "生成人甲",
      hits: [hit()],
    });
    const dec = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "issue" }),
    });
    assert.equal(dec.status, 200);
    const one = await app.request(`/api/tasks/${tid}`, { headers: authHeader() });
    const oneBody = (await one.json()) as { created_by?: unknown };
    assert.equal(oneBody.created_by, "生成人甲");
    const list = await app.request("/api/tasks", { headers: authHeader() });
    const rows = (await list.json()) as Array<{ id: string; owner?: unknown }>;
    assert.equal(rows.find((r) => r.id === tid)?.owner, "生成人甲");
  });

  it("GET task hides job_pid from the client", async () => {
    saveTask({
      id: "121212121212",
      title: "排队",
      product_name: "排队",
      type: "excel_pdf",
      status: "comparing",
      owner: "刘籽烨",
      job_kind: "compare",
      job_status: "running",
      job_pid: 4242,
    });
    const res = await app.request("/api/tasks/121212121212", { headers: authHeader() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal("job_pid" in body, false);
    assert.equal(body.job_status, "running");
  });

  it("decision is owner-scoped for reviewers", async () => {
    saveTask({
      id: "151515151515",
      title: "别人的点",
      product_name: "别人的点",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
      hits: [{ id: "h1", field: "净含量", status: "疑点", decision: "pending" }],
    });
    const other = issueSessionForTest("路人", "reviewer", "ou_other_decision");
    const res = await app.request("/api/tasks/151515151515/decision", {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "confirm" }),
    });
    assert.equal(res.status, 403);
  });

  it("pages are owner-scoped for reviewers", async () => {
    saveTask({
      id: "161616161616",
      title: "别人的页",
      product_name: "别人的页",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
    });
    const other = issueSessionForTest("路人", "reviewer", "ou_other_pages");
    const res = await app.request("/api/tasks/161616161616/pages/page_01.png", {
      headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(res.status, 403);
  });

  it("serves generated SVG review pages with a locked content policy", async () => {
    const tid = seed({
      id: "161616161617",
      title: "矢量核对页",
      product_name: "矢量核对页",
      type: "excel_pdf",
      status: "pending_review",
    });
    const pagesDir = join(process.env.WB_DATA_DIR as string, "uploads", tid, "pages");
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "page_01.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");

    const res = await app.request(`/api/tasks/${tid}/pages/page_01.svg`, { headers: authHeader() });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^image\/svg\+xml/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'none'/);
  });

  it("serves side SVG review pages with the same locked content policy", async () => {
    const tid = seed({
      id: "161616161618",
      title: "对红矢量核对页",
      product_name: "对红矢量核对页",
      type: "excel_pdf",
      status: "pending_review",
    });
    const sideDir = join(process.env.WB_DATA_DIR as string, "uploads", tid, "pages", "b");
    mkdirSync(sideDir, { recursive: true });
    writeFileSync(join(sideDir, "page_01.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");

    const res = await app.request(`/api/tasks/${tid}/pages/b/page_01.svg`, { headers: authHeader() });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^image\/svg\+xml/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'none'/);
  });

  it("rework is owner-scoped for reviewers", async () => {
    saveTask({
      id: "171717171717",
      title: "别人的对红",
      product_name: "别人的对红",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
      hits: [{ id: "h1", field: "净含量", status: "疑点", decision: "issue" }],
    });
    const other = issueSessionForTest("路人", "reviewer", "ou_other_rework");
    const fd = new FormData();
    fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
    const res = await app.request("/api/tasks/171717171717/rework", {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}` },
      body: fd,
    });
    assert.equal(res.status, 403);
  });

  it("complete is owner-scoped for reviewers", async () => {
    saveTask({
      id: "141414141414",
      title: "别人的签",
      product_name: "别人的签",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
      hits: [{ id: "h1", field: "净含量", status: "一致", decision: "confirm" }],
    });
    const other = issueSessionForTest("路人", "reviewer", "ou_other_complete");
    const res = await app.request("/api/tasks/141414141414/complete", {
      method: "POST",
      headers: { ...{ authorization: `Bearer ${other.token}` }, "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "偷签" }),
    });
    assert.equal(res.status, 403);
  });

  it("GET task is owner-scoped for reviewers", async () => {
    saveTask({
      id: "131313131313",
      title: "别人的",
      product_name: "别人的",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
    });
    const other = issueSessionForTest("路人", "reviewer", "ou_other_owner");
    const res = await app.request("/api/tasks/131313131313", {
      headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(res.status, 403);
  });

  it("fails closed for a legacy task without owner, while admin can read it", async () => {
    saveTask({
      id: "232323232323",
      title: "无主人旧单",
      product_name: "无主人旧单",
      type: "excel_pdf",
      status: "pending_review",
    });
    const reviewer = issueSessionForTest("刘籽烨", "reviewer", "ou_ownerless_reviewer");
    const denied = await app.request("/api/tasks/232323232323", {
      headers: { authorization: `Bearer ${reviewer.token}` },
    });
    assert.equal(denied.status, 403);
    const admin = issueSessionForTest("管理员", "admin", "ou_ownerless_admin");
    const allowed = await app.request("/api/tasks/232323232323", {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    assert.equal(allowed.status, 200);
  });

  it("keeps display-name compatibility for a legacy task owner", async () => {
    saveTask({
      id: "242424242424",
      title: "花名主人旧单",
      product_name: "花名主人旧单",
      type: "excel_pdf",
      status: "pending_review",
      owner: "魏炜",
    });
    const owner = issueSessionForTest("魏炜", "reviewer", "ou_legacy_owner");
    const res = await app.request("/api/tasks/242424242424", {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(res.status, 200);
  });

  it("owner can delete a task; stranger cannot", async () => {
    saveTask({
      id: "191919191919",
      title: "待删",
      product_name: "待删",
      type: "excel_pdf",
      status: "compare_failed",
      owner: "魏炜",
      job_status: "failed",
      job_error: "对照中断",
    });
    const other = issueSessionForTest("路人", "reviewer", "ou_del_stranger");
    const denied = await app.request("/api/tasks/191919191919", {
      method: "DELETE",
      headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(denied.status, 403);
    const owner = issueSessionForTest("魏炜", "admin", "ou_del_owner");
    const ok = await app.request("/api/tasks/191919191919", {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(ok.status, 200);
    const retried = await app.request("/api/tasks/191919191919", {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(retried.status, 200);
    assert.equal(((await retried.json()) as { already_deleted?: boolean }).already_deleted, true);
    const gone = await app.request("/api/tasks/191919191919", {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(gone.status, 404);
  });

  it("refuses to delete a running compare", async () => {
    saveTask({
      id: "202020202020",
      title: "跑着",
      product_name: "跑着",
      type: "excel_pdf",
      status: "comparing",
      owner: "魏炜",
      job_status: "running",
    });
    const owner = issueSessionForTest("魏炜", "admin", "ou_del_running");
    const res = await app.request("/api/tasks/202020202020", {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /还在跑/);
  });

  it("direct loopback health keeps the release queue contract", async () => {
    const res = await app.request("/api/health", { headers: { host: "127.0.0.1:8787" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      version?: string;
      jobs?: {
        ocr?: { running: number; queued: number };
        blender?: { running: number; queued: number };
        illustrator?: {
          running: number;
          queued: number;
          agent?: { required?: boolean; ready?: boolean; mode?: string };
        };
      };
      uploads?: { active: number; waiting: number };
    };
    assert.match(String(body.version), /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(typeof body.jobs?.ocr?.running, "number");
    assert.equal(typeof body.jobs?.ocr?.queued, "number");
    assert.equal(typeof body.jobs?.blender?.running, "number");
    assert.equal(typeof body.jobs?.blender?.queued, "number");
    assert.equal(typeof body.jobs?.illustrator?.running, "number");
    assert.equal(typeof body.jobs?.illustrator?.queued, "number");
    assert.equal(body.jobs?.illustrator?.agent?.required, false);
    assert.equal(body.jobs?.illustrator?.agent?.ready, true);
    assert.equal(body.jobs?.illustrator?.agent?.mode, "native");
    assert.equal(typeof body.uploads?.active, "number");
    assert.equal(typeof body.uploads?.waiting, "number");
  });

  it("public health does not expose or scan live queue counts", async () => {
    const res = await app.request("/api/health", {
      headers: { host: "www.jianghua.site", "cf-connecting-ip": "203.0.113.10" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      version?: string;
      feishu_notify?: boolean;
      uploads?: unknown;
      jobs?: Record<string, { visibility?: string }>;
    };
    assert.match(String(body.version), /^\d+\.\d+\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(body.jobs || {}), ["illustrator"]);
    assert.equal(body.jobs?.illustrator?.visibility, "authenticated");
    assert.equal("feishu_notify" in body, false);
    assert.equal("uploads" in body, false);
  });

  it("only exposes live health for an unforwarded loopback Host", async () => {
    const cases = [
      { name: "IPv4 loopback", headers: { host: "127.0.0.1:8787" }, live: true },
      { name: "localhost", headers: { host: "localhost:8787" }, live: true },
      { name: "public Host", headers: { host: "www.jianghua.site" }, live: false },
      {
        name: "Cloudflare forwarded loopback",
        headers: { host: "127.0.0.1:8787", "cf-connecting-ip": "203.0.113.10" },
        live: false,
      },
      {
        name: "generic proxy forwarded loopback",
        headers: { host: "localhost:8787", "x-forwarded-for": "203.0.113.11" },
        live: false,
      },
    ] as const;

    for (const row of cases) {
      const res = await app.request("/api/health", { headers: row.headers });
      assert.equal(res.status, 200, row.name);
      const body = (await res.json()) as {
        feishu_notify?: boolean;
        jobs?: {
          ocr?: { running?: number };
          illustrator?: { visibility?: string };
        };
      };
      assert.equal(typeof body.jobs?.ocr?.running === "number", row.live, row.name);
      assert.equal(body.jobs?.illustrator?.visibility, row.live ? undefined : "authenticated", row.name);
      assert.equal("feishu_notify" in body, row.live, row.name);
    }
  });

  it("authenticated status carries the live queue used by sidebar pulses", async () => {
    saveSettings({ FEISHU_ENABLED: "true", FEISHU_OPEN_ID: "ou_status_test" });
    try {
      const denied = await app.request("/api/status");
      assert.equal(denied.status, 401);

      const res = await app.request("/api/status", { headers: authHeader() });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        feishu_notify?: boolean;
        jobs?: {
          ocr?: { running?: number; queued?: number };
          blender?: { running?: number; queued?: number };
          illustrator?: { running?: number; queued?: number };
        };
      };
      assert.equal(typeof body.jobs?.ocr?.running, "number");
      assert.equal(typeof body.jobs?.blender?.queued, "number");
      assert.equal(typeof body.jobs?.illustrator?.running, "number");
      assert.equal(body.feishu_notify, true);
    } finally {
      saveSettings({ FEISHU_ENABLED: "false", FEISHU_OPEN_ID: "" });
    }
  });

  it("upload returns comparing before the worker finishes", async () => {
    setJobsTestHooks({
      runCompare: () => new Promise(() => {
        /* hang until process exit; slot is occupied on purpose */
      }),
    });
    try {
      const fd = new FormData();
      fd.set("excel", new File([Buffer.from([0x50, 0x4b, 0x03, 0x04])], "a.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "a.pdf", { type: "application/pdf" }));
      const upload = await app.request("/api/uploads", { method: "POST", headers: authHeader(), body: fd });
      assert.equal(upload.status, 200);
      const staged = (await upload.json()) as { receipt?: string };
      const started = Date.now();
      const res = await app.request("/api/tasks/start", {
        method: "POST",
        headers: { ...authHeader(), "content-type": "application/json" },
        body: JSON.stringify({
          receipt: staged.receipt,
          product_name: "挂机精华",
          title: "挂机精华",
          pack_surface: "carton",
        }),
      });
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.ok(elapsed < 2000, `upload waited ${elapsed}ms`);
      const body = (await res.json()) as { status?: string; job_status?: string; job_pid?: number };
      assert.equal(body.status, "comparing");
      assert.ok(body.job_status === "queued" || body.job_status === "running");
      assert.equal("job_pid" in body, false);
    } finally {
      resetJobsTestHooks();
    }
  });

  it("rework returns comparing before the worker finishes", async () => {
    setJobsTestHooks({
      runRework: () =>
        new Promise(() => {
          /* hang */
        }),
    });
    try {
      const tid = seed({
        id: "181818181818",
        title: "对红立即",
        product_name: "对红立即",
        type: "excel_pdf",
        status: "completed",
        complete_kind: "rework",
        conclusion: "待设计改稿",
        hits: [hit({ decision: "issue" })],
      });
      const fd = new FormData();
      fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
      const started = Date.now();
      const res = await app.request(`/api/tasks/${tid}/rework`, {
        method: "POST",
        headers: authHeader(),
        body: fd,
      });
      assert.equal(res.status, 200);
      assert.ok(Date.now() - started < 2000, "rework waited");
      const body = (await res.json()) as { status?: string; job_kind?: string; job_status?: string; job_pid?: number };
      assert.equal(body.status, "comparing");
      assert.equal(body.job_kind, "rework");
      assert.ok(body.job_status === "queued" || body.job_status === "running");
      assert.equal("job_pid" in body, false);
      const again = await app.request(`/api/tasks/${tid}/rework`, {
        method: "POST",
        headers: authHeader(),
        body: fd,
      });
      assert.equal(again.status, 409);
    } finally {
      resetJobsTestHooks();
    }
  });

  it("rejects a second rework while the first is still queued", async () => {
    const tid = seed({
      id: "141414141414",
      title: "对红排队",
      product_name: "对红排队",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const { loadTask, saveTask } = await import("./tasks.js");
    const t = loadTask(tid);
    t.job_kind = "rework";
    t.job_status = "queued";
    saveTask(t);
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /对红还在排队或正在跑/);
  });

  it("rejects a rework upload that is not a PDF", async () => {
    const tid = seed({
      id: "151515151515",
      title: "坏稿",
      product_name: "坏稿",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const fd = new FormData();
    fd.set("pdf", new File([Buffer.from("not-a-pdf")], "a.txt", { type: "text/plain" }));
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
      body: fd,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /不是有效的 PDF/);
  });

  it("honors a lower WB_MAX_UPLOAD_MB limit for rework", async () => {
    const { saveSettings } = await import("./settings.js");
    const tid = seed({
      id: "151515151519",
      title: "低上限改稿",
      product_name: "低上限改稿",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    saveSettings({ WB_MAX_UPLOAD_MB: "1" });
    try {
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      bytes.write("%PDF-1.4");
      const fd = new FormData();
      fd.set("pdf", new File([bytes], "large.pdf", { type: "application/pdf" }));
      const res = await app.request(`/api/tasks/${tid}/rework`, {
        method: "POST",
        headers: authHeader(),
        body: fd,
      });
      assert.equal(res.status, 400);
      assert.match(String(((await res.json()) as { detail?: string }).detail || ""), /文件超过 1 MB/);
    } finally {
      saveSettings({ WB_MAX_UPLOAD_MB: "" });
    }
  });

  it("does not resurrect a task deleted while a slow rework body is parsing", async () => {
    const tid = seed({
      id: "151515151520",
      title: "并发删除改稿",
      product_name: "并发删除改稿",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const boundary = "beian-slow-rework";
    const encoder = new TextEncoder();
    let releaseBody!: () => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="slow.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ));
        bodyStarted();
        void new Promise<void>((resolve) => {
          releaseBody = resolve;
        }).then(() => {
          controller.enqueue(encoder.encode("%PDF-1.4\n%slow\r\n"));
          controller.enqueue(encoder.encode(`--${boundary}--\r\n`));
          controller.close();
        });
      },
    });
    const request = new Request(`http://localhost/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const rework = app.request(request);
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const removed = await app.request(`/api/tasks/${tid}`, { method: "DELETE", headers: authHeader() });
    assert.equal(removed.status, 200);
    releaseBody();

    const result = await rework;
    assert.equal(result.status, 404);
    const get = await app.request(`/api/tasks/${tid}`, { headers: authHeader() });
    assert.equal(get.status, 404);
  });

  it("rejects an oversized rework body before parsing it", async () => {
    const { MAX_UPLOAD_BODY_BYTES } = await import("./uploads.js");
    const tid = seed({
      id: "151515151516",
      title: "大改稿",
      product_name: "大改稿",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const boundary = "beian-rework-over-limit";
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(MAX_UPLOAD_BODY_BYTES + 1),
      },
      body: `--${boundary}--\r\n`,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { detail: "上传总量超过 100 MB" });
  });

  it("a reviewer cannot re-upload another reviewer's failed rework: 403, nothing queued, no new artwork", async () => {
    const tid = seed({
      id: "dbdbdbdbdbdb",
      title: "别人的复核失败",
      product_name: "别人的复核失败",
      type: "excel_pdf",
      status: "pending_review",
      job_kind: "rework",
      job_status: "failed",
      hits: [hit({ decision: "confirm" })],
    });
    const other = issueSessionForTest("路人", "reviewer", "ou_rework_failed_other");
    const fd = new FormData();
    fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}` },
      body: fd,
    });
    assert.equal(res.status, 403);
    const after = loadTask(tid);
    assert.equal(after.status, "pending_review");
    assert.equal(after.job_kind, "rework");
    assert.equal(after.job_status, "failed");
    assert.equal(existsSync(join(process.env.WB_DATA_DIR as string, "uploads", tid, "artwork_v2.pdf")), false);
  });

  it("checks rework ownership before accepting or sizing the request body", async () => {
    const { MAX_UPLOAD_BODY_BYTES } = await import("./uploads.js");
    const tid = seed({
      id: "151515151517",
      title: "别人的改稿",
      product_name: "别人的改稿",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const other = issueSessionForTest("路人", "reviewer", "ou_rework_body_other");
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${other.token}`,
        "content-type": "multipart/form-data; boundary=foreign-large-body",
        "content-length": String(MAX_UPLOAD_BODY_BYTES + 1),
      },
      body: "--foreign-large-body--\r\n",
    });
    assert.equal(res.status, 403);
  });
});

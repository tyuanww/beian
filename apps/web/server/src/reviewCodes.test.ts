import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HIT_STATUS_CODES,
  JOB_ERROR_CODES,
  REVIEW_CODES,
  REVIEW_CODE_STATUS,
  REVIEW_CODE_TEXT,
  hitStatusCode,
  pendingDetail,
  reviewDetail,
} from "./reviewCodes.js";
import { ReviewProblem, reviewProblemBody } from "./reviewProblem.js";
import { makeTestTempDir } from "./testTemp.js";

process.env.WB_DATA_DIR = makeTestTempDir("beian-review-codes-");
const { VERBATIM_STATUSES } = await import("./tasks.js");

const CODE_RE = /^[a-z][a-z0-9_]*$/;

describe("审稿接口码表 reviewCodes.ts", () => {
  it("码全部合规：小写 ASCII + 下划线，≤ 40 字符，返回体码带接口域，任务字段码不带", () => {
    for (const code of [...REVIEW_CODES, ...JOB_ERROR_CODES]) {
      assert.match(code, CODE_RE, code);
      assert.ok(code.length <= 40, code);
    }
    for (const code of REVIEW_CODES) assert.match(code, /^(complete|decision|rework)_/, code);
    for (const code of JOB_ERROR_CODES) assert.doesNotMatch(code, /^(complete|decision|rework|page_view)_/, code);
  });

  it("任务字段码：超页 + 三个作业失败码（加码 Q3）", () => {
    assert.deepEqual([...JOB_ERROR_CODES], ["page_over", "ocr_failed", "result_truncated", "private_data_failed"]);
  });

  it("码唯一，返回体码和任务字段码不重名", () => {
    const all = [...REVIEW_CODES, ...JOB_ERROR_CODES];
    assert.equal(new Set(all).size, all.length);
  });

  it("每个返回体码都登记了状态码和原文（null = 原文由调用处给）", () => {
    assert.deepEqual(Object.keys(REVIEW_CODE_STATUS).sort(), [...REVIEW_CODES].sort());
    assert.deepEqual(Object.keys(REVIEW_CODE_TEXT).sort(), [...REVIEW_CODES].sort());
    const dynamic = REVIEW_CODES.filter((code) => REVIEW_CODE_TEXT[code] === null);
    assert.deepEqual(dynamic, ["rework_pdf_too_large", "rework_verbatim_not_ready"]);
  });

  it("原文与加码前逐字相同", () => {
    assert.equal(reviewDetail("complete_job_running"), "对照还在排队或正在跑，不能签字");
    assert.equal(reviewDetail("complete_status_not_reviewable"), "当前状态不可签字");
    assert.equal(reviewDetail("complete_rework_failed"), "当前状态不可签字");
    assert.equal(reviewDetail("complete_hits_invalid", { count: 2 }), "有 2 条审核数据状态异常，请重新对照");
    assert.equal(reviewDetail("complete_order_held_unconfirmed", { count: 1 }), "整单待人工确认，签字即认可");
    assert.equal(reviewDetail("complete_conclusion_missing"), "请写下结论");
    assert.equal(reviewDetail("decision_held_confirm_forbidden"), "待人工确认不能选一致");
    assert.equal(reviewDetail("rework_status_not_allowed"), "当前状态不可对红");
    assert.equal(reviewDetail("rework_pdf_too_large"), null);
  });

  it("按状态分开数的原文：词序按 items 顺序，「、」连接", () => {
    assert.equal(
      pendingDetail([
        { kind: "held", count: 2 },
        { kind: "reading_doubt", count: 1 },
      ]),
      "仍有 2 条待人工确认、1 条认字存疑未处理",
    );
    assert.equal(
      reviewDetail("complete_hits_pending", {
        items: [
          { kind: "status", status: "suspect", count: 2 },
          { kind: "status", status: "field_missing", count: 1 },
        ],
      }),
      "仍有 2 条疑点、1 条缺失未处理",
    );
  });

  it("状态英文枚举防漂移：中文一侧正好是真错 ∪ {疑点、缺失} ∪ 空格类", () => {
    const want = new Set([...VERBATIM_STATUSES.true_errors, "疑点", "缺失", ...VERBATIM_STATUSES.space_errors]);
    assert.deepEqual(new Set(Object.values(HIT_STATUS_CODES)), want);
    assert.equal(Object.values(HIT_STATUS_CODES).length, want.size);
    assert.equal(hitStatusCode("缺失"), "field_missing");
    assert.equal(hitStatusCode("缺空格"), "missing_space");
    assert.equal(hitStatusCode("一致"), undefined);
    for (const code of Object.keys(HIT_STATUS_CODES)) assert.match(code, CODE_RE, code);
  });
});

describe("ReviewProblem 返回体", () => {
  it("状态码和原文从码表取，params 原样带出", () => {
    const err = new ReviewProblem("complete_hits_invalid", { count: 3 });
    assert.equal(err.status, 400);
    assert.deepEqual(reviewProblemBody(err), {
      detail: "有 3 条审核数据状态异常，请重新对照",
      code: "complete_hits_invalid",
      params: { count: 3 },
    });
    const running = new ReviewProblem("rework_job_running");
    assert.equal(running.status, 409);
    assert.deepEqual(reviewProblemBody(running), { detail: "对红还在排队或正在跑", code: "rework_job_running" });
    assert.equal(new ReviewProblem("decision_hit_not_found").status, 404);
  });

  it("原文由调用处给的码必须传 detail", () => {
    assert.throws(() => new ReviewProblem("rework_pdf_too_large"));
    assert.equal(new ReviewProblem("rework_pdf_too_large", undefined, "单个文件超过 100 MB").message, "单个文件超过 100 MB");
  });
});

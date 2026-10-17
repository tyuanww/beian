import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SIGN_RETURN_RULES, signReturnHitExtras, type SignReturnInput } from "../../../server/src/signReturnRules.ts";
import type { TaskDetail } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import { reviewGate, reviewPageHits } from "./reviewActions";

/**
 * 前后端合同：签字灰态旁 / 悬停的「仍有 N 条…未处理」与服务端 `/complete` 拦截（`completeGate.ts`）逐字一致。
 * 同一份条目（规则表 `signReturnRules.ts` 的 hit 写法，经 `signReturnHitExtras` 落成同样的字段）同时喂给
 * 核对页 `reviewGate` 和服务端 `completeGate`：前端有待确认时，提示、签字悬停都必须等于服务端 400 的那句。
 * 服务端行为不在这里改；服务端自己的断言在 `apps/web/server/src/signReturnRules.test.ts`。
 */

// 服务端 tasks / config 读 DATA_DIR；这里只调纯函数 completeGate，不落盘。
const dataDir = mkdtempSync(join(tmpdir(), "beian-ui-sign-copy-"));
process.once("exit", () => rmSync(dataDir, { recursive: true, force: true }));
process.env.WB_DATA_DIR = dataDir;
const { completeGate } = await import("../../../server/src/completeGate.ts");

type Hits = SignReturnInput["hits"];

function taskFor(input: SignReturnInput) {
  return {
    id: "e5969b58cd92",
    title: "拦截文案合成单",
    status: input.status,
    ...(input.job ? { job_kind: input.job.kind, job_status: input.job.status } : {}),
    ...(input.verbatimCheck ? { verbatim_check: true } : {}),
    ...(input.verbatimWarning ? { verbatim_warning: "稿件未保留 Illustrator 编辑数据" } : {}),
    hits: input.hits.map((hit, i) => ({
      id: `h${i}`,
      field: hit.field ?? "中文品名",
      status: hit.status,
      ...(hit.decision === undefined ? {} : { decision: hit.decision }),
      ...signReturnHitExtras(hit),
    })),
  };
}

function bothSides(input: SignReturnInput): { ui: { hint: string; title: string; pending: number }; server: string | null } {
  const task = taskFor(input);
  const ui = reviewGate(task as TaskDetail, reviewPageHits(task as TaskDetail, false), false);
  const gate = completeGate(task as Parameters<typeof completeGate>[0], undefined);
  return { ui: { hint: ui.hint, title: ui.title, pending: ui.pending }, server: gate.ok ? null : gate.message };
}

const reviewer = (hits: Hits, extra: Partial<SignReturnInput> = {}): SignReturnInput => ({ role: "reviewer", status: "in_review", hits, ...extra });

/** 拦截文案用例：同一份条目，两边都要得到 `text`。 */
const COPY_CASES: ReadonlyArray<{ name: string; input: SignReturnInput; text: string }> = [
  { name: "只有待人工确认（非逐字单）", input: reviewer([{ status: "待人工确认" }, { status: "待人工确认", decision: "pending" }]), text: "仍有 2 条待人工确认未处理" },
  { name: "只有认字存疑（状态本是一致）", input: reviewer([{ status: "一致", coverageMiss: ["CAPSULE MIST"] }]), text: "仍有 1 条认字存疑未处理" },
  { name: "缺空格没标 pending、只因认字存疑", input: reviewer([{ status: "缺空格", onlyInExcel: ["香柠檬"] }]), text: "仍有 1 条认字存疑未处理" },
  { name: "缺空格带 doubt_bucket", input: reviewer([{ status: "缺空格", doubtBucket: "ocr_graphic" }]), text: "仍有 1 条认字存疑未处理" },
  {
    name: "待人工确认 + 认字存疑：分开数，按首次出现",
    input: reviewer([{ status: "待人工确认" }, { status: "一致", coverageMiss: ["CAPSULE MIST"] }, { status: "待人工确认" }]),
    text: "仍有 2 条待人工确认、1 条认字存疑未处理",
  },
  {
    name: "认字存疑在前：词序跟着变",
    input: reviewer([{ status: "一致", coverageMiss: ["CAPSULE MIST"] }, { status: "待人工确认" }, { status: "待人工确认" }]),
    text: "仍有 1 条认字存疑、2 条待人工确认未处理",
  },
  { name: "疑点 + 缺失", input: reviewer([{ status: "疑点", decision: "pending" }, { status: "缺失" }, { status: "疑点" }]), text: "仍有 2 条疑点、1 条缺失未处理" },
  { name: "疑点带 coverage.miss 仍写疑点", input: reviewer([{ status: "疑点", coverageMiss: ["x"] }]), text: "仍有 1 条疑点未处理" },
  { name: "多空格标 pending", input: reviewer([{ status: "多空格", decision: "pending" }]), text: "仍有 1 条多空格未处理" },
  {
    name: "真错 + 待人工确认 + 认字存疑 + 缺失",
    input: reviewer([{ status: "错字" }, { status: "待人工确认" }, { status: "一致", coverageMiss: ["x"] }, { status: "缺失" }, { status: "错字", decision: "pending" }]),
    text: "仍有 2 条错字、1 条待人工确认、1 条认字存疑、1 条缺失未处理",
  },
  {
    name: "已下结论的、工艺表的不计",
    input: reviewer([
      { status: "待人工确认", decision: "ignore" },
      { status: "一致", coverageMiss: ["x"], decision: "confirm" },
      { field: "工艺说明", status: "疑点" },
      { status: "一致", coverageMiss: ["x"] },
    ]),
    text: "仍有 1 条认字存疑未处理",
  },
  {
    name: "逐字单：待人工确认不计入，只剩认字存疑",
    input: reviewer([{ status: "待人工确认" }, { status: "缺空格", onlyInExcel: ["香柠檬"] }], { verbatimCheck: true }),
    text: "仍有 1 条认字存疑未处理",
  },
];

/**
 * 规则表里两边都拦、但拦截文案不同的行（不在本批改）：
 * - decision 是非法值：服务端 `isValidHitReviewState` 判为「有 1 条审核数据状态异常，请重新对照」；
 *   前端 `hasInvalidHitStatus` 只看状态，按待确认写「仍有 1 条疑点未处理」（按钮规则表里本来就是「待确认」）。
 */
const KNOWN_COPY_GAPS = new Set(["decision 是非法值：按待确认挡住"]);

describe("签字拦截文案前后端合同（「仍有 N 条…未处理」）", () => {
  for (const row of COPY_CASES) {
    it(row.name, () => {
      const { ui, server } = bothSides(row.input);
      assert.equal(server, row.text, "服务端 /complete");
      assert.equal(ui.hint, row.text, "前端签字旁提示");
      assert.equal(ui.title, row.text, "前端签字悬停");
    });
  }

  it("用例覆盖到只有一类和多类、认字存疑、待人工确认", () => {
    const texts = COPY_CASES.map((row) => row.text);
    assert.ok(texts.some((t) => !t.includes("、")) && texts.some((t) => t.includes("、")));
    assert.ok(texts.some((t) => t.includes(REVIEW_COPY.readingDoubtWord)) && texts.some((t) => t.includes("待人工确认")));
  });

  // 规则表里所有「前端有待确认」的行（前端写了「仍有…」提示）：提示必须等于服务端拦截原文。
  const pendingRows = SIGN_RETURN_RULES.filter((row) => {
    const { ui } = bothSides(row.input);
    return ui.pending > 0 && ui.hint !== "" && ui.hint !== REVIEW_COPY.invalidHitStatus;
  });
  it("规则表里有前端待确认的行", () => assert.ok(pendingRows.length >= 5, String(pendingRows.length)));
  for (const row of pendingRows) {
    it(`规则表：${row.name}`, () => {
      const { ui, server } = bothSides(row.input);
      if (KNOWN_COPY_GAPS.has(row.name)) {
        // 锁现状：两边都拦，但文案不同。哪天对齐了这里变红，把行从 KNOWN_COPY_GAPS 去掉。
        assert.notEqual(ui.hint, server, `${row.name}：已对齐，请从 KNOWN_COPY_GAPS 去掉`);
        return;
      }
      assert.equal(ui.hint, server);
      assert.equal(ui.title, server);
    });
  }
});

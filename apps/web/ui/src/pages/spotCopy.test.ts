import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FieldHit } from "../api";
import { REVIEW_COPY } from "../copy/labels";
import {
  markedSlices,
  spanOmitReason,
  spotColumns,
  spotHeaderText,
  spotTitleParts,
  spotLocus,
  spotNavTarget,
  spotPendingEmptyLine,
} from "./spotCopy.js";

function hit(partial: FieldHit): FieldHit {
  return partial;
}

describe("spotColumns", () => {
  it("titles Excel标准 only for one non-empty row", () => {
    const columns = spotColumns(hit({
      status: "错字",
      manuscript: "甲乙丙",
      excel_standard: "甲丁丙",
      excel_row_count: 1,
      pdf_span: [1, 2],
      excel_span: [1, 2],
    }));
    assert.equal(columns.left.title, REVIEW_COPY.manuscriptRead);
    assert.equal(columns.left.sentence, "甲乙丙");
    assert.deepEqual(columns.left.span, [1, 2]);
    assert.equal(columns.right.title, REVIEW_COPY.excelStandard);
    assert.equal(columns.right.sentence, "甲丁丙");
    assert.deepEqual(columns.right.notes, []);
  });

  it("keeps a single space as the Excel sentence", () => {
    const columns = spotColumns(hit({
      status: "多空格",
      manuscript: "甲乙",
      excel_standard: " ",
      excel_row_count: 1,
    }));
    assert.equal(columns.right.title, REVIEW_COPY.excelStandard);
    assert.equal(columns.right.sentence, " ");
  });

  it("does not title an empty sentence", () => {
    const columns = spotColumns(hit({
      status: "错字",
      manuscript: "甲乙",
      excel_standard: "",
      excel_row_count: 1,
      excel_value: "乙",
    }));
    assert.equal(columns.right.title, REVIEW_COPY.diffFragment);
    assert.equal(columns.right.body, "乙");
    assert.equal(columns.right.sentence, "");
    assert.deepEqual(columns.right.notes, [REVIEW_COPY.notFullSentence]);
  });

  it("refuses to stitch several rows into one sentence", () => {
    const columns = spotColumns(hit({
      status: "错字",
      manuscript: "甲乙丙",
      excel_standard: "不该拼上",
      excel_row_count: 2,
    }));
    assert.equal(columns.right.title, "");
    assert.equal(columns.right.body, REVIEW_COPY.multiRows);
    assert.equal(columns.right.sentence, "");
  });

  it("says the confirmation sheet has no such passage", () => {
    const columns = spotColumns(hit({
      status: "稿件有但确认单没有",
      manuscript: "甲乙丙",
      excel_standard: "不该题标准",
      excel_row_count: 1,
    }));
    assert.equal(columns.right.title, "");
    assert.equal(columns.right.body, REVIEW_COPY.excelMissing);
    assert.equal(columns.left.title, REVIEW_COPY.manuscriptRead);
  });

  it("labels an old hit as a fragment, not a sentence", () => {
    const columns = spotColumns(hit({ status: "错字", pdf: "AB", excel_value: "AC" }));
    assert.equal(columns.left.title, REVIEW_COPY.manuscriptFragment);
    assert.equal(columns.left.body, "AB");
    assert.equal(columns.left.sentence, "");
    assert.deepEqual(columns.left.notes, [REVIEW_COPY.notFullParagraph]);
    assert.equal(columns.right.title, REVIEW_COPY.diffFragment);
    assert.equal(columns.right.body, "AC");
    assert.deepEqual(columns.right.notes, [REVIEW_COPY.notFullSentence, REVIEW_COPY.oldNoSentence]);
  });

  it("does not call an empty manuscript an old result", () => {
    const columns = spotColumns(hit({
      status: "错字",
      manuscript: "",
      excel_row_count: 0,
      excel_value: "丙",
      pdf_span_omit: "unmatched",
    }));
    assert.equal(columns.left.title, REVIEW_COPY.manuscriptRead);
    assert.equal(columns.left.sentence, "");
    assert.equal(spanOmitReason(columns.left), null);
    assert.deepEqual(columns.right.notes, [REVIEW_COPY.notFullSentence]);
  });
});

describe("spanOmitReason", () => {
  it("explains a duplicate only when the sentence is shown and unmarked", () => {
    assert.equal(spanOmitReason({ sentence: "甲乙丙", span: null, omit: "duplicate" }), REVIEW_COPY.spanDuplicate);
    assert.equal(spanOmitReason({ sentence: "甲乙丙", span: null, omit: "unmatched" }), REVIEW_COPY.spanUnmatched);
    assert.equal(spanOmitReason({ sentence: "甲乙丙", span: [0, 1], omit: "duplicate" }), null);
    assert.equal(spanOmitReason({ sentence: "", span: null, omit: "unmatched" }), null);
  });
});

describe("spotHeaderText", () => {
  it("adds the Excel item when the hit has one", () => {
    assert.equal(spotHeaderText("错字", "品名", "待确认", "2/5"), "错字 · 品名 · 待确认 2/5");
    assert.equal(spotHeaderText("错字", "  ", "全部", "1/1"), "错字 · 全部 1/1");
  });
});

describe("spotNavTarget", () => {
  it("stops at the ends of the current pool", () => {
    assert.equal(spotNavTarget([0, 2, 4], 2, 1), 4);
    assert.equal(spotNavTarget([0, 2, 4], 2, -1), 0);
    assert.equal(spotNavTarget([0, 2, 4], 4, 1), null);
    assert.equal(spotNavTarget([0, 2, 4], 0, -1), null);
    assert.equal(spotNavTarget([0, 2, 4], 3, 1), null);
  });
});

describe("spotPendingEmptyLine", () => {
  it("shows only after the pending pool is empty and this hit has a verdict", () => {
    assert.equal(spotPendingEmptyLine(0, "confirm"), true);
    assert.equal(spotPendingEmptyLine(0, "issue"), true);
    assert.equal(spotPendingEmptyLine(0, "ignore"), true);
    assert.equal(spotPendingEmptyLine(1, "confirm"), false);
    assert.equal(spotPendingEmptyLine(0, "pending"), false);
    assert.equal(spotPendingEmptyLine(0, null), false);
  });
});

describe("spotLocus", () => {
  it("points at the missing character between the two readings", () => {
    const locus = spotLocus(hit({
      status: "漏字",
      manuscript: "角鲨烷其他微量",
      excel_standard: "角鲨烷、其他微量",
      excel_row_count: 1,
      excel_span: [3, 4],
      excel_value: "、",
    }));
    assert.equal(locus?.kind, "miss");
    assert.equal(locus?.title, REVIEW_COPY.missHere);
    assert.equal(locus?.detail, "少了「、」");
    assert.equal(locus?.standard?.mark, "、");
    assert.equal(locus?.standard?.before, "角鲨烷");
    assert.equal(locus?.manuscript?.gap, true);
    assert.equal(locus?.manuscript?.before, "角鲨烷");
    assert.equal(locus?.manuscript?.after, "其他微量");
  });

  it("points at the extra characters on the manuscript", () => {
    const locus = spotLocus(hit({
      status: "多字",
      manuscript: "角鲨烷、其他微量",
      excel_standard: "角鲨烷其他微量",
      excel_row_count: 1,
      pdf_span: [3, 4],
      pdf: "、",
    }));
    assert.equal(locus?.kind, "extra");
    assert.equal(locus?.detail, "多了「、」");
    assert.equal(locus?.manuscript?.mark, "、");
    assert.equal(locus?.manuscript?.gap, false);
    assert.equal(locus?.standard?.gap, true);
    assert.equal(locus?.standard?.before, "角鲨烷");
    assert.equal(locus?.standard?.after, "其他微量");
  });

  it("shrinks a long span to the first absent run", () => {
    const excel = "角鲨烷其他微量成分：糖类同分异构体、长茎葡萄藻还有很多后面的字";
    const manuscript = "角鲨烷其他微量成分：糖类同分异构体长茎葡萄藻还有很多后面的字";
    const locus = spotLocus(hit({
      status: "漏字",
      manuscript,
      excel_standard: excel,
      excel_row_count: 1,
      excel_span: [0, Array.from(excel).length],
      excel_value: excel,
    }));
    assert.equal(locus?.detail, "少了「、」");
    assert.equal(locus?.standard?.mark, "、");
    assert.equal(locus?.manuscript?.gap, true);
  });

  it("不把缺口标到更早的同一段上", () => {
    const excel = "同词、同词、尾";
    const locus = spotLocus(hit({
      status: "漏字",
      manuscript: "同词同词尾",
      excel_standard: excel,
      excel_row_count: 1,
      excel_span: [5, 6],
      excel_value: "、",
    }));
    assert.equal(locus?.standard?.mark, "、");
    assert.equal(locus?.standard?.before.endsWith("同词"), true);
    assert.equal(locus?.manuscript, null);
  });

  it("stays quiet for other statuses", () => {
    assert.equal(spotLocus(hit({ status: "错字", manuscript: "甲", excel_standard: "乙", excel_row_count: 1 })), null);
    assert.equal(spotLocus(hit({ status: "漏字" })), null);
  });
});

describe("markedSlices", () => {
  it("keeps a raw less-than inside the marked slice", () => {
    assert.deepEqual(markedSlices("a<b>c", [1, 4]), [
      { text: "a", mark: false },
      { text: "<b>", mark: true },
      { text: "c", mark: false },
    ]);
  });

  it("marks a supplementary-plane character by code point", () => {
    const sentence = "甲𠀀丙";
    assert.equal(sentence.length, 4);
    assert.deepEqual(markedSlices(sentence, [1, 2]), [
      { text: "甲", mark: false },
      { text: "𠀀", mark: true },
      { text: "丙", mark: false },
    ]);
  });
});

describe("spotTitleParts", () => {
  it("puts the field name first", () => {
    const parts = spotTitleParts("中文品名", "疑点", undefined, "待确认", "1/3");
    assert.equal(parts.field, "中文品名");
    assert.equal(parts.rest, "疑点 · 待确认 1/3");
    assert.equal(parts.full, "中文品名 · 疑点 · 待确认 1/3");
  });
  it("keeps a distinct Excel item and drops a duplicate one", () => {
    assert.equal(spotTitleParts("品名", "错字", "品名", "待确认", "2/5").full, "品名 · 错字 · 待确认 2/5");
    assert.equal(spotTitleParts("文案", "错字", "功效", "全部", "1/1").full, "文案 · 错字 · 功效 · 全部 1/1");
  });
  it("falls back without a field name", () => {
    assert.deepEqual(spotTitleParts("  ", "疑点", undefined, "全部", "1/1"), { field: "", rest: "疑点 · 全部 1/1", full: "疑点 · 全部 1/1" });
  });
});

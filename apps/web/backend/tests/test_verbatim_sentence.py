"""合成命中：整句、跨度、行号回查、加宽前合并。不跑 OCR，不打印真实稿句。"""
from __future__ import annotations

from app.verbatim_check import _hit, _mark_warning_hit, _span_in_sentence, assemble_hits

MATRIX = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
PAGE = (1000, 1000)
ROWS = [
    {"row": 2, "item": "合成甲", "text": "不要用下标取这句"},
    {"row": 15, "item": "合成乙", "text": "甲，乙丙"},
]


def _op(kind: str, got: str, exp: str, box: list[float], verdict: str = "confirmed") -> dict:
    return {
        "type": kind,
        "got": got,
        "exp": exp,
        "verdict": verdict,
        "box": box,
        "p": 0.99,
        "ctx": ("甲" * 30, "乙" * 30),
        "exp_ctx": ("丙" * 30, "丁" * 30),
    }


def _piece(manuscript: str, row_ids: list[int], ops: list[dict], bbox: list[float] | None = None) -> dict:
    return {
        "manuscript": manuscript,
        "bbox": [0, 0, 80, 40] if bbox is None else bbox,
        "row_ids": row_ids,
        "ops": ops,
    }


def test_worksheet_row_skips_list_index() -> None:
    hits = assemble_hits(
        [_piece("甲，乙丙", [15], [_op("错字", "甲乙", "甲乙", [10, 10, 20, 20])])],
        ROWS,
        MATRIX,
        PAGE,
    )
    assert len(hits) == 1
    hit = hits[0]
    assert hit["item"] == "合成乙"
    assert hit["excel_standard"] == "甲，乙丙"
    assert hit["excel_row_count"] == 1
    assert hit["manuscript"] == "甲，乙丙"
    assert hit["excel_standard"] != ROWS[0]["text"]
    assert len(hit["evidence"]) <= 80
    roles = [box["role"] for box in hit["bboxes"]]
    assert roles == ["range", "hit"]
    assert hit["bboxes"][0]["width"] == 80
    assert hit["field"] == "错字"
    assert hit["status"] == "错字"
    assert hit["decision"] == "pending"
    assert hit["excel_value"] == "甲乙"
    assert hit["pdf"] == "甲乙"
    assert hit["page"] == 1


def test_unique_fragment_keeps_punctuation_inside_span() -> None:
    pdf_span, pdf_omit = _span_in_sentence("甲，乙丙", "甲乙", drop_space=False)
    excel_span, excel_omit = _span_in_sentence("甲，乙丙", "甲乙", drop_space=True)
    assert pdf_span == [0, 3]
    assert excel_span == [0, 3]
    assert pdf_omit is None and excel_omit is None
    hits = assemble_hits(
        [_piece("甲，乙丙", [15], [_op("错字", "甲乙", "甲乙", [10, 10, 20, 20])])],
        ROWS,
        MATRIX,
        PAGE,
    )
    assert hits[0]["pdf_span"] == [0, 3]
    assert hits[0]["excel_span"] == [0, 3]
    assert "pdf_span_omit" not in hits[0]
    assert "excel_span_omit" not in hits[0]


def test_repeated_fragment_omits_span() -> None:
    hits = assemble_hits(
        [_piece("甲乙甲乙", [15], [_op("错字", "甲乙", "甲乙", [10, 10, 20, 20])])],
        [{"row": 15, "item": "合成乙", "text": "甲乙甲乙"}],
        MATRIX,
        PAGE,
    )
    hit = hits[0]
    assert "pdf_span" not in hit
    assert "excel_span" not in hit
    assert hit["pdf_span_omit"] == "duplicate"
    assert hit["excel_span_omit"] == "duplicate"


def test_empty_needle_is_unmatched_without_search() -> None:
    span, omit = _span_in_sentence("甲乙丙", "", drop_space=False)
    assert span is None
    assert omit == "unmatched"
    hits = assemble_hits(
        [_piece("甲乙丙", [15], [_op("漏字", "", "乙", [10, 10, 18, 20])])],
        [{"row": 15, "item": "合成乙", "text": "甲乙丙"}],
        MATRIX,
        PAGE,
    )
    assert hits[0]["pdf_span_omit"] == "unmatched"
    assert "pdf_span" not in hits[0]


def test_space_error_writes_neither_span_nor_omit() -> None:
    hits = assemble_hits(
        [_piece("甲乙", [15], [_op("多空格", " ", " ", [10, 10, 14, 20], verdict="confirmed")])],
        [{"row": 15, "item": "合成乙", "text": "甲 乙"}],
        MATRIX,
        PAGE,
    )
    hit = hits[0]
    assert hit["status"] == "多空格"
    assert "pdf_span" not in hit
    assert "excel_span" not in hit
    assert "pdf_span_omit" not in hit
    assert "excel_span_omit" not in hit


def test_unconfirmed_space_does_not_widen_or_explain_span() -> None:
    hits = assemble_hits(
        [_piece("甲乙", [15], [_op("多空格", " ", "", [10, 10, 14, 20], verdict="review")])],
        [{"row": 15, "item": "合成乙", "text": "甲乙"}],
        MATRIX,
        PAGE,
    )
    hit = hits[0]
    assert hit["status"] == "待人工确认"
    assert hit["decision"] is None
    assert hit["bboxes"][-1]["left"] == 10
    assert hit["bboxes"][-1]["width"] == 4
    assert "pdf_span_omit" not in hit
    assert "excel_span_omit" not in hit


def test_zero_rows_missing_from_excel_does_not_invent_standard() -> None:
    hits = assemble_hits(
        [_piece("甲乙丙", [], [_op("片段无对应", "甲乙丙", "甲乙丙", [10, 10, 40, 20], verdict="nomatch")])],
        ROWS,
        MATRIX,
        PAGE,
    )
    hit = hits[0]
    assert hit["status"] == "稿件有但确认单没有"
    assert hit["excel_standard"] == ""
    assert hit["excel_row_count"] == 0
    assert "item" not in hit
    assert "manuscript" in hit


def test_many_rows_stay_empty() -> None:
    hits = assemble_hits(
        [_piece("甲乙", [2, 15], [_op("错字", "甲", "乙", [10, 10, 20, 20])])],
        ROWS,
        MATRIX,
        PAGE,
    )
    hit = hits[0]
    assert hit["excel_standard"] == ""
    assert hit["excel_row_count"] == 2
    assert "item" not in hit
    assert "不要用下标" not in hit["excel_standard"]
    assert "甲，乙丙" not in hit["excel_standard"]


def test_empty_excel_text_is_not_a_standard_sentence() -> None:
    hits = assemble_hits(
        [_piece("甲乙", [15], [_op("错字", "甲", "乙", [10, 10, 20, 20])])],
        [{"row": 15, "item": "合成乙", "text": ""}],
        MATRIX,
        PAGE,
    )
    assert hits[0]["excel_row_count"] == 1
    assert hits[0]["excel_standard"] == ""
    assert hits[0]["item"] == "合成乙"


def test_positive_area_merges_and_keeps_first_status() -> None:
    hits = assemble_hits(
        [_piece("甲乙", [15], [
            _op("错字", "甲乙", "甲乙", [0, 0, 10, 10]),
            _op("错字", "甲乙", "甲乙", [4, 4, 14, 14]),
        ])],
        [{"row": 15, "item": "合成乙", "text": "甲乙丙"}],
        MATRIX,
        PAGE,
    )
    assert len(hits) == 1
    hit = hits[0]
    assert hit["status"] == "错字"
    assert hit["decision"] == "pending"
    assert hit["field"] == "错字"
    hit_boxes = [box for box in hit["bboxes"] if box["role"] == "hit"]
    assert len(hit_boxes) == 1
    assert hit_boxes[0]["left"] == 0
    assert hit_boxes[0]["width"] == 10


def test_edge_touch_does_not_merge() -> None:
    hits = assemble_hits(
        [_piece("甲乙", [15], [
            _op("错字", "甲乙", "甲乙", [0, 0, 10, 10]),
            _op("错字", "甲乙", "甲乙", [10, 0, 20, 10]),
        ])],
        [{"row": 15, "item": "合成乙", "text": "甲乙丙"}],
        MATRIX,
        PAGE,
    )
    assert len(hits) == 2


def test_gap_that_widening_would_close_stays_two_hits() -> None:
    hits = assemble_hits(
        [_piece("甲乙", [15], [
            _op("多空格", " ", " ", [0, 0, 10, 10]),
            _op("多空格", " ", " ", [12, 0, 22, 10]),
        ])],
        [{"row": 15, "item": "合成乙", "text": "甲乙"}],
        MATRIX,
        PAGE,
    )
    assert len(hits) == 2
    assert all(hit["status"] == "多空格" for hit in hits)


def test_overlap_without_one_row_does_not_merge() -> None:
    hits = assemble_hits(
        [
            _piece("甲乙", [], [_op("错字", "甲乙", "甲乙", [0, 0, 10, 10])]),
            _piece("甲乙", [2, 15], [_op("错字", "甲乙", "甲乙", [4, 4, 14, 14])]),
        ],
        ROWS,
        MATRIX,
        PAGE,
    )
    assert len(hits) == 2


def test_different_rows_do_not_merge() -> None:
    hits = assemble_hits(
        [
            _piece("甲乙", [2], [_op("错字", "甲乙", "甲乙", [0, 0, 10, 10])]),
            _piece("甲乙", [15], [_op("错字", "甲乙", "甲乙", [4, 4, 14, 14])]),
        ],
        ROWS,
        MATRIX,
        PAGE,
    )
    assert len(hits) == 2


def test_excel_span_crosses_spaces_pdf_span_does_not() -> None:
    # Value: protects=Excel span maps through spaces while the PDF span does not, and a punctuation-only needle stays unmatched; fails_when=drop_space flags are swapped or a punct-only needle is searched; why_new=the punctuation fixture has no spaces, so both flags return the same span; seam=none; no_claim=no OCR and no browser highlight
    pdf_span, pdf_omit = _span_in_sentence("甲 乙丙", "甲乙", drop_space=False)
    excel_span, excel_omit = _span_in_sentence("甲 乙丙", "甲乙", drop_space=True)
    assert pdf_span is None and pdf_omit == "unmatched"
    assert excel_span == [0, 3] and excel_omit is None
    punct_span, punct_omit = _span_in_sentence("甲，乙", "，", drop_space=False)
    assert punct_span is None and punct_omit == "unmatched"
    hits = assemble_hits(
        [_piece("甲 乙丙", [15], [_op("错字", "甲乙", "甲乙", [10, 10, 20, 20])])],
        [{"row": 15, "item": "合成乙", "text": "甲 乙丙"}],
        MATRIX,
        PAGE,
    )
    hit = hits[0]
    assert "pdf_span" not in hit
    assert hit["pdf_span_omit"] == "unmatched"
    assert hit["excel_span"] == [0, 3]
    assert "excel_span_omit" not in hit


def test_bool_and_repeated_row_ids_stay_one_worksheet_row() -> None:
    # Value: protects=bool row ids are dropped and a repeated worksheet row stays one sentence; fails_when=True is kept as row 1 or [15, 15] is treated as two rows; why_new=existing fixtures use distinct real ints, so the bool filter and dedupe never run; seam=none; no_claim=no Excel file is opened
    hits = assemble_hits(
        [_piece("甲，乙丙", [True, 15, 15], [_op("错字", "甲乙", "甲乙", [10, 10, 20, 20])])],
        ROWS,
        MATRIX,
        PAGE,
    )
    hit = hits[0]
    assert hit["excel_row_count"] == 1
    assert hit["excel_standard"] == "甲，乙丙"
    assert hit["item"] == "合成乙"
    assert hit["excel_standard"] != ROWS[0]["text"]


def test_missing_worksheet_row_does_not_borrow_another_sentence() -> None:
    # Value: protects=one unmatched worksheet row stays count 1 with an empty standard; fails_when=the lookup falls back to another row or reports zero rows; why_new=existing tests only cover a found row, zero ids, or several ids; seam=none; no_claim=no list-index fallback is implied to be safe
    hits = assemble_hits(
        [_piece("甲乙", [99], [_op("错字", "甲", "乙", [10, 10, 20, 20])])],
        ROWS,
        MATRIX,
        PAGE,
    )
    hit = hits[0]
    assert hit["excel_row_count"] == 1
    assert hit["excel_standard"] == ""
    assert "item" not in hit
    assert ROWS[0]["text"] not in hit["excel_standard"]
    assert ROWS[1]["text"] not in hit["excel_standard"]


def test_overlap_merges_only_the_same_reading() -> None:
    # Value: protects=overlap merges only when status, got, and exp match, including a reversed box; fails_when=status, got, or exp is ignored, or x1<x0 is treated as no area; why_new=merge fixtures repeat one identical op and only use ordered boxes; seam=none; no_claim=widened space boxes are not covered here
    rows = [{"row": 15, "item": "合成乙", "text": "甲乙丙"}]
    different_status = assemble_hits(
        [_piece("甲乙", [15], [
            _op("错字", "甲乙", "甲乙", [0, 0, 10, 10]),
            _op("漏字", "甲乙", "甲乙", [4, 4, 14, 14]),
        ])],
        rows,
        MATRIX,
        PAGE,
    )
    assert len(different_status) == 2
    assert {hit["status"] for hit in different_status} == {"错字", "漏字"}
    different_got = assemble_hits(
        [_piece("甲乙丙", [15], [
            _op("错字", "甲", "乙", [0, 0, 10, 10]),
            _op("错字", "丙", "乙", [4, 4, 14, 14]),
        ])],
        rows,
        MATRIX,
        PAGE,
    )
    assert len(different_got) == 2
    reversed_box = assemble_hits(
        [_piece("甲乙", [15], [
            _op("错字", "甲乙", "甲乙", [10, 10, 0, 0]),
            _op("错字", "甲乙", "甲乙", [4, 4, 14, 14]),
        ])],
        rows,
        MATRIX,
        PAGE,
    )
    assert len(reversed_box) == 1
    assert reversed_box[0]["status"] == "错字"
    different_exp = assemble_hits(
        [_piece("甲乙丙", [15], [
            _op("错字", "甲", "乙", [0, 0, 10, 10]),
            _op("错字", "甲", "丙", [4, 4, 14, 14]),
        ])],
        rows,
        MATRIX,
        PAGE,
    )
    assert len(different_exp) == 2
    assert {hit["excel_value"] for hit in different_exp} == {"乙", "丙"}


def test_warning_hit_keeps_manuscript_key_and_drops_range() -> None:
    raw = _hit(1, "待人工确认", False, {"exp": "", "got": "", "p": 0}, {"left": 3, "top": 4, "width": 5, "height": 6}, 1)
    raw["bboxes"].append({"left": 0, "top": 0, "width": 9, "height": 9, "page": 1, "role": "range"})
    hit = _mark_warning_hit(raw)
    assert hit["manuscript"] == ""
    assert hit["excel_standard"] == ""
    assert hit["excel_row_count"] == 0
    assert [box["role"] for box in hit["bboxes"]] == ["hit"]

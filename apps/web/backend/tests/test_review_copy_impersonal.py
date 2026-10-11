"""审核员看到的系统文案不以「我」自称（产品哥 2026-10-11 定稿）。"""

import re

from app.fields import match_field


def test_net_content_unread_copy_is_impersonal():
    hit = match_field("净含量", "净含量：30ml", [], "")
    assert hit["status"] == "疑点"
    assert hit["evidence"].endswith("确认单要的净含量，这一面没读到，请核对")
    assert "我" not in hit["evidence"]


def test_net_barcode_unread_copy_is_impersonal():
    hit = match_field("净含量&条形码", "净含量：30ml\n条形码：6901234567890", [], "")
    assert hit["status"] == "疑点"
    assert hit["evidence"] == "确认单要的毫升和条码，这一面没读全，请核对"


def test_fields_source_has_no_first_person_reviewer_copy():
    from pathlib import Path

    src = (Path(__file__).resolve().parents[1] / "app" / "fields.py").read_text(encoding="utf-8")
    literals = re.findall(r'"([^"\n]*)"', src)
    assert not [s for s in literals if "我" in s]

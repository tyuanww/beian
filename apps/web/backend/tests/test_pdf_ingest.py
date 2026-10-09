from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest
from PIL import Image, ImageChops, ImageDraw

from app.pdf_ingest import (
    FULL_PAGE_IMAGE_MIN_COVERAGE,
    WARNING_IMAGE,
    WARNING_OUTLINED,
    classify_document,
    classify_page,
    ingest_pdf,
    live_char_count,
    public_ingest,
)
from app.pdf_render import render_pdf_pages
from app.text_verify import merge_text_sources

REPO = Path(__file__).resolve().parents[4]


def _zhuanqu_pdfs() -> list[Path]:
    roots = [REPO / "测试" / "审稿台"]
    out: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.pdf")):
            if "转曲" not in path.name:
                continue
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(path)
    return out


def _live_text_pdf(path: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=420, height=300)
    page.insert_text(
        (36, 72),
        "Product Name Helvetica Live Text Sample for Cosmetics Label Review 12345",
        fontsize=12,
        fontname="helv",
    )
    page.insert_text(
        (36, 108),
        "INCI Water Glycerin Niacinamide more selectable characters on this carton.",
        fontsize=11,
        fontname="helv",
    )
    doc.save(str(path))
    doc.close()
    return path


def _outlined_pdf(path: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=420, height=300)
    for i in range(450):
        x = 12.0 + (i % 45) * 8.0
        y = 12.0 + (i // 45) * 14.0
        page.draw_line(
            pymupdf.Point(x, y),
            pymupdf.Point(x + 5.0, y + 9.0),
            color=(0, 0, 0),
            width=0.4,
        )
    page.insert_text((24, 280), "29.35", fontsize=8, fontname="helv")
    page.insert_text((72, 280), "56", fontsize=8, fontname="helv")
    doc.save(str(path))
    doc.close()
    return path


def _image_pdf(path: Path) -> Path:
    raster = path.with_suffix(".png")
    im = Image.new("RGB", (800, 600), (18, 92, 54))
    draw = ImageDraw.Draw(im)
    draw.rectangle((40, 40, 760, 560), outline=(240, 240, 240), width=6)
    draw.ellipse((220, 160, 580, 440), fill=(200, 40, 40))
    im.save(raster)
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    page.insert_image(page.rect, filename=str(raster))
    doc.save(str(path))
    doc.close()
    return path


def _image_with_live_footer_pdf(path: Path) -> Path:
    raster = path.with_suffix(".png")
    Image.new("RGB", (800, 600), (18, 92, 54)).save(raster)
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    page.insert_image(page.rect, filename=str(raster))
    page.insert_text(
        (16, 286),
        "LIVE FOOTER TEXT " * 4,
        fontsize=7,
        fontname="helv",
    )
    doc.save(str(path))
    doc.close()
    return path


def _tiled_images_with_live_footer_pdf(path: Path) -> Path:
    raster = path.with_suffix(".png")
    Image.new("RGB", (400, 300), (18, 92, 54)).save(raster)
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    for rect in (
        pymupdf.Rect(0, 0, 200, 150),
        pymupdf.Rect(200, 0, 400, 150),
        pymupdf.Rect(0, 150, 200, 300),
        pymupdf.Rect(200, 150, 400, 300),
    ):
        page.insert_image(rect, filename=str(raster))
    page.insert_text(
        (16, 286),
        "LIVE FOOTER TEXT " * 4,
        fontsize=7,
        fontname="helv",
    )
    doc.save(str(path))
    doc.close()
    return path


def test_classify_thresholds():
    assert classify_page(80, 0) == "live_text"
    assert classify_page(0, 400) == "outlined"
    assert classify_page(20, 399) == "image"
    assert classify_page(50, 10) == "live_text"
    assert classify_page(50, 400) == "mixed"
    assert classify_page(20, 0, image_coverage=0.9) == "image"
    assert classify_page(50, 0, image_coverage=0.9) == "mixed"
    assert classify_document(["live_text", "outlined"]) == "mixed"
    assert classify_document(["live_text", "image"]) == "mixed"
    assert classify_document(["outlined", "image"]) == "mixed"


def test_dieline_numbers_are_not_live_chars():
    assert live_char_count("29.35 56 30 186.35") == 0
    assert live_char_count("29.35×56×30mm " * 10) == 0
    assert live_char_count("W29.35 H56 " * 10) == 0
    assert live_char_count("29.35/56/30 " * 10) == 0
    assert live_char_count("2026/08/27") > 0
    assert live_char_count("达肤妍保湿喷雾 30ml") >= 8


def test_dense_dieline_with_compound_dimensions_stays_outlined(tmp_path: Path):
    pdf = _outlined_pdf(tmp_path / "outlined-dimensions.pdf")
    doc = pymupdf.open(pdf)
    page = doc[0]
    for i in range(10):
        page.insert_text(
            (20, 150 + i * 10),
            "29.35×56×30mm",
            fontsize=7,
            fontname="helv",
        )
    doc.save(str(tmp_path / "outlined-dimensions-saved.pdf"))
    doc.close()
    result = ingest_pdf(tmp_path / "outlined-dimensions-saved.pdf", max_pages=1)
    assert result["mode"] == "outlined"
    assert result["pages"][0]["live_chars"] == 0


def test_live_text_helvetica(tmp_path: Path):
    """带 Helvetica 活字的单页 PDF → live_text。"""
    pdf = _live_text_pdf(tmp_path / "live.pdf")
    result = ingest_pdf(pdf, max_pages=1)
    assert result["mode"] == "live_text"
    assert result["pages"][0]["mode"] == "live_text"
    assert result["live_chars"] >= 80
    assert result["warning"] is None
    assert len(result["warning"] or "") <= 80


def test_outlined_path_drawings(tmp_path: Path):
    """大量 path、几乎无 text object → outlined。刀版数字不算活字。"""
    pdf = _outlined_pdf(tmp_path / "outlined.pdf")
    result = ingest_pdf(pdf, max_pages=1)
    assert result["mode"] == "outlined"
    assert result["pages"][0]["mode"] == "outlined"
    assert result["pages"][0]["live_chars"] < 40
    assert result["drawings"] >= 400
    assert result["warning"] == WARNING_OUTLINED
    assert len(result["warning"]) <= 80


def test_grouped_vector_commands_with_live_text_route_to_ocr(tmp_path: Path):
    """Illustrator 可把大量转曲字合并进少量 path；按组内指令复杂度仍判 mixed。"""
    pdf = tmp_path / "grouped-vector.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=800)
    page.insert_textbox(
        pymupdf.Rect(20, 20, 580, 120),
        "LIVE TEXT FOOTER " * 8,
        fontsize=10,
        fontname="helv",
    )
    shape = page.new_shape()
    for index in range(810):
        x = 20 + (index % 90) * 6
        y = 160 + (index // 90) * 12
        shape.draw_line((x, y), (x + 3, y + 6))
    shape.finish(color=(0, 0, 0), width=0.4)
    shape.commit()
    doc.save(str(pdf))
    doc.close()

    result = ingest_pdf(pdf, max_pages=1)
    page_result = result["pages"][0]

    assert page_result["drawings"] < 400
    assert page_result["drawing_items"] >= 800
    assert page_result["live_chars"] >= 40
    assert page_result["mode"] == "mixed"


def test_grouped_vector_commands_without_live_text_stay_outlined(tmp_path: Path):
    pdf = tmp_path / "grouped-vector-outlined.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=800)
    shape = page.new_shape()
    for index in range(810):
        x = 20 + (index % 90) * 6
        y = 80 + (index // 90) * 12
        shape.draw_line((x, y), (x + 3, y + 6))
    shape.finish(color=(0, 0, 0), width=0.4)
    shape.commit()
    doc.save(str(pdf))
    doc.close()

    result = ingest_pdf(pdf, max_pages=1)
    page_result = result["pages"][0]

    assert page_result["drawings"] < 400
    assert page_result["drawing_items"] >= 800
    assert page_result["live_chars"] == 0
    assert page_result["mode"] == "outlined"


def test_full_page_image(tmp_path: Path):
    """一张大图页 → image。"""
    pdf = _image_pdf(tmp_path / "image.pdf")
    result = ingest_pdf(pdf, max_pages=1)
    assert result["mode"] == "image"
    assert result["pages"][0]["mode"] == "image"
    assert result["pages"][0]["live_chars"] == 0
    assert result["warning"] == WARNING_IMAGE
    assert len(result["warning"]) <= 80


def test_full_page_image_with_live_footer_still_routes_to_ocr(tmp_path: Path):
    pdf = _image_with_live_footer_pdf(tmp_path / "image-live-footer.pdf")
    result = ingest_pdf(pdf, max_pages=1)
    page = result["pages"][0]
    assert page["mode"] == "mixed"
    assert page["image_coverage"] >= 0.9
    assert page["live_chars"] >= 40


def test_tiled_page_images_with_live_footer_still_route_to_ocr(tmp_path: Path):
    pdf = _tiled_images_with_live_footer_pdf(tmp_path / "tiled-live-footer.pdf")
    result = ingest_pdf(pdf, max_pages=1)
    page = result["pages"][0]
    assert page["mode"] == "mixed"
    assert page["image_blocks"] == 4
    assert page["image_coverage"] >= 0.99
    assert page["live_chars"] >= 40


@pytest.mark.real_artwork
def test_zhuanqu_artwork_is_outlined():
    """工作区审稿台转曲真稿（不 copy 进 git）。"""
    pdfs = _zhuanqu_pdfs()
    if not pdfs:
        pytest.fail("已显式选择真实稿测试，但工作区没有 测试/审稿台/**/转曲*.pdf")
    for pdf in pdfs:
        result = ingest_pdf(pdf, max_pages=1)
        assert result["mode"] == "outlined", (
            f"{pdf.name}: mode={result['mode']} "
            f"live_chars={result['live_chars']} drawings={result['drawings']}"
        )
        assert result["pages"][0]["live_chars"] < 40
        assert result["drawings"] >= 400


def test_live_span_maps_inside_png_pixels(tmp_path: Path):
    pdf = _live_text_pdf(tmp_path / "live.pdf")
    metas = render_pdf_pages(pdf, tmp_path / "pages", max_pages=1, quality="high")
    result = ingest_pdf(pdf, metas, max_pages=1)
    assert result["spans"]
    meta = metas[0]
    w, h = int(meta["width"]), int(meta["height"])
    assert w > 0 and h > 0
    for span in result["spans"]:
        assert span["source"] == "pdf_layer"
        assert 0 <= span["left"] < w
        assert 0 <= span["top"] < h
        assert span["left"] + span["width"] <= w
        assert span["top"] + span["height"] <= h
        assert span["width"] >= 1
        assert span["height"] >= 1
        assert span["text"]


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_live_span_follows_rendered_page_rotation(tmp_path: Path, rotation: int):
    pdf = tmp_path / f"rotated-{rotation}.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=200, height=100)
    page.insert_text((20, 30), "HELLO LIVE TEXT", fontsize=10, fontname="helv")
    page.set_rotation(rotation)
    doc.save(str(pdf))
    doc.close()

    metas = render_pdf_pages(
        pdf,
        tmp_path / f"pages-{rotation}",
        max_pages=1,
        dpi=144,
        max_side=1000,
        review_svg_max_bytes=0,
    )
    result = ingest_pdf(pdf, metas, max_pages=1)
    span = result["spans"][0]
    with Image.open(metas[0]["path"]) as image:
        rgb = image.convert("RGB")
        pixels = ImageChops.difference(rgb, Image.new("RGB", rgb.size, "white")).getbbox()
    assert pixels is not None
    mapped = (
        span["left"],
        span["top"],
        span["left"] + span["width"],
        span["top"] + span["height"],
    )
    assert all(abs(actual - expected) <= 30 for actual, expected in zip(mapped, pixels))


def test_mixed_page_sources_keep_live_and_ocr_evidence():
    layer_text = "Live page selectable product name and filing content with enough characters"
    ocr_text = "转曲页文案"
    layer_words = [
        {
            "text": "Live page product name",
            "page": 1,
            "location": {"left": 1, "top": 1, "width": 80, "height": 20},
        },
        {
            "text": "29.35",
            "page": 2,
            "location": {"left": 2, "top": 30, "width": 30, "height": 10},
        },
    ]
    ocr_words = [
        {
            "text": "转曲页文案",
            "page": 2,
            "location": {"left": 2, "top": 2, "width": 90, "height": 20},
        }
    ]
    text, words, source = merge_text_sources(
        layer_text,
        ocr_text,
        layer_words,
        ocr_words,
        prefer_layer=True,
    )
    assert layer_text in text
    assert ocr_text in text
    # 同页定位框仍由 OCR 接管，避免双源重复钉；这里只验证短 OCR 全文不会被漏掉。
    assert "29.35" not in " ".join(w["text"] for w in words)
    assert {int(w["page"]) for w in words} == {1, 2}
    assert source == "pdf_text+ocr"


def test_native_fallback_does_not_reuse_layer_when_ocr_is_empty():
    layer_words = [{
        "text": "陈旧隐藏文字",
        "page": 1,
        "location": {"left": 1, "top": 1, "width": 40, "height": 10},
    }]
    text, words, source = merge_text_sources(
        "陈旧隐藏文字",
        "",
        layer_words,
        [],
        prefer_layer=False,
        allow_layer_fallback=False,
    )
    assert text == ""
    assert words == []
    assert source == "ocr"


def test_public_ingest_drops_spans_and_layer_text(tmp_path: Path):
    pdf = _live_text_pdf(tmp_path / "live.pdf")
    full = ingest_pdf(pdf, max_pages=1)
    pub = public_ingest(full)
    assert "spans" not in pub
    assert "layer_text" not in pub
    assert "layer_blocks" not in pub
    assert "has_layer" not in pub
    assert set(pub) == {
        "mode",
        "pages",
        "live_chars",
        "drawings",
        "drawing_items",
        "images",
        "warning",
    }


def test_surface_job_emits_ingest_without_spans(tmp_path: Path, monkeypatch, capsys):
    from app import compare_core

    compare_core.init_paths(tmp_path / "data")
    pdf = _live_text_pdf(tmp_path / "live.pdf")
    monkeypatch.setattr(
        compare_core,
        "_ocr_pages",
        lambda _metas, _ingested=None: ("OCR", [], "mock", {}),
    )
    monkeypatch.setattr(
        compare_core,
        "_qrcode_pages",
        lambda _metas: ([], {"status": "empty"}),
    )
    monkeypatch.setattr(
        compare_core,
        "verify_fields",
        lambda *_a, **_k: [],
    )
    result = compare_core._surface_job(
        tid="0123456789ab",
        pdf=pdf,
        pages_subdir="",
        max_pages=1,
        surface_label="花盒",
        fields=[],
        title="活字夹具",
        filename="live.pdf",
    )
    err = capsys.readouterr().err
    assert "STAGE render_pdf" in err
    assert "STAGE ingest" in err
    assert "STAGE layout" in err
    assert "STAGE ocr" in err
    assert "STAGE match" in err
    ingest = result["ingest"]
    assert ingest["mode"] == "live_text"
    assert "spans" not in ingest
    assert ingest["warning"] is None
    assert result["pack_layout"]["regions"]


def _native_surface_ingest() -> dict:
    return {
        "mode": "live_text",
        "pages": [
            {
                "page": 1,
                "mode": "live_text",
                "live_chars": 0,
                "words": 0,
                "text_blocks": 0,
                "image_blocks": 0,
                "image_coverage": 0.0,
                "drawings": 0,
                "drawing_items": 0,
                "warning": None,
            }
        ],
        "live_chars": 0,
        "drawings": 0,
        "drawing_items": 0,
        "images": 0,
        "warning": None,
        "spans": [],
        "layer_text": "",
        "layer_blocks": [],
        "has_layer": False,
    }


def _native_candidate(text: str = "Native Product") -> dict:
    return {
        "text": text,
        "page": 1,
        "bbox": [10, 10, 180, 34],
        "object_id": "native-1",
    }


def test_native_coverage_skips_baidu_ocr(monkeypatch, tmp_path: Path):
    """闭合且覆盖确认单的原生文字可以独立完成审稿。"""
    from app import compare_core

    compare_core.init_paths(tmp_path / "data")
    page_path = tmp_path / "page.png"
    page_path.write_bytes(b"synthetic-page")
    metas = [{"page": 1, "path": str(page_path), "name": "page.png", "width": 400, "height": 300}]
    monkeypatch.setattr(compare_core, "render_pdf_pages", lambda *_a, **_k: metas)
    ingested = _native_surface_ingest()
    ingested["has_layer"] = True
    ingested["layer_text"] = "过期隐藏文字，不应替代已证明可见的原生文字。"
    monkeypatch.setattr(compare_core, "ingest_pdf", lambda *_a, **_k: ingested)

    def fail_ocr(*_args, **_kwargs):
        raise AssertionError("原生覆盖完整时不应调用百度 OCR")

    monkeypatch.setattr(compare_core, "_ocr_pages", fail_ocr)
    monkeypatch.setattr(
        compare_core.native_text,
        "load_candidates",
        lambda *_a, **_k: ([_native_candidate()], None),
    )
    monkeypatch.setattr(compare_core, "_qrcode_pages", lambda *_a: ([], {"status": "empty"}))
    monkeypatch.setattr(
        compare_core,
        "verify_fields",
        lambda *_a, **_k: [{
            "id": "native-hit",
            "field": "中文品名",
            "status": "疑点",
            "bboxes": [{"page": 1, "left": 10, "top": 10, "width": 170, "height": 24}],
        }],
    )

    result = compare_core._surface_job(
        tid="0123456789ab",
        pdf=tmp_path / "artwork.pdf",
        pages_subdir="",
        max_pages=1,
        surface_label="花盒",
        fields=[{"field": "中文品名", "excel_value": "Native Product", "field_group": "中文品名"}],
        title="Native Product",
        filename="artwork.pdf",
    )

    assert result["ocr_engine"] == "illustrator_native"
    assert result["ocr_meta"]["skipped"] is True
    assert result["ocr_meta"]["reason"] == "native_coverage"
    assert result["text_source"] == "illustrator_native"
    assert result["pack_text"] == "Native Product"
    assert "过期隐藏文字" not in result["pack_text"]
    assert result["hits"][0]["native_text_evidence"]["status"] == "used"
    assert result["hits"][0]["native_text_evidence"]["ocr_text"] is None


def test_native_partial_coverage_falls_back_to_ocr(monkeypatch, tmp_path: Path):
    """原生文字未覆盖确认单时仍必须调用 OCR。"""
    from app import compare_core

    compare_core.init_paths(tmp_path / "data")
    page_path = tmp_path / "page.png"
    page_path.write_bytes(b"synthetic-page")
    metas = [{"page": 1, "path": str(page_path), "name": "page.png", "width": 400, "height": 300}]
    monkeypatch.setattr(compare_core, "render_pdf_pages", lambda *_a, **_k: metas)
    ingested = _native_surface_ingest()
    ingested["has_layer"] = True
    ingested["layer_text"] = "Native Product"
    monkeypatch.setattr(compare_core, "ingest_pdf", lambda *_a, **_k: ingested)
    calls = {"n": 0}

    def fake_ocr(*_args, **_kwargs):
        calls["n"] += 1
        return "OCR fallback", [{"text": "OCR fallback", "page": 1, "location": {"left": 10, "top": 40, "width": 120, "height": 20}}], "mock", {"skipped": False}

    monkeypatch.setattr(compare_core, "_ocr_pages", fake_ocr)
    monkeypatch.setattr(
        compare_core.native_text,
        "load_candidates",
        lambda *_a, **_k: ([_native_candidate("Unrelated")], None),
    )
    monkeypatch.setattr(compare_core, "_qrcode_pages", lambda *_a: ([], {"status": "empty"}))
    monkeypatch.setattr(compare_core, "verify_fields", lambda *_a, **_k: [])

    result = compare_core._surface_job(
        tid="0123456789ab",
        pdf=tmp_path / "artwork.pdf",
        pages_subdir="",
        max_pages=1,
        surface_label="花盒",
        fields=[{"field": "中文品名", "excel_value": "Native Product", "field_group": "中文品名"}],
        title="Native Product",
        filename="artwork.pdf",
    )

    assert calls["n"] == 1
    assert result["ocr_engine"] == "mock"
    assert result["ocr_meta"]["skipped"] is False


def test_rejected_native_attempt_forces_ocr_on_live_text(monkeypatch, tmp_path: Path):
    """原生尝试因预算/映射失败时，不能回用陈旧 PDF 文字层。"""
    from app import compare_core

    compare_core.init_paths(tmp_path / "data")
    page_path = tmp_path / "page.png"
    page_path.write_bytes(b"synthetic-page")
    metas = [{"page": 1, "path": str(page_path), "name": "page.png", "width": 400, "height": 300}]
    ingested = _native_surface_ingest()
    ingested["has_layer"] = True
    ingested["layer_text"] = "过期隐藏文字"
    monkeypatch.setattr(compare_core, "render_pdf_pages", lambda *_a, **_k: metas)
    monkeypatch.setattr(compare_core, "ingest_pdf", lambda *_a, **_k: ingested)
    calls = []

    def fake_ocr(*_args, **kwargs):
        calls.append(kwargs.get("force_ocr"))
        return "OCR fallback", [{"text": "OCR fallback", "page": 1, "location": {"left": 10, "top": 40, "width": 120, "height": 20}}], "mock", {"skipped": False}

    monkeypatch.setattr(compare_core, "_ocr_pages", fake_ocr)
    monkeypatch.setattr(
        compare_core.native_text,
        "load_candidates",
        lambda *_a, **_k: ([], "native_mapping_unconfirmed"),
    )
    monkeypatch.setattr(compare_core, "_qrcode_pages", lambda *_a: ([], {"status": "empty"}))
    monkeypatch.setattr(compare_core, "verify_fields", lambda *_a, **_k: [])
    monkeypatch.setattr(compare_core, "NATIVE_DIR", tmp_path / ".native-rejected")

    result = compare_core._surface_job(
        tid="0123456789ab",
        pdf=tmp_path / "artwork.pdf",
        pages_subdir="",
        max_pages=1,
        surface_label="花盒",
        fields=[],
        title="Native Product",
        filename="artwork.pdf",
    )

    assert calls == [True]
    assert result["text_source"] == "ocr"
    assert "过期隐藏文字" not in result["pack_text"]


def test_native_candidate_does_not_skip_ocr_on_mixed_page(monkeypatch, tmp_path: Path):
    """mixed 页可能还有转曲文案，单个原生文字框不能证明整页覆盖。"""
    from app import compare_core

    compare_core.init_paths(tmp_path / "data")
    page_path = tmp_path / "page.png"
    page_path.write_bytes(b"synthetic-page")
    metas = [{"page": 1, "path": str(page_path), "name": "page.png", "width": 400, "height": 300}]
    ingested = _native_surface_ingest()
    ingested["mode"] = "mixed"
    ingested["pages"][0]["mode"] = "mixed"
    ingested["pages"][0]["drawings"] = 500
    monkeypatch.setattr(compare_core, "render_pdf_pages", lambda *_a, **_k: metas)
    monkeypatch.setattr(compare_core, "ingest_pdf", lambda *_a, **_k: ingested)
    calls = {"n": 0}

    def fake_ocr(*_args, **_kwargs):
        calls["n"] += 1
        return "OCR fallback", [{"text": "OCR fallback", "page": 1, "location": {"left": 10, "top": 40, "width": 120, "height": 20}}], "mock", {"skipped": False}

    monkeypatch.setattr(compare_core, "_ocr_pages", fake_ocr)
    monkeypatch.setattr(compare_core.native_text, "load_candidates", lambda *_a, **_k: ([_native_candidate()], None))
    monkeypatch.setattr(compare_core, "_qrcode_pages", lambda *_a: ([], {"status": "empty"}))
    monkeypatch.setattr(compare_core, "verify_fields", lambda *_a, **_k: [])

    result = compare_core._surface_job(
        tid="0123456789ab",
        pdf=tmp_path / "artwork.pdf",
        pages_subdir="",
        max_pages=1,
        surface_label="花盒",
        fields=[{"field": "中文品名", "excel_value": "Native Product", "field_group": "中文品名"}],
        title="Native Product",
        filename="artwork.pdf",
    )

    assert calls["n"] == 1
    assert result["ocr_engine"] == "mock"
    assert result["ocr_meta"]["skipped"] is False


def test_native_candidate_budget_falls_back_before_native_only(monkeypatch):
    """候选过多时回退 OCR，避免原生证据扫描失控。"""
    from app import compare_core

    candidates = [_native_candidate("Native Product")] * (compare_core.NATIVE_ONLY_MAX_CANDIDATES + 1)
    only_native, gate = compare_core._native_only_gate(
        _native_surface_ingest(),
        candidates,
        [{"field": "中文品名", "excel_value": "Native Product", "field_group": "中文品名"}],
    )

    assert only_native is False
    assert gate["reason"] == "candidate_limit"


def test_native_gate_does_not_use_ocr_fuzzy_phrase_matching():
    """跳过 OCR 的门不能把缺字的前缀/锚点命中当作完整覆盖。"""
    from app import compare_core

    only_native, gate = compare_core._native_only_gate(
        _native_surface_ingest(),
        [_native_candidate("Native Product")],
        [{"field": "中文品名", "excel_value": "Native Product Deluxe"}],
    )

    assert only_native is False
    assert gate["reason"] == "coverage_incomplete"
    assert gate["matched"] < gate["total"]


# Value: protects=native and barcode gates reject numeric substring matches; fails_when=expected code 1234567890 is accepted inside 01234567890; why_new=phrase coverage tests cover text prefixes but not numeric token boundaries; seam=none
def test_native_gate_requires_complete_barcode_token():
    from app import compare_core

    only_native, gate = compare_core._native_only_gate(
        _native_surface_ingest(),
        [_native_candidate("01234567890")],
        [{"field": "条码", "excel_value": "1234567890", "field_group": "条形码"}],
    )

    assert only_native is False
    assert gate["reason"] == "coverage_incomplete"


# Value: protects=native gate rejects image-heavy pages even when the PDF mode says live_text; fails_when=image_coverage guard is removed and native text suppresses OCR over artwork; why_new=existing gate tests cover mode and phrase coverage but not the image threshold branch; seam=none
def test_native_gate_falls_back_for_image_heavy_live_page():
    from app import compare_core

    ingested = _native_surface_ingest()
    ingested["pages"][0]["image_coverage"] = FULL_PAGE_IMAGE_MIN_COVERAGE
    only_native, gate = compare_core._native_only_gate(
        ingested,
        [_native_candidate()],
        [{"field": "中文品名", "excel_value": "Native Product", "field_group": "中文品名"}],
    )

    assert only_native is False
    assert gate["reason"] == "image_content"


# Value: protects=native gate counts only reviewable fields and normalizes unit spellings; fails_when=skip-field filtering or unit normalization is removed and valid native-only jobs fall back or skip required checks; why_new=no existing gate case combines metadata filtering with a milliliter unit variant; seam=none
def test_native_gate_ignores_pack_metadata_and_matches_unit_variant():
    from app import compare_core

    ingested = _native_surface_ingest()
    only_native, gate = compare_core._native_only_gate(
        ingested,
        [_native_candidate("30 mL")],
        [
            {"field": "工艺说明", "excel_value": "局部烫金"},
            {"field": "净含量", "excel_value": "30毫升", "field_group": "净含量"},
        ],
    )

    assert only_native is True
    assert gate["reason"] == "native_coverage"
    assert gate["matched"] == gate["total"] == 1


def test_native_coverage_requires_every_rendered_page():
    """缺少任一页的原生证明时不能把整单误判为 native-only。"""
    from app import compare_core

    ingested = _native_surface_ingest()
    ingested["pages"].append({**ingested["pages"][0], "page": 2})
    only_native, gate = compare_core._native_only_gate(
        ingested,
        [_native_candidate()],
        [{"field": "中文品名", "excel_value": "Native Product", "field_group": "中文品名"}],
    )

    assert only_native is False
    assert gate["reason"] == "page_coverage_incomplete"


def test_multi_surface_ocr_meta_does_not_hide_secondary_ocr(monkeypatch, tmp_path: Path):
    """双面稿只在每一面都 native-only 时才展示整单跳过 OCR。"""
    from app import compare_core

    compare_core.init_paths(tmp_path / "data")
    excel = tmp_path / "source.xlsx"
    primary_pdf = tmp_path / "carton.pdf"
    pouch_pdf = tmp_path / "pouch.pdf"
    for path in (excel, primary_pdf, pouch_pdf):
        path.write_bytes(b"source")
    monkeypatch.setattr(compare_core, "parse_excel_fields", lambda *_a: [{"field": "中文品名", "excel_value": "Native Product"}])

    def face(label: str, *, skipped: bool, reason: str | None, engine: str):
        return {
            "surface": label,
            "pages": [],
            "page_metas": [],
            "hits": [],
            "pack_text": "Native Product",
            "pack_profile": {},
            "text_source": "illustrator_native" if skipped else "ocr",
            "has_layer": False,
            "ocr_engine": engine,
            "ocr_meta": {
                "skipped": skipped,
                **({"reason": reason} if reason else {}),
                "pages_ran": 0 if skipped else 1,
                "words": 2 if skipped else 3,
                "native_coverage": {"matched": 4 if skipped else 1, "total": 4},
                "api": None if skipped else "accurate",
                "probability": False if skipped else True,
            },
            "layout_zones": {},
            "pack_layout": {"regions": []},
            "qrcodes": [],
            "qrcode_meta": {},
            "reverse_extras": [],
            "ingest": {},
        }

    monkeypatch.setattr(
        compare_core,
        "_surface_job",
        lambda **kwargs: face(
            kwargs["surface_label"],
            skipped=kwargs["surface_label"] == "花盒",
            reason="native_coverage" if kwargs["surface_label"] == "花盒" else None,
            engine="illustrator_native" if kwargs["surface_label"] == "花盒" else "baidu:accurate",
        ),
    )

    result = compare_core.run_excel_pdf_job(
        "0123456789ab",
        excel,
        primary_pdf,
        1,
        "Native Product",
        pdf_pouch=pouch_pdf,
    )

    assert result["ocr_meta"]["skipped"] is False
    assert [item["surface"] for item in result["ocr_meta"]["surfaces"]] == ["花盒", "膜袋"]
    assert result["ocr_meta"]["surfaces"][1]["ocr_engine"] == "baidu:accurate"
    assert result["ocr_meta"]["engines"] == ["illustrator_native", "baidu:accurate"]
    assert result["ocr_meta"]["words"] == 5
    assert result["ocr_meta"]["native_coverage"] == {"matched": 5, "total": 8}
    assert "api" not in result["ocr_meta"]
    assert "probability" not in result["ocr_meta"]

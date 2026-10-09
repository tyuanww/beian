from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pymupdf
import pytest


ROOT = Path(__file__).resolve().parents[4]
PACKAGING = ROOT / "workers" / "packaging"
MODULE = PACKAGING / "structure_v2" / "unfolded_print.py"
EXPORTER = PACKAGING / "illustrator" / "export_structure.jsx"
CLOSE = PACKAGING / "illustrator" / "export_close.py"
WORKER = PACKAGING / "illustrator" / "illustrator_worker.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


publisher = load(MODULE, "unfolded_print_publisher")
close_mod = load(CLOSE, "illustrator_export_close")


def net(**overrides) -> dict:
    panels = [
        {"id": "glue", "role": "glue", "bounds_mm": [0, 30, 20, 70]},
        {"id": "back", "role": "back", "bounds_mm": [20, 30, 70, 90]},
        {"id": "left", "role": "left", "bounds_mm": [70, 30, 100, 90]},
        {"id": "front", "role": "front", "bounds_mm": [100, 30, 150, 90]},
        {"id": "right", "role": "right", "bounds_mm": [150, 30, 180, 90]},
        {"id": "top", "role": "top", "bounds_mm": [100, 0, 150, 30]},
        {"id": "bottom", "role": "bottom", "bounds_mm": [100, 90, 150, 120]},
        {"id": "tuck", "role": "tuck", "bounds_mm": [100, 120, 140, 140]},
    ]
    payload = {
        "schema": "unfolded-print-source/1",
        "assembly": "semantic-net",
        "panels": panels,
        "separation": {
            "method": "semantic-identity",
            "objects": [
                {"id": "ink", "role": "print", "panel_id": "front", "bounds_mm": [110, 40, 140, 80]},
                {"id": "rule", "role": "decoration", "panel_id": "front", "bounds_mm": [112, 82, 145, 82.2]},
                {"id": "knife", "role": "cut", "panel_id": "front", "bounds_mm": [100, 30, 150, 90]},
                {"id": "fold", "role": "crease", "panel_id": "front", "bounds_mm": [100, 30, 150, 31]},
                {"id": "dim", "role": "dimension", "panel_id": "glue", "bounds_mm": [2, 40, 18, 42]},
                {"id": "note", "role": "production", "panel_id": "tuck", "bounds_mm": [102, 122, 130, 136]},
            ],
        },
    }
    payload.update(overrides)
    return payload


def write_source(tmp_path: Path, payload: dict) -> Path:
    path = tmp_path / "unfolded-source.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def publish(tmp_path: Path, payload: dict, **kwargs):
    source = write_source(tmp_path, payload)
    output = tmp_path / "out.pdf"
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    result = publisher.publish_unfolded_print(source, output, expect_sha256=before, **kwargs)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    return result, output


def test_semantic_net_keeps_flaps_and_drops_helpers(tmp_path: Path):
    result, output = publish(tmp_path, net())
    assert result["ok"] is True
    assert result["width_mm"] == 180
    assert result["height_mm"] == 140
    document = pymupdf.open(output)
    try:
        page = document[0]
        assert page.rotation == 0
        assert abs(page.mediabox.width * 25.4 / 72 - 180) < 0.05
        assert abs(page.mediabox.height * 25.4 / 72 - 140) < 0.05
        drawings = page.get_drawings()
    finally:
        document.close()
    assert len(drawings) == 2
    fills = [item.get("fill") for item in drawings]
    assert any(fill is not None for fill in fills)
    assert all((item.get("width") or 0) < 2 for item in drawings)


def test_thin_decoration_is_kept_and_color_is_not_a_classifier(tmp_path: Path):
    payload = net()
    payload["separation"]["objects"][1]["bounds_mm"] = [112, 82, 145, 82.15]
    result, output = publish(tmp_path, payload)
    assert result["height_mm"] == 140
    document = pymupdf.open(output)
    try:
        assert len(document[0].get_drawings()) == 2
    finally:
        document.close()


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda payload: payload.update(assembly="six_png"), "geometry_incomplete"),
        (lambda payload: payload.update(assembly="glb_snapshot"), "geometry_incomplete"),
        (lambda payload: payload["panels"].pop(0), "geometry_incomplete"),
        (lambda payload: payload["panels"].pop(), "geometry_incomplete"),
        (lambda payload: payload["separation"].update(method="color"), "separation_unreliable"),
        (lambda payload: payload["separation"].update(method="stroke-width"), "separation_unreliable"),
        (
            lambda payload: payload["separation"]["objects"].append(
                {"id": "mystery", "role": "unknown", "panel_id": "front", "bounds_mm": [111, 41, 120, 50]}
            ),
            "separation_unreliable",
        ),
    ],
)
def test_incomplete_or_unreliable_sources_do_not_publish(tmp_path: Path, mutate, reason):
    payload = net()
    mutate(payload)
    source = write_source(tmp_path, payload)
    output = tmp_path / "out.pdf"
    with pytest.raises(publisher.UnfoldedPrintReject) as caught:
        publisher.publish_unfolded_print(source, output)
    assert caught.value.reason == reason
    assert not output.exists()


def test_attested_pdf_keeps_physical_size_and_rejects_a4_fit(tmp_path: Path):
    payload = net(assembly="attested-pdf", separation=None, attestation={
        "schema": "unfolded-separation-attestation/1",
        "method": "semantic-identity",
        "hidden_roles": ["cut", "crease", "dimension", "production"],
        "covers_blank_structure": True,
    })
    artwork = tmp_path / "artwork.pdf"
    document = pymupdf.open()
    document.new_page(width=180 * 72 / 25.4, height=140 * 72 / 25.4)
    document.save(artwork)
    document.close()
    digest = hashlib.sha256(artwork.read_bytes()).hexdigest()
    result, output = publish(tmp_path, payload, artwork=artwork, artwork_sha256=digest)
    assert result["width_mm"] == 180
    assert hashlib.sha256(artwork.read_bytes()).hexdigest() == digest
    fitted = tmp_path / "a4.pdf"
    a4 = pymupdf.open()
    a4.new_page(width=595.27, height=841.89)
    a4.save(fitted)
    a4.close()
    source = write_source(tmp_path, payload)
    with pytest.raises(publisher.UnfoldedPrintReject) as caught:
        publisher.publish_unfolded_print(source, tmp_path / "scaled.pdf", artwork=fitted)
    assert caught.value.reason == "geometry_incomplete"


def test_missing_and_changed_source(tmp_path: Path):
    with pytest.raises(publisher.UnfoldedPrintReject) as missing:
        publisher.publish_unfolded_print(tmp_path / "gone.json", tmp_path / "out.pdf")
    assert missing.value.reason == "source_missing"
    source = write_source(tmp_path, net())
    with pytest.raises(publisher.UnfoldedPrintReject) as changed:
        publisher.publish_unfolded_print(source, tmp_path / "out.pdf", expect_sha256="ab" * 32)
    assert changed.value.reason == "source_changed"
    assert not (tmp_path / "out.pdf").exists()


def test_windows_agent_reuses_the_structure_exporter_for_unfolded_print():
    text = WORKER.read_text(encoding="utf-8")
    assert 'exporter="structure" if select_jsx(config) == STRUCTURE_JSX else "legacy"' in text


def test_close_confirmation_is_separate_from_result_json():
    attempt = "a" * 32
    result = {
        "protocol": "beian.illustrator.export/2",
        "request_kind": "unfolded_print",
        "attempt_id": attempt,
        "success": True,
        "close_confirmed": False,
    }
    confirmed = close_mod.confirm_export_close(result, 0)
    assert confirmed["document_closed"] is True
    assert confirmed["lock_returnable"] is True
    assert confirmed["attempt_id"] == attempt
    assert close_mod.confirm_export_close({**result, "close_confirmed": True}, 0) is None
    assert close_mod.confirm_export_close({**result, "close_error": "still open"}, 0) is None
    assert close_mod.confirm_export_close(result, 8) is None
    assert close_mod.confirm_export_close({**result, "request_kind": "native_text"}, 0) is None
    assert close_mod.validate_request_kind({"request_kind": "native_text"}) == "request_kind_unsupported"
    assert close_mod.validate_request_kind({"request_kind": "structure"}) is None


def test_exporter_reuses_structure_jsx_and_does_not_classify_by_ink():
    source = EXPORTER.read_text(encoding="utf-8")
    start = source.index("function exportCleanUnfoldedPrint")
    end = source.index("function withConfiguredPrintLayers")
    body = source[start:end]
    assert "semantic-identity" in body
    assert "strokeWidth" not in body
    assert "strokeColor" not in body
    assert "request_kind === \"unfolded_print\"" in source
    assert "close_confirmed = false" in body
    worker = load(WORKER, "unfolded_illustrator_worker")
    assert worker.select_jsx({"request_kind": "unfolded_print"}).name == "export_structure.jsx"
    assert worker.select_jsx({}).name == "export_ai.jsx"

import copy
import importlib.util
import json
from pathlib import Path

import pymupdf
import pytest
from app import native_text
from app.field_verify import verify_fields


def fixture(tmp_path):
    source = tmp_path / "artwork.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page(width=300, height=200)
        page.insert_text((40, 70), "30ml", fontsize=20)
        page.insert_text((40, 130), "Image region stays", fontsize=12)
        box = list(page.get_text("dict")["blocks"][0]["lines"][0]["bbox"])
        doc.save(source)
    root = tmp_path / (".native-" + "a" * 32)
    root.mkdir()
    (root / "print.pdf").write_bytes(source.read_bytes())
    identity = {"protocol": "beian.illustrator.export/2", "request_kind": "native_text", "attempt_id": "a" * 32, "source_sha256": native_text.source_hash(source)}
    result = {**identity, "extractor_version": native_text.VERSION, "success": True, "pages": [{"page": 1, "width": 300, "height": 200}], "candidates": [{"object_id": "text-0", "text": "30ml", "page": 1, "bbox": box, "visible": True, "font": "Helvetica", "font_available": True}]}
    close = {**identity, "document_closed": True, "bridge_exited": True, "inflight": False, "lock_returnable": True}
    (root / "result.json").write_text(json.dumps(result))
    (root / "close.json").write_text(json.dumps(close))
    return source, root, result, [{"page": 1, "width": 300, "height": 200}]


def word(text, box, page=1):
    return {"text": text, "page": page, "location": {"left": box[0], "top": box[1], "width": box[2] - box[0], "height": box[3] - box[1]}}


def test_visible_native_corrects_ocr_without_discarding_image_region(tmp_path):
    source, root, _, metas = fixture(tmp_path)
    candidates, reason = native_text.load_candidates(root, source, metas)
    assert reason is None and len(candidates) == 1
    words = [word("80ml", candidates[0]["bbox"]), word("Image region stays", [40, 117, 160, 134])]
    original = copy.deepcopy(words)
    text, corrected, audit = native_text.fuse_words("80ml\nImage region stays", words, candidates)
    assert corrected[0]["text"] == "30ml"
    assert corrected[1] == words[1]
    assert words == original
    assert text == "30ml\nImage region stays"
    assert audit[0]["ocr_text"] == "80ml"
    assert audit[0]["status"] == "used"
    expected = [{"field": "英文品名", "excel_value": "30ml", "field_group": "品名"}]
    before_hits = verify_fields(expected, original, "80ml\nImage region stays")
    after_hits = verify_fields(expected, corrected, text)
    assert before_hits[0]["status"] != "一致"
    assert after_hits[0]["status"] == "一致"
    assert after_hits[0]["decision"] == "pending"
    # Existing rules still see a genuine difference from the expected content.
    fields = [{"field": "英文品名", "excel_value": "40ml", "field_group": "品名"}]
    hits = verify_fields(fields, corrected, text)
    assert hits and all(h.get("status") != "一致" for h in hits)


@pytest.mark.parametrize("change", ["hidden", "font", "wrong_text", "wrong_box", "rotation", "stale", "unclosed", "other_attempt", "version"])
def test_uncertain_native_never_overrides_visible_artwork(tmp_path, change):
    source, root, result, metas = fixture(tmp_path)
    candidate = result["candidates"][0]
    if change == "hidden": candidate["visible"] = False
    if change == "font": candidate["font_available"] = False
    if change == "wrong_text": candidate["text"] = "40ml"
    if change == "wrong_box": candidate["bbox"] = [5, 5, 20, 20]
    if change == "version": result["extractor_version"] = "native-text/2"
    if change in {"stale", "rotation"}:
        with pymupdf.open(source) as doc:
            if change == "stale": doc[0].insert_text((40, 160), "Changed")
            else: doc[0].set_rotation(90)
            doc.saveIncr()
        # Even a matching claimed source hash cannot bypass render correspondence.
        result["source_sha256"] = native_text.source_hash(source)
        close = json.loads((root / "close.json").read_text())
        close["source_sha256"] = result["source_sha256"]
        (root / "close.json").write_text(json.dumps(close))
    if change == "unclosed": (root / "close.json").unlink()
    if change == "other_attempt": result["attempt_id"] = "b" * 32
    (root / "result.json").write_text(json.dumps(result))
    assert native_text.load_candidates(root, source, metas)[0] == []


def test_duplicate_boxes_cannot_swallow_two_readings(tmp_path):
    source, root, _, metas = fixture(tmp_path)
    candidates, _ = native_text.load_candidates(root, source, metas)
    words = [word("80ml", candidates[0]["bbox"]), word("40ml", candidates[0]["bbox"])]
    text, corrected, audit = native_text.fuse_words("80ml 40ml", words, candidates)
    assert text == "80ml 40ml" and corrected == words
    assert all(e["status"] == "conflict" for e in audit)
    hits = [{"page": 1, "bboxes": [{"page": 1, **words[0]["location"]}], "decision": "issue"}]
    native_text.attach_evidence(hits, audit)
    assert hits[0]["decision"] == "issue"
    assert hits[0]["native_text_evidence"]["status"] == "conflict"


def test_limits_and_missing_close_fail_closed(tmp_path):
    source, root, result, metas = fixture(tmp_path)
    result["candidates"] *= 50001
    (root / "result.json").write_text(json.dumps(result))
    assert native_text.load_candidates(root, source, metas)[0] == []
    (root / "result.json").write_text('{"a":' * 70 + 'null' + '}' * 70)
    assert native_text.load_candidates(root, source, metas)[0] == []


# Value: protects=load_candidates fails closed when a page content stream exceeds the pre-extraction budget; fails_when=the resource guard is removed and hostile PDF content reaches PyMuPDF text extraction; why_new=existing limits cover JSON and total candidates but not page-level content limits; seam=none
def test_page_content_budget_fails_closed_before_text_extraction(tmp_path, monkeypatch):
    source, root, _, metas = fixture(tmp_path)
    monkeypatch.setattr(native_text, "_page_content_within_limit", lambda _page: False)

    candidates, reason = native_text.load_candidates(root, source, metas)

    assert candidates == []
    assert reason == "native_mapping_unconfirmed"


def test_native_reuses_close_contract_with_independent_observation():
    path = Path(__file__).resolve().parents[4] / "workers/packaging/illustrator/export_close.py"
    spec = importlib.util.spec_from_file_location("native_close_test", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    result = {"protocol": "beian.illustrator.export/2", "request_kind": "native_text", "attempt_id": "a" * 32, "source_sha256": "b" * 64}
    observation = {**result, "bridge_exited": True, "document_count": 0, "documents": []}
    assert module.confirm_export_close(result, 0) is None
    assert module.confirm_export_close(result, 0, observation)["request_kind"] == "native_text"
    assert module.confirm_export_close(result, 0, {**observation, "document_count": 1}) is None
    assert module.confirm_export_close(result, 2, observation) is None


def test_fusion_requires_complete_persistent_audit(tmp_path, monkeypatch):
    source, root, _, metas = fixture(tmp_path)
    candidates, _ = native_text.load_candidates(root, source, metas)
    words = [word("80ml", candidates[0]["bbox"])]
    text, _, audit = native_text.fuse_with_audit(root, source, "80ml", words, candidates)
    assert text == "30ml"
    stored = json.loads((root / "fusion-audit.json").read_text())
    assert stored["source_sha256"] == native_text.source_hash(source)
    assert stored["evidence"] == audit
    assert stored["evidence"][0]["ocr_text"] == "80ml"
    def fail_replace(*args):
        raise OSError("disk unavailable")
    monkeypatch.setattr(native_text.os, "replace", fail_replace)
    assert native_text.fuse_with_audit(root, source, "80ml", words, candidates) == ("80ml", words, [])
    assert not list(root.glob(".fusion-*"))


def test_compact_evidence_never_silently_truncates_readings():
    hits = [{"page": 1, "bboxes": [{"left": 0, "top": 0, "width": 10, "height": 10}]}]
    audit = [{"page": 1, "bbox": [0, 0, 10, 10], "status": "used", "native_text": "a" * 5000, "ocr_text": "b" * 5000}] * 2
    native_text.attach_evidence(hits, audit)
    assert "native_text_evidence" not in hits[0]


def _illustrator_worker():
    import sys
    folder = Path(__file__).resolve().parents[4] / "workers/packaging/illustrator"
    sys.path.insert(0, str(folder))
    try:
        spec = importlib.util.spec_from_file_location("illustrator_worker_watchdog_test", folder / "illustrator_worker.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(folder))


@pytest.mark.parametrize("proven", [True, False])
def test_save_watchdog_reports_save_timeout_and_closes_only_with_proof(tmp_path, capsys, proven):
    worker = _illustrator_worker()
    config = {"protocol": "beian.illustrator.export/2", "request_kind": "native_text", "attempt_id": "a" * 32, "source_sha256": "b" * 64, "close_json": str(tmp_path / "close.json")}
    observation = {"attempt_id": "a" * 32, "source_sha256": "b" * 64, "bridge_exited": True, "document_count": 0, "documents": []}
    error = worker.IllustratorAgentError("illustrator_save_timeout", "stalled", details={"source_unchanged": True, **({"close_observation": observation} if proven else {})})
    code = worker.save_watchdog_exit(config, error)
    public = json.loads(capsys.readouterr().out)
    assert public["reason"] == "save_timeout" and public["ok"] is False
    assert code == (4 if proven else 8)
    assert (tmp_path / "close.json").is_file() is proven
    assert worker.save_watchdog_exit(config, worker.IllustratorAgentError("illustrator_timeout", "x")) is None


def test_save_watchdog_source_change_never_closes_and_cap_is_reported(tmp_path, capsys):
    worker = _illustrator_worker()
    config = {"protocol": "beian.illustrator.export/2", "request_kind": "unfolded_print", "attempt_id": "a" * 32, "source_sha256": "b" * 64, "close_json": str(tmp_path / "close.json")}
    observation = {"attempt_id": "a" * 32, "source_sha256": "b" * 64, "bridge_exited": True, "document_count": 0, "documents": []}
    changed = worker.IllustratorAgentError("illustrator_save_timeout", "stalled", details={"source_unchanged": False, "close_observation": observation})
    assert worker.save_watchdog_exit(config, changed) == 8
    assert json.loads(capsys.readouterr().out)["reason"] == "save_source_changed"
    assert not (tmp_path / "close.json").exists()
    capped = worker.IllustratorAgentError("illustrator_recovery_failed", "cap", details={"watchdog_cap": True})
    assert worker.save_watchdog_exit(config, capped) == 6
    assert json.loads(capsys.readouterr().out)["reason"] == "watchdog_restart_cap"
    assert worker.save_watchdog_exit(config, worker.IllustratorAgentError("illustrator_recovery_failed", "x")) is None

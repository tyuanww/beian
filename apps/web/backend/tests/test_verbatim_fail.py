"""失败必须非零退出，不能变成可签字的空命中。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pymupdf

BACKEND = Path(__file__).resolve().parents[1]
PY = sys.executable


def _run(args: list[str], env: dict | None = None) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged["PYTHONPATH"] = str(BACKEND)
    if env:
        merged.update(env)
    return subprocess.run(args, cwd=BACKEND, env=merged, capture_output=True, text=True)


def _fail_json(proc: subprocess.CompletedProcess[str]) -> dict:
    assert proc.returncode != 0, proc.stdout
    line = proc.stderr.strip().splitlines()[-1]
    body = json.loads(line)
    assert body["ok"] is False
    assert "/" not in body["error"]
    return body


def test_hash_mismatch_exits_before_pdf() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "NOTICE").write_text("notice\n", encoding="utf-8")
        for name in (
            "PP-OCRv6_det_small.onnx",
            "PP-OCRv6_rec_medium.onnx",
            "PP-OCRv6_rec_small.onnx",
        ):
            (root / name).write_bytes(b"not-a-model")
        proc = _run([
            PY, "-m", "app.cli", "compare", "--verbatim-check", "--model-dir", str(root),
            "--tid", "0123456789ab", "--excel", "/tmp/missing.xlsx", "--pdf", "/tmp/missing.pdf",
            "--product-name", "t", "--data-dir", str(root / "data"),
        ])
    body = _fail_json(proc)
    assert body["code"] == "model_hash_mismatch"


def test_truncated_result_exits() -> None:
    script = """
import json, sys
from app.cli import _verbatim_fail
from app.verbatim_check import VerbatimFail, guard_stdout
try:
    guard_stdout("x" * 80)
except VerbatimFail as exc:
    raise SystemExit(_verbatim_fail(exc))
"""
    proc = _run([PY, "-c", script], {"VERBATIM_STDOUT_LIMIT": "8"})
    body = _fail_json(proc)
    assert body["code"] == "result_truncated"


def test_egress_is_blocked() -> None:
    script = """
import sys
from app.verbatim_check import block_egress
block_egress()
import urllib.request
try:
    urllib.request.urlopen("http://example.invalid/ocr")
except Exception as exc:
    print(type(exc).__name__)
    raise SystemExit(0 if "VerbatimFail" in type(exc).__name__ or "verbatim" in str(exc) else 3)
raise SystemExit(4)
"""
    proc = _run([PY, "-c", script])
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "VerbatimFail" in proc.stdout
    client = _run([PY, "-c", """
from app.verbatim_check import block_egress
block_egress()
import httpx
try:
    with httpx.Client(timeout=1.0) as client:
        client.post("http://example.invalid/ocr")
except Exception as exc:
    print(type(exc).__name__)
    raise SystemExit(0 if type(exc).__name__ == "VerbatimFail" else 3)
raise SystemExit(4)
"""])
    assert client.returncode == 0, client.stdout + client.stderr
    assert "VerbatimFail" in client.stdout


def test_parse_failure_exits() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        pdf = root / "bad.pdf"
        doc = pymupdf.open()
        doc.new_page()
        a = doc.get_new_xref()
        b = doc.get_new_xref()
        doc.update_object(a, "<< /Length 24 >>")
        doc.update_stream(a, b"%AI24_ZStandard_Data" + b"not-zstd")
        doc.update_object(b, "<< /Length 24 >>")
        doc.update_stream(b, b"%AI24_ZStandard_Data" + b"also-bad")
        cat = doc.pdf_catalog()
        obj = doc.xref_object(cat)
        doc.update_object(cat, obj[:-2] + f" /AIPDFPrivateData1 {a} 0 R /AIPDFPrivateData2 {b} 0 R >>")
        doc.save(pdf)
        doc.close()
        script = f"""
import sys
from pathlib import Path
from app.verbatim_check import VerbatimFail, _private_bytes
try:
    _private_bytes(Path({str(pdf)!r}))
except VerbatimFail as exc:
    print(exc.code)
    raise SystemExit(2)
raise SystemExit(0)
"""
        proc = _run([PY, "-c", script])
    assert proc.returncode == 2, proc.stdout + proc.stderr
    assert "private_data_parse_failed" in proc.stdout or "private_data_limit" in proc.stdout


def test_oom_exit_is_nonzero() -> None:
    script = """
from app.cli import _verbatim_fail
from app.verbatim_check import oom_fail
raise SystemExit(_verbatim_fail(oom_fail()))
"""
    proc = _run([PY, "-c", script])
    body = _fail_json(proc)
    assert body["code"] == "oom"
    assert body["error"] == "这一单认字超出内存"


def test_measured_rss_over_cap_exits_oom() -> None:
    script = """
from app.cli import _verbatim_fail
from app.verbatim_check import RSS_CAP, VerbatimFail, enforce_rss
try:
    enforce_rss(RSS_CAP + 1)
except VerbatimFail as exc:
    raise SystemExit(_verbatim_fail(exc))
raise SystemExit(0)
"""
    proc = _run([PY, "-c", script])
    body = _fail_json(proc)
    assert body["code"] == "oom"


def test_rss_cap_does_not_set_address_space() -> None:
    script = """
import resource
from app.verbatim_check import cap_rss
before = resource.getrlimit(resource.RLIMIT_AS)
cap_rss()
after = resource.getrlimit(resource.RLIMIT_AS)
print(before == after)
"""
    proc = _run([PY, "-c", script])
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "True"

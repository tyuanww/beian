import builtins
import json

from app.cli import cmd_probe


class _Args:
    def __init__(self, target: str):
        self.target = target


def test_probe_python_ok():
    assert cmd_probe(_Args("python")) == 0


def test_probe_unknown():
    assert cmd_probe(_Args("nope")) == 2


def test_probe_python_missing_pypdf(monkeypatch, capsys):
    real_import = builtins.__import__

    def _blocked(name, *a, **k):
        if name == "pypdf":
            raise ImportError("no pypdf")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _blocked)
    assert cmd_probe(_Args("python")) == 2
    err = capsys.readouterr().err.strip().splitlines()[-1]
    payload = json.loads(err)
    assert payload["ok"] is False
    assert "pypdf" in payload["error"]


def test_probe_baidu_unconfigured_carries_problem_code(monkeypatch, capsys):
    import app.config

    monkeypatch.setattr(app.config, "baidu_ak_sk", lambda cfg=None: ("", ""))
    assert cmd_probe(_Args("baidu")) == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "未配置百度 OCR"
    assert payload["code"] == "ocr_unavailable"


def test_job_baidu_unconfigured_carries_problem_code(monkeypatch, capsys):
    """对照 / 对红跑到百度 OCR 才发现没配置：原文照旧，stderr 多带私有码，服务端映射成 ocr_failed。"""
    import sys

    import app.cli
    from app.baidu_ocr import OcrUnavailable

    def _raise(_args):
        raise OcrUnavailable("未配置百度 OCR：backend/.env.baidu")

    monkeypatch.setattr(app.cli, "cmd_rework", _raise)
    monkeypatch.setattr(sys, "argv", ["app.cli", "rework", "--tid", "0123456789ab", "--pdf", "x.pdf"])
    assert app.cli.main() == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert payload["error"] == "未配置百度 OCR：backend/.env.baidu"
    assert payload["code"] == "ocr_unavailable"


def test_job_other_runtime_error_has_no_problem_code(monkeypatch, capsys):
    import sys

    import app.cli

    def _raise(_args):
        raise RuntimeError("百度 OCR 网络失败: timeout")

    monkeypatch.setattr(app.cli, "cmd_rework", _raise)
    monkeypatch.setattr(sys, "argv", ["app.cli", "rework", "--tid", "0123456789ab", "--pdf", "x.pdf"])
    assert app.cli.main() == 2
    payload = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert "code" not in payload


def test_ocr_unavailable_is_still_runtime_error():
    from app.baidu_ocr import OcrUnavailable

    assert issubclass(OcrUnavailable, RuntimeError)

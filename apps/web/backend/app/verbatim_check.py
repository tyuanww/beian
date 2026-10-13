"""逐字核对。只在 verbatim_check 分支内 import，不在 compare_core 顶层。

三份模块不重写。压缩包目录和 /tmp 不插入 sys.path。
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
STATUSES = json.loads((HERE / "verbatim_statuses.json").read_text(encoding="utf-8"))
WARNING = STATUSES["warning"]
FSC_NOTE = STATUSES["fsc_note"]
PAGE_OVER = STATUSES["page_over"]
TRUE_ERRORS = set(STATUSES["true_errors"])
SPACE_ERRORS = set(STATUSES["space_errors"])

MODEL_SHA = {
    "PP-OCRv6_det_small.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    "PP-OCRv6_rec_medium.onnx": "eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b",
    "PP-OCRv6_rec_small.onnx": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
}
DEPS = ("rapidocr", "cv2", "zstandard", "openpyxl", "PIL", "rapidfuzz", "numpy", "pymupdf")
FIX = "重新上传这一单"
PRIVATE_CAP = 256 * 1024 * 1024
RSS_CAP = 2 * 1024 * 1024 * 1024
STDOUT_CAP = 900_000


class VerbatimFail(Exception):
    def __init__(self, error: str, code: str, cause: str) -> None:
        self.error = str(error).strip()[:80]
        self.code = code
        self.cause = str(cause).strip()[:240]
        self.fix = FIX
        super().__init__(self.error)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _forbidden_path(path: str) -> bool:
    real = os.path.realpath(path)
    if real == "/tmp" or real.startswith("/tmp/"):
        return True
    return real.endswith("/ocr_code") or "/ocr_code/" in real


def _strip_forbidden() -> None:
    sys.path[:] = [item for item in sys.path if not _forbidden_path(item)]


def guard_stdout(text: str, limit: int | None = None) -> None:
    cap = STDOUT_CAP if limit is None else limit
    raw = os.environ.get("VERBATIM_STDOUT_LIMIT")
    if limit is None and raw:
        cap = int(raw)
    if len(text.encode("utf-8")) > cap:
        raise VerbatimFail("核对结果写不下", "result_truncated", "stdout limit")


def oom_fail() -> VerbatimFail:
    return VerbatimFail("这一单认字超出内存", "oom", "rss limit")


def rss_used_bytes() -> int:
    import resource

    used = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    if sys.platform == "darwin":
        return used
    return used * 1024


def cap_rss() -> None:
    """Child only. This Mac raises ValueError for any finite RSS limit. That is not a Baidu fallback, and RLIMIT_AS is not used."""
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_RSS, (RSS_CAP, RSS_CAP))
    except (AttributeError, OSError, ValueError):
        return


def enforce_rss(used: int | None = None) -> None:
    """Try the OS RSS cap, then measure. Over the cap exits oom. Never uses RLIMIT_AS."""
    cap_rss()
    try:
        used_bytes = rss_used_bytes() if used is None else used
    except Exception:
        return
    if used_bytes > RSS_CAP:
        raise oom_fail()


def block_egress() -> None:
    """Local weights only. Installed inside the verbatim child, not the old compare path."""
    import socket
    import urllib.request

    def blocked(*_args: object, **_kwargs: object) -> None:
        raise VerbatimFail("本地认字不能访问外网", "dep_missing", "verbatim egress blocked")

    urllib.request.urlopen = blocked  # type: ignore[assignment]
    socket.create_connection = blocked  # type: ignore[assignment]
    try:
        import httpx
    except ImportError:
        return

    class _BlockedClient:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            raise VerbatimFail("本地认字不能访问外网", "dep_missing", "verbatim egress blocked")

        def __enter__(self) -> "_BlockedClient":
            raise VerbatimFail("本地认字不能访问外网", "dep_missing", "verbatim egress blocked")

        def request(self, *_args: object, **_kwargs: object) -> None:
            raise VerbatimFail("本地认字不能访问外网", "dep_missing", "verbatim egress blocked")

    httpx.Client = _BlockedClient  # type: ignore[misc]
    httpx.AsyncClient = _BlockedClient  # type: ignore[misc]
    httpx.request = blocked  # type: ignore[attr-defined]
    httpx.get = blocked  # type: ignore[attr-defined]
    httpx.post = blocked  # type: ignore[attr-defined]


def prepare(model_dir: Path) -> Path:
    """Flag is already on. Do not open the job PDF."""
    cap_rss()
    root = Path(model_dir).expanduser().resolve()
    if not root.is_dir():
        raise VerbatimFail("本地认字模型未安装", "model_missing", "model dir missing")
    notice = root / "NOTICE"
    if not notice.is_file() or notice.stat().st_size <= 0:
        raise VerbatimFail("认字版权声明没放在模型目录旁", "notice_missing", "NOTICE missing")
    for name, expect in MODEL_SHA.items():
        path = root / name
        if not path.is_file():
            raise VerbatimFail("本地认字模型未安装", "model_missing", "model file missing")
        if _sha256(path) != expect:
            raise VerbatimFail("本地认字模型校验失败", "model_hash_mismatch", "model hash mismatch")
    modules = root.parent / "modules"
    missing = [name for name in ("private_text.py", "ai_art.py", "vec_fit.py") if not (modules / name).is_file()]
    if missing:
        raise VerbatimFail("认字依赖没装齐", "dep_missing", "module missing")
    code = root.parent / "code" / "ocr_code"
    if not (code / "check2.py").is_file() or not (code / "glyphs.py").is_file():
        raise VerbatimFail("认字依赖没装齐", "dep_missing", "prototype missing")
    for name in DEPS:
        if importlib.util.find_spec(name) is None:
            raise VerbatimFail("认字依赖没装齐", "dep_missing", "import missing")
    return root


def _load_prototype(model_dir: Path) -> Any:
    modules = model_dir.parent / "modules"
    code = model_dir.parent / "code" / "ocr_code"
    if str(modules) not in sys.path:
        sys.path.insert(0, str(modules))
    _strip_forbidden()
    glyphs_spec = importlib.util.spec_from_file_location("glyphs", code / "glyphs.py")
    if glyphs_spec is None or glyphs_spec.loader is None:
        raise VerbatimFail("认字依赖没装齐", "dep_missing", "glyphs load failed")
    glyphs = importlib.util.module_from_spec(glyphs_spec)
    sys.modules["glyphs"] = glyphs
    glyphs_spec.loader.exec_module(glyphs)
    _strip_forbidden()
    if not getattr(glyphs, "EXCLUDE_LAYERS", None):
        raise VerbatimFail("认字依赖没装齐", "dep_missing", "EXCLUDE_LAYERS missing")
    source = (code / "check2.py").read_text(encoding="utf-8")
    source = source.replace("sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n", "")
    prototype = importlib.util.module_from_spec(importlib.util.spec_from_loader("verbatim_check2", loader=None))
    prototype.__dict__["__file__"] = str(code / "check2.py")
    exec(compile(source, str(code / "check2.py"), "exec"), prototype.__dict__)
    _strip_forbidden()
    _bind_models(model_dir)
    return prototype


def _bind_models(model_dir: Path) -> None:
    import rapidocr

    rec = str(model_dir / "PP-OCRv6_rec_medium.onnx")
    det = str(model_dir / "PP-OCRv6_det_small.onnx")
    original = rapidocr.RapidOCR

    def bound(*args: object, **kwargs: object) -> object:
        params = dict(kwargs.get("params") or {})
        params["Rec.model_path"] = rec
        params["Det.model_path"] = det
        kwargs["params"] = params
        return original(*args, **kwargs)

    rapidocr.RapidOCR = bound  # type: ignore[misc]


def _private_bytes(pdf: Path) -> bytes | None:
    import pymupdf

    holder: dict[str, object] = {}

    def work() -> None:
        doc = pymupdf.open(pdf)
        try:
            from private_text import private

            data = private(doc)
            if data is not None and len(data) > PRIVATE_CAP:
                holder["limit"] = True
            else:
                holder["data"] = data
        except Exception as exc:  # noqa: BLE001 — 解析失败必须关闭，不回落
            holder["error"] = type(exc).__name__
        finally:
            doc.close()

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(60)
    if thread.is_alive():
        raise VerbatimFail("私有数据解析失败", "private_data_limit", "decompress timed out")
    if holder.get("limit"):
        raise VerbatimFail("私有数据解析失败", "private_data_limit", "decompress too large")
    if "error" in holder:
        raise VerbatimFail("私有数据解析失败", "private_data_parse_failed", "private parse failed")
    data = holder.get("data")
    if data is None:
        return None
    return data if isinstance(data, bytes) else None


def _matrix_of(page: dict) -> list[float]:
    matrix = page.get("matrix")
    if not isinstance(matrix, list) or len(matrix) != 6:
        raise VerbatimFail("私有数据解析失败", "private_data_parse_failed", "render matrix missing")
    return [float(item) for item in matrix]


def _page_px(box: object, matrix: list[float]) -> dict[str, int] | None:
    if not isinstance(box, (list, tuple)) or len(box) < 4:
        return None
    a, b, c, d, e, f = matrix
    x0, y0, x1, y1 = (float(box[0]), float(box[1]), float(box[2]), float(box[3]))
    pts = ((a * x0 + c * y0 + e, b * x0 + d * y0 + f), (a * x1 + c * y1 + e, b * x1 + d * y1 + f))
    left, right = sorted(pt[0] for pt in pts)
    top, bottom = sorted(pt[1] for pt in pts)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        return None
    return {"left": int(left), "top": int(top), "width": max(2, int(round(width))), "height": max(2, int(round(height)))}


def _cover_neighbors(box: dict[str, int] | None, page_size: tuple[int, int]) -> dict[str, int] | None:
    """Space gap has no ink. Extend sideways by one line height so the adjacent glyphs sit in the box."""
    if not box:
        return box
    page_w, page_h = page_size
    pad = max(box["height"], 2)
    left = max(0, box["left"] - pad)
    right = box["left"] + box["width"] + pad
    if page_w > 1:
        right = min(page_w, right)
    width = max(2, right - left)
    if page_w > 1 and page_h > 1 and width > page_w * 0.9 and box["height"] > page_h * 0.9:
        return box
    return {**box, "left": left, "width": width}


def _status(op: dict) -> tuple[str, bool] | None:
    kind = str(op.get("type") or "")
    verdict = str(op.get("verdict") or "")
    if verdict == "ok":
        return None
    if kind in SPACE_ERRORS:
        return kind, verdict == "confirmed"
    if kind == "漏识" or verdict == "review":
        return "待人工确认", False
    if verdict == "nomatch" or kind == "片段无对应":
        return "稿件有但确认单没有", True
    if verdict == "confirmed" and kind in TRUE_ERRORS:
        return kind, True
    return "待人工确认", False


def _note(op: dict) -> str:
    ctx = op.get("ctx") or ((), ())
    exp = op.get("exp_ctx") or ((), ())
    left = "".join(ctx[0]) if isinstance(ctx, (list, tuple)) and ctx else ""
    right = "".join(ctx[1]) if isinstance(ctx, (list, tuple)) and len(ctx) > 1 else ""
    eleft = "".join(exp[0]) if isinstance(exp, (list, tuple)) and exp else ""
    eright = "".join(exp[1]) if isinstance(exp, (list, tuple)) and len(exp) > 1 else ""
    return (left + right + eleft + eright)[:80]


def _hit(index: int, status: str, blocking: bool, op: dict, box: dict[str, int] | None, page: int) -> dict[str, Any]:
    hit: dict[str, Any] = {
        "id": f"V{index:03d}",
        "field": status,
        "status": status,
        "excel_value": str(op.get("exp") or ""),
        "pdf": str(op.get("got") or ""),
        "page": page,
        "decision": "pending" if blocking else None,
        "score": op.get("p") or 0,
        "evidence": _note(op),
        "bboxes": [],
        "bbox_space": "page_px",
        "no_bbox": box is None,
    }
    if box is not None:
        hit["bboxes"] = [{**box, "page": page, "role": "hit", "bbox_space": "page_px"}]
    return hit


def _fsc(text: str) -> bool:
    return "FSC" in text or "认证码" in text or "★" in text or "☆" in text


def _warning_hits(doc: Any, matrix: list[float], page_size: tuple[int, int]) -> list[dict[str, Any]]:
    page = doc[0]
    width, height = page_size
    hits = []
    index = 1
    for block in page.get_text("blocks") or []:
        if len(block) < 5 or not str(block[4] or "").strip():
            continue
        box = _page_px(block[:4], matrix)
        if box and width > 1 and height > 1 and box["width"] > width * 0.9 and box["height"] > height * 0.9:
            box = None
        hits.append(_hit(index, "待人工确认", False, {"exp": "", "got": "", "p": 0}, box, 1))
        index += 1
        if index > 40:
            break
    return hits


def compare_pdf(pdf: Path, xlsx: Path, model_dir: Path, pages: list[dict]) -> dict[str, Any]:
    block_egress()
    os.environ["OCR_MODEL"] = "v6m"
    modules = str(model_dir.parent / "modules")
    if modules not in sys.path:
        sys.path.insert(0, modules)
    _strip_forbidden()
    if not pages:
        raise VerbatimFail(PAGE_OVER, "page_over_rendered", "nothing rendered")
    matrix = _matrix_of(pages[0])
    page_size = (int(pages[0].get("width") or 0), int(pages[0].get("height") or 0))
    private = _private_bytes(pdf)
    if private is None:
        import pymupdf

        doc = pymupdf.open(pdf)
        try:
            hits = _warning_hits(doc, matrix, page_size)
        finally:
            doc.close()
        return {"hits": hits, "verbatim_warning": WARNING, "engine": "rapidocr:ppocrv6-medium"}
    prototype = _load_prototype(model_dir)
    import pymupdf

    doc = pymupdf.open(pdf)
    try:
        _page, blocks, _excluded, _rec, _canvas, _fit = prototype.build_blocks(doc)
    except Exception as exc:  # noqa: BLE001
        raise VerbatimFail("私有数据解析失败", "private_data_parse_failed", "block split failed") from exc
    rows, corpus = prototype.load_excel(str(xlsx))
    segs: list[dict] = []
    for block in blocks:
        segs.extend(prototype.segment_block(block, rows))
    blocks = segs
    corpus["stamp_all"] = "\u0001".join(
        "".join(char["c"] for char in block["chars"] if not char.get("punct")) for block in blocks
    ).lower()
    joined = []
    hits: list[dict[str, Any]] = []
    for block in blocks:
        draft = "".join(char["c"] for char in block["chars"])
        joined.append(draft)
        core = "".join(char["c"] for char in block["chars"] if not char.get("blank") and not char.get("punct"))
        result = {"status": "nontext", "ops": []} if len(core) < 2 else prototype.compare_block(block, corpus, rows, _rec, _canvas)
        if result.get("status") in ("nontext", "skip", "noncopy"):
            continue
        for op in result.get("ops") or []:
            mapped = _status(op)
            if mapped is None:
                continue
            status, blocking = mapped
            box = _page_px(op.get("box"), matrix)
            if status in SPACE_ERRORS:
                box = _cover_neighbors(box, page_size)
            hits.append(_hit(len(hits) + 1, status, blocking, op, box, 1))
    doc.close()
    out: dict[str, Any] = {"hits": hits, "engine": "rapidocr:ppocrv6-medium"}
    if _fsc("\n".join(joined)):
        out["fsc_note"] = FSC_NOTE
    enforce_rss()
    return out


def render_or_fail(pdf: Path, out_dir: Path, max_pages: int) -> list[dict]:
    import pymupdf

    from app.pdf_render import render_pdf_pages

    doc = pymupdf.open(pdf)
    try:
        page_count = doc.page_count
    finally:
        doc.close()
    rendered = render_pdf_pages(pdf, out_dir, max_pages=max_pages)
    if page_count > len(rendered):
        raise VerbatimFail(PAGE_OVER, "page_over_rendered", "pdf longer than rendered pages")
    return rendered

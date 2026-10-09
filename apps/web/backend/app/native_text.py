"""Bounded native-text evidence. Render equality is checked before OCR correction.

Candidates are never business conclusions; corrected words re-enter verify_fields.
No native process, network or OCR is launched here.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
import pymupdf

VERSION = "native-text/1"
MAX_JSON = 8 * 1024 * 1024
MAX_CANDIDATES = 10_000
MAX_CANDIDATES_PER_PAGE = 2_000
MAX_SPANS_PER_PAGE = 10_000
MAX_SPAN_CHARS_PER_PAGE = 1_000_000
MAX_SPAN_CHARS = 8_192
MAX_PAGE_CONTENT_BYTES = 16 * 1024 * 1024


def words_from_candidates(candidates: list[dict]) -> list[dict]:
    """把已经通过稿面证明的原生候选转换成字段匹配使用的词框。"""
    words: list[dict] = []
    for candidate in candidates or []:
        box = candidate.get("bbox")
        text = str(candidate.get("text") or "").strip()
        if not text or not isinstance(box, list) or len(box) != 4:
            continue
        try:
            left, top, right, bottom = (float(value) for value in box)
        except (TypeError, ValueError):
            continue
        if right <= left or bottom <= top:
            continue
        words.append(
            {
                "text": text,
                "page": int(candidate.get("page") or 1),
                "location": {
                    "left": int(left),
                    "top": int(top),
                    "width": max(1, int(right - left)),
                    "height": max(1, int(bottom - top)),
                },
                "source": "illustrator_native",
            }
        )
    return words


def _json(path: Path) -> dict:
    if path.is_symlink() or path.stat().st_size > MAX_JSON:
        raise ValueError("native_limit")
    value = json.loads(path.read_text(encoding="utf-8"))
    stack = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        if depth > 64:
            raise ValueError("native_limit")
        if isinstance(item, dict):
            stack.extend((v, depth + 1) for v in item.values())
        elif isinstance(item, list):
            stack.extend((v, depth + 1) for v in item)
    if not isinstance(value, dict):
        raise ValueError("native_invalid")
    return value


def source_hash(path: Path) -> str:
    if path.is_symlink() or path.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("source_changed")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _overlap(a: list[float], b: list[float]) -> float:
    inter = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0


def _page_content_within_limit(page: pymupdf.Page) -> bool:
    """在进入 PyMuPDF 文字设备前，拒绝过大的原始页面内容流。

    `get_text("dict")` / `get_texttrace()` 会在 C 层一次性构造结果，无法
    从 Python 侧逐条中止。先检查未解压的内容流大小和图像资源数量，把
    最容易造成解压膨胀的页面退回 OCR；文字行/trace 数量仍在提取后再次
    设上限，避免把原生路径当成无限资源通道。
    """
    try:
        contents = page.get_contents() or []
        raw_bytes = 0
        for xref in contents:
            raw_bytes += len(page.parent.xref_stream_raw(int(xref)))
            if raw_bytes > MAX_PAGE_CONTENT_BYTES:
                return False
        return len(page.get_images(full=True) or []) <= 256
    except (AttributeError, OSError, RuntimeError, TypeError, ValueError):
        return False


def load_candidates(directory: Path | None, source: Path, metas: list[dict]) -> tuple[list[dict], str | None]:
    if directory is None:
        return [], None
    try:
        if directory.is_symlink() or directory.parent.resolve() != source.parent.resolve() or not directory.name.startswith(".native-"):
            raise ValueError("native_invalid")
        result = _json(directory / "result.json")
        close = _json(directory / "close.json")
        sha = source_hash(source)
        if result.get("source_sha256") != sha or close.get("source_sha256") != sha:
            raise ValueError("source_changed")
        if result.get("extractor_version") != VERSION or result.get("success") is not True:
            raise ValueError("native_invalid")
        if any(record.get("protocol") != "beian.illustrator.export/2" or record.get("request_kind") != "native_text" for record in (result, close)):
            raise ValueError("native_invalid")
        if not result.get("attempt_id") or close.get("attempt_id") != result["attempt_id"] or directory.name != ".native-" + result["attempt_id"]:
            raise ValueError("native_invalid")
        if close.get("document_closed") is not True or close.get("bridge_exited") is not True or close.get("inflight") is not False or close.get("lock_returnable") is not True:
            raise ValueError("close_unconfirmed")
        candidates = result.get("candidates")
        if not isinstance(candidates, list) or len(candidates) > MAX_CANDIDATES:
            raise ValueError("native_limit")
        proof_path = directory / "print.pdf"
        if proof_path.is_symlink() or proof_path.stat().st_size > 128 * 1024 * 1024:
            raise ValueError("native_limit")
        safe = []
        with pymupdf.open(source) as original, pymupdf.open(proof_path) as proof:
            if len(original) != len(proof) or len(original) > 20:
                raise ValueError("native_mapping_unconfirmed")
            pages = result.get("pages") or []
            if len(pages) != len(proof):
                raise ValueError("native_mapping_unconfirmed")
            candidates_by_page: dict[int, list[dict]] = {}
            for candidate in candidates:
                if isinstance(candidate, dict):
                    try:
                        candidates_by_page.setdefault(int(candidate.get("page") or 0), []).append(candidate)
                    except (TypeError, ValueError):
                        continue
            for meta in metas:
                index = int(meta["page"]) - 1
                before, after = original[index], proof[index]
                p = pages[index]
                if before.rotation or after.rotation or before.rect != after.rect or abs(float(p["width"]) - before.rect.width) > .01 or abs(float(p["height"]) - before.rect.height) > .01:
                    continue
                page_candidates = candidates_by_page.get(index + 1, [])
                # Check both source and proof streams before any raster or text
                # device runs. A large/hostile page must fail closed before
                # PyMuPDF can inflate it in C code.
                if (
                    len(page_candidates) > MAX_CANDIDATES_PER_PAGE
                    or not _page_content_within_limit(before)
                    or not _page_content_within_limit(after)
                ):
                    raise ValueError("native_limit")
                # Bounded full-page rendering proves the native snapshot is the
                # current visible artwork, not stale private Illustrator data.
                scale = min(2, 2400 / max(before.rect.width, before.rect.height))
                matrix = pymupdf.Matrix(scale, scale)
                a, b = before.get_pixmap(matrix=matrix, alpha=False), after.get_pixmap(matrix=matrix, alpha=False)
                if a.width != b.width or a.height != b.height or a.samples != b.samples:
                    continue
                span_index: dict[str, list[list[float]]] = {}
                span_count = 0
                span_chars = 0
                for block in after.get_text("dict")["blocks"]:
                    for line in block.get("lines", []):
                        value = "".join(s["text"] for s in line["spans"])
                        if len(value) > MAX_SPAN_CHARS:
                            raise ValueError("native_limit")
                        span_count += 1
                        span_chars += len(value)
                        if span_chars > MAX_SPAN_CHARS_PER_PAGE:
                            raise ValueError("native_limit")
                        if span_count > MAX_SPANS_PER_PAGE:
                            raise ValueError("native_limit")
                        key = "".join(value.split())
                        if key:
                            span_index.setdefault(key, []).append(list(line["bbox"]))
                trace_index: dict[str, list[list[float]]] = {}
                trace_count = 0
                trace_chars = 0
                for trace in after.get_texttrace():
                    trace_count += 1
                    chars = trace.get("chars") or []
                    trace_chars += len(chars)
                    if trace_count > MAX_SPANS_PER_PAGE or trace_chars > MAX_SPAN_CHARS_PER_PAGE:
                        raise ValueError("native_limit")
                    if trace.get("type") not in (0, 1) or float(trace.get("opacity") or 0) <= 0:
                        continue
                    value = "".join(chr(int(char[0])) for char in chars if char)
                    key = "".join(value.split())
                    bbox = trace.get("bbox")
                    if key and isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                        trace_index.setdefault(key, []).append(list(bbox))
                for c in page_candidates:
                    if c.get("visible") is not True or c.get("font_available") is not True or not c.get("font"):
                        continue
                    text, box = c.get("text"), c.get("bbox")
                    if not isinstance(text, str) or not text.strip() or len(text) > 8192 or not isinstance(box, list) or len(box) != 4 or not all(isinstance(n, (int, float)) and math.isfinite(n) for n in box):
                        continue
                    rect = pymupdf.Rect(box)
                    if rect.is_empty or not before.rect.contains(rect):
                        continue
                    # A native frame also has to survive into the visible export
                    # as that exact text at that position. Mere bbox overlap fails.
                    key = "".join(text.split())
                    span_matches = [bb for bb in span_index.get(key, []) if _overlap(box, bb) >= .5]
                    trace_matches = [bb for bb in trace_index.get(key, []) if _overlap(box, bb) >= .5]
                    if len(span_matches) != 1 or len(trace_matches) != 1:
                        continue
                    sx, sy = meta["width"] / before.rect.width, meta["height"] / before.rect.height
                    safe.append({"text": text, "page": index + 1, "bbox": [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy], "object_id": str(c.get("object_id") or "")})
        if source_hash(source) != sha:
            raise ValueError("source_changed")
        return safe, None if safe else "native_mapping_unconfirmed"
    except (OSError, ValueError, TypeError, KeyError, IndexError, RuntimeError, RecursionError, MemoryError):
        return [], "native_mapping_unconfirmed"


def fuse_words(text: str, words: list[dict], candidates: list[dict]) -> tuple[str, list[dict], list[dict]]:
    if len(words) * (len(words) + len(candidates)) > 2000000:
        return text, words, []
    output = [dict(word) for word in words]
    audit = []
    for index, word in enumerate(words):
        loc = word.get("location") or {}
        x, y = float(loc.get("left", 0)), float(loc.get("top", 0))
        box = [x, y, x + float(loc.get("width", 0)), y + float(loc.get("height", 0))]
        matches = [c for c in candidates if c["page"] == int(word.get("page") or 1) and _overlap(box, c["bbox"]) >= .65]
        if len(matches) != 1:
            continue
        candidate = matches[0]
        # Require a one-to-one OCR/frame assignment, not a large frame consuming
        # unrelated image text or two OCR words claiming the same native frame.
        overlaps = 0
        for other in words:
            location = other.get("location") or {}
            ox, oy = float(location.get("left", 0)), float(location.get("top", 0))
            ob = [ox, oy, ox + float(location.get("width", 0)), oy + float(location.get("height", 0))]
            if int(other.get("page") or 1) == candidate["page"] and _overlap(ob, candidate["bbox"]) >= .2:
                overlaps += 1
        old, new = str(word.get("text") or ""), candidate["text"]
        used = overlaps == 1 and bool(old) and (old == new or text.count(old) == 1)
        audit.append({"status": "used" if used else "conflict", "native_text": new, "ocr_text": old, "page": candidate["page"], "bbox": box})
        if used:
            output[index]["text"] = new
            if old != new:
                text = text.replace(old, new, 1)
    return text, output, audit



def fuse_with_audit(directory: Path | None, source: Path, text: str, words: list[dict], candidates: list[dict]) -> tuple[str, list[dict], list[dict]]:
    corrected, output, audit = fuse_words(text, words, candidates)
    if not audit:
        return corrected, output, audit
    if directory is None:
        return text, words, []
    temporary = None
    try:
        result = _json(directory / "result.json")
        sha = source_hash(source)
        if result.get("source_sha256") != sha:
            raise ValueError("source_changed")
        payload = json.dumps({"version": VERSION, "attempt_id": result["attempt_id"],
                              "source_sha256": sha, "evidence": audit}, ensure_ascii=False).encode("utf-8")
        if len(payload) > MAX_JSON:
            raise ValueError("native_limit")
        with tempfile.NamedTemporaryFile(dir=directory, prefix=".fusion-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if source_hash(source) != sha:
            raise ValueError("source_changed")
        os.replace(temporary, directory / "fusion-audit.json")
        return corrected, output, audit
    except (OSError, ValueError, KeyError):
        # Keep the original OCR whenever complete evidence cannot be retained.
        return text, words, []
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def attach_evidence(hits: list[dict], audit: list[dict]) -> None:
    for hit in hits:
        related = []
        for evidence in audit:
            for box in hit.get("bboxes") or []:
                x, y = float(box.get("left", 0)), float(box.get("top", 0))
                rect = [x, y, x + float(box.get("width", 0)), y + float(box.get("height", 0))]
                if int(box.get("page") or hit.get("page") or 1) == evidence["page"] and _overlap(rect, evidence["bbox"]) > .2:
                    related.append(evidence)
                    break
        if not related:
            continue
        status = "conflict" if any(e["status"] == "conflict" for e in related) else "used"
        native = "\n".join(str(e.get("native_text") or "") for e in related)
        ocr_parts = [str(e["ocr_text"]) for e in related if isinstance(e.get("ocr_text"), str) and e.get("ocr_text")]
        ocr = "\n".join(ocr_parts) if ocr_parts else None
        # Full readings remain in the private fusion audit; never label a
        # silently truncated compact card as the complete source evidence.
        if len(native) > 8192 or len(ocr or "") > 8192:
            continue
        message = "两种文字来源无法唯一对应，请对照稿面。" if status == "conflict" else (
            "原稿文字已直接参与核对规则。" if not ocr else "已核对可见稿面及文字位置，原稿文字已参与现有核对规则。"
        )
        hit["native_text_evidence"] = {"version": 1, "status": status, "native_text": native, "ocr_text": ocr, "message": message}

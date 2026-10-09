"""Excel↔PDF 对照核心。只给 `python -m app.cli` 用，不依赖 HTTP。"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import config, layout_zones, pack_profile, text_verify, native_text
from app.baidu_ocr import qrcode_image_bytes
from app.claims_rules import build_claims_report
from app.field_verify import clip_hit_bboxes, verify_fields
from app.fields import key_phrases, normalize, normalize_units, numeric_code_in_text, parse_excel_fields
from app.layout_zones import skip_sheet_field
from app.pack_layout import detect_regions, words_in_roles
from app.pdf_ingest import FULL_PAGE_IMAGE_MIN_COVERAGE, ingest_pdf, public_ingest
from app.pdf_render import render_pdf_pages
from app.region_ocr import recognize_pages

ROOT = Path(__file__).resolve().parents[1]
TID_RE = re.compile(r"^[0-9a-f]{12}$")
DATA: Path
TASKS: Path
UPLOADS: Path
NATIVE_DIR: Path | None = None
NATIVE_ATTEMPTED = False
NATIVE_ONLY_MAX_CANDIDATES = 10_000


def init_paths(data_dir: Path | None = None) -> Path:
    """解析 worker 数据目录；不加载登录 session。"""
    global DATA, TASKS, UPLOADS
    raw = data_dir or os.environ.get("WB_DATA_DIR") or config.get("WB_DATA_DIR") or str(ROOT / "data")
    DATA = Path(str(raw)).expanduser().resolve()
    if config.public_mode() and DATA == (ROOT / "data").resolve():
        raise RuntimeError("WB_PUBLIC=1 时必须设置 WB_DATA_DIR，且不能落在 git 工作树内")
    if config.public_mode() and not config.truthy("AUTH_REQUIRE_KNOWN", True):
        raise RuntimeError("WB_PUBLIC=1 时 AUTH_REQUIRE_KNOWN 必须为 true")
    TASKS = DATA / "tasks"
    UPLOADS = DATA / "uploads"
    TASKS.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    return DATA


init_paths()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def assert_tid(tid: str) -> str:
    if not TID_RE.fullmatch(tid or ""):
        raise ValueError("无效任务 id")
    return tid


def load_task(tid: str) -> dict[str, Any]:
    path = TASKS / f"{assert_tid(tid)}.json"
    if not path.exists():
        raise FileNotFoundError("任务不存在")
    return json.loads(path.read_text(encoding="utf-8"))


def clamp_max_pages(raw: int) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = 2
    return max(1, min(n, 4))


def _summary(hits: list[dict]) -> dict[str, int]:
    s = {"一致": 0, "疑点": 0, "缺失": 0, "跳过": 0}
    for h in hits:
        st = h.get("status") or "疑点"
        if st not in s:
            st = "疑点"
        s[st] = s.get(st, 0) + 1
    return s


def _ocr_pages(
    page_metas: list[dict], ingested: dict | None = None, *, force_ocr: bool = False
) -> tuple[str, list[dict], str, dict]:
    """单引擎认字。活字跳过 OCR；禁止 zone_boost / Paddle-VL 拼进同一词表。"""
    return recognize_pages(page_metas, ingested, force_ocr=force_ocr)


def _native_coverage(fields: list[dict], source_text: str) -> dict[str, int]:
    """用严格规范化的确认单短语判断原生文字是否覆盖本次核对输入。

    native-only 是跳过 OCR 的安全门，不能复用面向 OCR 容错的模糊/前缀
    匹配；单位归一仍保留，但任何缺字、软锚点或 fuzzy 命中都必须回退 OCR。
    """
    total = 0
    matched = 0
    normalized_source = normalize(source_text)
    normalized_units = normalize_units(source_text)
    for field in fields or []:
        name = str(field.get("field") or "")
        value = str(field.get("excel_value") or "").strip()
        if skip_sheet_field(name) or not value:
            continue
        if field.get("remark"):
            value = f"{value}\n{field.get('remark')}"
        phrases = key_phrases(value)
        for phrase in phrases:
            normalized_phrase = normalize(phrase)
            if len(normalized_phrase) < 3:
                continue
            total += 1
            normalized_unit_phrase = normalize_units(phrase)
            phrase_match = (
                numeric_code_in_text(normalized_phrase, normalized_source)
                if normalized_phrase.isdigit()
                else normalized_phrase in normalized_source
            )
            unit_match = (
                numeric_code_in_text(normalized_unit_phrase, normalized_units)
                if normalized_unit_phrase.isdigit()
                else normalized_unit_phrase in normalized_units
            )
            if phrase_match or unit_match:
                matched += 1
    return {"matched": matched, "total": total}


def _native_only_gate(
    ingested: dict[str, Any], candidates: list[dict], fields: list[dict]
) -> tuple[bool, dict[str, Any]]:
    """决定原生候选能否成为本次审稿的主文字来源。

    只在候选已经通过 native_text 的稿面/关闭证明、每页仍是纯活字页、
    并覆盖确认单全部可核对短语时跳过 OCR。任何不确定都回到原有 OCR。
    """
    pages = ingested.get("pages") or []
    if not candidates:
        return False, {"status": "unavailable", "reason": "no_candidates", "matched": 0, "total": 0}
    if len(candidates) > NATIVE_ONLY_MAX_CANDIDATES:
        return False, {"status": "fallback", "reason": "candidate_limit", "matched": 0, "total": 0}
    page_numbers = {
        int(page.get("page") or 0)
        for page in pages
        if int(page.get("page") or 0) > 0
    }
    candidate_pages = {
        int(candidate.get("page") or 0)
        for candidate in candidates
        if int(candidate.get("page") or 0) > 0
    }
    if page_numbers - candidate_pages:
        return False, {
            "status": "fallback",
            "reason": "page_coverage_incomplete",
            "matched": 0,
            "total": 0,
        }
    if any(str(page.get("mode") or "") != "live_text" for page in pages):
        return False, {"status": "fallback", "reason": "non_live_page", "matched": 0, "total": 0}
    if any(float(page.get("image_coverage") or 0) >= FULL_PAGE_IMAGE_MIN_COVERAGE for page in pages):
        return False, {"status": "fallback", "reason": "image_content", "matched": 0, "total": 0}
    candidate_text = "\n".join(
        str(candidate.get("text") or "").strip()
        for candidate in candidates
        if str(candidate.get("text") or "").strip()
    )
    # The PDF text layer is not a visibility proof. A hidden, clipped, or
    # off-canvas span must never be able to satisfy the native-only gate.
    coverage = _native_coverage(fields, candidate_text)
    if coverage["total"] <= 0 or coverage["matched"] < coverage["total"]:
        return False, {"status": "fallback", "reason": "coverage_incomplete", **coverage}
    return True, {"status": "ready", "reason": "native_coverage", **coverage}


def _attach_page_size(words: list[dict], page_metas: list[dict]) -> None:
    """把渲染画布尺寸附在内部 OCR 词上，供绝对坐标裁剪使用。"""
    metas = {int(meta.get("page") or 1): meta for meta in page_metas or []}
    for word in words or []:
        meta = metas.get(int(word.get("page") or 1))
        if not meta:
            continue
        word["_page_width"] = int(meta.get("width") or 0)
        word["_page_height"] = int(meta.get("height") or 0)


def _qrcode_pages(page_metas: list[dict]) -> tuple[list[dict], dict]:
    """
    各页二维码识别。
    返回 (codes[{text, location, page}], meta)
    meta.ok / error / degraded 显式，不静默吞掉。
    """
    out: list[dict] = []
    errors: list[str] = []
    pages_tried = 0
    for meta in page_metas:
        pages_tried += 1
        try:
            data = Path(meta["path"]).read_bytes()
            codes, cmeta = qrcode_image_bytes(data)
            for c in codes:
                c = dict(c)
                c["page"] = meta["page"]
                out.append(c)
        except Exception as e:
            errors.append(f"page{meta.get('page')}:{e}")
    if out:
        status = "ok"
    elif errors:
        status = "error"
    else:
        status = "empty"
    meta = {
        "status": status,
        "codes": len(out),
        "pages_tried": pages_tried,
        "errors": errors[:5],
        "degraded": status != "ok",
        "message": (
            "二维码 API 命中"
            if status == "ok"
            else (
                "二维码 API 失败，已降级为文案引导匹配：" + (errors[0][:120] if errors else "")
                if status == "error"
                else "二维码 API 无结果，降级为文案引导匹配"
            )
        ),
    }
    return out, meta


def _apply_qrcode_to_hits(
    hits: list[dict],
    qrcodes: list[dict],
    qr_meta: dict | None = None,
) -> list[dict]:
    """Attach QR payload audit data without changing guide-text decisions."""
    qr_meta = qr_meta or {}
    qr_texts = [str(q.get("text") or "").strip() for q in qrcodes if q.get("text")]
    boxes = []
    for q in qrcodes:
        loc = q.get("location") or {}
        if loc.get("width") or loc.get("height"):
            boxes.append(
                {
                    "page": int(q.get("page") or 1),
                    "left": loc.get("left", 0),
                    "top": loc.get("top", 0),
                    "width": loc.get("width", 0),
                    "height": loc.get("height", 0),
                }
            )
    for h in hits:
        field = h.get("field") or ""
        fg = h.get("field_group") or ""
        if "二维码" not in field and "QR" not in field.upper() and fg != "二维码":
            continue
        h["qrcode_meta"] = qr_meta
        if boxes:
            h["qrcode_boxes"] = boxes
            if not (h.get("bboxes") or []):
                h["page"] = boxes[0]["page"]
        if qr_texts:
            joined = " | ".join(qr_texts[:5])
            h["qrcode_values"] = qr_texts
            h["qrcode_payload_evidence"] = f"二维码载荷已解出：{joined[:120]}"
        else:
            h["qrcode_degraded"] = True
    return hits


def _page_urls(tid: str, page_metas: list[dict], side: str | None = None) -> list[dict]:
    out = []
    for m in page_metas:
        raster_name = m["name"]
        review_name = m.get("review_name") or raster_name
        if side:
            url = f"/api/tasks/{tid}/pages/{side}/{review_name}"
            raster_url = f"/api/tasks/{tid}/pages/{side}/{raster_name}"
        else:
            url = f"/api/tasks/{tid}/pages/{review_name}"
            raster_url = f"/api/tasks/{tid}/pages/{raster_name}"
        out.append(
            {
                "url": url,
                "raster_url": raster_url,
                "page": m["page"],
                "width": m["width"],
                "height": m["height"],
                "name": raster_name,
                "review_name": review_name,
                "review_format": m.get("review_format") or "png",
            }
        )
    return out


def emit_stage(name: str) -> None:
    print(f"STAGE {name}", file=sys.stderr, flush=True)


def _surface_job(
    *,
    tid: str,
    pdf: Path,
    pages_subdir: str,
    max_pages: int,
    surface_label: str,
    fields: list[dict],
    title: str,
    filename: str,
) -> dict[str, Any]:
    """单面（花盒或膜袋）OCR + 匹配，返回中间结果。"""
    pages_dir = UPLOADS / tid / "pages" / pages_subdir
    pages_dir.mkdir(parents=True, exist_ok=True)
    emit_stage("render_pdf")
    page_metas = render_pdf_pages(pdf, pages_dir, max_pages=max_pages, quality="high")
    emit_stage("ingest")
    ingested = ingest_pdf(pdf, page_metas, max_pages=max_pages)
    layer_text = ingested.get("layer_text") or ""
    has_layer = bool(ingested.get("has_layer"))
    layer_px = ingested.get("spans") or []
    layer_words = text_verify.words_from_text_blocks(layer_px)
    candidates, native_reason = native_text.load_candidates(NATIVE_DIR, pdf, page_metas)
    candidate_budget_ok = len(candidates) <= NATIVE_ONLY_MAX_CANDIDATES
    native_words = native_text.words_from_candidates(candidates) if candidate_budget_ok else []
    native_blob = "\n".join(word.get("text") or "" for word in native_words)
    native_only, native_gate = _native_only_gate(ingested, candidates, fields)
    emit_stage("ocr")
    # `load_candidates` returns an empty list when a native attempt exists but
    # is rejected by its mapping/size/close checks. That is still an attempted
    # native source, so live_text must not silently reuse the PDF layer.
    native_attempted = NATIVE_ATTEMPTED or bool(candidates) or native_reason is not None
    native_fallback_ocr = native_attempted and not native_only
    if native_only:
        # 只使用已经通过稿面证明的 Illustrator 候选。PDF 文字层只能沿用
        # 原有 live_text 路由，不能成为跳过 OCR 的可见性证明。
        ocr_text, ocr_words = native_blob, native_words
        ocr_engine = "illustrator_native"
        ocr_meta = {
            "skipped": True,
            "reason": "native_coverage",
            "union": False,
            "engines": ["illustrator_native"],
            "pages_ran": 0,
            "words": len(ocr_words),
            "native_coverage": {"matched": native_gate["matched"], "total": native_gate["total"]},
        }
        native_audit = [
            {
                "status": "used",
                "native_text": candidate.get("text") or "",
                "ocr_text": None,
                "page": int(candidate.get("page") or 1),
                "bbox": candidate.get("bbox") or [],
            }
            for candidate in candidates
        ]
    else:
        # A partial Illustrator result is not a license to trust a stale PDF
        # layer. Force the raster OCR route for every page, including pages
        # classified as live_text, until the native gate is complete.
        if native_fallback_ocr:
            ocr_text, ocr_words, ocr_engine, ocr_meta = _ocr_pages(
                page_metas, ingested, force_ocr=True
            )
        else:
            # Keep the existing seam for host-unavailable/no-candidate paths.
            ocr_text, ocr_words, ocr_engine, ocr_meta = _ocr_pages(page_metas, ingested)
        ocr_meta = dict(ocr_meta or {})
        ocr_meta["native_coverage"] = {"matched": native_gate["matched"], "total": native_gate["total"]}
        ocr_text, ocr_words, native_audit = native_text.fuse_with_audit(
            NATIVE_DIR, pdf, ocr_text, ocr_words, candidates
        )
    if native_only:
        # A native-only decision is also a source selection decision. Do not
        # let a stale/hidden PDF text layer replace the visible native proof.
        pack_text, words, text_source = native_blob, native_words, "illustrator_native"
    else:
        prefer_layer = (has_layer or ingested.get("mode") == "live_text") and not native_fallback_ocr
        pack_text, words, text_source = text_verify.merge_text_sources(
            layer_text,
            ocr_text,
            layer_words,
            ocr_words,
            prefer_layer=prefer_layer,
            allow_layer_fallback=not native_fallback_ocr,
        )
    _attach_page_size(words, page_metas)
    emit_stage("layout")
    layout = detect_regions(words, page_metas)
    zones = (
        layout.get("zones")
        if "zones" in layout
        else layout_zones.detect_zones(
            words, page_height=int(page_metas[0]["height"]) if page_metas else 2400
        )
    )
    regions = layout.get("regions") or []
    excel_net = next(
        (f.get("excel_value") or "" for f in fields if f.get("field_group") == "净含量"),
        "",
    )
    excel_bc = next(
        (
            f.get("excel_value") or ""
            for f in fields
            if f.get("field_group") == "条形码" or "条码" in (f.get("field") or "")
        ),
        "",
    )
    profile = pack_profile.infer_pack_profile(
        title=title,
        filename=filename or pdf.name,
        ocr_text=pack_text,
        excel_net_content=excel_net,
        excel_barcode=excel_bc,
    )
    if surface_label == "膜袋":
        profile["surface"] = "pouch"
        profile["surface_label"] = "膜袋"
        # 用户显式选膜袋：无 5 片条码在包装上时强制单片
        if "5" not in (profile.get("piece_from_barcode") or []):
            profile["active_pieces"] = ["1"]
            profile["active_piece"] = "1"
            profile["ignore_piece_codes"] = ["5"]
            if not str(profile.get("active_spec") or "").endswith("ml装"):
                profile["active_spec"] = "1"
            profile.setdefault("rules", []).append("用户选择膜袋 → 装型按单片考核")
    if surface_label == "花盒":
        profile["surface"] = "carton"
        profile["surface_label"] = "花盒"
        if "1" not in (profile.get("piece_from_barcode") or []) and not profile.get(
            "active_piece"
        ):
            profile["active_pieces"] = ["5"]
            profile["active_piece"] = "5"
            profile["ignore_piece_codes"] = ["1"]

    excel_joined_pre = "\n".join(
        (f.get("excel_value") or "") + "\n" + (f.get("remark") or "") for f in fields
    )
    emit_stage("match")
    hits = verify_fields(
        fields,
        words,
        pack_text,
        pack_profile=profile,
        zones=zones,
        regions=regions,
        excel_joined=excel_joined_pre,
    )
    native_text.attach_evidence(hits, native_audit)
    if native_reason:
        for hit in hits:
            hit.setdefault("native_text_evidence", {"version": 1, "status": "not_used", "native_text": None, "ocr_text": None,
                "message": "原稿文字与当前可见稿面未能可靠对应，本字段继续使用原有识别结果。"})
    # 面标签
    for h in hits:
        h["surface"] = surface_label
        if h.get("id"):
            h["id"] = f"{pages_subdir}_{h['id']}"
        if h.get("bilingual_pair_id"):
            surface_key = pages_subdir or "a"
            h["bilingual_pair_id"] = f"{surface_key}_{h['bilingual_pair_id']}"

    qrcodes, qr_meta = _qrcode_pages(page_metas)
    hits = _apply_qrcode_to_hits(hits, qrcodes, qr_meta)

    excel_joined = excel_joined_pre
    # 反向：只扫卖点区（排除工艺表）
    claims_words = words_in_roles(words, regions, ("claims", "usage"))
    claims_text = "\n".join(
        str(w.get("text") or "").strip()
        for w in claims_words
        if str(w.get("text") or "").strip()
    )
    if not claims_text and zones:
        claims_text = layout_zones.claims_zone_text(words, zones)
    reverse_extras = text_verify.reverse_extra_phrases(
        claims_text or pack_text, excel_joined
    )
    if reverse_extras:
        rev_boxes: list[dict] = []
        try:
            from app.evidence_locate import locate_phrase_span

            for e in reverse_extras[:5]:
                tx = (e.get("text") or "")[:24]
                if len(tx) < 4:
                    continue
                b = locate_phrase_span(
                    tx,
                    words,
                    min_score=86.0,
                    role="check",
                    status="warn",
                    label=f"多出?{tx[:12]}",
                )
                if b and int(b.get("width") or 0) >= 40:
                    rev_boxes.append(b)
        except Exception:
            rev_boxes = []
        rev_hit = clip_hit_bboxes(
            {"field": "reverse_extra", "field_group": "文案", "bboxes": rev_boxes},
            regions,
        )
        hits.append(
            {
                "id": f"{pages_subdir}_reverse_extra",
                "field": f"【反向·{surface_label}】卖点区有、确认单未见",
                "excel_value": "（仅扫描卖点/用法区；已滤净含量/条码/工艺/成分噪声）",
                "status": "疑点",
                "evidence": (
                    "包装卖点区疑似多出确认单未载明的宣称："
                    + "；".join(e.get("text", "")[:40] for e in reverse_extras[:6])
                    + " · 请对照图上黄框（若有）判断是否改稿"
                ),
                "score": 55.0,
                "decision": "pending",
                "bboxes": rev_hit.get("bboxes") or [],
                "page": rev_hit.get("page") or 1,
                "category": "reverse_extra",
                "no_bbox": bool(rev_hit.get("no_bbox", not bool(rev_boxes))),
                "reverse_extras": reverse_extras,
                "surface": surface_label,
                "match_mode": "reverse_claims_zone",
                "doubt_bucket": "reverse",
            }
        )

    # _page_urls with side a/b style: pages/a/name
    if pages_subdir and pages_subdir not in (".",):
        pages = _page_urls(tid, page_metas, pages_subdir)
    else:
        pages = _page_urls(tid, page_metas)

    return {
        "surface": surface_label,
        "pages": pages,
        "page_metas": page_metas,
        "hits": hits,
        "pack_text": pack_text,
        "words": words,
        "text_source": text_source,
        "has_layer": has_layer,
        "ocr_engine": ocr_engine,
        "pack_profile": profile,
        "layout_zones": {
            k: {kk: vv for kk, vv in v.items() if kk != "box"}
            for k, v in zones.items()
        },
        "pack_layout": {
            "regions": [
                {k: r.get(k) for k in ("id", "role", "page", "left", "top", "width", "height")}
                for r in regions
            ]
        },
        "reverse_extras": reverse_extras,
        "qrcodes": qrcodes,
        "qrcode_meta": qr_meta,
        "ocr_meta": ocr_meta,
        "ingest": public_ingest(ingested),
    }


def run_excel_pdf_job(
    tid: str,
    excel: Path,
    pdf: Path,
    max_pages: int,
    title: str,
    note: str | None = None,
    *,
    pdf_pouch: Path | None = None,
    surface_a_label: str = "花盒",
    surface_b_label: str = "膜袋",
) -> dict[str, Any]:
    """
    Text Verification 2.1：
    PDF 分型 · 原生文字优先 · 按页选源 · 单 OCR 引擎 · 区域路由 · 单钉证据 · 金标评测
    """
    tdir = UPLOADS / tid
    tdir.mkdir(parents=True, exist_ok=True)
    fields = parse_excel_fields(str(excel))

    # 单面：优先用调用方指定的 surface_a_label（花盒/膜袋二选一）
    primary_label = surface_a_label or "包装"
    if not surface_a_label or surface_a_label in ("包装", "unknown"):
        if re.search(r"膜袋|pouch", title + " " + pdf.name, re.I):
            primary_label = "膜袋"
        elif re.search(r"花盒|carton", title + " " + pdf.name, re.I):
            primary_label = "花盒"
    primary = _surface_job(
        tid=tid,
        pdf=pdf,
        pages_subdir="a" if pdf_pouch else "",
        max_pages=max_pages,
        surface_label=primary_label,
        fields=fields,
        title=title,
        filename=pdf.name,
    )

    faces = [primary]
    hits = list(primary["hits"])
    engines = [f"{primary['ocr_engine']}+{primary['text_source']}"]

    secondary = None
    if pdf_pouch and pdf_pouch.exists():
        secondary = _surface_job(
            tid=tid,
            pdf=pdf_pouch,
            pages_subdir="b",
            max_pages=max_pages,
            surface_label=surface_b_label,
            fields=fields,
            title=title,
            filename=pdf_pouch.name,
        )
        faces.append(secondary)
        hits.extend(secondary["hits"])
        engines.append(f"{secondary['ocr_engine']}+{secondary['text_source']}+pouch")

    excel_joined = "\n".join(
        (f.get("excel_value") or "") + "\n" + (f.get("remark") or "") for f in fields
    )
    pack_all = primary["pack_text"]
    if secondary:
        pack_all = pack_all + "\n" + secondary["pack_text"]

    claims = build_claims_report(excel_joined, pack_all)
    if claims.get("excel_claim_risks") or claims.get("pack_claim_risks"):
        risk_n = len(claims.get("excel_claim_risks") or []) + len(
            claims.get("pack_claim_risks") or []
        )
        hits.append(
            {
                "id": "claims_hint",
                "field": "【合规提示】宣称风险词（骨架）",
                "excel_value": claims.get("disclaimer") or "",
                "status": "疑点" if risk_n else "一致",
                "evidence": f"命中 {risk_n} 处风险词提示，须人工核对法规/备案",
                "score": 50.0,
                "decision": "pending",
                "bboxes": [],
                "page": 1,
                "category": "claims",
                "claims": claims,
                "no_bbox": True,
            }
        )

    # 装型画像摘要 hit
    prof = primary.get("pack_profile") or {}
    hits.insert(
        0,
        {
            "id": "pack_profile",
            "field": "【装型画像】",
            "excel_value": title,
            "status": "一致",
            "evidence": "；".join(prof.get("rules") or [])
            or f"载体 {prof.get('surface_label')} · 装型 {prof.get('active_piece')}",
            "score": 100.0,
            "decision": "confirm",
            "bboxes": [],
            "page": 1,
            "category": "profile",
            "pack_profile": prof,
            "no_bbox": True,
        },
    )

    dpi = (primary["page_metas"][0].get("dpi") if primary.get("page_metas") else None) or 220
    pages = primary["pages"]
    pages_b = secondary["pages"] if secondary else []
    surface_ocr_meta = [
        {
            "surface": face.get("surface"),
            "skipped": bool((face.get("ocr_meta") or {}).get("skipped")),
            "reason": (face.get("ocr_meta") or {}).get("reason"),
            "pages_ran": (face.get("ocr_meta") or {}).get("pages_ran", 0),
            "ocr_engine": face.get("ocr_engine"),
            "words": (face.get("ocr_meta") or {}).get("words", 0),
            "native_coverage": (face.get("ocr_meta") or {}).get("native_coverage") or {},
        }
        for face in faces
    ]
    ocr_meta = dict(primary.get("ocr_meta") or {})
    if secondary:
        all_native_only = all(
            item["skipped"] and item["reason"] == "native_coverage"
            for item in surface_ocr_meta
        )
        ocr_meta["skipped"] = all_native_only
        ocr_meta["surfaces"] = surface_ocr_meta
        ocr_meta["pages_ran"] = sum(int(item["pages_ran"] or 0) for item in surface_ocr_meta)
        ocr_meta["engines"] = list(dict.fromkeys(
            engine
            for item in surface_ocr_meta
            for engine in ((item.get("ocr_engine") or "").split("+") if item.get("ocr_engine") else [])
            if engine
        ))
        ocr_meta["words"] = sum(int(item.get("words") or 0) for item in surface_ocr_meta)
        ocr_meta["native_coverage"] = {
            "matched": sum(int((item.get("native_coverage") or {}).get("matched") or 0) for item in surface_ocr_meta),
            "total": sum(int((item.get("native_coverage") or {}).get("total") or 0) for item in surface_ocr_meta),
        }
        # api/probability/zone details describe one OCR invocation. Keeping the
        # primary surface's values at document level is misleading for a
        # native-first carton plus OCR pouch, so consumers must use surfaces.
        for key in ("api", "probability", "prob_mean", "zone_boost", "union"):
            ocr_meta.pop(key, None)
        ocr_meta.pop("_".join(("paddle", "vl")), None)
        if all_native_only:
            ocr_meta["reason"] = "native_coverage"
        else:
            ocr_meta.pop("reason", None)

    return {
        "id": tid,
        "title": title,
        "type": "excel_pdf",
        "status": "pending_review",
        "created_at": now_iso(),
        "engine": " + ".join(engines),
        "engine_version": text_verify.ENGINE_VERSION,
        "engine_features": text_verify.ENGINE_FEATURES,
        "note": note,
        "label_a": primary.get("surface") or surface_a_label,
        "label_b": (secondary.get("surface") if secondary else None) or surface_b_label,
        "disclaimer": (
            "AI 仅标疑点，不构成过审结论。禁止一键全部通过。"
            " 引擎 tvt-lite-2.1：优先使用已证明可见的 PDF/Illustrator 文字；未覆盖的图稿区域才按页单次 OCR，证据框按区域收钉。"
        ),
        "pages": pages,
        "pages_b": pages_b,
        "hits": hits,
        "summary": _summary(hits),
        "ocr_text": (pack_all or "")[:12000],
        "text_source": primary.get("text_source"),
        "has_pdf_text_layer": primary.get("has_layer"),
        "ingest": primary.get("ingest"),
        "pack_layout": primary.get("pack_layout"),
        "pack_profile": prof,
        "layout_zones": primary.get("layout_zones"),
        "surfaces": [
            {
                "label": f.get("surface"),
                "pages": len(f.get("pages") or []),
                "profile": f.get("pack_profile"),
                "zones": f.get("layout_zones"),
                "ingest": f.get("ingest"),
            }
            for f in faces
        ],
        "multi_surface": bool(secondary),
        "qrcodes": [
            {"text": q.get("text"), "page": q.get("page")}
            for q in (primary.get("qrcodes") or [])[:20]
        ],
        "qrcode_meta": primary.get("qrcode_meta"),
        "ocr_meta": ocr_meta,
        "fields_count": len(fields),
        "excel_fields": [
            {
                "field": f.get("field"),
                "value_preview": (f.get("excel_value") or "")[:120],
                "remark_preview": (f.get("remark") or "")[:80],
                "field_group": f.get("field_group"),
                "step_id": f.get("step_id"),
            }
            for f in fields
        ],
        "reverse_extras": primary.get("reverse_extras") or [],
        "claims_report": claims,
        "render": {
            "quality": "high",
            "dpi": dpi,
            "max_side": 2800,
            "pages_rendered": len(primary.get("page_metas") or []),
            "max_pages": max_pages,
            "surfaces": 2 if secondary else 1,
        },
        "match_policy": {
            "mode": "tvt_lite",
            "engine_version": text_verify.ENGINE_VERSION,
            "pack_profile": True,
            "layout_zones": True,
            "inci_normalize": True,
            "multi_surface": bool(secondary),
            "pdf_ingest": "page_classified",
            "ocr_policy": "native_first_then_ocr_uncovered",
            "vlm_typo_layer": "disabled",
        },
        "audit": [],
        "actor": "审核员",
    }

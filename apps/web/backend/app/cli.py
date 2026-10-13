"""TS 产品层调用的对照 worker。只接受本机绝对路径，不监听端口。"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from app import compare_core

# 任务 JSON 只由 jobs.ts 写；成功时 stdout 最后一行是结果，失败走 _err。
_CLI_DESCRIPTION = "对照 worker（python -m app.cli）。不是 HTTP，不写任务 JSON。"
_CLI_EPILOG = """stderr: STAGE <name>
stdout last line = result JSON (no ocr_text)
do not call save_task；任务 JSON 只由 jobs.ts 写。
unique HTTP is Hono :8787, not this CLI。
打样 is NOT a subcommand; jobs.ts calls workers/packaging; HTTP is GET /api/mockups and POST /api/mockups/start。"""


def _ok(payload: dict) -> int:
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _err(msg: str, code: int = 2, *, problem: str = "", cause: str = "", fix: str = "") -> int:
    text = str(msg).strip()[:80]
    body: dict = {"ok": False, "error": text}
    if problem:
        body["code"] = problem
        body["cause"] = str(cause).strip()[:240]
        body["fix"] = str(fix).strip()[:240]
    print(json.dumps(body, ensure_ascii=False), file=sys.stderr)
    return code


def _result(payload: dict) -> int:
    body = {k: v for k, v in payload.items() if k != "ocr_text"}
    print(json.dumps(body, ensure_ascii=False))
    return 0


def cmd_probe(args: argparse.Namespace) -> int:
    target = (args.target or "").strip()
    if target == "python":
        missing: list[str] = []
        for name in ("fitz", "openpyxl", "pypdf"):
            try:
                __import__(name)
            except Exception:
                missing.append(name)
        if missing:
            return _err("缺少依赖: " + ", ".join(missing))
        return _ok({"ok": True, "executable": sys.executable})
    if target == "baidu":
        from app.baidu_ocr import get_access_token
        from app.config import baidu_ak_sk

        ak, sk = baidu_ak_sk()
        if not ak or not sk:
            return _err("未配置百度 OCR")
        try:
            get_access_token(ak, sk, force=True)
        except Exception as exc:  # noqa: BLE001 — 探测要吞细节
            return _err("百度拒绝: " + str(exc)[:160])
        return _ok({"ok": True})
    return _err("未知探测")


def _verbatim_fail(exc: Exception) -> int:
    from app.verbatim_check import VerbatimFail

    if isinstance(exc, VerbatimFail):
        return _err(exc.error, problem=exc.code, cause=exc.cause, fix=exc.fix)
    return _err(str(exc).strip() or type(exc).__name__)


def _verbatim_ready(args: argparse.Namespace) -> int | None:
    if not getattr(args, "verbatim_check", False):
        return None
    from app.verbatim_check import VerbatimFail, prepare

    try:
        prepare(Path(getattr(args, "model_dir", "") or ""))
    except VerbatimFail as exc:
        return _verbatim_fail(exc)
    return None


def cmd_compare(args: argparse.Namespace) -> int:
    failed = _verbatim_ready(args)
    if failed is not None:
        return failed
    data = Path(args.data_dir).expanduser().resolve() if args.data_dir else None
    compare_core.init_paths(data)
    compare_core.NATIVE_DIR = Path(args.native_dir).resolve() if getattr(args, "native_dir", None) else None
    compare_core.NATIVE_ATTEMPTED = bool(getattr(args, "native_attempted", False))
    tid = (args.tid or "").strip()
    if not compare_core.TID_RE.fullmatch(tid):
        return _err("无效任务 id")
    excel = Path(args.excel).resolve()
    pdf = Path(args.pdf).resolve()
    if not excel.is_file() or not pdf.is_file():
        return _err("excel 或 pdf 不存在")
    product = (args.product_name or "").strip()
    if not product:
        return _err("品名必填")
    surface = "膜袋" if args.surface == "pouch" else "花盒"
    title = (args.title or "").strip() or product
    tdir = compare_core.UPLOADS / tid
    tdir.mkdir(parents=True, exist_ok=True)
    ep, pp = tdir / "source.xlsx", tdir / "artwork.pdf"
    if excel != ep:
        shutil.copy2(excel, ep)
    if pdf != pp:
        shutil.copy2(pdf, pp)
    try:
        task = compare_core.run_excel_pdf_job(
            tid,
            ep,
            pp,
            compare_core.clamp_max_pages(int(args.max_pages or 2)),
            title,
            pdf_pouch=None,
            surface_a_label=surface,
            surface_b_label="膜袋",
            verbatim_check=bool(getattr(args, "verbatim_check", False)),
            model_dir=getattr(args, "model_dir", "") or "",
        )
    except Exception as exc:
        from app.verbatim_check import VerbatimFail

        if not isinstance(exc, VerbatimFail):
            raise
        return _verbatim_fail(exc)
    task["product_name"] = product
    task["title"] = title
    task["pack_surface"] = surface
    task["label_a"] = surface
    task["owner"] = args.actor or ""
    task["created_by"] = args.actor or ""
    task["actor"] = args.actor or ""
    task.setdefault("audit", []).append(
        {"at": compare_core.now_iso(), "actor": args.actor or "", "action": "create", "via": "ts-cli"}
    )
    if getattr(args, "verbatim_check", False):
        from app.verbatim_check import guard_stdout

        try:
            guard_stdout(json.dumps({k: v for k, v in task.items() if k != "ocr_text"}, ensure_ascii=False))
        except Exception as exc:
            return _verbatim_fail(exc)
    return _result(task)


def cmd_rework(args: argparse.Namespace) -> int:
    data = Path(args.data_dir).expanduser().resolve() if args.data_dir else None
    compare_core.init_paths(data)
    compare_core.NATIVE_DIR = Path(args.native_dir).resolve() if getattr(args, "native_dir", None) else None
    compare_core.NATIVE_ATTEMPTED = bool(getattr(args, "native_attempted", False))
    tid = (args.tid or "").strip()
    task = compare_core.load_task(tid)
    if task.get("verbatim_check") is True:
        args.verbatim_check = True
    failed = _verbatim_ready(args)
    if failed is not None:
        return failed
    pdf = Path(args.pdf).resolve()
    if not pdf.is_file():
        return _err("新 PDF 不存在")
    dest = compare_core.UPLOADS / tid / "artwork_v2.pdf"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if pdf.resolve() != dest.resolve():
        shutil.copy2(pdf, dest)
    excel = compare_core.UPLOADS / tid / "source.xlsx"
    if not excel.is_file():
        return _err("找不到原 Excel")
    if getattr(args, "verbatim_check", False):
        try:
            built = compare_core.verbatim_rework(
                tid,
                dest,
                excel,
                compare_core.clamp_max_pages(int(args.max_pages or 2)),
                getattr(args, "model_dir", "") or "",
            )
        except Exception as exc:
            return _verbatim_fail(exc)
        task["round"] = 2
        task["artwork_v2"] = "artwork_v2.pdf"
        task["pages_v2"] = built.get("pages") or []
        task["hits_v2"] = built.get("hits") if isinstance(built.get("hits"), list) else []
        task["verbatim_check"] = True
        task["engine"] = built.get("engine") or task.get("engine")
        task["status"] = "in_review"
        if built.get("verbatim_warning"):
            task["verbatim_warning"] = built["verbatim_warning"]
        if built.get("fsc_note"):
            task["fsc_note"] = built["fsc_note"]
        task.setdefault("audit", []).append(
            {"at": compare_core.now_iso(), "actor": args.actor or "", "action": "rework_v2"}
        )
        from app.verbatim_check import guard_stdout

        body = json.dumps({k: v for k, v in task.items() if k != "ocr_text"}, ensure_ascii=False)
        try:
            guard_stdout(body)
        except Exception as exc:
            return _verbatim_fail(exc)
        return _result(task)
    from app.fields import parse_excel_fields

    fields = parse_excel_fields(str(excel))
    surface = task.get("label_a") or task.get("pack_surface") or "花盒"
    result = compare_core._surface_job(
        tid=tid,
        pdf=dest,
        pages_subdir="v2",
        max_pages=compare_core.clamp_max_pages(int(args.max_pages or 2)),
        surface_label=str(surface),
        fields=fields,
        title=str(task.get("title") or ""),
        filename=dest.name,
    )
    task["round"] = 2
    task["artwork_v2"] = "artwork_v2.pdf"
    task["pages_v2"] = result.get("pages") or []
    task["hits_v2"] = result.get("hits") or []
    task["ingest"] = result.get("ingest")
    task["ocr_meta"] = result.get("ocr_meta")
    task["pack_layout"] = result.get("pack_layout")
    task["status"] = "in_review"
    prior = [
        h
        for h in (task.get("hits") or [])
        if h.get("decision") == "issue"
    ]
    v2_by_field = {(h.get("field") or ""): h for h in task["hits_v2"]}
    rematch = []
    for old in prior:
        field = old.get("field") or ""
        new = v2_by_field.get(field)
        rematch.append(
            {
                "field": field,
                "expected_text": old.get("excel") or old.get("excel_value") or old.get("expected"),
                "observed_text": old.get("pdf") or old.get("found"),
                "v1_status": old.get("status"),
                "v2_status": (new or {}).get("status") or "待人工确认",
                "page": (new or {}).get("page") or old.get("page"),
            }
        )
    task["rework_check"] = rematch
    task.setdefault("audit", []).append(
        {"at": compare_core.now_iso(), "actor": args.actor or "", "action": "rework_v2"}
    )
    return _result(task)


def main() -> int:
    p = argparse.ArgumentParser(
        prog="beian-review-worker",
        description=_CLI_DESCRIPTION,
        epilog=_CLI_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("compare", help="Excel↔PDF 对照；stdout 最后一行结果 JSON")
    c.add_argument("--tid", required=True)
    c.add_argument("--excel", required=True)
    c.add_argument("--pdf", required=True)
    c.add_argument("--product-name", required=True)
    c.add_argument("--title", default="")
    c.add_argument("--surface", default="carton")
    c.add_argument("--max-pages", default="2")
    c.add_argument("--actor", default="")
    c.add_argument("--data-dir", default="")

    c.add_argument("--native-dir", default="")
    c.add_argument("--native-attempted", action="store_true")
    c.add_argument("--verbatim-check", action="store_true")
    c.add_argument("--model-dir", default="")

    r = sub.add_parser("rework", help="对红第二轮 PDF；stdout 最后一行结果 JSON")
    r.add_argument("--tid", required=True)
    r.add_argument("--pdf", required=True)
    r.add_argument("--max-pages", default="2")
    r.add_argument("--actor", default="")
    r.add_argument("--data-dir", default="")

    r.add_argument("--native-dir", default="")
    r.add_argument("--native-attempted", action="store_true")
    r.add_argument("--verbatim-check", action="store_true")
    r.add_argument("--model-dir", default="")

    pr = sub.add_parser("probe")
    pr.add_argument("--target", required=True, choices=("python", "baidu"))

    args = p.parse_args()
    try:
        if args.cmd == "compare":
            return cmd_compare(args)
        if args.cmd == "rework":
            return cmd_rework(args)
        if args.cmd == "probe":
            return cmd_probe(args)
        return _err("未知命令")
    except Exception as exc:  # noqa: BLE001 — 对照失败必须给 jobs.ts 一行 JSON
        return _err(str(exc).strip() or type(exc).__name__)


if __name__ == "__main__":
    raise SystemExit(main())

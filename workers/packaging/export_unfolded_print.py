#!/usr/bin/env python3
"""Publish an unfolded print PDF. stdout is one JSON object and never a path."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from structure_v2.unfolded_print import UnfoldedPrintReject, publish_unfolded_print, write_unfolded_source


def _recover_source(resolution_path: Path, source_ai: Path, output: Path) -> dict[str, bool]:
    with resolution_path.open("rb") as stream:
        contents = stream.read(25 * 1024 * 1024 + 1)
    if len(contents) > 25 * 1024 * 1024:
        raise UnfoldedPrintReject("geometry_incomplete")
    try:
        resolution = json.loads(contents)
    except (ValueError, RecursionError) as error:
        raise UnfoldedPrintReject("geometry_incomplete") from error
    write_unfolded_source(resolution, source_ai, output)
    return {"ok": True}


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish a 1:1 unfolded print PDF")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--artwork", type=Path)
    parser.add_argument("--expect-sha256", default="")
    parser.add_argument("--artwork-sha256", default="")
    parser.add_argument("--from-resolution", type=Path)
    parser.add_argument("--execution-id", required=True)
    parser.add_argument("--job-dir", type=Path, required=True)
    args = parser.parse_args()
    if len(args.execution_id) != 32:
        print(json.dumps({"ok": False, "reason": "export_failed"}, ensure_ascii=False))
        return 2
    try:
        result = _recover_source(args.from_resolution, args.source, args.output) if args.from_resolution else publish_unfolded_print(
            args.source,
            args.output,
            artwork=args.artwork,
            expect_sha256=args.expect_sha256,
            artwork_sha256=args.artwork_sha256,
        )
    except UnfoldedPrintReject as error:
        print(json.dumps({"ok": False, "reason": error.reason}, ensure_ascii=False))
        return 2
    except Exception:
        print(json.dumps({"ok": False, "reason": "export_failed"}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

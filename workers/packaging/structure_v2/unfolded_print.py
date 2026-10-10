"""Publish one 1:1 unfolded print PDF from an explicit semantic net.

Classification uses only object roles and exact layer identities carried in the
source document. Stroke width and ink color are not inputs. A page is ready
only when the net still contains the blank glue flap, tuck, and both closures,
and helper geometry has been omitted rather than cropped away.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping


SOURCE_SCHEMA = "unfolded-print-source/1"
ATTESTATION_SCHEMA = "unfolded-separation-attestation/1"
MM_TO_PT = 72.0 / 25.4
PT_TO_MM = 25.4 / 72.0
TOLERANCE_MM = 0.2
MIN_SHARED_EDGE_MM = 5.0

BODY_ROLES = ("front", "back", "left", "right")
CLOSURE_ROLES = ("top", "bottom")
FLAP_ROLES = ("glue", "tuck")
HELPER_ROLES = frozenset({"cut", "crease", "dimension", "production"})
KEEP_ROLES = frozenset({"print", "decoration"})
PANEL_ROLES = frozenset(BODY_ROLES + CLOSURE_ROLES + FLAP_ROLES)
FORBIDDEN_ASSEMBLIES = frozenset({"six_png", "glb_snapshot"})


class UnfoldedPrintReject(Exception):
    def __init__(self, reason: str):
        if reason not in {
            "source_missing",
            "geometry_incomplete",
            "separation_unreliable",
            "source_changed",
            "export_failed",
        }:
            reason = "export_failed"
        super().__init__(reason)
        self.reason = reason


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _finite_number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UnfoldedPrintReject("geometry_incomplete")
    number = float(value)
    if not math.isfinite(number):
        raise UnfoldedPrintReject("geometry_incomplete")
    return number


def _box(value: Any) -> tuple[float, float, float, float]:
    if not isinstance(value, list) or len(value) != 4:
        raise UnfoldedPrintReject("geometry_incomplete")
    return tuple(_finite_number(item) for item in value)  # type: ignore[return-value]


def _bounds(value: Any) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = _box(value)
    if x1 - x0 <= TOLERANCE_MM or y1 - y0 <= TOLERANCE_MM:
        raise UnfoldedPrintReject("geometry_incomplete")
    return x0, y0, x1, y1


def _mark_bounds(value: Any) -> tuple[float, float, float, float]:
    """A print rule may be thinner than the panel tolerance. A point is not a mark."""
    x0, y0, x1, y1 = _box(value)
    width = x1 - x0
    height = y1 - y0
    if width < -TOLERANCE_MM or height < -TOLERANCE_MM or max(width, height) <= TOLERANCE_MM:
        raise UnfoldedPrintReject("geometry_incomplete")
    return x0, y0, x1, y1


def _overlap_area(left: tuple[float, float, float, float], right: tuple[float, float, float, float]) -> float:
    width = min(left[2], right[2]) - max(left[0], right[0])
    height = min(left[3], right[3]) - max(left[1], right[1])
    if width <= TOLERANCE_MM or height <= TOLERANCE_MM:
        return 0.0
    return width * height


def _shares_edge(left: tuple[float, float, float, float], right: tuple[float, float, float, float]) -> bool:
    if abs(left[2] - right[0]) <= TOLERANCE_MM or abs(right[2] - left[0]) <= TOLERANCE_MM:
        return min(left[3], right[3]) - max(left[1], right[1]) >= MIN_SHARED_EDGE_MM
    if abs(left[3] - right[1]) <= TOLERANCE_MM or abs(right[3] - left[1]) <= TOLERANCE_MM:
        return min(left[2], right[2]) - max(left[0], right[0]) >= MIN_SHARED_EDGE_MM
    return False


def _inside(inner: tuple[float, float, float, float], outer: tuple[float, float, float, float]) -> bool:
    return (
        inner[0] >= outer[0] - TOLERANCE_MM
        and inner[1] >= outer[1] - TOLERANCE_MM
        and inner[2] <= outer[2] + TOLERANCE_MM
        and inner[3] <= outer[3] + TOLERANCE_MM
    )


def _load_source(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise UnfoldedPrintReject("source_missing")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise UnfoldedPrintReject("source_missing") from error
    if not isinstance(payload, dict) or payload.get("schema") != SOURCE_SCHEMA:
        raise UnfoldedPrintReject("geometry_incomplete")
    return payload


def _panels(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("panels")
    if not isinstance(raw, list) or not raw or len(raw) > 64:
        raise UnfoldedPrintReject("geometry_incomplete")
    panels: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise UnfoldedPrintReject("geometry_incomplete")
        identity = item.get("id")
        role = item.get("role")
        if not isinstance(identity, str) or not identity or identity in seen or role not in PANEL_ROLES:
            raise UnfoldedPrintReject("geometry_incomplete")
        seen.add(identity)
        panels.append({"id": identity, "role": role, "bounds_mm": _bounds(item.get("bounds_mm"))})
    roles = {panel["role"] for panel in panels}
    if any(role not in roles for role in BODY_ROLES + CLOSURE_ROLES + FLAP_ROLES):
        raise UnfoldedPrintReject("geometry_incomplete")
    if any(sum(panel["role"] == role for panel in panels) != 1 for role in BODY_ROLES + CLOSURE_ROLES):
        raise UnfoldedPrintReject("geometry_incomplete")
    if all("polygon_mm" in item for item in raw):
        from shapely.geometry import Polygon
        shapes = []
        for item, panel in zip(raw, panels):
            points = item["polygon_mm"]
            if not isinstance(points, list) or not 3 <= len(points) <= 20000:
                raise UnfoldedPrintReject("geometry_incomplete")
            polygon = Polygon([[_finite_number(v) for v in point] for point in points])
            if not polygon.is_valid or polygon.area <= TOLERANCE_MM ** 2 or any(abs(a - b) > TOLERANCE_MM for a, b in zip(polygon.bounds, panel["bounds_mm"])):
                raise UnfoldedPrintReject("geometry_incomplete")
            shapes.append(polygon)
        connected = {0}
        for i, shape in enumerate(shapes):
            for other in shapes[i + 1:]:
                if shape.intersection(other).area > TOLERANCE_MM ** 2:
                    raise UnfoldedPrintReject("geometry_incomplete")
        while True:
            expanded = connected | {i for i, shape in enumerate(shapes) if any(shape.boundary.intersection(shapes[j].boundary).length >= MIN_SHARED_EDGE_MM for j in connected if i != j)}
            if expanded == connected:
                break
            connected = expanded
        if len(connected) != len(shapes):
            raise UnfoldedPrintReject("geometry_incomplete")
        return panels
    for index, panel in enumerate(panels):
        for other in panels[index + 1 :]:
            if _overlap_area(panel["bounds_mm"], other["bounds_mm"]) > 0:
                raise UnfoldedPrintReject("geometry_incomplete")
    by_role = {panel["role"]: panel for panel in panels if panel["role"] in BODY_ROLES + CLOSURE_ROLES}
    bodies = [by_role[role] for role in BODY_ROLES]
    if not any(_shares_edge(panel["bounds_mm"], body["bounds_mm"]) for panel in panels if panel["role"] == "glue" for body in bodies):
        raise UnfoldedPrintReject("geometry_incomplete")
    closures = [by_role["top"], by_role["bottom"]]
    neighbours = bodies + closures
    if not any(
        _shares_edge(panel["bounds_mm"], neighbour["bounds_mm"])
        for panel in panels
        if panel["role"] == "tuck"
        for neighbour in neighbours
    ):
        raise UnfoldedPrintReject("geometry_incomplete")
    if not _shares_edge(by_role["top"]["bounds_mm"], bodies[0]["bounds_mm"]) and not any(
        _shares_edge(by_role["top"]["bounds_mm"], body["bounds_mm"]) for body in bodies
    ):
        raise UnfoldedPrintReject("geometry_incomplete")
    if not any(_shares_edge(by_role["bottom"]["bounds_mm"], body["bounds_mm"]) for body in bodies):
        raise UnfoldedPrintReject("geometry_incomplete")
    return panels


def _union(panels: list[dict[str, Any]]) -> tuple[float, float, float, float]:
    bounds = [panel["bounds_mm"] for panel in panels]
    return (
        min(item[0] for item in bounds),
        min(item[1] for item in bounds),
        max(item[2] for item in bounds),
        max(item[3] for item in bounds),
    )


def _separation(payload: Mapping[str, Any], panels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    raw = payload.get("separation")
    if not isinstance(raw, dict) or raw.get("method") != "semantic-identity":
        raise UnfoldedPrintReject("separation_unreliable")
    objects = raw.get("objects")
    if not isinstance(objects, list):
        raise UnfoldedPrintReject("separation_unreliable")
    panels_by_id = {panel["id"]: panel for panel in panels}
    kept: list[dict[str, Any]] = []
    for item in objects:
        if not isinstance(item, dict):
            raise UnfoldedPrintReject("separation_unreliable")
        role = item.get("role")
        if role not in HELPER_ROLES | KEEP_ROLES:
            raise UnfoldedPrintReject("separation_unreliable")
        bounds = _mark_bounds(item.get("bounds_mm"))
        panel_id = item.get("panel_id")
        panel = panels_by_id.get(panel_id) if isinstance(panel_id, str) else None
        if panel is None or not _inside(bounds, panel["bounds_mm"]):
            raise UnfoldedPrintReject("geometry_incomplete")
        if role in KEEP_ROLES:
            kept.append({"role": role, "bounds_mm": bounds})
    if not any(item["role"] == "print" for item in kept):
        raise UnfoldedPrintReject("geometry_incomplete")
    return kept


def _attestation(payload: Mapping[str, Any]) -> None:
    raw = payload.get("attestation")
    if not isinstance(raw, dict) or raw.get("schema") != ATTESTATION_SCHEMA:
        raise UnfoldedPrintReject("separation_unreliable")
    if raw.get("method") != "semantic-identity" or raw.get("covers_blank_structure") is not True:
        raise UnfoldedPrintReject("separation_unreliable")
    hidden = raw.get("hidden_roles")
    if not isinstance(hidden, list) or not hidden or any(role not in HELPER_ROLES for role in hidden):
        raise UnfoldedPrintReject("separation_unreliable")


def _page_box_mm(page: Any) -> tuple[float, float]:
    rotation = int(getattr(page, "rotation", 0) or 0)
    if rotation != 0:
        raise UnfoldedPrintReject("geometry_incomplete")
    width = float(page.mediabox.width) * PT_TO_MM
    height = float(page.mediabox.height) * PT_TO_MM
    if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
        raise UnfoldedPrintReject("geometry_incomplete")
    return width, height


def _assert_page_matches(page: Any, union: tuple[float, float, float, float]) -> tuple[float, float]:
    width, height = _page_box_mm(page)
    expected_width = union[2] - union[0]
    expected_height = union[3] - union[1]
    if abs(width - expected_width) > TOLERANCE_MM or abs(height - expected_height) > TOLERANCE_MM:
        raise UnfoldedPrintReject("geometry_incomplete")
    return width, height


def _write_pdf(document: Any, output: Path) -> None:
    if output.exists() or output.is_symlink():
        document.close()
        raise UnfoldedPrintReject("export_failed")
    output.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(delete=False, dir=output.parent, prefix=".unfolded-", suffix=".pdf")
    temporary = Path(handle.name)
    handle.close()
    try:
        document.save(temporary, deflate=True, garbage=4, no_new_id=True)
    except Exception:
        document.close()
        temporary.unlink(missing_ok=True)
        raise
    document.close()
    try:
        os.replace(temporary, output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _copy_attested(artwork: Path, union: tuple[float, float, float, float], output: Path) -> tuple[float, float]:
    import pymupdf

    if not artwork.is_file() or artwork.is_symlink() or artwork.resolve() == output.resolve():
        raise UnfoldedPrintReject("source_missing")
    source_hash = _sha256(artwork)
    document = pymupdf.open(artwork)
    try:
        if document.page_count != 1:
            raise UnfoldedPrintReject("geometry_incomplete")
        width, height = _assert_page_matches(document[0], union)
    except UnfoldedPrintReject:
        document.close()
        raise
    copied = pymupdf.open()
    copied.insert_pdf(document, from_page=0, to_page=0)
    document.close()
    if _sha256(artwork) != source_hash:
        copied.close()
        raise UnfoldedPrintReject("source_changed")
    if copied.page_count != 1:
        copied.close()
        raise UnfoldedPrintReject("geometry_incomplete")
    _assert_page_matches(copied[0], union)
    _write_pdf(copied, output)
    return width, height


def publish_unfolded_print(
    source_path: Path,
    output: Path,
    *,
    artwork: Path | None = None,
    expect_sha256: str = "",
    artwork_sha256: str = "",
) -> dict[str, Any]:
    """Write a new PDF. The source and artwork files are only read."""

    source_path = source_path.expanduser()
    output = output.expanduser()
    if expect_sha256 and (not source_path.is_file() or _sha256(source_path) != expect_sha256.lower()):
        raise UnfoldedPrintReject("source_changed" if source_path.is_file() else "source_missing")
    before = _sha256(source_path) if source_path.is_file() else ""
    payload = _load_source(source_path)
    assembly = payload.get("assembly")
    if assembly in FORBIDDEN_ASSEMBLIES:
        raise UnfoldedPrintReject("geometry_incomplete")
    if assembly not in {"semantic-net", "attested-pdf"}:
        raise UnfoldedPrintReject("geometry_incomplete")
    panels = _panels(payload)
    union = _union(panels)
    if assembly == "semantic-net":
        # Roles and bounding boxes do not contain artwork. Never synthesize ink.
        _separation(payload, panels)
    _attestation(payload)
    if artwork is None:
        raise UnfoldedPrintReject("source_missing")
    artwork = artwork.expanduser()
    if artwork_sha256 and (not artwork.is_file() or _sha256(artwork) != artwork_sha256.lower()):
        raise UnfoldedPrintReject("source_changed" if artwork.is_file() else "source_missing")
    page_bounds = _bounds(payload["page_bounds_mm"]) if "page_bounds_mm" in payload else union
    if not _inside(union, page_bounds):
        raise UnfoldedPrintReject("geometry_incomplete")
    width, height = _copy_attested(artwork, page_bounds, output)
    if before and _sha256(source_path) != before:
        output.unlink(missing_ok=True)
        raise UnfoldedPrintReject("source_changed")
    return {
        "ok": True,
        "reason": None,
        "width_mm": round(width, 3),
        "height_mm": round(height, 3),
    }


def produce_unfolded_source(resolution: Mapping[str, Any], source_ai: Path, output: Path, print_layers: list[str] | None = None) -> bool:
    """Carry accepted V2 geometry to the shared native exporter; no new inference.

    Absence of explicit flap/glue roles is an unsupported net, not permission
    to replace artwork with six face textures or drop blank structural areas.
    """
    structure = resolution.get("structure") or {}
    if resolution.get("status") != "ready" or structure.get("validation", {}).get("status") != "accepted":
        return False
    digest = _sha256(source_ai)
    source = structure.get("source", {})
    if source.get("sha256") != digest or structure.get("units") != "mm":
        return False
    vertices = {v["id"]: [v["x"], v["y"]] for v in structure.get("vertices", [])}
    panels = []
    try:
        for face in structure.get("faces", []):
            role = {"glue_tab": "glue", "flap": "tuck"}.get(face["role"], face["role"])
            if role not in PANEL_ROLES:
                return False
            polygon = [vertices[v] for v in face["boundary"]]
            xs, ys = zip(*polygon)
            panels.append({"id": face["id"], "role": role, "polygon_mm": polygon,
                           "bounds_mm": [min(xs), min(ys), max(xs), max(ys)]})
        page = source["page_size"]
        payload = {"schema": SOURCE_SCHEMA, "assembly": "attested-pdf", "export": "native",
                   "source_ai_sha256": digest, "panels": panels, "print_layers": print_layers or [],
                   "page_bounds_mm": [0, 0, page[0], page[1]],
                   "attestation": {"schema": ATTESTATION_SCHEMA, "method": "semantic-identity",
                                   "hidden_roles": list(sorted(HELPER_ROLES)), "covers_blank_structure": True}}
        checked = _panels(payload)
        if not _inside(_union(checked), _bounds(payload["page_bounds_mm"])):
            return False
    except (KeyError, TypeError, ValueError, UnfoldedPrintReject):
        return False
    if _sha256(source_ai) != digest:
        return False
    output.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return True

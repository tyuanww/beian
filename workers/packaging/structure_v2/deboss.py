"""Map an isolated deboss plate to normals and renderer-only face textures."""

from __future__ import annotations

from functools import lru_cache
import hashlib
import io
import math
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping, NamedTuple

from PIL import Image, ImageChops, ImageFilter

from glb_verify import PAPER_ALBEDO_LINEAR

from .artwork import ArtworkMappingError, ROLE_SIZE_KEYS, render_face_assets


_DEPTH_MM = 0.15
_BEVEL_RADIUS_MM = 0.10
_MAX_NORMAL_EDGE_PX = 1536
_INK_ALPHA_CUTOFF = 128


class DebossTextures(NamedTuple):
    normals: dict[str, str]
    face_assets: dict[str, str]


def supports_deboss(spec: Mapping[str, Any]) -> bool:
    material = spec["material"]
    white_card = [PAPER_ALBEDO_LINEAR] * 3 + [1.0]
    return (
        spec["geometry"]["family"] == "rectangular_carton_v1"
        and material["substrate_profile"] == "white-card-default-v1"
        and material["substrate_rgba"] == white_card
        and material.get("substrate_micro_normal") is None
    )


def _mask_differences(mask: Image.Image) -> tuple[bytes, bytes]:
    width, height = mask.size
    # Repeat the border pixel so a plate extending over a fold has no artificial rim.
    edges = (
        ((0, 0, 1, height), (0, 1)),
        ((width - 1, 0, width, height), (width + 1, 1)),
        ((0, 0, width, 1), (1, 0)),
        ((0, height - 1, width, height), (1, height + 1)),
    )
    with Image.new("L", (width + 2, height + 2)) as padded:
        padded.paste(mask, (1, 1))
        for crop, position in edges:
            with mask.crop(crop) as edge:
                padded.paste(edge, position)
        with (
            padded.crop((0, 1, width, height + 1)) as left,
            padded.crop((2, 1, width + 2, height + 1)) as right,
            padded.crop((1, 0, width + 1, height)) as above,
            padded.crop((1, 2, width + 1, height + 2)) as below,
            ImageChops.subtract(right, left, scale=2, offset=128) as dx,
            ImageChops.subtract(above, below, scale=2, offset=128) as dy,
        ):
            return dx.tobytes(), dy.tobytes()


def _bevel_normals(mask: Image.Image, width_mm: float, height_mm: float) -> Image.Image:
    ppm_x, ppm_y = mask.width / width_mm, mask.height / height_mm
    with mask.filter(ImageFilter.GaussianBlur(_BEVEL_RADIUS_MM * min(ppm_x, ppm_y))) as bevel:
        dx, dy = _mask_differences(bevel)

    @lru_cache(maxsize=None)
    def encode(dx: int, dy: int) -> bytes:
        # Height is negative inside the plate. Texture rows grow opposite to tangent +Y.
        nx = (dx - 128) * _DEPTH_MM * ppm_x / 255
        ny = (dy - 128) * _DEPTH_MM * ppm_y / 255
        length = math.sqrt(nx * nx + ny * ny + 1)
        return bytes(round(127.5 * (component / length + 1)) for component in (nx, ny, 1))

    pixels = b"".join(encode(x, y) for x, y in zip(dx, dy, strict=True))
    return Image.frombytes("RGB", mask.size, pixels)


def _relief_coverage(normal: Image.Image) -> Image.Image:
    # Expand around the slope by one texel so texture filtering can show the bevel.
    with (
        Image.new("L", normal.size, 128) as neutral,
        normal.getchannel("R") as x,
        normal.getchannel("G") as y,
        ImageChops.difference(x, neutral) as horizontal,
        ImageChops.difference(y, neutral) as vertical,
        ImageChops.lighter(horizontal, vertical) as slope,
        slope.point(lambda level: min(level * 64, 255)) as coverage,
    ):
        return coverage.filter(ImageFilter.MaxFilter(3))


def _restore_paper_coverage(print_path: Path, normal: Image.Image) -> Image.Image | None:
    # The compat carton clips ink at 0.5. Overlay matching white card only where
    # the normal needs a surface, while keeping visible ink and flat paper intact.
    with Image.open(print_path) as artwork, _relief_coverage(normal) as coverage:
        with coverage.resize(artwork.size, Image.Resampling.BILINEAR) as aligned:
            bounds = aligned.getbbox()
            if bounds is None:
                return None
            with (
                aligned.crop(bounds) as relief,
                artwork.crop(bounds) as ink,
                ink.getchannel("A") as alpha,
                alpha.point(lambda level: 255 if level < _INK_ALPHA_CUTOFF else 0) as uncovered,
                ImageChops.multiply(relief, uncovered) as paper_alpha,
            ):
                if paper_alpha.getbbox() is None:
                    return None
                with Image.new("RGBA", ink.size, (255, 255, 255, 255)) as paper:
                    paper.putalpha(paper_alpha)
                    with (
                        Image.alpha_composite(paper, ink) as restored,
                        paper_alpha.point(lambda level: 255 if level else 0) as changed,
                    ):
                        textured = artwork.copy()
                        textured.paste(restored, bounds, changed)
                        return textured


def _stage_texture(image: Image.Image, staging: Path, prefix: str, hash_length: int) -> str:
    with io.BytesIO() as png:
        image.save(png, format="PNG", compress_level=3)
        payload = png.getvalue()
    filename = f"{prefix}-{hashlib.sha256(payload).hexdigest()[:hash_length]}.png"
    (staging / filename).write_bytes(payload)
    return filename


def render_deboss_textures(
    deboss_pdf: Path | str,
    resolved: Mapping[str, Any],
    output_dir: Path | str,
    **sampling: Any,
) -> DebossTextures:
    """Return immutable maps without altering the six published print faces."""
    from pymupdf import FileDataError

    destination = Path(output_dir).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    normals: dict[str, str] = {}
    face_assets: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix=".deboss-", dir=destination) as directory:
        staging = Path(directory)
        try:
            render_face_assets(deboss_pdf, resolved, staging, **sampling)
        except FileDataError as error:
            raise ArtworkMappingError("artwork_page_invalid", "激凹工艺板 PDF 无法读取") from error
        dimensions = resolved["dimensions_mm"]
        for face, (width_key, height_key) in ROLE_SIZE_KEYS.items():
            with Image.open(staging / f"panel_{face}.png") as plate, plate.getchannel("A") as mask:
                if mask.getbbox() is None:
                    continue
                mask.thumbnail((_MAX_NORMAL_EDGE_PX, _MAX_NORMAL_EDGE_PX), Image.Resampling.LANCZOS)
                with _bevel_normals(mask, dimensions[width_key], dimensions[height_key]) as normal:
                    filename = _stage_texture(normal, staging, f"normal_{face}", 64)
                    normals[face] = str(destination / filename)
                    textured = _restore_paper_coverage(destination / f"panel_{face}.png", normal)
                    if textured is not None:
                        with textured:
                            # Blender before 5.0 limits image data-block names to 63 bytes.
                            filename = _stage_texture(textured, staging, f"deboss_face_{face}", 40)
                        face_assets[face] = str(destination / filename)

        for texture_path in (*normals.values(), *face_assets.values()):
            target = Path(texture_path)
            source = staging / target.name
            if target.is_symlink() or not target.is_file() or target.read_bytes() != source.read_bytes():
                os.replace(source, target)
    return DebossTextures(normals, face_assets)

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image
import pymupdf
import pytest

from test_packaging_glb_verify import _runtime_artifact, _write_artifact, glb_verify
from test_packaging_pipeline_v2 import pipeline_module, prepare_v2_product
from test_packaging_structure_artwork import artwork_pdf, resolved_fixture
from render_contract import RenderContractError, renderer_face_assets, validate_job_asset_contract
from structure_v2 import ArtworkMappingError, render_face_assets
from structure_v2.deboss import render_deboss_textures


def _plate(path: Path, rectangle: tuple[int, int, int, int], *, pages: int = 1, fill=(1, 1, 1)) -> Path:
    mm_to_pt = 72.0 / 25.4
    with pymupdf.open() as document:
        for _ in range(pages):
            page = document.new_page(width=120 * mm_to_pt, height=90 * mm_to_pt)
            page.draw_rect(
                pymupdf.Rect(*(coord * mm_to_pt for coord in rectangle)),
                color=None,
                fill=fill,
            )
        document.save(path)
    return path


@pytest.mark.parametrize(
    ("transform", "rectangle", "left_mm", "right_mm", "bare_paper"),
    [
        ([1, 0, 0, 1, -50, 0], (54, 8, 63, 23), 4, 13, False),
        ([-1, 0, 0, 1, 80, 0], (54, 8, 63, 23), 17, 26, False),
        ([0, -1, 1, 0, -50, 50], (27, 54, 42, 63), 4, 13, True),
    ],
)
def test_deboss_uses_the_face_affine_and_preserves_original_print(
    tmp_path, transform, rectangle, left_mm, right_mm, bare_paper,
):
    resolved = resolved_fixture()
    resolved["faces"]["front"]["artwork_layers"][0]["artwork_transform"] = transform
    art = artwork_pdf(tmp_path / "print.pdf", page_height_mm=90)
    plate = _plate(tmp_path / "deboss.pdf", rectangle)
    output = tmp_path / "assets"
    sampling = {"raster_width_px": 2_400}
    sizes = render_face_assets(art, resolved, output, **sampling)
    original = {path: path.read_bytes() for path in output.glob("panel_*.png")}

    textures = render_deboss_textures(plate, resolved, output, **sampling)
    normals = textures.normals

    assert set(normals) == {"front"}
    front = Path(normals["front"])
    assert front.parent == output
    assert front.name == f"normal_front-{hashlib.sha256(front.read_bytes()).hexdigest()}.png"
    assert render_deboss_textures(plate, resolved, output, **sampling) == textures
    assert {path: path.read_bytes() for path in output.glob("panel_*.png")} == original
    assert set(textures.face_assets) == ({"front"} if bare_paper else set())
    assert set(output.iterdir()) == set(original) | {front} | set(map(Path, textures.face_assets.values()))
    with Image.open(front) as normal:
        assert normal.mode == "RGB"
        assert list(normal.size) == sizes["front"]
        scale_x, scale_y = normal.width / 30, normal.height / 50
        center_x = round((left_mm + right_mm) / 2 * scale_x)
        center_y = round(15 * scale_y)
        left, right = round(left_mm * scale_x), round(right_mm * scale_x)
        top, bottom = round(8 * scale_y), round(23 * scale_y)
        assert normal.getpixel((0, 0)) == normal.getpixel((center_x, center_y)) == (128, 128, 255)
        assert max(normal.getpixel((left + i, center_y))[0] for i in range(-2, 3)) > 165
        assert min(normal.getpixel((right + i, center_y))[0] for i in range(-2, 3)) < 90
        assert min(normal.getpixel((center_x, top + i))[1] for i in range(-2, 3)) < 90
        assert max(normal.getpixel((center_x, bottom + i))[1] for i in range(-2, 3)) > 165


def test_plate_outside_faces_leaves_no_normal_assets(tmp_path):
    plate = _plate(tmp_path / "outside.pdf", (112, 60, 118, 69))
    output = tmp_path / "assets"
    assert render_deboss_textures(plate, resolved_fixture(), output, raster_width_px=1_200) == ({}, {})
    assert list(output.iterdir()) == []


def test_invalid_plate_leaves_no_staged_assets(tmp_path):
    plate = _plate(tmp_path / "multipage.pdf", (54, 8, 63, 23), pages=2)
    output = tmp_path / "assets"
    with pytest.raises(ArtworkMappingError) as error:
        render_deboss_textures(plate, resolved_fixture(), output, raster_width_px=1_200)
    assert error.value.code == "artwork_page_invalid"
    assert list(output.iterdir()) == []


def test_deboss_exposes_relief_on_bare_white_card_and_preserves_print(tmp_path):
    resolved = resolved_fixture()
    ink = _plate(tmp_path / "print.pdf", (50, 0, 60, 50), fill=(0.2, 0.4, 0.6))
    plate = _plate(tmp_path / "deboss.pdf", (54, 8, 72, 23))
    output = tmp_path / "assets"
    sampling = {"raster_width_px": 2_400}
    render_face_assets(ink, resolved, output, **sampling)
    original = {path: path.read_bytes() for path in output.glob("panel_*.png")}

    textures = render_deboss_textures(plate, resolved, output, **sampling)
    assert set(textures.face_assets) == {"front"}
    companion = Path(textures.face_assets["front"])
    assets = {path.stem.removeprefix("panel_"): str(path) for path in original}
    job = {"assets": assets, "deboss_normals": textures.normals, "deboss_face_assets": textures.face_assets}
    validate_job_asset_contract(job, project_dir=tmp_path)
    assert renderer_face_assets(job) == {**assets, "front": str(companion)}

    with Image.open(output / "panel_front.png") as read, Image.open(textures.normals["front"]) as normal:
        x = round(22 / 30 * read.width)
        y = round(15 / 50 * read.height)
        assert read.getpixel((x, y)) == (0, 0, 0, 0)
        assert normal.getpixel((x, y))[0] < 100
        assert companion.name == f"deboss_face_front-{hashlib.sha256(companion.read_bytes()).hexdigest()[:40]}.png"
        with Image.open(companion) as rendered:
            assert (rendered.mode, rendered.size) == ("RGBA", read.size)
            assert rendered.getpixel((x, y)) == (255, 255, 255, 255)
            assert rendered.getpixel((x, 0)) == read.getpixel((x, 0))
            assert rendered.crop((0, 0, read.width // 4, read.height)).tobytes() == read.crop(
                (0, 0, read.width // 4, read.height),
            ).tobytes()
    assert {path: path.read_bytes() for path in output.glob("panel_*.png")} == original
    with companion.open("ab") as stream:
        stream.write(b"tampered bytes")
    with pytest.raises(RenderContractError) as error:
        validate_job_asset_contract(job, project_dir=tmp_path)
    assert error.value.details["field"] == "deboss_face_assets.front"


def test_corrupt_optional_deboss_plate_keeps_print_faces(tmp_path, monkeypatch, capsys):
    pipeline = pipeline_module()
    product, _ = prepare_v2_product(tmp_path)
    artwork = tmp_path / product.pop("artwork_pdf")
    approved = tmp_path / product["structure_sidecar"]
    output = tmp_path / "output"
    project = output / product["code"]
    normalized = project / "illustrator_semantic"
    normalized.mkdir(parents=True)
    plate = normalized / ("deboss-" + "a" * 32 + ".pdf")
    plate.write_bytes(b"these are not PDF bytes")
    monkeypatch.setattr(pipeline, "run_illustrator_structure_export", lambda *_args, **_options: {
        "layers": ["刀版", "印刷", "激凹"],
        "print_pdf": str(artwork),
        "structure_json": str(approved),
        "deboss_pdf": str(plate),
    })

    job = pipeline.preflight_product_v2(product, tmp_path, output, False, {})

    assert {Path(path).name for path in job["assets"].values()} == {
        f"panel_{face}.png" for face in ("front", "right", "back", "left", "top", "bottom")
    }
    pipeline.validate_job_asset_contract(job, project_dir=project)
    assert "deboss_normals" not in job
    assert "deboss_face_assets" not in job
    assert "deboss_plate" not in json.loads((project / "structure_resolution.json").read_text())
    assert "激凹工艺板跳过" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("damage", "error_code"),
    [
        (None, None),
        ("missing", "glb_deboss_normal_binding_invalid"),
        ("wrong_face", "glb_deboss_normal_unexpected"),
        ("base_color", "glb_deboss_normal_binding_invalid"),
        ("wrong_uv", "glb_deboss_normal_binding_invalid"),
        ("wrong_pixels", "glb_deboss_normal_pixels_invalid"),
    ],
)
def test_glb_requires_registered_deboss_pixels_and_normal_texture(tmp_path, damage, error_code):
    module = glb_verify()
    artifact, assets = _runtime_artifact(module, tmp_path)
    document = artifact.document
    normal = tmp_path / "normal_front.png"
    embedded = tmp_path / "embedded.png"
    with Image.new("RGB", (3, 1)) as expected:
        expected.putdata([(176, 128, 246), (128, 128, 255), (79, 128, 246)])
        expected.save(normal)
        with expected.convert("RGBA") as exported:
            if damage == "wrong_pixels":
                exported.putpixel((0, 0), (79, 128, 246, 255))
            exported.save(embedded)

    payload = embedded.read_bytes()
    buffer_view = len(document["bufferViews"])
    texture_index = len(document["textures"])
    document["bufferViews"].append({"buffer": 0, "byteOffset": len(artifact.binary), "byteLength": len(payload)})
    document["images"].append({"bufferView": buffer_view, "mimeType": "image/png"})
    document["textures"].append({"source": len(document["images"]) - 1})
    binary = artifact.binary + payload + b"\x00" * (-len(payload) % 4)
    document["buffers"][0]["byteLength"] = len(binary)
    front, right = (next(row for row in document["materials"] if row["name"] == f"MAT_{face}") for face in ("front", "right"))
    if damage != "missing":
        material = right if damage == "wrong_face" else front
        texture_info = {"index": texture_index}
        if damage == "base_color":
            texture_info["index"] = front["pbrMetallicRoughness"]["baseColorTexture"]["index"]
        if damage == "wrong_uv":
            texture_info["texCoord"] = 1
        material["normalTexture"] = texture_info

    saved = _write_artifact(module, tmp_path, module.GlbArtifact(document, binary))
    report = module.compare_glb_artifact_contract(
        module.load_glb_artifact(saved), assets, resolved_fixture()["dimensions_mm"],
        0.5, [1, 1, 1, 1], deboss_normals={"front": normal},
    )
    assert report["ok"] == (error_code is None), report
    if error_code is not None:
        assert error_code in {error["code"] for error in report["material"]["errors"]}

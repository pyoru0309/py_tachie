from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

from fastapi import UploadFile

from .assets import is_valid_image_file, safe_asset_filename, uploaded_category_path
from .log_setup import app_logger
from .manifest import scan_character_manifest
from .paths import ASSETS_DIR, PROJECT_ROOT

_log = app_logger("character")
from .utils import (
    ProjectContext,
    relative_to_root,
    slugify_project_id,
    write_project_file,
)


def safe_character_root(rel_path: str | None, ctx: ProjectContext | None = None) -> Path:
    if not rel_path:
        raise ValueError("assetRoot is required")
    path = (PROJECT_ROOT / rel_path).resolve()
    allowed_roots = [(ASSETS_DIR / "characters").resolve()]
    if ctx:
        allowed_roots.append((ctx.root / "assets" / "characters").resolve())
    if not any(path == root or root in path.parents for root in allowed_roots):
        raise ValueError("Character path is outside of character assets")
    if not path.exists() or not path.is_dir():
        raise ValueError("Character directory not found")
    return path


def safe_project_character_root(rel_path: str | None, ctx: ProjectContext) -> Path:
    path = safe_character_root(rel_path, ctx)
    project_characters_root = (ctx.root / "assets" / "characters").resolve()
    if not (path == project_characters_root or project_characters_root in path.parents):
        raise ValueError("共通キャラクターはプロジェクト管理画面から削除できません")
    return path


def update_character_manifest_payload(payload: dict[str, Any], ctx: ProjectContext | None = None) -> dict[str, Any]:
    character_dir = safe_character_root(str(payload.get("assetRoot") or ""), ctx)
    manifest = scan_character_manifest(character_dir)
    expected_id = slugify_project_id(str(payload.get("characterId") or manifest.get("id") or character_dir.name))
    path_id = slugify_project_id(character_dir.name)
    if expected_id and expected_id != slugify_project_id(str(manifest.get("id") or expected_id)):
        raise ValueError("Character ID does not match selected character")
    manifest["id"] = slugify_project_id(str(manifest.get("id") or path_id))
    title = str(payload.get("name") or manifest.get("name") or character_dir.name).strip()
    manifest["name"] = title or character_dir.name
    defaults = manifest.setdefault("defaults", {})
    current_character = defaults.get("character") if isinstance(defaults.get("character"), dict) else {}
    character_payload = payload.get("character") if isinstance(payload.get("character"), dict) else {}
    defaults["character"] = {
        "x": int(character_payload.get("x", current_character.get("x", 448))),
        "y": int(character_payload.get("y", current_character.get("y", 0))),
        "scale": float(character_payload.get("scale", current_character.get("scale", 1))),
    }
    if "removeWhite" in payload:
        defaults["removeWhite"] = bool(payload.get("removeWhite"))
    else:
        defaults["removeWhite"] = bool(defaults.get("removeWhite", True))

    # 音声合成の紐付け。voice payload があれば上書き、なければ既存値を保つ。
    if "voice" in payload:
        voice_in = payload.get("voice")
        if isinstance(voice_in, dict):
            manifest["voice"] = {
                "id": str(voice_in.get("id") or "").strip(),
                "emotion": str(voice_in.get("emotion") or "").strip(),
            }
        else:
            manifest["voice"] = {"id": "", "emotion": ""}
    else:
        existing_voice = manifest.get("voice") if isinstance(manifest.get("voice"), dict) else {}
        manifest["voice"] = {
            "id": str(existing_voice.get("id") or "").strip(),
            "emotion": str(existing_voice.get("emotion") or "").strip(),
        }

    # 表示色 (空文字は「未指定 = アクセントカラー使用」)。
    if "color" in payload:
        raw_color = str(payload.get("color") or "").strip().lower()
        manifest["color"] = raw_color if re.fullmatch(r"#[0-9a-f]{6}", raw_color) else ""

    manifest_path = character_dir / "character_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    # 配布用 import_manifest.yml も透過ミラーで再生成しておく。
    # これをやらないと、アセット管理ダイアログで voice / color / removeWhite を
    # 変更しても import_manifest.yml は古いまま残り、「追加インポート」ダイアログ
    # に表示されるマッピング YAML が character_manifest.json と乖離する。
    try:
        from .scenario import refresh_import_manifest_for_character as _refresh_import_manifest
        _refresh_import_manifest(character_dir, manifest)
    except Exception as exc:  # noqa: BLE001
        _log.warning("import_manifest.yml の更新に失敗: %s", exc)
    if ctx and character_dir.is_relative_to(ctx.root):
        write_project_file(ctx)
    return manifest


def write_character_manifest(character_dir: Path, character_id: str, name: str, ctx: ProjectContext) -> dict[str, Any]:
    manifest = scan_character_manifest(character_dir)
    manifest["id"] = character_id
    manifest["name"] = name
    manifest.setdefault("defaults", {})
    manifest_path = character_dir / "character_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    write_project_file(ctx)
    return manifest


def keep_imported_image(candidate_path: Path, target_path: Path) -> bool:
    if not is_valid_image_file(candidate_path):
        candidate_path.unlink(missing_ok=True)
        return False
    target_path.unlink(missing_ok=True)
    candidate_path.replace(target_path)
    return True


async def import_character_uploads(
    *,
    name: str,
    character_id: str,
    psd_file: UploadFile | None,
    zip_file: UploadFile | None,
    png_files: list[UploadFile] | None,
    ctx: ProjectContext,
) -> dict[str, Any]:
    return await import_character_into_root(
        target_characters_root=ctx.root / "assets" / "characters",
        name=name,
        character_id=character_id,
        psd_files=[psd_file] if psd_file else [],
        zip_files=[zip_file] if zip_file else [],
        png_files=list(png_files or []),
        ctx=ctx,
    )


async def import_character_into_root(
    *,
    target_characters_root: Path,
    name: str,
    character_id: str,
    psd_files: list[UploadFile],
    zip_files: list[UploadFile],
    png_files: list[UploadFile],
    ctx: ProjectContext | None,
) -> dict[str, Any]:
    display_name = name.strip() or character_id or "新規キャラクター"
    safe_id = slugify_project_id(character_id or display_name)
    character_dir = target_characters_root / safe_id
    character_dir.mkdir(parents=True, exist_ok=True)

    imported = 0
    for psd_file in psd_files:
        if not psd_file or not psd_file.filename:
            continue
        suffix = Path(psd_file.filename).suffix.lower()
        if suffix != ".psd":
            raise ValueError("PSDファイルを選択してください")
        psd_dir = character_dir / "psd"
        psd_dir.mkdir(parents=True, exist_ok=True)
        psd_path = psd_dir / safe_asset_filename(psd_file.filename)
        psd_path.write_bytes(await psd_file.read())
        manifest_path = character_dir / "character_manifest.json"
        subprocess.run(
            [
                sys.executable,
                str(PROJECT_ROOT / "tools" / "import_psd.py"),
                str(psd_path),
                "--out",
                relative_to_root(character_dir),
                "--manifest",
                relative_to_root(manifest_path),
                "--name",
                display_name,
            ],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        # PSD ルート直下に import_manifest.yml テキストレイヤーがあれば、
        # flags / preset / メタ情報を反映する (loose PSD 経路と同じ helper を流用)。
        try:
            from .assets import _apply_psd_embedded_yaml_after_import
            _apply_psd_embedded_yaml_after_import(psd_path, character_dir, manifest_path)
        except Exception as exc:  # noqa: BLE001
            _log.warning("upload: PSD 埋め込み YAML の反映に失敗: %s", exc)
        imported += 1

    for zip_file in zip_files:
        if not zip_file or not zip_file.filename:
            continue
        suffix = Path(zip_file.filename).suffix.lower()
        if suffix != ".zip":
            raise ValueError("ZIPファイルを選択してください")
        zip_path = character_dir / safe_asset_filename(zip_file.filename)
        zip_path.write_bytes(await zip_file.read())
        with zipfile.ZipFile(zip_path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                suffix = Path(info.filename).suffix.lower()
                if suffix not in {".png", ".webp", ".avif"}:
                    continue
                category_path = uploaded_category_path(info.filename)
                if not category_path:
                    continue
                category, filename = category_path
                target_dir = character_dir / category
                target_dir.mkdir(parents=True, exist_ok=True)
                target_path = target_dir / filename
                candidate_path = target_dir / f".{target_path.name}.importing"
                candidate_path.unlink(missing_ok=True)
                with archive.open(info) as source, candidate_path.open("wb") as target:
                    shutil.copyfileobj(source, target)
                if not keep_imported_image(candidate_path, target_path):
                    continue
                imported += 1
        zip_path.unlink(missing_ok=True)

    for upload in png_files:
        if not upload or not upload.filename:
            continue
        suffix = Path(upload.filename).suffix.lower()
        if suffix not in {".png", ".webp", ".avif"}:
            continue
        category_path = uploaded_category_path(upload.filename)
        if not category_path:
            continue
        category, filename = category_path
        target_dir = character_dir / category
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / filename
        candidate_path = target_dir / f".{target_path.name}.importing"
        candidate_path.unlink(missing_ok=True)
        candidate_path.write_bytes(await upload.read())
        if not keep_imported_image(candidate_path, target_path):
            continue
        imported += 1

    if imported == 0:
        raise ValueError("PSD、ZIP、またはカテゴリ別フォルダ内のPNG/WebP/AVIFを選択してください")

    manifest = scan_character_manifest(character_dir)
    manifest["id"] = safe_id
    manifest["name"] = display_name
    manifest.setdefault("defaults", {})
    manifest_path = character_dir / "character_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    # ZIP / フォルダのルート直下に import_manifest.yml (or 旧 .import.yaml) があれば、
    # 統合ヘルパで flags / removeWhite / voice / color / 表情/髪型プリセット を反映する。
    try:
        from .psd import (
            parse_psd_importer_yaml as _parse_psd_importer_yaml,
            read_import_manifest_yaml_text as _read_import_manifest_yaml_text,
        )
        from .scenario import (
            apply_import_manifest_yaml_to_character as _apply_import_manifest,
        )
        yaml_text = _read_import_manifest_yaml_text(character_dir)
        if yaml_text:
            parsed = _parse_psd_importer_yaml(yaml_text)
            applied = _apply_import_manifest(character_dir, manifest, parsed)
            if applied.get("expression") or applied.get("hairstyle"):
                _log.info(
                    "upload: %s: presets applied (expression=%s, hairstyle=%s)",
                    character_dir.name, applied["expression"], applied["hairstyle"],
                )
    except Exception as exc:  # noqa: BLE001
        _log.warning("upload: import_manifest.yml の反映に失敗: %s", exc)

    if ctx is not None:
        write_project_file(ctx)
    return manifest

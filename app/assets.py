from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, UnidentifiedImageError

from .log_setup import app_logger
from .paths import ASSETS_DIR, PROJECT_ROOT
from .utils import ProjectContext, relative_to_root, slugify_project_id

_log = app_logger("assets")


def to_nfc(value: str) -> str:
    # macOS の HFS+/APFS は濁点・半濁点を NFD で保存することがある。Windows (NTFS) は
    # 厳密一致なので NFD ファイルを NFC 名で開けず素材が認識されなくなる。アップロード
    # 経路 / scan / scenario すべてで NFC に統一して fork を発生させない。
    return unicodedata.normalize("NFC", value or "")


def safe_asset_filename(filename: str) -> str:
    filename = to_nfc(filename)
    stem = re.sub(r'[\\/:*?"<>|]+', "_", Path(filename).stem).strip(" ._") or "asset"
    suffix = Path(filename).suffix.lower()
    return f"{stem}{suffix}"


def is_valid_image_file(path: Path) -> bool:
    if path.name.startswith("._") or "__MACOSX" in path.parts:
        return False
    try:
        with Image.open(path) as image:
            image.verify()
        return True
    except (OSError, UnidentifiedImageError):
        return False


def valid_manifest_items(items: Any) -> list[dict[str, str]]:
    if not isinstance(items, list):
        return []
    valid_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        rel_path = str(item.get("path") or "")
        if not rel_path:
            continue
        try:
            path = (PROJECT_ROOT / rel_path).resolve()
            if path.exists() and is_valid_image_file(path):
                valid_items.append(item)
        except ValueError:
            continue
    return valid_items


def valid_image_asset_path(path_value: Any) -> bool:
    rel_path = str(path_value or "")
    if not rel_path:
        return False
    try:
        path = (PROJECT_ROOT / rel_path).resolve()
    except ValueError:
        return False
    return path.exists() and is_valid_image_file(path)


def ignored_upload_member(filename: str) -> bool:
    parts = [part for part in PurePosixPath(filename).parts if part not in ("", ".", "..")]
    return any(part == "__MACOSX" or part.startswith("._") for part in parts) or (
        bool(parts) and parts[-1].startswith(".")
    )


def uploaded_category_path(filename: str) -> tuple[str, str] | None:
    if ignored_upload_member(filename):
        return None
    parts = [part for part in PurePosixPath(filename).parts if part not in ("", ".", "..")]
    if not parts:
        return None
    aliases = {
        "base": "base",
        "bases": "base",
        # 旧 v3 命名は v4 では bases に流し込む
        "body": "base",
        "bodies": "base",
        "pose": "base",
        "poses": "base",
        "costume": "base",
        "costumes": "base",
        "cheek": "cheek",
        "cheeks": "cheek",
        "eye": "eye",
        "eyes": "eye",
        "mouth": "mouth",
        "mouths": "mouth",
        "bangs": "bangs",
        "前髪": "bangs",
        "back_hair": "back_hair",
        "backhair": "back_hair",
        "back_hairs": "back_hair",
        "backhairs": "back_hair",
        "後ろ髪": "back_hair",
        "うしろ髪": "back_hair",
        "後髪": "back_hair",
        "front": "front",
        "fronts": "front",
        "前面": "front",
        # 旧 v3 foreground は front に集約
        "foreground": "front",
        "foregrounds": "front",
    }
    for part in parts[:-1]:
        category = aliases.get(part.lower())
        if category:
            return category, safe_asset_filename(parts[-1])
    return None


def image_items(directory: str, prefix: str) -> list[dict[str, str]]:
    target = PROJECT_ROOT / directory
    if not target.exists():
        return []
    items = []
    paths = sorted(
        path
        for pattern in ("*.png", "*.webp", "*.avif")
        for path in target.glob(pattern)
    )
    for index, path in enumerate(paths, start=1):
        items.append(
            {
                "id": f"{prefix}_{index:02d}",
                "name": f"{prefix}_{index:02d}",
                "path": path.relative_to(PROJECT_ROOT).as_posix(),
            }
        )
    return items


def asset_items(paths: list[Path], prefix: str) -> list[dict[str, str]]:
    items = []
    seen: set[str] = set()
    for path in sorted(paths):
        if not path.exists() or not path.is_file():
            continue
        rel_path = relative_to_root(path)
        if rel_path in seen:
            continue
        seen.add(rel_path)
        items.append(
            {
                "id": f"{prefix}_{len(items) + 1:02d}",
                "name": path.stem,
                "path": rel_path,
            }
        )
    return items


def migrate_nfc_filenames(root: Path) -> int:
    # root 配下を recursive walk して、NFD 文字を含むファイル/ディレクトリ名を NFC に
    # リネームする。Windows (NTFS) との互換のため。UI のアセット管理経由だけでなく
    # ユーザーが Finder/Explorer から直接ファイルを置く経路もカバーする想定で、
    # `scan_project_assets` を呼ぶ直前にこれを実行する。idempotent: NFC のみなら no-op。
    #
    # macOS APFS は normalization-insensitive matching するので、NFD ファイル A に対して
    # NFC 名で `new_path.exists()` が True を返す (= 同じディスクエントリを指す)。
    # この場合は一時名を経由した 2-step rename で強制的にディスク上の表記を変える。
    # 真に別ファイル (= 別 inode) で衝突している場合のみ WARN+スキップ。
    if not root.exists():
        return 0
    renamed = 0
    # bottom-up で walk しないと、親ディレクトリを先にリネームすると下層の path が壊れる
    entries: list[Path] = []
    for path in root.rglob("*"):
        entries.append(path)
    entries.sort(key=lambda p: len(p.parts), reverse=True)
    for path in entries:
        try:
            name = path.name
            nfc_name = unicodedata.normalize("NFC", name)
            if name == nfc_name:
                continue
            new_path = path.with_name(nfc_name)
            if new_path.exists():
                try:
                    same_entry = path.stat().st_ino == new_path.stat().st_ino
                except OSError:
                    same_entry = False
                if not same_entry:
                    _log.warning(
                        "NFC migration skipped (target exists with different inode): %s -> %s",
                        path,
                        new_path,
                    )
                    continue
                # 同一 inode = APFS の normalization-insensitive matching。
                # 一時名経由でリネームしてディスク上の表記を NFC に書き換える。
                tmp_name = f".__nfc_migrate__{nfc_name}"
                tmp_path = path.with_name(tmp_name)
                if tmp_path.exists():
                    tmp_path = path.with_name(f".__nfc_migrate__{uuid.uuid4().hex}__{nfc_name}")
                path.rename(tmp_path)
                tmp_path.rename(new_path)
            else:
                path.rename(new_path)
            renamed += 1
            _log.info("NFC migration: %s -> %s", name, nfc_name)
        except OSError as exc:
            _log.warning("NFC migration failed for %s: %s", path, exc)
    return renamed


def scan_project_assets(ctx: ProjectContext) -> dict[str, list[dict[str, str]]]:
    # AVIF は Pillow 12.x のネイティブ対応。背景/前景/オーバーレイ/キャラ全てで透過保持。
    # 直前に NFC リネームを走らせて、macOS NFD 名のファイルが Windows で
    # 認識されないバグを毎回防ぐ。idempotent なので overhead は小さい。
    migrate_nfc_filenames(ASSETS_DIR)
    migrate_nfc_filenames(ctx.root / "assets")
    background_exts = ("*.png", "*.jpg", "*.jpeg", "*.webp", "*.avif")
    overlay_exts = ("*.png", "*.webp", "*.avif")
    audio_exts = ("*.wav", "*.mp3", "*.m4a", "*.aac", "*.ogg")
    video_exts = ("*.mp4", "*.mov", "*.webm", "*.mkv")
    common_backgrounds = [path for pattern in background_exts for path in (ASSETS_DIR / "backgrounds").rglob(pattern)]
    common_foregrounds = [path for pattern in background_exts for path in (ASSETS_DIR / "foregrounds").rglob(pattern)]
    common_overlays = [path for pattern in overlay_exts for path in (ASSETS_DIR / "overlays").rglob(pattern)]
    common_audio = [path for pattern in audio_exts for path in (ASSETS_DIR / "audio").rglob(pattern)]
    common_sound_effects = [
        path for pattern in audio_exts for path in (ASSETS_DIR / "sound_effects").rglob(pattern)
    ]
    common_videos = [path for pattern in video_exts for path in (ASSETS_DIR / "videos").rglob(pattern)]
    project_backgrounds = [
        path for pattern in background_exts for path in (ctx.root / "assets" / "backgrounds").rglob(pattern)
    ]
    project_foregrounds = [
        path for pattern in background_exts for path in (ctx.root / "assets" / "foregrounds").rglob(pattern)
    ]
    project_overlays = [
        path for pattern in overlay_exts for path in (ctx.root / "assets" / "overlays").rglob(pattern)
    ]
    project_audio = [path for pattern in audio_exts for path in (ctx.root / "assets" / "audio").rglob(pattern)]
    project_sound_effects = [
        path for pattern in audio_exts for path in (ctx.root / "assets" / "sound_effects").rglob(pattern)
    ]
    project_videos = [path for pattern in video_exts for path in (ctx.root / "assets" / "videos").rglob(pattern)]
    return {
        "backgrounds": asset_items(project_backgrounds + common_backgrounds, "background"),
        "foregrounds": asset_items(project_foregrounds + common_foregrounds, "foreground"),
        "overlays": asset_items(project_overlays + common_overlays, "overlay"),
        "audio": asset_items(project_audio + common_audio, "audio"),
        "soundEffects": asset_items(project_sound_effects + common_sound_effects, "sound_effect"),
        "videos": asset_items(project_videos + common_videos, "video"),
    }


def character_roots(ctx: ProjectContext) -> list[tuple[Path, str]]:
    return [
        (ASSETS_DIR / "characters", "common"),
        (ctx.root / "assets" / "characters", "project"),
    ]


def _run_import_psd_cli(psd_path: Path, target_dir: Path, manifest_path: Path, display_name: str) -> None:
    """`tools/import_psd.py` をサブプロセスで起動し、レイヤー命名規則ベースで
    PSD をキャラクターディレクトリに展開する。"""
    target_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            str(PROJECT_ROOT / "tools" / "import_psd.py"),
            str(psd_path),
            "--out",
            relative_to_root(target_dir),
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


def _apply_psd_embedded_yaml_after_import(psd_path: Path, target_dir: Path, manifest_path: Path) -> None:
    """インポート完了後、PSD ルート直下に `import_manifest.yml` テキストレイヤー
    があれば、その flags / preset / メタ情報を character に反映する。"""
    try:
        from .psd import (
            _extract_psd_embedded_yaml as _extract,
            parse_psd_importer_yaml as _parse,
        )
        from .scenario import (
            apply_import_manifest_yaml_to_character as _apply_import_manifest,
        )
        from psd_tools import PSDImage
    except Exception:
        return
    try:
        psd = PSDImage.open(psd_path)
        yaml_text = _extract(psd)
        if not yaml_text:
            return
        parsed = _parse(yaml_text)
        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        applied = _apply_import_manifest(target_dir, manifest, parsed)
        if applied.get("expression") or applied.get("hairstyle"):
            _log.info(
                "loose-psd %s: embedded YAML presets applied (expression=%s, hairstyle=%s)",
                target_dir.name, applied["expression"], applied["hairstyle"],
            )
    except Exception as exc:  # noqa: BLE001
        _log.warning("loose-psd %s の埋め込み YAML 反映に失敗: %s", psd_path.name, exc)


def import_character_psds(ctx: ProjectContext) -> bool:
    """`assets/characters/<id>/psd/*.psd` (per-character) を毎起動 / 素材再スキャン
    で自動取り込みする。PSD ルートに `import_manifest.yml` テキストレイヤーが
    あれば flags / preset / メタ情報も反映する。

    ルート直下の `assets/psd/` 直置きルートは廃止 (GUI からの登録専用とする)。
    """
    changed = False
    for characters_root, _origin in character_roots(ctx):
        if not characters_root.exists():
            continue
        for character_dir in sorted(path for path in characters_root.iterdir() if path.is_dir()):
            psd_dir = character_dir / "psd"
            psd_files = sorted(psd_dir.glob("*.psd")) if psd_dir.exists() else []
            if not psd_files:
                continue
            manifest_path = character_dir / "character_manifest.json"
            latest_psd_mtime = max(path.stat().st_mtime for path in psd_files)
            if manifest_path.exists() and manifest_path.stat().st_mtime >= latest_psd_mtime:
                continue
            _run_import_psd_cli(psd_files[0], character_dir, manifest_path, character_dir.name)
            _apply_psd_embedded_yaml_after_import(psd_files[0], character_dir, manifest_path)
            changed = True
    return changed


# ============================================================================
# アセット管理（共通／プロジェクト × キャラ・背景・オーバーレイ・フォント・音声）
# ============================================================================

ASSET_CATEGORY_KINDS: dict[str, dict[str, Any]] = {
    "characters": {"kind": "directory", "extensions": []},
    "backgrounds": {"kind": "file", "extensions": [".png", ".jpg", ".jpeg", ".webp", ".avif"]},
    "foregrounds": {"kind": "file", "extensions": [".png", ".jpg", ".jpeg", ".webp", ".avif"]},
    "overlays": {"kind": "file", "extensions": [".png", ".webp", ".avif"]},
    "fonts": {"kind": "file", "extensions": [".otf", ".ttf"]},
    "audio": {"kind": "file", "extensions": [".wav", ".mp3", ".m4a", ".aac", ".ogg"]},
    "sound_effects": {"kind": "file", "extensions": [".wav", ".mp3", ".m4a", ".aac", ".ogg"]},
    "videos": {"kind": "file", "extensions": [".mp4", ".mov", ".webm", ".mkv"]},
}


def asset_scope_root(scope: str, ctx: ProjectContext | None) -> Path:
    if scope == "common":
        return ASSETS_DIR
    if scope == "project":
        if ctx is None:
            raise ValueError("プロジェクトが選択されていません")
        return ctx.root / "assets"
    raise ValueError(f"未知のスコープです: {scope}")


def asset_scope_trash_root(scope: str, ctx: ProjectContext | None) -> Path:
    return asset_scope_root(scope, ctx) / ".trash"


def ensure_trash_root(scope: str, ctx: ProjectContext | None) -> Path:
    root = asset_scope_trash_root(scope, ctx)
    (root / "files").mkdir(parents=True, exist_ok=True)
    manifest_path = root / "trash.json"
    if not manifest_path.exists():
        manifest_path.write_text("[]", encoding="utf-8")
    return root


def load_trash_manifest(scope: str, ctx: ProjectContext | None) -> list[dict[str, Any]]:
    path = asset_scope_trash_root(scope, ctx) / "trash.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
    except json.JSONDecodeError:
        pass
    return []


def save_trash_manifest(scope: str, entries: list[dict[str, Any]], ctx: ProjectContext | None) -> None:
    ensure_trash_root(scope, ctx)
    path = asset_scope_trash_root(scope, ctx) / "trash.json"
    path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def safe_resolve_asset_path(scope: str, sub_path: str, ctx: ProjectContext | None) -> Path:
    base = asset_scope_root(scope, ctx).resolve()
    candidate = (base / sub_path).resolve()
    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise ValueError(f"許可されていないパスです: {sub_path}") from exc
    return candidate


def is_inside_trash(path: Path, scope: str, ctx: ProjectContext | None) -> bool:
    trash = asset_scope_trash_root(scope, ctx).resolve()
    if not trash.exists():
        return False
    try:
        path.resolve().relative_to(trash)
        return True
    except ValueError:
        return False


def directory_size_bytes(path: Path) -> int:
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            try:
                total += child.stat().st_size
            except OSError:
                continue
    return total


def asset_url(rel_path: str | None) -> str | None:
    if not rel_path:
        return None
    safe_rel = rel_path.replace("\\", "/")
    url = "/assets/" + safe_rel
    # `?v=<mtime_ns>` を付けてブラウザの texture-cache (URL キー memoize) を invalidate する。
    # PNG を上書きしても URL が同じだと renderer/texture-cache.js が古い Texture を
    # 返し続け、「画像を差し替えたのに反映されない」状態になる。stat 失敗時は
    # クエリ無しで返す (asset_url は不在パスでも URL を生成する用途がある)。
    try:
        mtime_ns = (PROJECT_ROOT / rel_path).stat().st_mtime_ns
    except OSError:
        return url
    return f"{url}?v={mtime_ns}"


def _font_display_name(path: Path) -> str | None:
    """フォントファイルの UI 表示名 (日本語 name 優先) を返す。失敗時は None。

    アセット管理のフォント一覧で、ファイル名 (NekoSpoon.otf) ではなく
    name table 由来の family 名 (ねこスプーン) を見出しに出すため。
    fontTools 未導入などで解決できないときは None でファイル名表示に倒す。
    """
    try:
        from .font_inspect import inspect_font
        from .config import display_name_for_font, font_family_and_weight

        meta = inspect_font(path)
        stem_family, _ = font_family_and_weight(path.stem)
        name = display_name_for_font(meta, stem_family)
        return name or None
    except Exception:  # noqa: BLE001
        return None


def file_metadata(path: Path, scope_root: Path) -> dict[str, Any]:
    stat = path.stat()
    rel_under_scope = path.relative_to(scope_root).as_posix()
    rel_root = relative_to_root(path).replace("\\", "/")
    meta: dict[str, Any] = {
        "name": path.name,
        "stem": path.stem,
        "ext": path.suffix.lower(),
        "relativePath": rel_under_scope,
        "rootPath": rel_root,
        "url": asset_url(rel_root),
        "size": stat.st_size,
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "kind": "file",
    }
    if path.suffix.lower() in (".otf", ".ttf"):
        display = _font_display_name(path)
        if display:
            meta["displayName"] = display
    return meta


def scan_character_directory_summary(char_dir: Path, scope_root: Path) -> dict[str, Any]:
    manifest_path = char_dir / "character_manifest.json"
    manifest_data: dict[str, Any] = {}
    if manifest_path.exists():
        try:
            manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            manifest_data = {}

    parts_count: dict[str, int] = {}
    for category in ("back_hair", "base", "cheek", "eye", "mouth", "bangs", "front"):
        sub = char_dir / category
        if sub.exists():
            parts_count[category] = sum(
                1
                for entry in sub.iterdir()
                if entry.is_file() and is_valid_image_file(entry)
            )

    psd_dir = char_dir / "psd"
    psd_files = sorted(psd_dir.glob("*.psd")) if psd_dir.exists() else []

    preview_path: Path | None = None
    thumb_candidate = char_dir / "thumb.png"
    if thumb_candidate.exists() and is_valid_image_file(thumb_candidate):
        preview_path = thumb_candidate
    if preview_path is None:
        candidate_dir = char_dir / "base"
        if candidate_dir.exists():
            for image in sorted(candidate_dir.iterdir()):
                if image.is_file() and is_valid_image_file(image):
                    preview_path = image
                    break

    stat = char_dir.stat()
    rel_root = relative_to_root(char_dir).replace("\\", "/")
    preview_url = asset_url(relative_to_root(preview_path).replace("\\", "/")) if preview_path else None
    return {
        "name": char_dir.name,
        "characterId": char_dir.name,
        "displayName": manifest_data.get("name") or char_dir.name,
        "relativePath": char_dir.relative_to(scope_root).as_posix(),
        "rootPath": rel_root,
        "url": preview_url,
        "size": directory_size_bytes(char_dir),
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "kind": "directory",
        "hasManifest": manifest_path.exists(),
        "hasPsd": bool(psd_files),
        "psdCount": len(psd_files),
        "partsCount": parts_count,
        "readOnly": bool(manifest_data.get("readOnly")),
    }


def scan_assets_for_scope(scope: str, ctx: ProjectContext | None) -> dict[str, Any]:
    if scope == "project" and ctx is None:
        raise ValueError("プロジェクトが選択されていません")

    scope_root = asset_scope_root(scope, ctx)
    scope_root.mkdir(parents=True, exist_ok=True)

    inventory: dict[str, list[dict[str, Any]]] = {}
    for category, info in ASSET_CATEGORY_KINDS.items():
        category_root = scope_root / category
        items: list[dict[str, Any]] = []
        if category_root.exists():
            if info["kind"] == "directory":
                for entry in sorted(category_root.iterdir()):
                    if entry.is_dir() and not entry.name.startswith("."):
                        items.append(scan_character_directory_summary(entry, scope_root))
            else:
                extensions = info["extensions"]
                for path in sorted(category_root.rglob("*")):
                    if not path.is_file():
                        continue
                    if path.suffix.lower() not in extensions:
                        continue
                    rel_parts = path.relative_to(category_root).parts
                    if any(part.startswith(".") for part in rel_parts):
                        continue
                    if path.name.startswith("._") or "__MACOSX" in path.parts:
                        continue
                    items.append(file_metadata(path, scope_root))
        inventory[category] = items

    return {
        "scope": scope,
        "scopeRoot": relative_to_root(scope_root),
        "categories": inventory,
        "trash": load_trash_manifest(scope, ctx),
    }


def move_asset_to_trash(
    scope: str,
    category: str,
    rel_path: str,
    ctx: ProjectContext | None,
) -> dict[str, Any]:
    if category not in ASSET_CATEGORY_KINDS:
        raise ValueError(f"未知のカテゴリです: {category}")
    info = ASSET_CATEGORY_KINDS[category]
    scope_root = asset_scope_root(scope, ctx)
    relative = (Path(category) / rel_path).as_posix()
    source = safe_resolve_asset_path(scope, relative, ctx)
    if not source.exists():
        raise FileNotFoundError(f"アセットが見つかりません: {relative}")
    if is_inside_trash(source, scope, ctx):
        raise ValueError("このアセットはすでにゴミ箱にあります")

    ensure_trash_root(scope, ctx)
    trash_files = asset_scope_trash_root(scope, ctx) / "files"
    trash_id = uuid.uuid4().hex
    target = trash_files / f"{trash_id}__{source.name}"

    shutil.move(str(source), str(target))

    if target.is_dir():
        size = directory_size_bytes(target)
    else:
        try:
            size = target.stat().st_size
        except OSError:
            size = 0

    entry = {
        "id": trash_id,
        "name": source.name,
        "originalPath": relative,
        "category": category,
        "scope": scope,
        "deletedAt": datetime.now(timezone.utc).isoformat(),
        "size": size,
        "kind": info["kind"],
    }

    entries = load_trash_manifest(scope, ctx)
    entries.insert(0, entry)
    save_trash_manifest(scope, entries, ctx)
    return entry


def restore_asset_from_trash(
    scope: str,
    trash_id: str,
    ctx: ProjectContext | None,
) -> dict[str, Any]:
    entries = load_trash_manifest(scope, ctx)
    matching = next((entry for entry in entries if entry.get("id") == trash_id), None)
    if matching is None:
        raise FileNotFoundError("ゴミ箱に該当するエントリがありません")

    trash_files = asset_scope_trash_root(scope, ctx) / "files"
    source = trash_files / f"{trash_id}__{matching['name']}"
    if not source.exists():
        raise FileNotFoundError("ゴミ箱内のファイルが見つかりません")

    scope_root = asset_scope_root(scope, ctx)
    target = scope_root / matching["originalPath"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if matching.get("kind") == "directory":
            stem = target.name
            counter = 1
            while True:
                alt = target.parent / f"{stem}_復元{counter}"
                if not alt.exists():
                    target = alt
                    break
                counter += 1
        else:
            stem = target.stem
            suffix = target.suffix
            counter = 1
            while True:
                alt = target.with_name(f"{stem}_復元{counter}{suffix}")
                if not alt.exists():
                    target = alt
                    break
                counter += 1

    shutil.move(str(source), str(target))

    remaining = [entry for entry in entries if entry.get("id") != trash_id]
    save_trash_manifest(scope, remaining, ctx)

    return {
        **matching,
        "restoredPath": target.relative_to(scope_root).as_posix(),
    }


def empty_asset_trash(scope: str, ctx: ProjectContext | None) -> int:
    trash_root = asset_scope_trash_root(scope, ctx)
    files_dir = trash_root / "files"
    removed = 0
    if files_dir.exists():
        for child in files_dir.iterdir():
            try:
                if child.is_file() or child.is_symlink():
                    child.unlink()
                elif child.is_dir():
                    shutil.rmtree(child)
                removed += 1
            except OSError:
                continue
    save_trash_manifest(scope, [], ctx)
    return removed


def rename_asset(
    scope: str,
    category: str,
    rel_path: str,
    new_name: str,
    ctx: ProjectContext | None,
) -> dict[str, Any]:
    if category not in ASSET_CATEGORY_KINDS:
        raise ValueError(f"未知のカテゴリです: {category}")
    info = ASSET_CATEGORY_KINDS[category]
    scope_root = asset_scope_root(scope, ctx)
    relative = (Path(category) / rel_path).as_posix()
    source = safe_resolve_asset_path(scope, relative, ctx)
    if not source.exists():
        raise FileNotFoundError(relative)

    if info["kind"] == "directory":
        safe_id = re.sub(r"[^A-Za-z0-9_\-]+", "_", new_name).strip("_") or "character"
        target = source.parent / safe_id
    else:
        clean = safe_asset_filename(new_name)
        if not Path(new_name).suffix:
            clean = Path(clean).stem + source.suffix
        target = source.parent / clean

    if target == source:
        return scan_character_directory_summary(target, scope_root) if info["kind"] == "directory" else file_metadata(target, scope_root)

    if target.exists():
        raise ValueError(f"既に同名が存在します: {target.name}")

    source.rename(target)
    return (
        scan_character_directory_summary(target, scope_root)
        if info["kind"] == "directory"
        else file_metadata(target, scope_root)
    )


def find_missing_asset_references(ctx: ProjectContext) -> list[dict[str, Any]]:
    missing: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    scenarios_dir = ctx.root / "scenarios"
    if not scenarios_dir.exists():
        return missing
    for scenario_path in sorted(scenarios_dir.glob("*.json")):
        try:
            data = json.loads(scenario_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        cuts = data.get("cuts", [])
        if not isinstance(cuts, list):
            continue
        for cut in cuts:
            if not isinstance(cut, dict):
                continue
            cut_id = str(cut.get("id") or cut.get("title") or "")
            state = cut.get("state", {}) or {}
            checks: list[tuple[str, str]] = []
            background = state.get("background")
            if isinstance(background, str) and background:
                checks.append(("background", background))
            audio = cut.get("audio")
            if isinstance(audio, str) and audio:
                checks.append(("audio", audio))
            text_style = state.get("textStyle", {}) or {}
            overlay = text_style.get("boxOverlayImage")
            if isinstance(overlay, str) and overlay:
                checks.append(("textStyle.boxOverlayImage", overlay))
            # v4 ではキャラ素材は ID 参照なのでパス存在チェックは不要
            for field, ref in checks:
                target = (PROJECT_ROOT / ref).resolve()
                try:
                    target.relative_to(PROJECT_ROOT)
                    inside = True
                except ValueError:
                    inside = False
                if inside and target.exists():
                    continue
                key = (scenario_path.stem, cut_id, field, ref)
                if key in seen:
                    continue
                seen.add(key)
                missing.append(
                    {
                        "scenario": scenario_path.stem,
                        "cutId": cut_id,
                        "field": field,
                        "path": ref,
                    }
                )
    return missing

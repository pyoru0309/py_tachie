from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .assets import (
    character_roots,
    import_character_psds,
    is_valid_image_file,
    scan_project_assets,
    valid_manifest_items,
)
from .config import default_config
from .paths import ASSETS_DIR, DEFAULT_PROJECT_ID
from .utils import (
    ProjectContext,
    current_project,
    project_context,
    relative_to_root,
    slugify_project_id,
)


CHARACTER_CATEGORIES = {
    "back_hair": "backHairs",
    "base": "bases",
    "cheek": "cheeks",
    "eye": "eyes",
    "mouth": "mouths",
    "bangs": "bangs",
    "front": "fronts",
}
V4_MANIFEST_KEYS = ["backHairs", "bases", "cheeks", "eyes", "mouths", "bangs", "fronts"]


def generate_manifest(ctx: ProjectContext | None = None) -> dict[str, Any]:
    ctx = ctx or current_project()
    import_character_psds(ctx)
    project_assets = scan_project_assets(ctx)
    backgrounds = []
    backgrounds = project_assets["backgrounds"] + backgrounds
    foregrounds = project_assets.get("foregrounds", [])
    base = {"id": "", "name": "", "path": ""}

    return {
        "version": 1,
        "canvas": {"width": 1920, "height": 1080},
        "backgrounds": backgrounds,
        "foregrounds": foregrounds,
        "backHairs": [],
        "bases": [],
        "cheeks": [],
        "eyes": [],
        "mouths": [],
        "bangs": [],
        "fronts": [],
        "audio": project_assets["audio"],
        "soundEffects": project_assets.get("soundEffects", []),
        "videos": project_assets.get("videos", []),
        "overlays": project_assets["overlays"],
        "defaults": {
            "background": backgrounds[0]["path"] if backgrounds else "",
            "character": {"x": 448, "y": 0, "scale": 1},
            "textStyle": {
                "fontSize": 54,
                "fontFamily": "noto_sans_jp",
                "fontWeight": "regular",
                "align": "left",
                "lines": 2,
                "boxOpacity": 215,
                "speechPlacement": "bottom",
                "boxBorderWidth": 3,
                "boxBorderColor": "#ffffff",
                "boxBackgroundColor": "#14181c",
                "textColor": "#ffffff",
                "textOutlineWidth": 0,
                "textOutlineColor": "#666666",
                "boxOverlayImage": "",
                "speechOffsetX": 120,
                "speechOffsetY": 70,
                "speechPaddingX": 60,
                "speechPaddingY": 70,
                "lineGap": 16,
                "speakerNameFontSize": 28,
                "inactiveCharacterOpacity": 0.5,
            },
            "removeWhite": True,
        },
    }


def category_items_from_directory(character_dir: Path, category: str, target_key: str) -> list[dict[str, str]]:
    category_dir = character_dir / category
    if not category_dir.exists():
        return []
    paths = sorted(
        path
        for pattern in ("*.png", "*.webp", "*.avif")
        for path in category_dir.glob(pattern)
        if path.is_file() and is_valid_image_file(path)
    )
    items = []
    for path in paths:
        label = path.stem
        items.append(
            {
                "id": f"{category}_{slugify_project_id(label)}",
                "name": label,
                "path": relative_to_root(path),
            }
        )
    return items


def default_body_item(items: list[dict[str, str]]) -> dict[str, str] | None:
    if not items:
        return None
    return next(
        (
            item
            for item in items
            if "default" in item.get("name", "").lower() or "デフォルト" in item.get("name", "")
        ),
        items[0],
    )


def _v4_upgrade_manifest_in_memory(manifest: dict[str, Any]) -> dict[str, Any]:
    """ディスク書き戻しせずに in-memory で v3→v4 互換キーを揃える。"""
    if int(manifest.get("version") or 0) >= 4:
        return manifest
    legacy_bodies = (
        manifest.get("bodies")
        or manifest.get("costumes")
        or manifest.get("poses")
        or manifest.get("base")
        or []
    )
    if isinstance(legacy_bodies, dict):
        legacy_bodies = [legacy_bodies]
    if not manifest.get("bases"):
        manifest["bases"] = legacy_bodies
    if not manifest.get("fronts") and isinstance(manifest.get("foregrounds"), list):
        manifest["fronts"] = manifest.get("foregrounds") or []
    manifest.setdefault("bangs", [])
    manifest.setdefault("backHairs", [])
    manifest["version"] = 4
    return manifest


def scan_character_manifest(character_dir: Path) -> dict[str, Any]:
    manifest_path = character_dir / "character_manifest.json"
    if manifest_path.exists():
        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    else:
        manifest = {
            "version": 4,
            "id": slugify_project_id(character_dir.name),
            "name": character_dir.name,
        }

    manifest = _v4_upgrade_manifest_in_memory(manifest)
    manifest.setdefault("version", 4)
    manifest["id"] = slugify_project_id(str(manifest.get("id") or character_dir.name))
    manifest["name"] = str(manifest.get("name") or character_dir.name)
    for category, target_key in CHARACTER_CATEGORIES.items():
        manifest[target_key] = valid_manifest_items(manifest.get(target_key))
        if not manifest[target_key]:
            manifest[target_key] = category_items_from_directory(character_dir, category, target_key)
    manifest.setdefault("defaults", {})
    manifest["defaults"].setdefault("character", {"x": 448, "y": 0, "scale": 1})
    manifest["defaults"].setdefault("removeWhite", True)
    # 音声合成の紐付け (voice id + 既定 emotion)。設定が無ければ空 dict。
    voice_in = manifest.get("voice")
    if isinstance(voice_in, dict):
        manifest["voice"] = {
            "id": str(voice_in.get("id") or "").strip(),
            "emotion": str(voice_in.get("emotion") or "").strip(),
        }
    else:
        manifest["voice"] = {"id": "", "emotion": ""}
    # 表示色 (#rrggbb)。空文字は「未指定 = アクセントカラーを使う」。
    raw_color = str(manifest.get("color") or "").strip().lower()
    if re.fullmatch(r"#[0-9a-f]{6}", raw_color):
        manifest["color"] = raw_color
    else:
        manifest["color"] = ""
    return manifest


def merge_project_asset_manifest(manifest: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    project_assets = scan_project_assets(ctx)
    for key in ["backgrounds", "audio", "soundEffects", "overlays"]:
        existing = manifest.setdefault(key, [])
        existing_paths = {item.get("path") for item in existing}
        for item in project_assets[key]:
            if item.get("path") not in existing_paths:
                existing.insert(0 if key == "backgrounds" else len(existing), item)
                existing_paths.add(item.get("path"))
    if manifest.get("backgrounds"):
        manifest.setdefault("defaults", {})["background"] = manifest["backgrounds"][0]["path"]
    return manifest


def _read_asset_expression_presets_for_character(character_dir: Path) -> list[dict[str, Any]]:
    """`character_definition_from_asset_manifest` から呼ぶ薄いヘルパ。
    scenario.read_asset_expression_presets を再エクスポートしたいが循環 import を
    避けるためローカル import で取り出す。
    """
    from .scenario import read_asset_expression_presets
    return read_asset_expression_presets(character_dir)


def _read_asset_hairstyle_presets_for_character(character_dir: Path) -> list[dict[str, Any]]:
    """同上。assets/<id>/hairstyle_presets.json を読む。"""
    from .scenario import read_asset_hairstyle_presets
    return read_asset_hairstyle_presets(character_dir)


def resolve_hairstyle_preset(
    character_def: dict[str, Any], preset_id: str
) -> dict[str, Any]:
    """char_def + hairstylePresetId から (base, bangs, back_hair) item を引き当てる。

    返値: {"base": item|None, "bangs": item|None, "backHair": item|None,
           "preset": preset|None}
    `preset_id` が空または無効なら、`isDefault=True` の preset を採用。それも
    無ければ全て None (= 「なし」状態)。
    """
    presets = character_def.get("hairstylePresets") or []
    target = next((p for p in presets if p.get("id") == preset_id), None)
    if target is None:
        target = next((p for p in presets if p.get("isDefault")), None)
    if target is None:
        return {"base": None, "bangs": None, "backHair": None, "preset": None}

    def find(items_key: str, id_value: str) -> dict[str, Any] | None:
        if not id_value:
            return None
        for item in character_def.get(items_key) or []:
            if item.get("id") == id_value:
                return item
        return None

    return {
        "base": find("bases", target.get("baseId") or ""),
        "bangs": find("bangs", target.get("bangsId") or ""),
        "backHair": find("backHairs", target.get("backHairId") or ""),
        "preset": target,
    }


def character_definition_from_asset_manifest(
    character_manifest: dict[str, Any],
    character_id: str,
    name: str,
    origin: str,
    character_dir: Path,
) -> dict[str, Any]:
    def items(key: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in character_manifest.get(key, []):
            entry: dict[str, Any] = {
                "id": item.get("id", ""),
                "name": item.get("name", ""),
                "path": item.get("path", ""),
            }
            # flags (blinkOpen / blinkHalf / blinkClosed / lipClosed / lipMid / lipOpen)
            # は project-level manifest にも露出させる。これが無いと animation_layers
            # が flag を引けず blink/lipsync が一切動かない。
            flags = item.get("flags")
            if isinstance(flags, dict) and flags:
                entry["flags"] = {str(k): bool(v) for k, v in flags.items() if v}
            out.append(entry)
        return out

    bases = items("bases")
    default_base_id = ""
    if bases:
        preferred = next(
            (
                item
                for item in bases
                if "default" in item.get("name", "").lower() or "デフォルト" in item.get("name", "")
            ),
            bases[0],
        )
        default_base_id = preferred.get("id", "")
    voice = character_manifest.get("voice") or {}
    raw_color = str(character_manifest.get("color") or "").strip().lower()
    color = raw_color if re.fullmatch(r"#[0-9a-f]{6}", raw_color) else ""
    return {
        "id": character_id,
        "manifestId": str(character_manifest.get("id") or character_id),
        "name": name,
        "origin": origin,
        "readOnly": origin == "common",
        "assetRoot": relative_to_root(character_dir),
        "color": color,
        "backHairs": items("backHairs"),
        "bases": bases,
        "cheeks": items("cheeks"),
        "eyes": items("eyes"),
        "mouths": items("mouths"),
        "bangs": items("bangs"),
        "fronts": items("fronts"),
        # アセット側 expression preset (assets/<id>/expression_presets.json) を char def に
        # 添付しておく。ensure_expression_presets が project 側とマージするときに使う。
        "assetExpressionPresets": _read_asset_expression_presets_for_character(character_dir),
        # 髪型プリセット (assets/<id>/hairstyle_presets.json)。アセット定義のみで
        # 完結するため project 側ファイルは持たない。cut state は hairstylePresetId を
        # この配列の id と突き合わせて解決する。
        "hairstylePresets": _read_asset_hairstyle_presets_for_character(character_dir),
        "defaults": {
            "baseId": default_base_id,
            "character": {"x": 448, "y": 0, "scale": 1},
            **character_manifest.get("defaults", {}),
        },
        "voice": {
            "id": str(voice.get("id") or "").strip(),
            "emotion": str(voice.get("emotion") or "").strip(),
        },
    }


def _character_has_assets(character: dict[str, Any]) -> bool:
    return any(character.get(key) for key in V4_MANIFEST_KEYS)


def attach_character_definitions(manifest: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    characters = []
    seen_ids: set[str] = set()
    for characters_root, origin in character_roots(ctx):
        if not characters_root.exists():
            continue
        for character_dir in sorted(path for path in characters_root.iterdir() if path.is_dir()):
            character_manifest = scan_character_manifest(character_dir)
            character_id = str(character_manifest.get("id") or slugify_project_id(character_dir.name))
            if character_id in seen_ids:
                character_id = f"{origin}_{character_id}"
            seen_ids.add(character_id)
            character = character_definition_from_asset_manifest(
                character_manifest,
                character_id,
                str(character_manifest.get("name") or character_dir.name),
                origin,
                character_dir,
            )
            if _character_has_assets(character):
                characters.append(character)
    manifest["characters"] = characters
    if characters:
        first = characters[0]
        for key in V4_MANIFEST_KEYS:
            manifest[key] = first.get(key, [])
        defaults = manifest.setdefault("defaults", {})
        first_defaults = first.get("defaults", {}) or {}
        defaults["baseId"] = first_defaults.get("baseId", "")
        defaults["character"] = first_defaults.get("character", defaults.get("character", {"x": 448, "y": 0, "scale": 1}))
        defaults["removeWhite"] = bool(first_defaults.get("removeWhite", defaults.get("removeWhite", True)))
    return manifest


def common_character_manifest() -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "version": 1,
        "canvas": {"width": 1920, "height": 1080},
        "backgrounds": [],
        "audio": [],
        "soundEffects": [],
        "overlays": [],
        "characters": [],
        "defaults": {
            "background": "",
            "baseId": "",
            "character": {"x": 448, "y": 0, "scale": 1},
            "removeWhite": True,
            "textStyle": generate_manifest(project_context(DEFAULT_PROJECT_ID))["defaults"]["textStyle"],
        },
        "config": default_config(),
        "expressionPresets": [],
        "project": None,
        "projectId": "",
    }
    characters = []
    seen_ids: set[str] = set()
    characters_root = ASSETS_DIR / "characters"
    if characters_root.exists():
        for character_dir in sorted(path for path in characters_root.iterdir() if path.is_dir()):
            character_manifest = scan_character_manifest(character_dir)
            character_id = str(character_manifest.get("id") or slugify_project_id(character_dir.name))
            if character_id in seen_ids:
                character_id = f"common_{character_id}"
            seen_ids.add(character_id)
            character = character_definition_from_asset_manifest(
                character_manifest,
                character_id,
                str(character_manifest.get("name") or character_dir.name),
                "common",
                character_dir,
            )
            if _character_has_assets(character):
                characters.append(character)
    manifest["characters"] = characters
    if characters:
        first = characters[0]
        for key in V4_MANIFEST_KEYS:
            manifest[key] = first.get(key, [])
        defaults = manifest["defaults"]
        first_defaults = first.get("defaults", {}) or {}
        defaults["baseId"] = first_defaults.get("baseId", "")
        defaults["character"] = first_defaults.get("character", defaults["character"])
        defaults["removeWhite"] = bool(first_defaults.get("removeWhite", defaults["removeWhite"]))
    return manifest


def ensure_manifest(ctx: ProjectContext | None = None) -> dict[str, Any]:
    ctx = ctx or current_project()
    ctx.manifest_path.parent.mkdir(parents=True, exist_ok=True)
    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = generate_manifest(ctx)
    with ctx.manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    return attach_character_definitions(merge_project_asset_manifest(manifest, ctx), ctx)


def apply_config_defaults(manifest: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    text_defaults = config.get("textDefaults", {})
    text_style = manifest.setdefault("defaults", {}).setdefault("textStyle", {})
    if text_defaults:
        text_style["fontFamily"] = text_defaults.get("fontFamily", text_style.get("fontFamily", "noto_sans_jp"))
        text_style["fontWeight"] = text_defaults.get("fontWeight", text_style.get("fontWeight", "regular"))
        text_style["fontSize"] = int(text_defaults.get("fontSize", text_style.get("fontSize", 54)))
        box_opacity = float(text_defaults.get("boxOpacity", 0.8))
        text_style["boxOpacity"] = round(max(0.0, min(1.0, box_opacity)) * 255)
        for key in [
            "speechPlacement",
            "boxBorderWidth",
            "boxBorderColor",
            "boxBackgroundColor",
            "textColor",
            "textOutlineWidth",
            "textOutlineColor",
            "boxOverlayImage",
            "speechOffsetX",
            "speechOffsetY",
            "speechPaddingX",
            "speechPaddingY",
            "lineGap",
            "speakerNameFontSize",
            "showSpeakerName",
            "inactiveCharacterOpacity",
        ]:
            text_style[key] = text_defaults.get(key, text_style.get(key, default_config()["textDefaults"][key]))
    return manifest

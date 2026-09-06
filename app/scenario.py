from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from .timecode import PROJECT_FPS, sec_to_frames
from .utils import ProjectContext, current_project, write_project_file


def _nfc(value: Any) -> str:
    # macOS NFD ↔ Windows NFC のずれを scenario レベルで吸収する。
    # src / background / foreground / audio など、ディスク上の素材を指す
    # 文字列はすべて NFC で保持する。
    return unicodedata.normalize("NFC", str(value or ""))


ASSET_EXPRESSION_PRESETS_FILENAME = "expression_presets.json"
ASSET_HAIRSTYLE_PRESETS_FILENAME = "hairstyle_presets.json"


def apply_import_manifest_yaml_to_character(
    character_dir: Path,
    manifest: dict[str, Any],
    parsed_yaml: dict[str, Any],
) -> dict[str, int]:
    """配布用 `import_manifest.yml` の内容をアセットに反映する統合ヘルパ。

    flags / removeWhite / voice / color を `manifest` の
    各 entry / defaults / 属性に書き戻し、`character_manifest.json` を保存し、
    expressionPresets / hairstylePresets を JSON ファイルに展開し、最後に
    `import_manifest.yml` を整合再生成する。

    PSD インポータ・ZIP/フォルダ取込み・loose PSD スキャンの 3 経路から
    共通で呼ぶ。
    """
    if not isinstance(parsed_yaml, dict):
        return {"expression": 0, "hairstyle": 0}

    # flags を combination 一致で entry["flags"] に書き込む
    yaml_flags_map = parsed_yaml.get("flags") or {}
    if isinstance(yaml_flags_map, dict) and yaml_flags_map:
        for key in ("backHairs", "bases", "cheeks", "eyes", "mouths", "bangs", "fronts"):
            for entry in manifest.get(key) or []:
                if not isinstance(entry, dict):
                    continue
                combo = (
                    str(entry.get("sourceCombination") or "")
                    or str(entry.get("name") or "")
                    or str(entry.get("id") or "")
                )
                flag_list = yaml_flags_map.get(combo) or []
                if flag_list:
                    entry["flags"] = {str(f): True for f in flag_list if f}

    if isinstance(parsed_yaml.get("removeWhite"), bool):
        manifest.setdefault("defaults", {})["removeWhite"] = bool(parsed_yaml["removeWhite"])
    voice_yaml = parsed_yaml.get("voice") or {}
    if isinstance(voice_yaml, dict) and (voice_yaml.get("id") or voice_yaml.get("emotion")):
        manifest["voice"] = {
            "id": str(voice_yaml.get("id") or ""),
            "emotion": str(voice_yaml.get("emotion") or ""),
        }
    if parsed_yaml.get("color"):
        manifest["color"] = str(parsed_yaml["color"])

    # manifest を更新内容で書き戻す
    manifest_path = character_dir / "character_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    # preset JSON を展開し、import_manifest.yml を JSON 側の正規化済み内容で再生成
    counts = apply_yaml_presets_to_character(character_dir, parsed_yaml, manifest)
    refresh_import_manifest_for_character(character_dir, manifest)
    return counts


def apply_yaml_presets_to_character(
    character_dir: Path,
    parsed_yaml: dict[str, Any],
    manifest: dict[str, Any],
) -> dict[str, int]:
    """`import_manifest.yml` の preset ブロックをアセット側 JSON ファイルへ展開する。

    PSD インポータ / ZIP・フォルダ取込みの直後に呼ぶ。`parsed_yaml`
    (`parse_psd_importer_yaml` の結果) の `expressionPresets` /
    `hairstylePresets` を、manifest のレイヤー entry の `name` フィールドで
    ID 解決し、`assets/<id>/expression_presets.json` /
    `hairstyle_presets.json` を書き出す。

    返値は `{"expression": <件数>, "hairstyle": <件数>}`。空ブロックは
    既存の JSON ファイルを変更しない (誤消去防止)。
    """
    counts = {"expression": 0, "hairstyle": 0}

    def find_id(items_key: str, name: str) -> str:
        if not name:
            return ""
        # name 完全一致 → id 完全一致 → sourceCombination 完全一致 の順で探す
        for item in manifest.get(items_key) or []:
            if item.get("name") == name:
                return str(item.get("id") or "")
        for item in manifest.get(items_key) or []:
            if item.get("id") == name:
                return str(item.get("id") or "")
        for item in manifest.get(items_key) or []:
            if item.get("sourceCombination") == name:
                return str(item.get("id") or "")
        return ""

    # character_def 形式に正規化 (write_asset_*_presets が valid_id 検証で読む)
    char_def_for_validation = {
        "bases": list(manifest.get("bases") or []),
        "cheeks": list(manifest.get("cheeks") or []),
        "eyes": list(manifest.get("eyes") or []),
        "mouths": list(manifest.get("mouths") or []),
        "bangs": list(manifest.get("bangs") or []),
        "backHairs": list(manifest.get("backHairs") or []),
        "fronts": list(manifest.get("fronts") or []),
    }

    expr_yaml = parsed_yaml.get("expressionPresets") or []
    if isinstance(expr_yaml, list) and expr_yaml:
        records: list[dict[str, Any]] = []
        for index, entry in enumerate(expr_yaml, start=1):
            if not isinstance(entry, dict):
                continue
            records.append({
                "id": str(entry.get("id") or entry.get("name") or f"preset_{index}"),
                "name": str(entry.get("name") or f"表情{index}"),
                "cheekId": find_id("cheeks", str(entry.get("cheek") or "")),
                "eyeId": find_id("eyes", str(entry.get("eye") or "")),
                "mouthId": find_id("mouths", str(entry.get("mouth") or "")),
                "isDefault": bool(entry.get("isDefault") or False),
            })
        if records:
            saved = write_asset_expression_presets(
                character_dir, records, char_def_for_validation
            )
            counts["expression"] = len(saved)

    hair_yaml = parsed_yaml.get("hairstylePresets") or []
    if isinstance(hair_yaml, list) and hair_yaml:
        records2: list[dict[str, Any]] = []
        for index, entry in enumerate(hair_yaml, start=1):
            if not isinstance(entry, dict):
                continue
            records2.append({
                "id": str(entry.get("id") or entry.get("name") or f"hairstyle_{index}"),
                "name": str(entry.get("name") or f"髪型{index}"),
                "baseId": find_id("bases", str(entry.get("base") or "")),
                "bangsId": find_id("bangs", str(entry.get("bangs") or "")),
                "backHairId": find_id("backHairs", str(entry.get("backHair") or "")),
                "isDefault": bool(entry.get("isDefault") or False),
            })
        if records2:
            saved2 = write_asset_hairstyle_presets(
                character_dir, records2, char_def_for_validation
            )
            counts["hairstyle"] = len(saved2)

    return counts


def refresh_import_manifest_for_character(character_dir: Path, manifest: dict[str, Any]) -> None:
    """assets/<id>/import_manifest.yml を **毎回フル再生成** する。

    character_manifest.json と透過的に整合させるため、現在のアセット状態
    (manifest のレイヤー一覧・各 entry の flags / sourceCombination・preset
    JSON ファイルの内容・defaults / voice / color) をすべて読み直して書き出す。
    ダーティフラグや差分書き出しは行わない。

    `categories` / `flags` ブロックは manifest のレイヤー entry から再構築:
      - combination キーは `entry["sourceCombination"]` (PSD 由来) があれば
        それ、無ければ `entry["name"]` を使う。
      - `flags` は entry["flags"] の True エントリを書き出す。
    `thumb` と `map` は PSD importer 専用情報なので、既存 YAML から残置する
    (manifest からは生成できない)。
    """
    # 循環 import 回避のためローカル import
    from .psd import (
        IMPORT_YAML_FILENAME,
        parse_psd_importer_yaml,
        read_import_manifest_yaml_text,
        serialize_psd_importer_yaml,
        PSD_IMPORTER_DIR_FOR_CATEGORY,
    )

    # 既存 YAML から残すのは thumb と map のみ (PSD importer 用、manifest に無い情報)。
    legacy_thumb: list[str] = []
    legacy_map: dict[str, str] = {}
    existing_text = read_import_manifest_yaml_text(character_dir)
    if existing_text:
        try:
            legacy = parse_psd_importer_yaml(existing_text)
            if isinstance(legacy.get("thumb"), list):
                legacy_thumb = list(legacy["thumb"])
            if isinstance(legacy.get("map"), dict):
                legacy_map = dict(legacy["map"])
        except Exception:
            pass

    yaml_data: dict[str, Any] = {
        "schemaVersion": 1,
        "id": str(manifest.get("id") or ""),
        "name": str(manifest.get("name") or ""),
        "categories": {key: [] for key in PSD_IMPORTER_DIR_FOR_CATEGORY},
        "thumb": legacy_thumb,
        "map": legacy_map,
        "flags": {},
    }

    # カテゴリのレイヤー一覧と flags を manifest から再構築する。
    category_to_manifest_key = {
        "back_hair": "backHairs",
        "base": "bases",
        "cheek": "cheeks",
        "eye": "eyes",
        "mouth": "mouths",
        "bangs": "bangs",
        "front": "fronts",
    }
    for cat_slug, manifest_key in category_to_manifest_key.items():
        combos: list[str] = []
        for entry in manifest.get(manifest_key) or []:
            if not isinstance(entry, dict):
                continue
            combo = (
                str(entry.get("sourceCombination") or "")
                or str(entry.get("name") or "")
                or str(entry.get("id") or "")
            )
            if not combo:
                continue
            combos.append(combo)
            flags = entry.get("flags") or {}
            if isinstance(flags, dict):
                active = [str(k) for k, v in flags.items() if v]
                if active:
                    yaml_data["flags"][combo] = active
        if combos:
            yaml_data["categories"][cat_slug] = combos

    def name_of(items_key: str, id_value: str) -> str:
        if not id_value:
            return ""
        for item in manifest.get(items_key) or []:
            if item.get("id") == id_value:
                return str(item.get("name") or "")
        return ""

    expr_presets = read_asset_expression_presets(character_dir)
    yaml_data["expressionPresets"] = [
        {
            "name": str(p.get("name") or ""),
            "isDefault": bool(p.get("isDefault")),
            "cheek": name_of("cheeks", str(p.get("cheekId") or "")),
            "eye": name_of("eyes", str(p.get("eyeId") or "")),
            "mouth": name_of("mouths", str(p.get("mouthId") or "")),
        }
        for p in expr_presets
    ]
    hair_presets = read_asset_hairstyle_presets(character_dir)
    yaml_data["hairstylePresets"] = [
        {
            "name": str(p.get("name") or ""),
            "isDefault": bool(p.get("isDefault")),
            "base": name_of("bases", str(p.get("baseId") or "")),
            "bangs": name_of("bangs", str(p.get("bangsId") or "")),
            "backHair": name_of("backHairs", str(p.get("backHairId") or "")),
        }
        for p in hair_presets
    ]
    defaults = manifest.get("defaults") or {}
    # 既存 manifest の値を尊重 (新規 PSD は False で生成される / 旧マニフェストは True)。
    yaml_data["removeWhite"] = bool(defaults.get("removeWhite", False))
    voice = manifest.get("voice") or {}
    if isinstance(voice, dict):
        # serialize_psd_importer_yaml 側で「id も emotion も空ならキー省略」する。
        # 空 dict を渡しても OK (透過ミラー)。
        yaml_data["voice"] = {
            "id": str(voice.get("id") or ""),
            "emotion": str(voice.get("emotion") or ""),
        }
    # color は空文字でも出す (透過ミラー)。
    yaml_data["color"] = str(manifest.get("color") or "")

    (character_dir / IMPORT_YAML_FILENAME).write_text(
        serialize_psd_importer_yaml(yaml_data), encoding="utf-8"
    )


def first_character_id(manifest: dict[str, Any]) -> str:
    characters = manifest.get("characters") or []
    return str(characters[0].get("id") or "default") if characters else "default"


def character_manifest_items(manifest: dict[str, Any], character_id: str, key: str) -> list[dict[str, Any]]:
    """指定キャラの v4 manifest 配列（bases/cheeks/eyes/mouths/bangs/fronts）を取り出す。"""
    for character in manifest.get("characters") or []:
        if character.get("id") == character_id:
            items = character.get(key)
            return items if isinstance(items, list) else []
    return manifest.get(key, []) if isinstance(manifest.get(key), list) else []


def _migrate_legacy_preset(preset: dict[str, Any], manifest: dict[str, Any], character_id: str) -> bool:
    """v3 形式（cheek/eye/mouth が path）→ v4（cheekId/eyeId/mouthId）"""
    changed = False
    for legacy_key, new_key, manifest_key in [
        ("cheek", "cheekId", "cheeks"),
        ("eye", "eyeId", "eyes"),
        ("mouth", "mouthId", "mouths"),
    ]:
        if new_key in preset:
            continue
        legacy_value = preset.pop(legacy_key, None)
        if legacy_value:
            for item in character_manifest_items(manifest, character_id, manifest_key):
                if item.get("path") == legacy_value:
                    preset[new_key] = item.get("id") or ""
                    break
            else:
                preset[new_key] = ""
        else:
            preset[new_key] = ""
        changed = True
    return changed


def _load_project_expression_presets(
    manifest: dict[str, Any], ctx: ProjectContext
) -> tuple[list[dict[str, Any]], bool]:
    """projects/<id>/expression_presets.json を読み、isDefault / cheekId 等を正規化する。
    第2要素は `changed` (再書き出しが必要か)。
    """
    ctx.presets_path.parent.mkdir(parents=True, exist_ok=True)
    if not ctx.presets_path.exists():
        return [], True
    with ctx.presets_path.open("r", encoding="utf-8") as handle:
        try:
            raw = json.load(handle)
        except json.JSONDecodeError:
            raw = []
    if not isinstance(raw, list):
        return [], True
    changed = False
    valid_character_ids = {item.get("id") for item in manifest.get("characters") or []}
    fallback = first_character_id(manifest)
    out: list[dict[str, Any]] = []
    for preset in raw:
        if not isinstance(preset, dict):
            changed = True
            continue
        raw_character_id = str(preset.get("characterId") or "")
        # 「孤児」preset: cut state と同じく、削除済みキャラの preset は characterId を
        # そのまま残しておく (同じ ID で再インポートすれば自動的に有効に戻る)。
        # characterId が空のときだけ fallback (=最初のキャラ) を充てる。
        is_orphan_preset = bool(raw_character_id) and bool(valid_character_ids) and raw_character_id not in valid_character_ids
        if not raw_character_id:
            preset["characterId"] = fallback
            changed = True
        character_id = str(preset.get("characterId") or fallback)
        if is_orphan_preset:
            # manifest 側にキャラがいない間は cheekId/eyeId/mouthId のバリデーションを
            # 走らせない (片方向に valid_*_ids が空になり全フィールドを消し去ってしまう)。
            out.append(preset)
            # isDefault は型整形だけ行う
            is_default_raw = preset.get("isDefault")
            is_default = bool(is_default_raw) if is_default_raw is not None else False
            if preset.get("isDefault") is not is_default:
                preset["isDefault"] = is_default
                changed = True
            continue
        if any(legacy_key in preset for legacy_key in ("cheek", "eye", "mouth")):
            if _migrate_legacy_preset(preset, manifest, character_id):
                changed = True
        valid_cheek_ids = {item.get("id") for item in character_manifest_items(manifest, character_id, "cheeks")}
        valid_eye_ids = {item.get("id") for item in character_manifest_items(manifest, character_id, "eyes")}
        valid_mouth_ids = {item.get("id") for item in character_manifest_items(manifest, character_id, "mouths")}
        if preset.get("cheekId") and preset.get("cheekId") not in valid_cheek_ids:
            preset["cheekId"] = ""
            changed = True
        if preset.get("eyeId") and preset.get("eyeId") not in valid_eye_ids:
            preset["eyeId"] = ""
            changed = True
        if preset.get("mouthId") and preset.get("mouthId") not in valid_mouth_ids:
            preset["mouthId"] = ""
            changed = True
        # isDefault は bool。型不正なら False。
        is_default_raw = preset.get("isDefault")
        is_default = bool(is_default_raw) if is_default_raw is not None else False
        if preset.get("isDefault") is not is_default:
            preset["isDefault"] = is_default
            changed = True
        out.append(preset)
    return out, changed


def _merge_asset_and_project_presets(
    asset_presets_by_char: dict[str, list[dict[str, Any]]],
    project_presets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """asset 側 preset と project 側 preset をマージ。
    同 (characterId, id) は project が上書き。isDefault は characterId ごとに 1 件のみ
    残し、project origin を優先する。出力 preset には `origin` ("asset"|"project") が乗る。
    """
    merged: list[dict[str, Any]] = []

    def make_record(preset: dict[str, Any], character_id: str, origin: str) -> dict[str, Any]:
        return {
            "id": str(preset.get("id") or ""),
            "name": str(preset.get("name") or ""),
            "characterId": character_id,
            "cheekId": str(preset.get("cheekId") or ""),
            "eyeId": str(preset.get("eyeId") or ""),
            "mouthId": str(preset.get("mouthId") or ""),
            "isDefault": bool(preset.get("isDefault") or False),
            "origin": origin,
        }

    for character_id, presets in asset_presets_by_char.items():
        for p in presets:
            pid = str(p.get("id") or "")
            if not pid:
                continue
            merged.append(make_record(p, character_id, "asset"))

    for p in project_presets:
        cid = str(p.get("characterId") or "")
        pid = str(p.get("id") or "")
        if not pid:
            continue
        existing_index = next(
            (
                i for i, item in enumerate(merged)
                if item["characterId"] == cid and item["id"] == pid
            ),
            -1,
        )
        record = make_record(p, cid, "project")
        if existing_index >= 0:
            merged[existing_index] = record
        else:
            merged.append(record)

    # isDefault 排他: 各 characterId で 1 件のみ。project 由来を優先。
    seen_default_per_char: set[str] = set()
    for record in sorted(merged, key=lambda r: 0 if r["origin"] == "project" else 1):
        if record.get("isDefault"):
            cid = record["characterId"]
            if cid in seen_default_per_char:
                record["isDefault"] = False
            else:
                seen_default_per_char.add(cid)
    return merged


# ---------------------------------------------------------------------------
# 配置プリセット (placement presets)
#
# 表情プリセットとは独立した「キャラ 1 体の立ち位置」プリセット。
# 名前付きで X / Y / 拡大率 を保存し、任意のカットの同じキャラへ適用する。
# 保存先は projects/<id>/placement_presets.json (プロジェクト単位) のみ。
# アセット側 (assets/characters/<id>/) には持たせない ── 座標はプロジェクトの
# 構図設計に強く依存するため、共通アセットへ持ち回る意味が薄い。
# ---------------------------------------------------------------------------

def _normalize_placement_preset(item: Any, index: int, fallback_character_id: str) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    name = str(item.get("name") or f"配置{index}").strip() or f"配置{index}"
    raw_id = str(item.get("id") or name or f"placement_{index}").strip()
    preset_id = re.sub(r"\s+", "_", raw_id) or f"placement_{index}"
    character_id = str(item.get("characterId") or fallback_character_id or "")

    def _num(key: str, default: float) -> float:
        try:
            return round(float(item.get(key, default)), 2)
        except (TypeError, ValueError):
            return default

    scale = _num("scale", 1.0)
    if not (scale > 0):
        scale = 1.0
    return {
        "id": preset_id,
        "name": name,
        "characterId": character_id,
        "x": _num("x", 0.0),
        "y": _num("y", 0.0),
        "scale": round(min(4.0, max(0.05, scale)), 4),
    }


def ensure_placement_presets(
    manifest: dict[str, Any], ctx: ProjectContext | None = None
) -> list[dict[str, Any]]:
    """projects/<id>/placement_presets.json を読み込んで正規化した配列を返す。

    ファイルが無い場合は空配列 (作成はしない ── 保存時に初めて書き出す)。
    """
    ctx = ctx or current_project()
    path = ctx.placement_presets_path
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(raw, list):
        return []
    fallback = first_character_id(manifest)
    out: list[dict[str, Any]] = []
    used_keys: set[tuple[str, str]] = set()
    for index, item in enumerate(raw, start=1):
        record = _normalize_placement_preset(item, index, fallback)
        if record is None:
            continue
        key = (record["characterId"], record["id"])
        if key in used_keys:
            continue
        used_keys.add(key)
        out.append(record)
    return out


def save_placement_presets(
    payload: dict[str, Any],
    manifest: dict[str, Any],
    ctx: ProjectContext | None = None,
) -> list[dict[str, Any]]:
    """projects/<id>/placement_presets.json を丸ごと置き換える。

    表情プリセットと違いアセット側の正本が無いので、受け取った配列をそのまま
    正規化して保存し、保存後の配列を返す。
    """
    ctx = ctx or current_project()
    presets_payload = payload.get("presets")
    if not isinstance(presets_payload, list):
        raise ValueError("presets must be a list")
    fallback = first_character_id(manifest)
    out: list[dict[str, Any]] = []
    used_keys: set[tuple[str, str]] = set()
    for index, item in enumerate(presets_payload, start=1):
        record = _normalize_placement_preset(item, index, fallback)
        if record is None:
            continue
        key = (record["characterId"], record["id"])
        suffix = 2
        while key in used_keys:
            record["id"] = f"{record['id']}_{suffix}"
            key = (record["characterId"], record["id"])
            suffix += 1
        used_keys.add(key)
        out.append(record)
    ctx.placement_presets_path.parent.mkdir(parents=True, exist_ok=True)
    with ctx.placement_presets_path.open("w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)
    write_project_file(ctx)
    return out


def ensure_expression_presets(manifest: dict[str, Any], ctx: ProjectContext | None = None) -> list[dict[str, Any]]:
    """project + asset の表情プリセットをマージして返す。

    - project 側: projects/<id>/expression_presets.json (override 列)
    - asset 側: 各 character の `assetExpressionPresets` (manifest 構築時に attach 済み)
    - 同一 (characterId, presetId) は project 側を採用。
    - isDefault は characterId ごとに 1 件、project origin が優先。
    """
    ctx = ctx or current_project()
    project_presets, changed = _load_project_expression_presets(manifest, ctx)
    if changed:
        with ctx.presets_path.open("w", encoding="utf-8") as handle:
            json.dump(project_presets, handle, ensure_ascii=False, indent=2)

    asset_presets_by_char: dict[str, list[dict[str, Any]]] = {}
    for character in manifest.get("characters") or []:
        cid = str(character.get("id") or "")
        asset_presets = character.get("assetExpressionPresets") or []
        if isinstance(asset_presets, list) and asset_presets:
            asset_presets_by_char[cid] = asset_presets

    return _merge_asset_and_project_presets(asset_presets_by_char, project_presets)


def read_asset_expression_presets(character_dir: Path) -> list[dict[str, Any]]:
    """assets/characters/<id>/expression_presets.json を読む。単一キャラ分。
    各 preset は {id, name, cheekId, eyeId, mouthId, isDefault} を含む (characterId は無い)。
    """
    path = character_dir / ASSET_EXPRESSION_PRESETS_FILENAME
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        out.append({
            "id": str(item.get("id") or ""),
            "name": str(item.get("name") or ""),
            "cheekId": str(item.get("cheekId") or ""),
            "eyeId": str(item.get("eyeId") or ""),
            "mouthId": str(item.get("mouthId") or ""),
            "isDefault": bool(item.get("isDefault") or False),
        })
    return out


def read_asset_hairstyle_presets(character_dir: Path) -> list[dict[str, Any]]:
    """assets/characters/<id>/hairstyle_presets.json を読む。

    各 preset は {id, name, baseId, bangsId, backHairId, isDefault} を含む。
    髪型プリセットは「ベース + 前髪 + 後ろ髪」の組合せを名前付きで保存する。
    プロジェクト側に持ち回さず、アセット定義で完結する (ユーザー確定済み)。
    """
    path = character_dir / ASSET_HAIRSTYLE_PRESETS_FILENAME
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        out.append({
            "id": str(item.get("id") or ""),
            "name": str(item.get("name") or ""),
            "baseId": str(item.get("baseId") or ""),
            "bangsId": str(item.get("bangsId") or ""),
            "backHairId": str(item.get("backHairId") or ""),
            "isDefault": bool(item.get("isDefault") or False),
        })
    return out


def write_asset_hairstyle_presets(
    character_dir: Path,
    presets: list[dict[str, Any]],
    character_def: dict[str, Any],
) -> list[dict[str, Any]]:
    """assets/<id>/hairstyle_presets.json を書き出す。

    valid_base/bangs/back_hair ID で正規化し、isDefault は最大 1 件。
    """
    valid_base = {entry.get("id") for entry in (character_def.get("bases") or [])}
    valid_bangs = {entry.get("id") for entry in (character_def.get("bangs") or [])}
    valid_back_hair = {entry.get("id") for entry in (character_def.get("backHairs") or [])}
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_default = False
    for index, item in enumerate(presets, start=1):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or f"髪型{index}").strip()
        raw_id = str(item.get("id") or name or f"hairstyle_{index}").strip()
        preset_id = re.sub(r"\s+", "_", raw_id) or f"hairstyle_{index}"
        suffix = 2
        unique_id = preset_id
        while unique_id in seen_ids:
            unique_id = f"{preset_id}_{suffix}"
            suffix += 1
        seen_ids.add(unique_id)
        base_id = item.get("baseId") or ""
        bangs_id = item.get("bangsId") or ""
        back_hair_id = item.get("backHairId") or ""
        if base_id and base_id not in valid_base:
            base_id = ""
        if bangs_id and bangs_id not in valid_bangs:
            bangs_id = ""
        if back_hair_id and back_hair_id not in valid_back_hair:
            back_hair_id = ""
        is_default = bool(item.get("isDefault") or False)
        if is_default and seen_default:
            is_default = False
        if is_default:
            seen_default = True
        out.append({
            "id": unique_id,
            "name": name,
            "baseId": base_id,
            "bangsId": bangs_id,
            "backHairId": back_hair_id,
            "isDefault": is_default,
        })
    path = character_dir / ASSET_HAIRSTYLE_PRESETS_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)
    return out


def write_asset_expression_presets(
    character_dir: Path,
    presets: list[dict[str, Any]],
    character_def: dict[str, Any],
) -> list[dict[str, Any]]:
    """assets/<id>/expression_presets.json を書き出す。

    valid_cheek/eye/mouth ID で正規化し、isDefault は最大 1 件。characterId は保存しない
    (キャラディレクトリ自体がスコープなので、配布アセットでも characterId 情報を持ち回らない)。
    """
    valid_cheek = {entry.get("id") for entry in (character_def.get("cheeks") or [])}
    valid_eye = {entry.get("id") for entry in (character_def.get("eyes") or [])}
    valid_mouth = {entry.get("id") for entry in (character_def.get("mouths") or [])}
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_default = False
    for index, item in enumerate(presets, start=1):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or f"表情{index}").strip()
        raw_id = str(item.get("id") or name or f"preset_{index}").strip()
        preset_id = re.sub(r"\s+", "_", raw_id) or f"preset_{index}"
        suffix = 2
        unique_id = preset_id
        while unique_id in seen_ids:
            unique_id = f"{preset_id}_{suffix}"
            suffix += 1
        seen_ids.add(unique_id)
        cheek_id = item.get("cheekId") or ""
        eye_id = item.get("eyeId") or ""
        mouth_id = item.get("mouthId") or ""
        if cheek_id and cheek_id not in valid_cheek:
            cheek_id = ""
        if eye_id and eye_id not in valid_eye:
            eye_id = ""
        if mouth_id and mouth_id not in valid_mouth:
            mouth_id = ""
        is_default = bool(item.get("isDefault") or False)
        if is_default and seen_default:
            is_default = False
        if is_default:
            seen_default = True
        out.append({
            "id": unique_id,
            "name": name,
            "cheekId": cheek_id,
            "eyeId": eye_id,
            "mouthId": mouth_id,
            "isDefault": is_default,
        })
    path = character_dir / ASSET_EXPRESSION_PRESETS_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)
    return out


def save_expression_presets(
    payload: dict[str, Any],
    manifest: dict[str, Any],
    ctx: ProjectContext | None = None,
) -> list[dict[str, Any]]:
    """projects/<id>/expression_presets.json に project 側プリセットを保存する。

    payload["presets"] には asset/project どちらの origin も含まれ得るが、
    `origin == "asset"` のレコードは保存しない (アセット側のファイルが正本)。
    そうでない (project または origin 未指定) レコードだけを project 側ファイルに
    書き出す。返値は ensure_expression_presets と同じ「project + asset マージ済み」の
    配列を返す (UI 側はこれをそのまま state.manifest.expressionPresets に置けば良い)。
    """
    ctx = ctx or current_project()
    presets_payload = payload.get("presets")
    if not isinstance(presets_payload, list):
        raise ValueError("presets must be a list")

    valid_character_ids = {item.get("id") for item in manifest.get("characters") or []}
    fallback_character_id = first_character_id(manifest)
    project_presets: list[dict[str, Any]] = []
    used_keys: set[tuple[str, str]] = set()
    seen_default_per_char: set[str] = set()
    for index, item in enumerate(presets_payload, start=1):
        if not isinstance(item, dict):
            continue
        if str(item.get("origin") or "") == "asset":
            # アセット由来のレコードはアセット側のファイルが正本。
            continue
        name = str(item.get("name") or f"表情{index}").strip()
        raw_id = str(item.get("id") or name or f"preset_{index}").strip()
        preset_id = re.sub(r"\s+", "_", raw_id) or f"preset_{index}"
        character_id = str(item.get("characterId") or fallback_character_id)
        if valid_character_ids and character_id not in valid_character_ids:
            character_id = fallback_character_id
        key = (character_id, preset_id)
        suffix = 2
        while key in used_keys:
            preset_id = f"{preset_id}_{suffix}"
            key = (character_id, preset_id)
            suffix += 1
        used_keys.add(key)
        valid_cheek_ids = {entry.get("id") for entry in character_manifest_items(manifest, character_id, "cheeks")}
        valid_eye_ids = {entry.get("id") for entry in character_manifest_items(manifest, character_id, "eyes")}
        valid_mouth_ids = {entry.get("id") for entry in character_manifest_items(manifest, character_id, "mouths")}
        cheek_id = item.get("cheekId") or ""
        eye_id = item.get("eyeId") or ""
        mouth_id = item.get("mouthId") or ""
        if cheek_id and cheek_id not in valid_cheek_ids:
            cheek_id = ""
        if eye_id and eye_id not in valid_eye_ids:
            eye_id = ""
        if mouth_id and mouth_id not in valid_mouth_ids:
            mouth_id = ""
        is_default = bool(item.get("isDefault") or False)
        if is_default and character_id in seen_default_per_char:
            is_default = False
        if is_default:
            seen_default_per_char.add(character_id)
        project_presets.append(
            {
                "id": preset_id,
                "name": name,
                "characterId": character_id,
                "cheekId": cheek_id,
                "eyeId": eye_id,
                "mouthId": mouth_id,
                "isDefault": is_default,
            }
        )

    ctx.presets_path.parent.mkdir(parents=True, exist_ok=True)
    with ctx.presets_path.open("w", encoding="utf-8") as handle:
        json.dump(project_presets, handle, ensure_ascii=False, indent=2)
    write_project_file(ctx)
    # 返却時は asset とマージ済みリスト。フロントは即 state.manifest.expressionPresets に
    # 置けば良い。
    asset_presets_by_char: dict[str, list[dict[str, Any]]] = {}
    for character in manifest.get("characters") or []:
        cid = str(character.get("id") or "")
        asset_presets = character.get("assetExpressionPresets") or []
        if isinstance(asset_presets, list) and asset_presets:
            asset_presets_by_char[cid] = asset_presets
    return _merge_asset_and_project_presets(asset_presets_by_char, project_presets)


def default_scenario(manifest: dict[str, Any]) -> dict[str, Any]:
    defaults = manifest.get("defaults", {})
    initial_cut = {
        "id": "cut_001",
        "startFrame": 0,
        "durationFrame": PROJECT_FPS * 3,
        "audio": "",
        "state": {
            # 新規プロジェクトは背景「なし (透過)」で立ち上げる。
            # manifest.defaults.background は既存素材の先頭になりがちなので参照しない。
            "background": "",
            "foreground": "",
            "showSpeechBox": True,
            "text": "",
            "characters": [],
            "textStyle": defaults.get(
                "textStyle",
                {
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
                    "boxOverlayImage": "",
                    "speechOffsetX": 120,
                    "speechOffsetY": 70,
                    "speechPaddingX": 60,
                    "speechPaddingY": 70,
                    "lineGap": 16,
                    "speakerNameFontSize": 28,
                    "inactiveCharacterOpacity": 0.5,
                },
            ),
        },
    }
    return {
        "version": 4,
        "title": "sample",
        "scenes": [
            {
                "id": "scene_001",
                "title": "シーン1",
                # 同上 (透過スタート)。
                "background": "",
                "videoTrack": None,
                "bgmTracks": [],
                "soundEffects": [],
                "videoLayers": [],
                "bpm": None,
                "cuts": [initial_cut],
                "telops": [],
            }
        ],
    }


CHARACTER_STATE_KEYS = [
    "baseId",
    "cheekId",
    "eyeId",
    "mouthId",
    "hairstylePresetId",
    "frontIds",
    "eyeAboveBangs",
    "flipX",
    "removeWhite",
    "showCharacter",
    "character",
]

LEGACY_V3_STATE_KEYS = ("base", "body", "pose", "costume", "expression", "cheek", "eye", "mouth", "foreground", "bangs")


def _resolve_id_from_path(items: list[dict[str, Any]], path_value: str) -> str:
    if not path_value:
        return ""
    for entry in items or []:
        if entry.get("path") == path_value:
            return str(entry.get("id") or "")
    return ""


def _migrate_legacy_character_state(item: dict[str, Any], character_def: dict[str, Any]) -> dict[str, Any]:
    """v3 形式の cut character state を受け取り、IDベースのv4へ変換した辞書を返す。

    Phase 4 で `bangsId` フィールドが廃止されたため、旧 cut state の bangs パスは
    捨てる。代わりに hairstylePresetId をアセット側 default から拾う仕組みは
    `normalize_character_state` 末尾で行うのでここでは空のまま返す。
    """
    bases = character_def.get("bases") if isinstance(character_def.get("bases"), list) else []
    cheeks = character_def.get("cheeks") if isinstance(character_def.get("cheeks"), list) else []
    eyes = character_def.get("eyes") if isinstance(character_def.get("eyes"), list) else []
    mouths = character_def.get("mouths") if isinstance(character_def.get("mouths"), list) else []
    fronts = character_def.get("fronts") if isinstance(character_def.get("fronts"), list) else []

    body_path = item.get("body") or item.get("costume") or item.get("pose") or item.get("base") or ""
    return {
        "baseId": _resolve_id_from_path(bases, str(body_path)),
        "cheekId": _resolve_id_from_path(cheeks, str(item.get("cheek") or "")),
        "eyeId": _resolve_id_from_path(eyes, str(item.get("eye") or "")),
        "mouthId": _resolve_id_from_path(mouths, str(item.get("mouth") or "")),
        "hairstylePresetId": "",
        "frontIds": (
            [_resolve_id_from_path(fronts, str(item.get("foreground")))]
            if item.get("foreground")
            else []
        ),
    }


def _character_def_for(manifest: dict[str, Any], character_id: str) -> dict[str, Any]:
    for character in manifest.get("characters") or []:
        if character.get("id") == character_id:
            return character
    # character_id が空文字のときだけ先頭キャラを返す (v3 → v4 legacy migration 用)。
    # 非空で manifest に該当キャラがいない (= 孤児) ときは空 dict を返し、
    # `resolve_character_paths` 経由でレイヤーパスを空に倒す。これで chars[0] の
    # 素材が「孤児カット」に誤ってベイクされる事故を防げる。
    if not character_id:
        chars = manifest.get("characters") or []
        return chars[0] if chars else {}
    return {}


def default_character_state(manifest: dict[str, Any], index: int = 0) -> dict[str, Any]:
    defaults = manifest.get("defaults", {})
    character_defs = manifest.get("characters") or []
    character_def = character_defs[index] if index < len(character_defs) else (character_defs[0] if character_defs else {})
    character_defaults = character_def.get("defaults") or {}
    # アセット側 hairstyle preset の isDefault があれば auto-select。
    default_hairstyle_id = ""
    for preset in character_def.get("hairstylePresets") or []:
        if preset.get("isDefault"):
            default_hairstyle_id = str(preset.get("id") or "")
            break
    return {
        "id": f"character_{index + 1}",
        "name": character_def.get("name") or f"キャラクター{index + 1}",
        "characterId": character_def.get("id", "default"),
        "baseId": str(character_defaults.get("baseId") or ""),
        "cheekId": "",
        "eyeId": "",
        "mouthId": "",
        "hairstylePresetId": default_hairstyle_id,
        "frontIds": [],
        "eyeAboveBangs": False,
        "flipX": False,
        "removeWhite": bool(character_defaults.get("removeWhite", defaults.get("removeWhite", True))),
        "showCharacter": True,
        "character": dict(character_defaults.get("character") or defaults.get("character", {"x": 448, "y": 0, "scale": 1})),
    }


def normalize_character_state(item: dict[str, Any], manifest: dict[str, Any], index: int = 0) -> dict[str, Any]:
    normalized = default_character_state(manifest, index)
    valid_character_ids = {character.get("id") for character in manifest.get("characters") or []}
    raw_character_id = str(item.get("characterId") or "")
    has_valid_character_id = (not valid_character_ids) or (raw_character_id in valid_character_ids)
    # 「孤児」: cut state は characterId を指していたが、現在の manifest には該当キャラが
    # 居ない状態 (アセット管理から削除 / 配布キャラ未取込み)。素材選択や座標などは
    # そのまま保持し、同じ characterId で再インポートすれば自動的に valid に戻す。
    is_orphan = bool(raw_character_id) and bool(valid_character_ids) and not has_valid_character_id
    character_id = raw_character_id if (has_valid_character_id or is_orphan) else str(normalized.get("characterId") or "default")
    if has_valid_character_id:
        # v3 → v4 互換: パスから ID を解決
        if any(key in item for key in LEGACY_V3_STATE_KEYS) and not any(
            key in item for key in ("baseId", "cheekId", "eyeId", "mouthId", "hairstylePresetId", "frontIds")
        ):
            character_def = _character_def_for(manifest, character_id)
            migrated = _migrate_legacy_character_state(item, character_def)
            for key, value in migrated.items():
                normalized[key] = value
        for key in CHARACTER_STATE_KEYS:
            if key in item:
                normalized[key] = item[key]
        # 旧 bangsId フィールドは Phase 4 で廃止 (髪型プリセットへ移行)。
        # 旧プロジェクトの bangsId は読み捨てて、後段で hairstyle default へ流す。
        item.pop("bangsId", None) if isinstance(item, dict) else None
    elif is_orphan:
        # 孤児: 入力をそのまま転写。manifest 側の bases/cheeks/... が無いので
        # 後段の valid_id バリデーションは skip し、再登録時に値が復活するようにする。
        for key in CHARACTER_STATE_KEYS:
            if key in item:
                normalized[key] = item[key]
        item.pop("bangsId", None) if isinstance(item, dict) else None
    normalized["id"] = str(item.get("id") or normalized["id"])
    if has_valid_character_id or is_orphan:
        normalized["name"] = str(item.get("name") or normalized["name"])
    normalized["characterId"] = character_id
    # 旧スキーマの bangsId が紛れ込んでいたら明示的に剥がす (saveScenario 経路の取り回し対策)
    normalized.pop("bangsId", None)
    character = normalized.get("character")
    if not isinstance(character, dict):
        character = {}
    defaults = manifest.get("defaults", {}).get("character", {"x": 448, "y": 0, "scale": 1})
    normalized["character"] = {
        "x": character.get("x", defaults.get("x", 448)),
        "y": character.get("y", defaults.get("y", 0)),
        "scale": character.get("scale", defaults.get("scale", 1)),
    }
    # B-1: マルチキャラレイアウト (任意フィールド)。
    # crop / layoutSlot は normalize_character_state の入口で arbitrarily な dict から
    # コピーされてこないため (CHARACTER_STATE_KEYS にも入れていない)、ここで item から
    # 直接取り出して正規化する。
    normalized["crop"] = _normalize_character_crop(item.get("crop"))
    normalized["layoutSlot"] = _normalize_layout_slot(item.get("layoutSlot"))
    # M-1: per-character motion ({type, settings})。
    # 旧 cut.state.motionType / motionSettings (scene global, 話者のみ適用) を
    # 個別キャラに分散する設計。type="none" のとき何も動かない。
    normalized["motion"] = _normalize_character_motion(item.get("motion"))
    # BPM 上下ゆれ (bob)。motion とは独立した per-character エフェクト。
    normalized["bob"] = _normalize_character_bob(item.get("bob"))

    if is_orphan:
        # 孤児はバリデーション対象外。frontIds と eyeAboveBangs / flipX の型だけ整える。
        front_ids_raw = normalized.get("frontIds")
        if not isinstance(front_ids_raw, list):
            front_ids_raw = []
        normalized["frontIds"] = [str(value) for value in front_ids_raw]
        normalized["eyeAboveBangs"] = bool(normalized.get("eyeAboveBangs", False))
        normalized["flipX"] = bool(normalized.get("flipX", False))
        normalized["hairstylePresetId"] = str(normalized.get("hairstylePresetId") or "")
        return normalized
    # ID が manifest に無ければ空文字に落とす
    character_def = _character_def_for(manifest, normalized["characterId"])
    valid_id_sets = {
        "baseId": {entry.get("id") for entry in (character_def.get("bases") or [])},
        "cheekId": {entry.get("id") for entry in (character_def.get("cheeks") or [])},
        "eyeId": {entry.get("id") for entry in (character_def.get("eyes") or [])},
        "mouthId": {entry.get("id") for entry in (character_def.get("mouths") or [])},
    }
    for key, valid_ids in valid_id_sets.items():
        value = normalized.get(key)
        if value and value not in valid_ids:
            normalized[key] = ""
    valid_front_ids = {entry.get("id") for entry in (character_def.get("fronts") or [])}
    front_ids_raw = normalized.get("frontIds")
    if not isinstance(front_ids_raw, list):
        front_ids_raw = []
    normalized["frontIds"] = [str(value) for value in front_ids_raw if value in valid_front_ids]
    normalized["eyeAboveBangs"] = bool(normalized.get("eyeAboveBangs", False))
    normalized["flipX"] = bool(normalized.get("flipX", False))
    # 髪型プリセット ID を asset 側 hairstyle preset とマッチング。未指定または
    # 不正なら asset 側 default を auto-select、それも無ければ空文字 (= 「なし」)。
    valid_hairstyle_ids = {p.get("id") for p in (character_def.get("hairstylePresets") or [])}
    hairstyle_id = str(normalized.get("hairstylePresetId") or "")
    if hairstyle_id and hairstyle_id not in valid_hairstyle_ids:
        hairstyle_id = ""
    if not hairstyle_id:
        for preset in character_def.get("hairstylePresets") or []:
            if preset.get("isDefault"):
                hairstyle_id = str(preset.get("id") or "")
                break
    normalized["hairstylePresetId"] = hairstyle_id
    return normalized


def normalize_cut_state(state: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    defaults = manifest.get("defaults", {})
    raw_characters = state.get("characters")
    normalized_characters = []
    if isinstance(raw_characters, list):
        if raw_characters:
            normalized_characters = [
                normalize_character_state(item, manifest, index)
                for index, item in enumerate(raw_characters)
                if isinstance(item, dict)
            ]
    elif any(key in state for key in (*CHARACTER_STATE_KEYS, *LEGACY_V3_STATE_KEYS)):
        # 旧 v3 形式: state 直下にキャラ素材が置かれていた場合
        legacy_character = {
            key: state[key]
            for key in (*CHARACTER_STATE_KEYS, *LEGACY_V3_STATE_KEYS)
            if key in state
        }
        normalized_characters = [normalize_character_state(legacy_character, manifest, 0)]
    speaker_id = str(state.get("speakerCharacterId") or "")
    character_ids = {character.get("id") for character in normalized_characters}
    if speaker_id not in character_ids:
        speaker_id = str(normalized_characters[0].get("id") or "") if state.get("text") and normalized_characters else ""
    motion_type = str(state.get("motionType") or "none")
    if motion_type not in ("none", "shake_x", "shake_y", "zoom", "move"):
        motion_type = "none"
    # M-1 migration: 旧 scene global motion (state.motionType + state.motionSettings) を
    # 話者キャラ (見つからなければ先頭キャラ) の per-character motion へ移植する。
    # 移植後は scene global の motionType を "none"、motionSettings は破棄して、
    # scenario save 時に旧フィールドが永久に残らないようにする。
    if motion_type != "none" and normalized_characters:
        raw_old_settings = state.get("motionSettings") if isinstance(state.get("motionSettings"), dict) else {}
        target_char = next((c for c in normalized_characters if c.get("id") == speaker_id), None)
        if target_char is None:
            target_char = normalized_characters[0]
        if target_char is not None and not target_char.get("motion"):
            target_char["motion"] = {"type": motion_type, "settings": dict(raw_old_settings)}
        # 旧フィールドはここで強制的に解除する (= 新形式へ吸収済み)。
        motion_type = "none"
    try:
        background_blur_px = max(0.0, float(state.get("backgroundBlurPx", 0.0) or 0.0))
    except (TypeError, ValueError):
        background_blur_px = 0.0
    # 背景画像が未指定のときに表示される単色塗りつぶし。デフォルトは完全透明 (opacity=0)。
    raw_bg_color = str(state.get("backgroundColor") or "").strip().lower()
    background_color = raw_bg_color if re.fullmatch(r"#[0-9a-f]{6}", raw_bg_color) else "#000000"
    try:
        background_color_opacity = max(0.0, min(1.0, float(state.get("backgroundColorOpacity", 0.0) or 0.0)))
    except (TypeError, ValueError):
        background_color_opacity = 0.0

    # 前景の表示位置 (plane 左上の絶対座標, 0,0 = 画面左上)。None = 中央配置。
    def _coord_or_none(value: Any) -> float | None:
        if value is None or value == "":
            return None
        try:
            return round(float(value), 2)
        except (TypeError, ValueError):
            return None
    foreground_x = _coord_or_none(state.get("foregroundX"))
    foreground_y = _coord_or_none(state.get("foregroundY"))

    # 前景 / 背景の拡大率と背景の表示位置。
    #   - *Scale: 1.0 = 従来通り (前景 = contain フィット、背景 = cover フィット)。
    #   - backgroundX / Y: 背景 plane 左上の絶対座標。None = 中央 (= 従来挙動)。
    # ケンバーンズでズームアウトする際に「あらかじめ少し大きめに敷いておく」用途。
    def _scale_or_default(value: Any, default: float = 1.0) -> float:
        try:
            f = float(value)
        except (TypeError, ValueError):
            return default
        if not (f > 0):
            return default
        return round(min(SCALE_MAX, max(SCALE_MIN, f)), 4)

    foreground_scale = _scale_or_default(state.get("foregroundScale"))
    background_scale = _scale_or_default(state.get("backgroundScale"))
    background_x = _coord_or_none(state.get("backgroundX"))
    background_y = _coord_or_none(state.get("backgroundY"))

    # textStyle は基本的に pass-through だが、個別文字間カーニング (R8) だけは
    # スキーマ (gap index -> 1/1000em 整数, 0 は省く) を強制する。空なら出力しない。
    text_style = state.get("textStyle", defaults.get("textStyle", {}))
    if isinstance(text_style, dict) and "charKerning" in text_style:
        text_style = dict(text_style)
        ck = _normalize_char_kerning(text_style.get("charKerning"))
        if ck:
            text_style["charKerning"] = ck
        else:
            text_style.pop("charKerning", None)

    normalized = {
        "background": _nfc(
            state["background"]
            if "background" in state and isinstance(state["background"], str)
            else defaults.get("background", "")
        ),
        "foreground": _nfc(
            state["foreground"]
            if "foreground" in state and isinstance(state["foreground"], str)
            else ""
        ),
        "foregroundX": foreground_x,
        "foregroundY": foreground_y,
        "showSpeechBox": state.get("showSpeechBox", True),
        "text": state.get("text", ""),
        "textStyle": text_style,
        "speakerCharacterId": speaker_id,
        "characters": normalized_characters,
        "motionType": motion_type,
        "characterEffects": _normalize_character_effects(state.get("characterEffects")),
        "characterLayout": _normalize_character_layout(state.get("characterLayout")),
        "backgroundBlurPx": round(background_blur_px, 2),
        "backgroundColor": background_color,
        "backgroundColorOpacity": round(background_color_opacity, 3),
    }
    # M-1: motionSettings は scene global motion と一緒に廃止。新仕様では各キャラの
    # character.motion.settings に分散して保持される。旧フィールドが state に残って
    # いても normalized には乗せない (= save で消える)。
    # 編集中キャラ id (per-cut で永続化)。クライアントが loadCut 時に最優先で復元
    # する。記録された id がカット内に居なくても保持する (= キャラ削除→復活時に再利用)
    # が、空文字はそもそも書き出さない。
    # 前景 / 背景の拡大率・背景座標・ケンバーンズは「既定のときはキーを出さない」。
    # 既存シナリオの normalized payload が 1 bit も変わらず、scene-bundle の
    # token (= キャッシュキー) と自己修復書き戻しを無駄に無効化しないため。
    if foreground_scale != 1.0:
        normalized["foregroundScale"] = foreground_scale
    if background_scale != 1.0:
        normalized["backgroundScale"] = background_scale
    if background_x is not None:
        normalized["backgroundX"] = background_x
    if background_y is not None:
        normalized["backgroundY"] = background_y
    ken_burns = _normalize_ken_burns(state.get("kenBurns"))
    if ken_burns is not None:
        normalized["kenBurns"] = ken_burns
    raw_editing_id = state.get("editingCharacterId")
    if isinstance(raw_editing_id, str) and raw_editing_id:
        normalized["editingCharacterId"] = raw_editing_id
    if "speakerName" in state:
        normalized["speakerName"] = state["speakerName"]
    # ユーザーが手動で選び直した声/感情の override (話者キャラの default を上書き)。
    # id も emotion も空なら override 自体を残さない (default = 話者キャラ定義に
    # 紐付いた voice を使う、という UI 側の挙動と整合する)。
    raw_voice = state.get("voice")
    if isinstance(raw_voice, dict):
        voice_id = str(raw_voice.get("id") or "").strip()
        voice_emotion = str(raw_voice.get("emotion") or "").strip()
        if voice_id or voice_emotion:
            normalized["voice"] = {"id": voice_id, "emotion": voice_emotion}
    return normalized


def _coerce_frame_field(raw_frame: Any, raw_seconds: Any) -> int | None:
    """*Frame があれば優先、無ければ *Sec を fps 基準で frame 化。両方欠けたら None。"""
    if raw_frame is not None and raw_frame != "":
        try:
            value = int(raw_frame)
            return max(0, value)
        except (TypeError, ValueError):
            try:
                return max(0, int(round(float(raw_frame))))
            except (TypeError, ValueError):
                return None
    if raw_seconds is None or raw_seconds == "":
        return None
    return max(0, sec_to_frames(raw_seconds))


# --- v0.3 追加スキーマのヘルパ -------------------------------------------------

def _normalize_lane(value: Any) -> int:
    """タイムラインのレーン番号 (0 起点)。複数レーン化 (R2/R3) で各アイテムが持つ。"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, n)


def _normalize_char_kerning(raw: Any) -> dict[str, int]:
    """個別文字間カーニング (R8)。

    キー = 生テキスト上の gap index (文字 i と i+1 の間を "i" で表す, 0 起点)。
    値 = delta (1/1000em, 整数, 符号付き)。delta=0 は省く。全体字間とは独立に加算される。
    """
    out: dict[str, int] = {}
    if not isinstance(raw, dict):
        return out
    for key, value in raw.items():
        try:
            idx = int(key)
        except (TypeError, ValueError):
            continue
        if idx < 0:
            continue
        try:
            delta = int(round(float(value)))
        except (TypeError, ValueError):
            continue
        if delta == 0:
            continue
        out[str(idx)] = delta
    return out


_TRANSITION_TYPES = ("none", "crossfade", "wipe", "whiteout", "blackout", "crosszoom")


def _normalize_transition(raw: Any) -> dict[str, Any]:
    """カット入りトランジション (R10)。直前カット末尾→現カット先頭をブレンドする演出。

    先頭カットでも whiteout=ホワイトイン / blackout=ブラックイン等として適用できる
    (「前」が無い分は単色を擬似前フレームとして合成する。描画側で解釈)。
    """
    if not isinstance(raw, dict):
        return {"type": "none", "durationFrame": 0}
    t = str(raw.get("type") or "none").strip().lower()
    if t not in _TRANSITION_TYPES:
        t = "none"
    if t == "none":
        return {"type": "none", "durationFrame": 0}
    dur = _coerce_frame_field(raw.get("durationFrame"), raw.get("durationSec"))
    if dur is None or dur <= 0:
        dur = max(1, round(PROJECT_FPS * 0.5))  # 既定 0.5 秒
    out = {"type": t, "durationFrame": int(max(1, dur))}
    if t == "wipe":
        # ワイプの方向 (リビールが進む向き)。right=左→右 / left=右→左 / down=上→下 / up=下→上。
        d = str(raw.get("wipeDirection") or "right").strip().lower()
        out["wipeDirection"] = d if d in ("right", "left", "up", "down") else "right"
    return out


def _normalize_cut(cut: dict[str, Any], index: int, manifest: dict[str, Any]) -> dict[str, Any]:
    duration_frame = _coerce_frame_field(cut.get("durationFrame"), cut.get("duration"))
    if duration_frame is None or duration_frame <= 0:
        duration_frame = PROJECT_FPS * 3  # 既定 3 秒
    duration_frame = max(1, duration_frame)
    start_frame = _coerce_frame_field(cut.get("startFrame"), cut.get("startSec"))
    # 発話ディレイ (秒): カットの話者音声 (audio) を冒頭からこの秒数だけ遅らせて
    # 鳴らす。カット入りトランジションの間に声が出始める不自然さを避けるための
    # パラメータ (preview / export 共通)。カット尺を超える値はクランプ。
    try:
        audio_delay_sec = max(0.0, float(cut.get("audioDelaySec") or 0.0))
    except (TypeError, ValueError):
        audio_delay_sec = 0.0
    return {
        "id": str(cut.get("id") or f"cut_{index:03d}"),
        "startFrame": start_frame,  # None なら _fill_cut_start_frame で連番補完
        "durationFrame": duration_frame,
        "audio": _nfc(cut.get("audio")),
        "audioDelaySec": round(audio_delay_sec, 3),
        "transition": _normalize_transition(cut.get("transition")),
        "state": normalize_cut_state(cut.get("state") or {}, manifest),
    }


def _fill_cut_start_frame(cuts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`startFrame` が None のカットは前カット終端に追従させる。"""
    cursor = 0
    for cut in cuts:
        start = cut.get("startFrame")
        if start is None:
            cut["startFrame"] = cursor
        else:
            cut["startFrame"] = max(0, int(start))
        cursor = cut["startFrame"] + max(1, int(cut.get("durationFrame") or 0))
    return cuts


def _normalize_hex_color(value: Any, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    s = value.strip()
    if not s:
        return fallback
    if not s.startswith("#"):
        s = "#" + s
    if len(s) == 4:
        s = "#" + "".join(c * 2 for c in s[1:])
    if len(s) != 7:
        return fallback
    try:
        int(s[1:], 16)
    except ValueError:
        return fallback
    return s.lower()


# =============================================================================
# マルチキャラレイアウト (= 画面分割) 用のフィールド正規化。
#
# データモデルの設計 (B-1):
# - character.crop ({x, y, width, height} | None):
#     1920×1080 系の絶対 px 単位のクリップ矩形。描画時、キャラはこの矩形の
#     外側を描かない (= scissor で切り取る)。None なら全画面描画 (= 従来通り)。
# - character.layoutSlot (int | None):
#     所属する分割枠の 0-based index。None = 未割当 (free 配置)。
# - cut.state.characterLayout ({pattern, border} | None):
#     pattern: 分割パターン ID (再編集 / 再計算のため保持)
#     border: { width(px), color(hex), includeOuter(bool) }
#
# crop / layoutSlot / characterLayout は **すべて optional** で、未指定なら
# 従来の単キャラ自由配置として扱う (= 旧シナリオは無改修で動く)。
# =============================================================================
def _normalize_character_crop(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    try:
        x = float(raw.get("x", 0) or 0)
        y = float(raw.get("y", 0) or 0)
        width = float(raw.get("width", 0) or 0)
        height = float(raw.get("height", 0) or 0)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    # 1920×1080 を大きく超える矩形は弾く (= 不正データ防止)。座標は負も許容
    # (= キャラを画面外にずらして一部だけ見せる演出余地)。
    return {
        "x": round(x, 2),
        "y": round(y, 2),
        "width": round(width, 2),
        "height": round(height, 2),
    }


def _normalize_layout_slot(raw: Any) -> int | None:
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value


VALID_LAYOUT_PATTERNS = frozenset({
    "vertical_2", "horizontal_2",
    "vertical_3", "horizontal_3",
    "t_top", "t_bottom", "l_left", "l_right",
    "vertical_4", "horizontal_4", "grid_2x2",
})


# 前景 / 背景 / ケンバーンズで共有する拡大率のレンジ。
SCALE_MIN = 0.05
SCALE_MAX = 4.0

# ケンバーンズの補間カーブ。UI のセレクトと 1:1 対応。
KEN_BURNS_EASINGS = ("linear", "ease_in", "ease_out", "ease_in_out")


def _normalize_ken_burns(raw: Any) -> dict[str, Any] | None:
    """カット単位のケンバーンズ (ゆっくりズーム / パン) 設定を正規化する。

    背景・前景・キャラ・動画レイヤー・ビジュアライザーを 1 つの「絵」とみなし、
    カット尺いっぱいを使って start → end へ拡大率と平行移動を線形補間する
    (セリフ枠・テロップは対象外。renderer 側で world group から除外している)。

    - scale: 画面中心 (960, 540) を原点とした倍率。
    - x / y: 平行移動 (px)。正の x で絵が右へ動く。
    - 無効 (enabled=False) かつ start/end が既定値のままなら None を返して
      cut.state に書き込まない (= 既存シナリオの payload token を変えない)。
    """
    if not isinstance(raw, dict):
        return None

    def _num(key: str, default: float) -> float:
        try:
            return round(float(raw.get(key, default)), 3)
        except (TypeError, ValueError):
            return default

    def _scale(key: str) -> float:
        value = _num(key, 1.0)
        if not (value > 0):
            return 1.0
        return round(min(SCALE_MAX, max(SCALE_MIN, value)), 4)

    easing = str(raw.get("easing") or "ease_in_out")
    if easing not in KEN_BURNS_EASINGS:
        easing = "ease_in_out"
    normalized = {
        "enabled": bool(raw.get("enabled") or False),
        "startScale": _scale("startScale"),
        "endScale": _scale("endScale"),
        "startX": _num("startX", 0.0),
        "startY": _num("startY", 0.0),
        "endX": _num("endX", 0.0),
        "endY": _num("endY", 0.0),
        "easing": easing,
    }
    if not normalized["enabled"] and normalized == {
        "enabled": False,
        "startScale": 1.0,
        "endScale": 1.0,
        "startX": 0.0,
        "startY": 0.0,
        "endX": 0.0,
        "endY": 0.0,
        "easing": "ease_in_out",
    }:
        return None
    return normalized


def _normalize_character_layout(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    pattern = str(raw.get("pattern") or "")
    if pattern not in VALID_LAYOUT_PATTERNS:
        return None
    border_raw = raw.get("border") if isinstance(raw.get("border"), dict) else {}
    try:
        width = max(0.0, float(border_raw.get("width", 0) or 0))
    except (TypeError, ValueError):
        width = 0.0
    return {
        "pattern": pattern,
        "border": {
            "width": round(width, 2),
            "color": _normalize_hex_color(border_raw.get("color"), "#ffffff"),
            "includeOuter": bool(border_raw.get("includeOuter", False)),
        },
    }


# M-1: per-character motion ({type, settings})。
# type は "none"/"shake_x"/"shake_y"/"zoom"/"move"。
# settings は { shakeX: {amplitude,count,duration}, shakeY: {...}, zoom: {scale,origin},
#               move: {startFrame,durationFrame,startX,startY,endX,endY,easing} }
_VALID_CHARACTER_MOTION_TYPES = frozenset({"none", "shake_x", "shake_y", "zoom", "move"})


def _normalize_character_motion(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    motion_type = str(raw.get("type") or "none")
    if motion_type not in _VALID_CHARACTER_MOTION_TYPES:
        motion_type = "none"
    if motion_type == "none":
        return None
    raw_settings = raw.get("settings") if isinstance(raw.get("settings"), dict) else {}
    return {"type": motion_type, "settings": dict(raw_settings)}


def _normalize_character_bob(raw: Any) -> dict[str, Any] | None:
    """BPM 上下ゆれ (bob)。bpm / amplitudePx がともに正のときだけ有効。"""
    if not isinstance(raw, dict):
        return None
    try:
        bpm = float(raw.get("bpm") or 0)
        amplitude_px = float(raw.get("amplitudePx") or 0)
    except (TypeError, ValueError):
        return None
    if bpm <= 0 or amplitude_px <= 0:
        return None
    return {"bpm": round(bpm, 3), "amplitudePx": round(amplitude_px, 2)}


def _normalize_color_filter(raw: Any) -> dict[str, Any]:
    """カット単位の乗算カラーフィルター。enabled / color / opacity を返す。"""
    if not isinstance(raw, dict):
        raw = {}
    try:
        opacity = float(raw.get("opacity") if raw.get("opacity") is not None else 0.4)
    except (TypeError, ValueError):
        opacity = 0.4
    opacity = max(0.0, min(1.0, opacity))
    return {
        "enabled": bool(raw.get("enabled", False)),
        "color": _normalize_hex_color(raw.get("color"), "#ffe8f9"),
        "opacity": round(opacity, 3),
    }


def _normalize_character_glow(raw: Any) -> dict[str, Any]:
    """キャラ用 glow。テロップ glow と同形だが既定値を変える (キャラ向け blur 大きめ)。"""
    if not isinstance(raw, dict):
        raw = {}
    try:
        blur_px = max(0.0, float(raw.get("blurPx") if raw.get("blurPx") is not None else 24.0))
    except (TypeError, ValueError):
        blur_px = 24.0
    try:
        opacity = float(raw.get("opacity") if raw.get("opacity") is not None else 0.7)
    except (TypeError, ValueError):
        opacity = 0.7
    opacity = max(0.0, min(1.0, opacity))
    return {
        "enabled": bool(raw.get("enabled", False)),
        "color": _normalize_hex_color(raw.get("color"), "#ffffff"),
        "blurPx": round(blur_px, 2),
        "opacity": round(opacity, 3),
    }


def _normalize_character_drop_shadow(raw: Any) -> dict[str, Any]:
    """キャラ用 dropShadow。"""
    if not isinstance(raw, dict):
        raw = {}
    try:
        blur_px = max(0.0, float(raw.get("blurPx") if raw.get("blurPx") is not None else 12.0))
    except (TypeError, ValueError):
        blur_px = 12.0
    try:
        offset_x = float(raw.get("offsetX") if raw.get("offsetX") is not None else 8.0)
    except (TypeError, ValueError):
        offset_x = 8.0
    try:
        offset_y = float(raw.get("offsetY") if raw.get("offsetY") is not None else 8.0)
    except (TypeError, ValueError):
        offset_y = 8.0
    try:
        opacity = float(raw.get("opacity") if raw.get("opacity") is not None else 0.6)
    except (TypeError, ValueError):
        opacity = 0.6
    opacity = max(0.0, min(1.0, opacity))
    return {
        "enabled": bool(raw.get("enabled", False)),
        "color": _normalize_hex_color(raw.get("color"), "#000000"),
        "blurPx": round(blur_px, 2),
        "offsetX": round(offset_x, 2),
        "offsetY": round(offset_y, 2),
        "opacity": round(opacity, 3),
    }


def _normalize_character_effects(raw: Any) -> dict[str, Any]:
    """演出タブの「キャラクター」カテゴリで設定する効果群 (cut 単位)。"""
    if not isinstance(raw, dict):
        raw = {}
    return {
        "colorFilter": _normalize_color_filter(raw.get("colorFilter")),
        "glow": _normalize_character_glow(raw.get("glow")),
        "dropShadow": _normalize_character_drop_shadow(raw.get("dropShadow")),
    }


def _normalize_glow_style(raw: dict[str, Any]) -> dict[str, Any]:
    try:
        blur_px = max(0.0, float(raw.get("blurPx") if raw.get("blurPx") is not None else 12.0))
    except (TypeError, ValueError):
        blur_px = 12.0
    try:
        opacity = float(raw.get("opacity") if raw.get("opacity") is not None else 0.8)
    except (TypeError, ValueError):
        opacity = 0.8
    opacity = max(0.0, min(1.0, opacity))
    return {
        "enabled": bool(raw.get("enabled", False)),
        "color": _normalize_hex_color(raw.get("color"), "#ffffff"),
        "blurPx": round(blur_px, 2),
        "opacity": round(opacity, 3),
        # 強さ: ぼかしで薄くなった halo を濃くするスタック合成回数 (1〜8, 既定 1)。
        "intensity": _normalize_effect_intensity(raw.get("intensity")),
    }


def _normalize_effect_intensity(value: Any) -> float:
    try:
        n = float(value) if value is not None else 1.0
    except (TypeError, ValueError):
        n = 1.0
    return round(max(1.0, min(8.0, n)), 2)


def _normalize_drop_shadow_style(raw: dict[str, Any]) -> dict[str, Any]:
    try:
        blur_px = max(0.0, float(raw.get("blurPx") if raw.get("blurPx") is not None else 6.0))
    except (TypeError, ValueError):
        blur_px = 6.0
    try:
        offset_x = float(raw.get("offsetX") if raw.get("offsetX") is not None else 4.0)
    except (TypeError, ValueError):
        offset_x = 4.0
    try:
        offset_y = float(raw.get("offsetY") if raw.get("offsetY") is not None else 4.0)
    except (TypeError, ValueError):
        offset_y = 4.0
    try:
        opacity = float(raw.get("opacity") if raw.get("opacity") is not None else 0.7)
    except (TypeError, ValueError):
        opacity = 0.7
    opacity = max(0.0, min(1.0, opacity))
    return {
        "enabled": bool(raw.get("enabled", False)),
        "color": _normalize_hex_color(raw.get("color"), "#000000"),
        "blurPx": round(blur_px, 2),
        "offsetX": round(offset_x, 2),
        "offsetY": round(offset_y, 2),
        "opacity": round(opacity, 3),
        # 強さ: ぼかしで薄くなった影を濃くするスタック合成回数 (1〜8, 既定 1)。
        "intensity": _normalize_effect_intensity(raw.get("intensity")),
    }


# ★ Phase 0 で追加された TextClip 拡張キー。
#   ・kind          : "caption" | "mv_text"。未指定は caption に倒す
#   ・renderLayer   : "overlay" | "above_bg" | "above_chars" | "above_fg"。未知値は overlay
#   ・effectPreset  : mv_text 用の視覚フィルタ ID (neon_glow / rgb_shift 等)。caption は None
#   ・effectParams  : プリセット固有パラメータの dict。バリデーションは client/プリセット側
#   ・animation     : {in,out,body} それぞれ {preset, params} の dict
#   ・occlusion     : Phase 5 で解禁する人物マスク連携の予約フィールド (MVP は mode="none")
#
# 既存プロジェクトは kind 未指定で "caption" として読まれるため完全互換。
#
# ★ Phase 4 で追加された metadata.posterTypography (= テンプレ生成由来の clip 結びつき)
#   と style.rotation の許容も _normalize_telop で行う。テンプレ生成された clip 群は
#   後から個別調整可能だが、metadata.posterTypography.templateId / sourceText / params /
#   groupId を残しておけば「テンプレを再適用」できる (Phase 4-4)。
_TEXTCLIP_KIND_VALID = ("caption", "mv_text")
_TEXTCLIP_RENDER_LAYER_VALID = ("overlay", "above_bg", "above_chars", "above_fg")
_TEXTCLIP_ANIMATION_SLOTS = ("in", "out", "body")
_TEXTCLIP_OCCLUSION_MODES = ("none", "character_alpha", "character_part", "depth")
_TEXTCLIP_OCCLUSION_TARGETS = ("characters", "specific")
_TEXTCLIP_OCCLUSION_PART_MODES = ("all", "specific")


def _normalize_textclip_animation(raw: Any) -> dict[str, Any]:
    """animation = {in: {preset, params}, out: {...}, body: {...}}"""
    if not isinstance(raw, dict):
        raw = {}
    out: dict[str, Any] = {}
    for slot in _TEXTCLIP_ANIMATION_SLOTS:
        slot_raw = raw.get(slot)
        if isinstance(slot_raw, dict):
            preset_val = slot_raw.get("preset")
            preset = str(preset_val).strip() if preset_val not in (None, "") else None
            params_raw = slot_raw.get("params")
            params = params_raw if isinstance(params_raw, dict) else {}
        else:
            preset = None
            params = {}
        out[slot] = {"preset": preset, "params": params}
    return out


def _normalize_textclip_occlusion(raw: Any) -> dict[str, Any]:
    """occlusion = {mode, target, targetCharacterIds, partMode, targetPartIds}.
    Phase 5 まで未使用だが、永続化スキーマには既定値で必ず乗せる。"""
    if not isinstance(raw, dict):
        raw = {}
    mode = str(raw.get("mode") or "none").lower()
    if mode not in _TEXTCLIP_OCCLUSION_MODES:
        mode = "none"
    target = str(raw.get("target") or "characters").lower()
    if target not in _TEXTCLIP_OCCLUSION_TARGETS:
        target = "characters"
    target_ids_raw = raw.get("targetCharacterIds")
    target_ids: list[str] = []
    if isinstance(target_ids_raw, list):
        for item in target_ids_raw:
            if isinstance(item, str) and item:
                target_ids.append(item)
    part_mode = str(raw.get("partMode") or "all").lower()
    if part_mode not in _TEXTCLIP_OCCLUSION_PART_MODES:
        part_mode = "all"
    target_parts_raw = raw.get("targetPartIds")
    target_parts: list[str] = []
    if isinstance(target_parts_raw, list):
        for item in target_parts_raw:
            if isinstance(item, str) and item:
                target_parts.append(item)
    return {
        "mode": mode,
        "target": target,
        "targetCharacterIds": target_ids,
        "partMode": part_mode,
        "targetPartIds": target_parts,
    }


def _normalize_telop(telop: dict[str, Any], index: int) -> dict[str, Any]:
    raw_position = str(telop.get("position") or "bottom").lower()
    if raw_position not in ("top", "bottom", "center", "custom"):
        raw_position = "bottom"
    start_frame = _coerce_frame_field(telop.get("startFrame"), telop.get("startSec")) or 0
    duration_frame = _coerce_frame_field(telop.get("durationFrame"), telop.get("duration"))
    if duration_frame is None or duration_frame <= 0:
        duration_frame = PROJECT_FPS * 2  # 既定 2 秒
    duration_frame = max(1, duration_frame)
    style_raw = telop.get("style")
    style: dict[str, Any] = {}
    if isinstance(style_raw, dict):
        for key in (
            "fontSize",
            "fontFamily",
            "fontWeight",
            "color",
            "outlineColor",
            "outlineWidth",
            "boxBackgroundColor",
            "boxOpacity",
            "boxPaddingX",
            "boxPaddingY",
            "align",
            "letterSpacing",
            "lineSpacing",
            "enableOpticalKerning",
            "opticalKerningHighQuality",
            # ★ R8: 個別文字間カーニング (gap index -> 1/1000em)。下で schema 強制する。
            "charKerning",
            # ★ Phase 0 追加: mv_text 用 (caption の見た目には影響しない)。
            #   blendMode  : "normal" | "screen" | "multiply"
            #   bodyOpacity: 本体不透明度 (glow / shadow と独立)
            "blendMode",
            "bodyOpacity",
            # ★ Phase 4 追加: 文字ブロックの回転 (deg)。poster_typography テンプレ
            #   の diagonal_phrase が必須で要求するが、caption 側でも個別に使える。
            #   既定 0 として normalize した場合は省略 (= dict に出さない) でも互換。
            "rotation",
            # ★ 縦書き対応: "horizontal" (既定, 省略可) | "vertical"。
            #   縦書き時は行 = カラム (右→左)、句読点/括弧類は GSUB vert 字形
            #   (取得不可時は Unicode 分類の回転/シフト) で描画する。
            "writingMode",
        ):
            if key in style_raw:
                style[key] = style_raw[key]
        glow_raw = style_raw.get("glow")
        if isinstance(glow_raw, dict):
            style["glow"] = _normalize_glow_style(glow_raw)
        shadow_raw = style_raw.get("dropShadow")
        if isinstance(shadow_raw, dict):
            style["dropShadow"] = _normalize_drop_shadow_style(shadow_raw)
    # R8: 個別文字間カーニングは schema 強制 (空なら出力しない)。
    if "charKerning" in style:
        ck = _normalize_char_kerning(style.get("charKerning"))
        if ck:
            style["charKerning"] = ck
        else:
            style.pop("charKerning", None)
    x_value = telop.get("x")
    y_value = telop.get("y")
    try:
        x_norm = None if x_value in (None, "") else int(x_value)
    except (TypeError, ValueError):
        x_norm = None
    try:
        y_norm = None if y_value in (None, "") else int(y_value)
    except (TypeError, ValueError):
        y_norm = None
    kind = str(telop.get("kind") or "caption").lower()
    if kind not in _TEXTCLIP_KIND_VALID:
        kind = "caption"
    render_layer = str(telop.get("renderLayer") or "overlay").lower()
    if render_layer not in _TEXTCLIP_RENDER_LAYER_VALID:
        render_layer = "overlay"
    # effectPreset は mv_text 専用。caption に紛れていても null に倒す。
    if kind == "mv_text":
        effect_raw = telop.get("effectPreset")
        effect_preset = str(effect_raw).strip() if effect_raw not in (None, "") else None
    else:
        effect_preset = None
    effect_params_raw = telop.get("effectParams")
    effect_params = effect_params_raw if isinstance(effect_params_raw, dict) else {}
    # ★ Phase 4 で廃止された effectPreset。同等表現は poster_typography テンプレ
    #   (= 複数 TextClip を一度に生成) で作る方針に倒したので、旧 disk データの
    #   "huge_handwritten" は null に倒して effectParams も捨てる。これで起動時に
    #   "未登録プリセット" 警告が出ない。
    if effect_preset == "huge_handwritten":
        effect_preset = None
        effect_params = {}
    # ★ effectPreset 個別の旧キー migration。
    #   Phase 5 で neon_glow を 3 層構造 (暗ハロー+管+白芯) に再設計し、旧パラメータを
    #   全廃。tubeColor (ユーザー指定の管色) だけは「ユーザーの意図」として保持し、
    #   その他の旧キー (color / hollowFill / coreOpacity / blurPx / glowSource /
    #   autoAttenuateBright / opacity / haloStrength の旧意味 / pulseAmount の旧範囲)
    #   は捨てて新デフォルトに乗せる。
    if effect_preset == "neon_glow" and isinstance(effect_params, dict):
        effect_params = dict(effect_params)
        # 旧 `color` を tubeColor に格上げ (新キーが未指定のときのみ)
        if "tubeColor" not in effect_params and "color" in effect_params:
            effect_params["tubeColor"] = effect_params.pop("color")
        # Phase 5 で廃止された旧キーを掃除する。残しておくと「効かない設定が disk に
        # 残り続けて UI 表示と挙動が乖離する」事故になる。
        for legacy_key in (
            "color",            # tubeColor に格上げ済み
            "hollowFill",       # 廃止 (coreStrokeWidth に置換)
            "coreOpacity",      # 廃止 (coreStrokeWidth に置換)
            "blurPx",           # haloBlurPx / midBlurPx に分離
            "glowSource",       # 廃止 (常に stroke 由来)
            "autoAttenuateBright",  # 廃止 (常に off)
        ):
            effect_params.pop(legacy_key, None)
    # ★ Phase 4: poster_typography テンプレ生成由来の metadata。
    #   生成元 templateId / sourceText / params / groupId を残しておくと、
    #   後から「テンプレを再適用」できる。手動で作った clip では metadata が
    #   無いだけで動作には影響しない。
    metadata_raw = telop.get("metadata")
    metadata: dict[str, Any] = {}
    if isinstance(metadata_raw, dict):
        poster_raw = metadata_raw.get("posterTypography")
        if isinstance(poster_raw, dict):
            template_id_raw = poster_raw.get("templateId")
            template_id = str(template_id_raw).strip() if template_id_raw not in (None, "") else ""
            if template_id:
                source_text = str(poster_raw.get("sourceText") or "")
                params_raw = poster_raw.get("params")
                params = params_raw if isinstance(params_raw, dict) else {}
                group_id_raw = poster_raw.get("groupId")
                group_id = str(group_id_raw).strip() if group_id_raw not in (None, "") else ""
                role_raw = poster_raw.get("role")
                role = str(role_raw).strip() if role_raw not in (None, "") else ""
                metadata["posterTypography"] = {
                    "templateId": template_id,
                    "sourceText": source_text,
                    "params": params,
                    "groupId": group_id,
                    "role": role,
                }
    linked_cut_id = telop.get("linkedCutId")
    return {
        "id": str(telop.get("id") or f"telop_{index:03d}"),
        "kind": kind,
        "lane": _normalize_lane(telop.get("lane")),
        "startFrame": int(start_frame),
        "durationFrame": int(duration_frame),
        "text": str(telop.get("text") or ""),
        "position": raw_position,
        "x": x_norm,
        "y": y_norm,
        "style": style,
        "renderLayer": render_layer,
        "effectPreset": effect_preset,
        "effectParams": effect_params,
        "animation": _normalize_textclip_animation(telop.get("animation")),
        "occlusion": _normalize_textclip_occlusion(telop.get("occlusion")),
        "metadata": metadata,
        # カットへの紐付け (optional)。設定時はカット複製・並び替え・削除に追従する。
        "linkedCutId": str(linked_cut_id) if linked_cut_id else None,
    }


def _normalize_video_track(track: Any) -> dict[str, Any] | None:
    if not isinstance(track, dict):
        return None
    src = _nfc(track.get("src")).strip()
    if not src:
        return None
    fit = str(track.get("fit") or "cover").lower()
    if fit not in ("cover", "contain", "fill"):
        fit = "cover"
    loop = str(track.get("loop") or "loop").lower()
    if loop not in ("loop", "stretch", "freeze_last_frame"):
        loop = "loop"
    try:
        trim_start = max(0.0, float(track.get("trimStartSec") or 0.0))
    except (TypeError, ValueError):
        trim_start = 0.0
    raw_trim_end = track.get("trimEndSec")
    try:
        trim_end = float(raw_trim_end) if raw_trim_end not in (None, "") else None
    except (TypeError, ValueError):
        trim_end = None
    try:
        speed = max(0.05, float(track.get("speed") or 1.0))
    except (TypeError, ValueError):
        speed = 1.0
    return {
        "src": src,
        "muted": bool(track.get("muted", True)),
        "fit": fit,
        "trimStartSec": round(trim_start, 3),
        "trimEndSec": round(trim_end, 3) if trim_end is not None else None,
        "loop": loop,
        "speed": round(speed, 3),
    }


def _normalize_bgm_track(track: dict[str, Any]) -> dict[str, Any] | None:
    src = _nfc(track.get("src")).strip()
    if not src:
        return None
    try:
        volume = max(0.0, min(2.0, float(track.get("volume") or 1.0)))
    except (TypeError, ValueError):
        volume = 1.0
    try:
        trim_start = max(0.0, float(track.get("trimStartSec") or 0.0))
    except (TypeError, ValueError):
        trim_start = 0.0
    try:
        fade_in = max(0.0, float(track.get("fadeInSec") or 0.0))
    except (TypeError, ValueError):
        fade_in = 0.0
    try:
        fade_out = max(0.0, float(track.get("fadeOutSec") or 0.0))
    except (TypeError, ValueError):
        fade_out = 0.0
    return {
        "src": src,
        "volume": round(volume, 3),
        "trimStartSec": round(trim_start, 3),
        "fadeInSec": round(fade_in, 3),
        "fadeOutSec": round(fade_out, 3),
        "useForLipSync": bool(track.get("useForLipSync") or False),
        # loop=True なら scene 終端までトラックをループ再生する。
        # 複数 BGM が ON でも排他ではなく、それぞれ独立にループする。
        "loop": bool(track.get("loop") or False),
    }


def _normalize_video_layer(vl: dict[str, Any], index: int) -> dict[str, Any] | None:
    """動画レイヤー 1 件を正規化。

    - `src` は manifest 経由で解決される相対パス (例 `assets/videos/title.mp4`)。
      未指定 (空文字) のものはドロップする。
    - 開始位置はフレーム単位 (PROJECT_FPS=24)。旧プロジェクト互換の `startSec` も読む。
    - `durationFrame` は持たない (タイムライン上の長さは trim 範囲から派生)。
    - `loop` / `speed` は持たない (等倍再生のみ / loop なし)。
    - `layer` は `above_bg` / `above_fg` の 2 値のみ。
    - `scale` は 0.05〜4.0 でクランプ (縦横比維持の追加倍率)。
    """
    src = _nfc(vl.get("src")).strip()
    if not src:
        return None
    start_frame = _coerce_frame_field(vl.get("startFrame"), vl.get("startSec")) or 0
    try:
        trim_start = max(0.0, float(vl.get("trimStartSec") or 0.0))
    except (TypeError, ValueError):
        trim_start = 0.0
    raw_trim_end = vl.get("trimEndSec")
    try:
        trim_end = float(raw_trim_end) if raw_trim_end not in (None, "") else None
    except (TypeError, ValueError):
        trim_end = None
    if trim_end is not None and trim_end < trim_start:
        trim_end = trim_start
    fit = str(vl.get("fit") or "contain").lower()
    if fit not in ("cover", "contain", "fill"):
        fit = "contain"
    try:
        scale = max(0.05, min(4.0, float(vl.get("scale") or 1.0)))
    except (TypeError, ValueError):
        scale = 1.0
    # offsetX / offsetY: 中央アンカーからのピクセルオフセット (±2000 でクランプ)。
    # 1920×1080 ステージの中央 (= computeVideoFit が計算した plane の中央) を原点に、
    # +X で右、+Y で下に動かす。Three.js は Y-down 座標 (OrthographicCamera(0,W,0,H))
    # を使っているので、UI 表示と内部表現は同じ。
    try:
        offset_x = max(-2000.0, min(2000.0, float(vl.get("offsetX") or 0.0)))
    except (TypeError, ValueError):
        offset_x = 0.0
    try:
        offset_y = max(-2000.0, min(2000.0, float(vl.get("offsetY") or 0.0)))
    except (TypeError, ValueError):
        offset_y = 0.0
    layer = str(vl.get("layer") or "above_fg").strip().lower()
    if layer not in ("above_bg", "above_fg"):
        layer = "above_fg"
    try:
        volume = max(0.0, min(2.0, float(vl.get("volume") if vl.get("volume") is not None else 1.0)))
    except (TypeError, ValueError):
        volume = 1.0
    # 不透明度 (0.0〜1.0、既定 1.0)。fadeIn/fadeOut で時間方向に絞る前のベース。
    try:
        opacity = max(0.0, min(1.0, float(vl.get("opacity") if vl.get("opacity") is not None else 1.0)))
    except (TypeError, ValueError):
        opacity = 1.0
    # フェードイン / フェードアウト。enabled=false なら sec をスキーマ上保持しても
    # alpha 計算に効かない。sec は 0〜60 でクランプ。
    fade_in_enabled = bool(vl.get("fadeInEnabled") or False)
    try:
        fade_in_sec = max(0.0, min(60.0, float(vl.get("fadeInSec") or 0.0)))
    except (TypeError, ValueError):
        fade_in_sec = 0.0
    fade_out_enabled = bool(vl.get("fadeOutEnabled") or False)
    try:
        fade_out_sec = max(0.0, min(60.0, float(vl.get("fadeOutSec") or 0.0)))
    except (TypeError, ValueError):
        fade_out_sec = 0.0
    return {
        "id": str(vl.get("id") or f"vl_{index:03d}"),
        "src": src,
        "lane": _normalize_lane(vl.get("lane")),
        "startFrame": int(start_frame),
        "trimStartSec": round(trim_start, 3),
        "trimEndSec": round(trim_end, 3) if trim_end is not None else None,
        "fit": fit,
        "scale": round(scale, 3),
        "offsetX": round(offset_x, 1),
        "offsetY": round(offset_y, 1),
        "layer": layer,
        "opacity": round(opacity, 3),
        "fadeInEnabled": fade_in_enabled,
        "fadeInSec": round(fade_in_sec, 3),
        "fadeOutEnabled": fade_out_enabled,
        "fadeOutSec": round(fade_out_sec, 3),
        "muted": bool(vl.get("muted") or False),
        "volume": round(volume, 3),
        # カットへの紐付け (optional)。設定時はカット複製・並び替え・削除に追従する。
        "linkedCutId": (str(vl.get("linkedCutId")) if vl.get("linkedCutId") else None),
    }


def _normalize_sound_effect(se: dict[str, Any], index: int) -> dict[str, Any] | None:
    """効果音 1 件を正規化。

    - `src` は manifest 経由で解決される相対パス (例 `assets/sound_effects/foo.wav`)。
      未指定 (空文字) のものは scene.soundEffects[] からドロップする。
    - 開始位置はフレーム単位 (PROJECT_FPS=24)。旧プロジェクトの `startSec` も読む。
    - 終了時間は durationFrame (フレーム単位)。0 = 「未指定、素材長そのまま」。
      loop=True で素材長 < durationFrame なら durationFrame 経過まで素材を繰り返す。
    - フェードイン / フェードアウトは秒。区間全体の先頭と末尾だけに掛かる
      (= ループ反復の境目には掛けない)。
    - 音量は 0.0..2.0 にクランプ (BGM トラックと同じレンジ)。
    """
    src = _nfc(se.get("src")).strip()
    if not src:
        return None
    start_frame = _coerce_frame_field(se.get("startFrame"), se.get("startSec")) or 0
    duration_frame_raw = _coerce_frame_field(se.get("durationFrame"), se.get("durationSec"))
    duration_frame = max(0, int(duration_frame_raw or 0))
    raw_volume = se.get("volume")
    try:
        volume = max(0.0, min(2.0, float(raw_volume) if raw_volume is not None else 1.0))
    except (TypeError, ValueError):
        volume = 1.0
    try:
        fade_in = max(0.0, float(se.get("fadeInSec") or 0.0))
    except (TypeError, ValueError):
        fade_in = 0.0
    try:
        fade_out = max(0.0, float(se.get("fadeOutSec") or 0.0))
    except (TypeError, ValueError):
        fade_out = 0.0
    try:
        audio_offset = max(0.0, float(se.get("audioOffsetSec") or 0.0))
    except (TypeError, ValueError):
        audio_offset = 0.0
    linked_cut_id = se.get("linkedCutId")
    return {
        "id": str(se.get("id") or f"se_{index:03d}"),
        "src": src,
        "lane": _normalize_lane(se.get("lane")),
        "startFrame": int(start_frame),
        "durationFrame": int(duration_frame),
        "loop": bool(se.get("loop") or False),
        "fadeInSec": round(fade_in, 3),
        "fadeOutSec": round(fade_out, 3),
        # 素材内の頭出し位置 (秒)。リサイズで左端をドラッグした分や、分割で生まれた
        # 「続き」効果音が素材の途中から鳴り始めるときに使う。
        "audioOffsetSec": round(audio_offset, 3),
        "volume": round(volume, 3),
        # カットへの紐付け (optional)。設定時はカット複製・並び替え・削除に追従する。
        # 存在しない cutId を指していたら scene 正規化後の post-pass で null に倒す。
        "linkedCutId": str(linked_cut_id) if linked_cut_id else None,
    }


def _normalize_scene_visualizer(raw: Any) -> dict[str, Any]:
    """シーン単位のビジュアライザ設定 (F5a)。

    プラグインキー / 音源トラック (bgm.src 値) / レイヤ位置 / params をまとめる。
    全キー欠損でも辞書を返す (`enabled=False`) ことで、UI 側のフォーム生成が単純になる。
    """
    if not isinstance(raw, dict):
        raw = {}
    plugin_key = str(raw.get("pluginKey") or "").strip()
    audio_track_id = str(raw.get("audioTrackId") or "").strip()
    layer = str(raw.get("layer") or "above_bg").strip().lower()
    if layer not in ("below_bg", "above_bg", "above_chars", "above_fg"):
        layer = "above_bg"
    params_raw = raw.get("params")
    params: dict[str, Any] = {}
    if isinstance(params_raw, dict):
        for key, value in params_raw.items():
            params[str(key)] = value
    return {
        "enabled": bool(raw.get("enabled", False)),
        "pluginKey": plugin_key,
        "audioTrackId": audio_track_id,
        "layer": layer,
        "params": params,
    }


def _normalize_scene(
    scene: dict[str, Any],
    scene_index: int,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    raw_cuts = scene.get("cuts")
    cuts: list[dict[str, Any]] = []
    if isinstance(raw_cuts, list):
        for cut_index, cut in enumerate(raw_cuts, start=1):
            if isinstance(cut, dict):
                cuts.append(_normalize_cut(cut, cut_index, manifest))
    _fill_cut_start_frame(cuts)
    # useForLipSync は同シーン内で 1 トラックのみ (_normalize_bgm_tracks が担保)。
    bgm_tracks = _normalize_bgm_tracks(scene.get("bgmTracks"))
    telops_raw = scene.get("telops")
    telops: list[dict[str, Any]] = []
    if isinstance(telops_raw, list):
        for telop_index, telop in enumerate(telops_raw, start=1):
            if isinstance(telop, dict):
                telops.append(_normalize_telop(telop, telop_index))
    # ID 重複の修復: クライアント側の旧 defaultTelop が `telop_${Date.now()}` で
    # ms 単位のため、一括追加ループ内で同じ ID が大量生成されるバグがあった。
    # 既存プロジェクトの読み込みで自動的にユニーク化して上書きする。
    seen_ids: set[str] = set()
    for idx, telop_obj in enumerate(telops, start=1):
        base_id = telop_obj.get("id") or f"telop_{idx:03d}"
        if base_id in seen_ids:
            suffix = 2
            new_id = f"{base_id}_{suffix}"
            while new_id in seen_ids:
                suffix += 1
                new_id = f"{base_id}_{suffix}"
            telop_obj["id"] = new_id
        seen_ids.add(telop_obj["id"])
    sound_effects_raw = scene.get("soundEffects")
    sound_effects: list[dict[str, Any]] = []
    if isinstance(sound_effects_raw, list):
        for se_index, se in enumerate(sound_effects_raw, start=1):
            if isinstance(se, dict):
                normalized = _normalize_sound_effect(se, se_index)
                if normalized:
                    sound_effects.append(normalized)
    # ID 重複の修復: telop と同様に旧 ms 単位 ID が衝突する可能性に備える。
    se_seen_ids: set[str] = set()
    for idx, se in enumerate(sound_effects, start=1):
        base_id = se.get("id") or f"se_{idx:03d}"
        if base_id in se_seen_ids:
            suffix = 2
            new_id = f"{base_id}_{suffix}"
            while new_id in se_seen_ids:
                suffix += 1
                new_id = f"{base_id}_{suffix}"
            se["id"] = new_id
        se_seen_ids.add(se["id"])
    video_layers_raw = scene.get("videoLayers")
    video_layers: list[dict[str, Any]] = []
    if isinstance(video_layers_raw, list):
        for vl_index, vl in enumerate(video_layers_raw, start=1):
            if isinstance(vl, dict):
                normalized = _normalize_video_layer(vl, vl_index)
                if normalized:
                    video_layers.append(normalized)
    vl_seen_ids: set[str] = set()
    for idx, vl in enumerate(video_layers, start=1):
        base_id = vl.get("id") or f"vl_{idx:03d}"
        if base_id in vl_seen_ids:
            suffix = 2
            new_id = f"{base_id}_{suffix}"
            while new_id in vl_seen_ids:
                suffix += 1
                new_id = f"{base_id}_{suffix}"
            vl["id"] = new_id
        vl_seen_ids.add(vl["id"])
    bpm_value = scene.get("bpm")
    try:
        bpm: float | None = float(bpm_value) if bpm_value not in (None, "") else None
    except (TypeError, ValueError):
        bpm = None
    breath = _normalize_breath(scene.get("breath"))
    bpm_bob = _normalize_bpm_bob(scene.get("bpmBob"))

    # linkedCutId post-pass: 存在しないカット ID を指していたら null に倒す。
    # シナリオ読み込み後にも整合性を保つための安全網。
    valid_cut_ids = {c.get("id") for c in cuts if isinstance(c, dict) and c.get("id")}
    for items in (telops, sound_effects, video_layers):
        for item in items:
            if item.get("linkedCutId") and item["linkedCutId"] not in valid_cut_ids:
                item["linkedCutId"] = None

    # R2: 種別ごとのレーン数。要求値 (laneCounts) とアイテムが乗っている最大レーンの
    # 両方を満たすよう max を取り、最低 1。アイテムがあるレーンが消えないようにする。
    raw_lane_counts = scene.get("laneCounts") if isinstance(scene.get("laneCounts"), dict) else {}

    def _lane_count(key: str, items: list[dict[str, Any]]) -> int:
        try:
            requested = int(raw_lane_counts.get(key))
        except (TypeError, ValueError):
            requested = 1
        max_lane = 0
        for it in items:
            try:
                max_lane = max(max_lane, int(it.get("lane") or 0))
            except (TypeError, ValueError):
                pass
        return max(1, requested, max_lane + 1)

    lane_counts = {
        "telop": _lane_count("telop", telops),
        "soundEffect": _lane_count("soundEffect", sound_effects),
        "videoLayer": _lane_count("videoLayer", video_layers),
    }

    out_scene = {
        "id": str(scene.get("id") or f"scene_{scene_index:03d}"),
        "title": str(scene.get("title") or f"シーン{scene_index}"),
        "background": str(scene.get("background") or ""),
        "videoTrack": _normalize_video_track(scene.get("videoTrack")),
        "bgmTracks": bgm_tracks,
        "soundEffects": sound_effects,
        "videoLayers": video_layers,
        "laneCounts": lane_counts,
        "bpm": bpm,
        "breath": breath,
        "bpmBob": bpm_bob,
        "cuts": cuts,
        "telops": telops,
        "visualizer": _normalize_scene_visualizer(scene.get("visualizer")),
    }
    # シーン間トランジション (Phase 3)。cut.transition と同一スキーマ。
    # "none" のときはキーごと出さない (既存シナリオの正規化結果を変えないため)。
    scene_transition = _normalize_transition(scene.get("transition"))
    if scene_transition.get("type") != "none":
        out_scene["transition"] = scene_transition
    return out_scene


def _normalize_breath(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {"amplitudePx": 0.0, "periodSec": 4.0}
    try:
        amp = max(0.0, float(value.get("amplitudePx") or 0))
    except (TypeError, ValueError):
        amp = 0.0
    try:
        period = float(value.get("periodSec") or 4.0)
    except (TypeError, ValueError):
        period = 4.0
    if period <= 0:
        period = 4.0
    return {"amplitudePx": amp, "periodSec": period}


def _normalize_bpm_bob(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {"amplitudePx": 0.0}
    try:
        amp = max(0.0, float(value.get("amplitudePx") or 0))
    except (TypeError, ValueError):
        amp = 0.0
    return {"amplitudePx": amp}


# =============================================================================
# ベッド設定 (SceneBed) の二層化 — プロジェクト通し / シーンごと
#
# 「その区間の下地として敷かれ続けるもの」= background / videoTrack / bgmTracks /
# visualizer / breath / bpmBob / bpm を、プロジェクト単位でも持てるようにする。
# どちらを使うかは `scenario.bedScope` が唯一の真実で、切替時に無効側のデータは
# **消さない** (再生 / 書き出しに使われなくなるだけ)。
#
# 詳細は dev_docs/plans/multi-scene.md §1-2。
# =============================================================================

# bedScope のキーと、それが支配する SceneBed のフィールド。
BED_SCOPE_FIELDS: dict[str, tuple[str, ...]] = {
    "bgm": ("bgmTracks",),
    "videoTrack": ("videoTrack",),
    "visualizer": ("visualizer",),
    "bodySway": ("breath", "bpmBob"),
}
BED_SCOPE_KEYS: tuple[str, ...] = tuple(BED_SCOPE_FIELDS.keys())

# 排他スコープを持たない「上書き型」フィールド。単一スカラーで二重適用が
# 起きないので、`scene 側に値があればそれ、無ければ projectSettings` で解決する。
# ・bpm: テンポ。bpmBob とビジュアライザのビート同期が参照する。
# ・background: gap フレーム用の背景。現状シーン設定に編集 UI が無く常に空。
BED_OVERRIDE_FIELDS: tuple[str, ...] = ("bpm", "background")


def _normalize_bgm_tracks(raw: Any) -> list[dict[str, Any]]:
    """BGM 配列の正規化 + useForLipSync の単一化 (同一レベル内で 1 本まで)。"""
    tracks: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for track in raw:
            if isinstance(track, dict):
                normalized = _normalize_bgm_track(track)
                if normalized:
                    tracks.append(normalized)
    seen_lip_sync = False
    for track in tracks:
        if track.get("useForLipSync"):
            if seen_lip_sync:
                track["useForLipSync"] = False
            else:
                seen_lip_sync = True
    return tracks


def _normalize_bed_scope(raw: Any) -> dict[str, str]:
    """各ベッド項目を project / scene のどちらから取るか。既定は全部 "scene"。

    既定を "scene" にしてあるので、既存プロジェクト (シーン 1 個・データは
    scenes[0] にしかない) は挙動が 1 mm も変わらない。
    """
    raw = raw if isinstance(raw, dict) else {}
    out: dict[str, str] = {}
    for key in BED_SCOPE_KEYS:
        value = str(raw.get(key) or "scene").strip().lower()
        out[key] = "project" if value == "project" else "scene"
    # 制約: ビジュアライザは audioTrackId で BGM を指すので、viz がプロジェクト
    # 通しなら BGM もプロジェクト通しでなければ「1 個の viz が場面ごとに違う曲を
    # 解析する」破綻が起きる。
    if out["visualizer"] == "project":
        out["bgm"] = "project"
    return out


def _normalize_scene_bed(raw: Any) -> dict[str, Any]:
    """SceneBed (プロジェクト通し設定 / シーン設定で共通の形) を正規化する。"""
    raw = raw if isinstance(raw, dict) else {}
    bpm_value = raw.get("bpm")
    try:
        bpm = int(bpm_value) if bpm_value not in (None, "") else None
    except (TypeError, ValueError):
        bpm = None
    if bpm is not None and bpm <= 0:
        bpm = None
    return {
        "background": _nfc(str(raw.get("background") or "")),
        "videoTrack": _normalize_video_track(raw.get("videoTrack")),
        "bgmTracks": _normalize_bgm_tracks(raw.get("bgmTracks")),
        "visualizer": _normalize_scene_visualizer(raw.get("visualizer")),
        "breath": _normalize_breath(raw.get("breath")),
        "bpmBob": _normalize_bpm_bob(raw.get("bpmBob")),
        "bpm": bpm,
    }


def _scene_bed_is_default(bed: dict[str, Any]) -> bool:
    """何も設定されていない SceneBed か。既定なら永続化から省く判定に使う。"""
    return (
        not bed.get("background")
        and bed.get("videoTrack") is None
        and not bed.get("bgmTracks")
        and not (bed.get("visualizer") or {}).get("enabled")
        and not (bed.get("breath") or {}).get("amplitudePx")
        and not (bed.get("bpmBob") or {}).get("amplitudePx")
        and bed.get("bpm") is None
    )


def resolve_effective_scene(
    scenario: dict[str, Any], scene: dict[str, Any]
) -> dict[str, Any]:
    """bedScope に従い、scene のベッド設定を projectSettings で差し替えた dict を返す。

    元の scene は変更しない (shallow copy)。呼び出し側はこの戻り値をそのまま
    「シーン」として扱えるので、既存の読み出しコードに手を入れずに済む。
    """
    if not isinstance(scene, dict):
        return scene
    scope = _normalize_bed_scope(scenario.get("bedScope") if isinstance(scenario, dict) else None)
    raw_project = scenario.get("projectSettings") if isinstance(scenario, dict) else None
    if all(v == "scene" for v in scope.values()) and not isinstance(raw_project, dict):
        return scene
    project_bed = _normalize_scene_bed(raw_project)
    out = dict(scene)
    for key, fields in BED_SCOPE_FIELDS.items():
        if scope.get(key) != "project":
            continue
        for field in fields:
            out[field] = project_bed.get(field)
    # 上書き型: scene 側が未指定のときだけ projectSettings を使う。
    for field in BED_OVERRIDE_FIELDS:
        if not out.get(field) and project_bed.get(field):
            out[field] = project_bed.get(field)
    return out


def normalize_scenario(scenario: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    raw_scenes = scenario.get("scenes")
    scenes_input: list[dict[str, Any]]
    if isinstance(raw_scenes, list) and raw_scenes:
        scenes_input = [scene for scene in raw_scenes if isinstance(scene, dict)]
    else:
        # 旧形式: cuts が直下にある v3 / 初期 v4 を scenes[0] へ移行
        scenes_input = [
            {
                "id": "scene_001",
                "title": "シーン1",
                "background": "",
                "cuts": scenario.get("cuts") or [],
            }
        ]
    scenes = [
        _normalize_scene(scene, scene_index, manifest)
        for scene_index, scene in enumerate(scenes_input, start=1)
    ]
    if not scenes:
        scenes = [_normalize_scene({"id": "scene_001", "title": "シーン1", "cuts": []}, 1, manifest)]
    out: dict[str, Any] = {
        "version": 4,
        "title": str(scenario.get("title", "scenario")),
        "scenes": scenes,
    }
    # プロジェクト通しのベッド設定 + どちらを使うかのスコープ。
    # どちらも「既定なら書き出さない」= 既存シナリオの正規化結果を 1 bit も変えない。
    project_bed = _normalize_scene_bed(scenario.get("projectSettings"))
    if not _scene_bed_is_default(project_bed):
        out["projectSettings"] = project_bed
    bed_scope = _normalize_bed_scope(scenario.get("bedScope"))
    if any(value != "scene" for value in bed_scope.values()):
        out["bedScope"] = bed_scope
    return out


def scenario_cuts(scenario: dict[str, Any]) -> list[dict[str, Any]]:
    """互換ヘルパ: 全シーンのカットを順に並べる（Phase 3 時点では scenes[0] のみ運用）。"""
    cuts: list[dict[str, Any]] = []
    for scene in scenario.get("scenes") or []:
        if isinstance(scene, dict):
            for cut in scene.get("cuts") or []:
                if isinstance(cut, dict):
                    cuts.append(cut)
    return cuts


def ensure_scenario(manifest: dict[str, Any], ctx: ProjectContext | None = None) -> dict[str, Any]:
    ctx = ctx or current_project()
    ctx.scenario_path.parent.mkdir(parents=True, exist_ok=True)
    if ctx.scenario_path.exists():
        with ctx.scenario_path.open("r", encoding="utf-8") as handle:
            scenario = json.load(handle)
        normalized = normalize_scenario(scenario, manifest)
        if normalized != scenario:
            with ctx.scenario_path.open("w", encoding="utf-8") as handle:
                json.dump(normalized, handle, ensure_ascii=False, indent=2)
        return normalized
    scenario = default_scenario(manifest)
    with ctx.scenario_path.open("w", encoding="utf-8") as handle:
        json.dump(scenario, handle, ensure_ascii=False, indent=2)
    return scenario

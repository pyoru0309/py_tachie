"""v3 → v4 片道変換スクリプト。

対象:
- assets/characters/<id>/character_manifest.json
- projects/<id>/assets/characters/<id>/character_manifest.json
- projects/<id>/scenarios/*.json

変換内容:
- character_manifest:
    bodies → bases、foregrounds → fronts、bangs/=空配列 を追加
    base/poses/costumes/faces は破棄、bangs は手動投入を促す
    defaults.body / defaults.base は破棄（bangs/eyeAboveBangs は持たない）
    defaults.removeWhite/antialiasBlackLine/character は維持
    version: 4
- scenario:
    state.characters[i] の base/body/foreground/pose/costume を v4 ID に変換
        - body → baseId（マニフェストの bases から path 一致で id を引く）
        - base/pose/costume は破棄
        - cheek/eye/mouth → cheekId/eyeId/mouthId
        - foreground → frontIds[0]
        - bangsId は "" のまま、eyeAboveBangs は false
    state 直下の base/body/foreground 等の旧フィールドは破棄
    version: 4

旧 PNG ファイル自体は削除しない（手動で整理する想定）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def find_id_by_path(items: list[dict[str, Any]], target_path: str | None) -> str:
    if not target_path:
        return ""
    for item in items:
        if str(item.get("path") or "") == str(target_path):
            return str(item.get("id") or "")
    return ""


def migrate_character_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    if int(manifest.get("version") or 0) >= 4:
        return manifest

    bodies = (
        manifest.get("bodies")
        or manifest.get("costumes")
        or manifest.get("poses")
        or manifest.get("base")
        or []
    )
    foregrounds = manifest.get("foregrounds") or []
    cheeks = manifest.get("cheeks") or []
    eyes = manifest.get("eyes") or []
    mouths = manifest.get("mouths") or []

    def normalize(items: list[Any]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            if not item.get("path"):
                continue
            result.append(
                {
                    "id": str(item.get("id") or ""),
                    "name": str(item.get("name") or ""),
                    "path": str(item.get("path") or ""),
                }
            )
        return result

    defaults_in = manifest.get("defaults") or {}
    defaults_out: dict[str, Any] = {
        "character": defaults_in.get("character") or {"x": 448, "y": 0, "scale": 1},
        "removeWhite": bool(defaults_in.get("removeWhite", True)),
        "antialiasBlackLine": bool(defaults_in.get("antialiasBlackLine", False)),
    }

    new_manifest: dict[str, Any] = {
        "version": 4,
        "id": str(manifest.get("id") or ""),
        "name": str(manifest.get("name") or ""),
        "bases": normalize(bodies),
        "cheeks": normalize(cheeks),
        "eyes": normalize(eyes),
        "mouths": normalize(mouths),
        "bangs": normalize(manifest.get("bangs") or []),
        "fronts": normalize(foregrounds),
        "defaults": defaults_out,
    }
    if manifest.get("readOnly") is not None:
        new_manifest["readOnly"] = bool(manifest.get("readOnly"))
    return new_manifest


def migrate_character_state(item: dict[str, Any], v4_manifests_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    character_id = str(item.get("characterId") or "")
    manifest = v4_manifests_by_id.get(character_id, {})
    bases = manifest.get("bases") or []
    cheeks = manifest.get("cheeks") or []
    eyes = manifest.get("eyes") or []
    mouths = manifest.get("mouths") or []
    bangs = manifest.get("bangs") or []
    fronts = manifest.get("fronts") or []

    body_path = item.get("body") or item.get("costume") or item.get("pose") or ""
    base_id = find_id_by_path(bases, body_path)
    cheek_id = find_id_by_path(cheeks, item.get("cheek") or "")
    eye_id = find_id_by_path(eyes, item.get("eye") or "")
    mouth_id = find_id_by_path(mouths, item.get("mouth") or "")
    foreground_path = item.get("foreground") or ""
    front_id = find_id_by_path(fronts, foreground_path)
    front_ids = [front_id] if front_id else []

    character = item.get("character") or {}
    return {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "characterId": character_id,
        "baseId": base_id,
        "cheekId": cheek_id,
        "eyeId": eye_id,
        "mouthId": mouth_id,
        "bangsId": "",
        "frontIds": front_ids,
        "eyeAboveBangs": bool(item.get("eyeAboveBangs", False)),
        "removeWhite": bool(item.get("removeWhite", True)),
        "antialiasBlackLine": bool(item.get("antialiasBlackLine", False)),
        "showCharacter": bool(item.get("showCharacter", True)),
        "character": {
            "x": int(character.get("x", 448)),
            "y": int(character.get("y", 0)),
            "scale": float(character.get("scale", 1.0)),
        },
    }


def migrate_scenario(scenario: dict[str, Any], v4_manifests_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
    # v4 で scenes 形式が確立されているなら触らない。
    # version>=4 でも cuts 直下のままになっている過渡期形式は scenes[0] に巻き直す。
    if int(scenario.get("version") or 0) >= 4 and isinstance(scenario.get("scenes"), list):
        return scenario

    raw_cuts = scenario.get("cuts") or []
    new_cuts: list[dict[str, Any]] = []
    cursor = 0.0
    for cut in raw_cuts:
        if not isinstance(cut, dict):
            continue
        state = cut.get("state") or {}
        characters_in = state.get("characters")
        characters_out: list[dict[str, Any]] = []
        if isinstance(characters_in, list):
            for character_item in characters_in:
                if isinstance(character_item, dict):
                    characters_out.append(
                        migrate_character_state(character_item, v4_manifests_by_id)
                    )
        new_state: dict[str, Any] = {
            "background": str(state.get("background") or ""),
            "showSpeechBox": bool(state.get("showSpeechBox", True)),
            "text": str(state.get("text") or ""),
            "textStyle": state.get("textStyle") or {},
            "speakerCharacterId": str(state.get("speakerCharacterId") or ""),
            "characters": characters_out,
            "motionType": str(state.get("motionType") or "none"),
        }
        if "motionSettings" in state:
            new_state["motionSettings"] = state["motionSettings"]
        if "speakerName" in state:
            new_state["speakerName"] = state["speakerName"]
        if "audioLipSyncOnly" in cut or "audioLipSyncOnly" in state:
            new_state["audioLipSyncOnly"] = bool(
                cut.get("audioLipSyncOnly") or state.get("audioLipSyncOnly") or False
            )
        duration = float(cut.get("duration") or 3.0)
        start_sec_raw = cut.get("startSec")
        try:
            start_sec = float(start_sec_raw) if start_sec_raw is not None else cursor
        except (TypeError, ValueError):
            start_sec = cursor
        new_cuts.append(
            {
                "id": str(cut.get("id") or ""),
                "startSec": round(start_sec, 3),
                "duration": duration,
                "audio": str(cut.get("audio") or ""),
                "audioLipSyncOnly": bool(cut.get("audioLipSyncOnly") or False),
                "state": new_state,
            }
        )
        cursor = start_sec + duration
    return {
        "version": 4,
        "title": str(scenario.get("title") or "scenario"),
        "scenes": [
            {
                "id": "scene_001",
                "title": "シーン1",
                "background": "",
                "videoTrack": None,
                "bgmTracks": [],
                "bpm": None,
                "cuts": new_cuts,
                "telops": [],
            }
        ],
    }


def discover_character_dirs(roots: list[Path]) -> list[Path]:
    result: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for entry in sorted(root.iterdir()):
            if entry.is_dir():
                result.append(entry)
    return result


def discover_scenarios(project_dir: Path) -> list[Path]:
    scenarios_dir = project_dir / "scenarios"
    if not scenarios_dir.exists():
        return []
    return sorted(scenarios_dir.glob("*.json"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def migrate_all(root: Path, dry_run: bool) -> None:
    common_chars_root = root / "assets" / "characters"
    projects_root = root / "projects"

    project_dirs: list[Path] = []
    if projects_root.exists():
        for entry in sorted(projects_root.iterdir()):
            if entry.is_dir():
                project_dirs.append(entry)

    character_dirs = discover_character_dirs([common_chars_root])
    for project_dir in project_dirs:
        character_dirs.extend(discover_character_dirs([project_dir / "assets" / "characters"]))

    v4_manifests_by_id: dict[str, dict[str, Any]] = {}
    for char_dir in character_dirs:
        manifest_path = char_dir / "character_manifest.json"
        if not manifest_path.exists():
            continue
        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        v4 = migrate_character_manifest(manifest)
        if not v4.get("id"):
            v4["id"] = char_dir.name
        if not v4.get("name"):
            v4["name"] = char_dir.name
        if not dry_run:
            write_json(manifest_path, v4)
        v4_manifests_by_id[str(v4.get("id") or "")] = v4
        print(f"[manifest] {manifest_path}")

    for project_dir in project_dirs:
        for scenario_path in discover_scenarios(project_dir):
            with scenario_path.open("r", encoding="utf-8") as handle:
                scenario = json.load(handle)
            new_scenario = migrate_scenario(scenario, v4_manifests_by_id)
            if not dry_run:
                write_json(scenario_path, new_scenario)
            print(f"[scenario] {scenario_path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="v3 → v4 一括変換")
    parser.add_argument("--root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    migrate_all(args.root, args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())

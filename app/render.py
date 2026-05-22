from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .manifest import resolve_hairstyle_preset
from .paths import PROJECT_ROOT
from .scenario import _character_def_for


def safe_output_name(name: str | None) -> str:
    if name:
        cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._")
        if cleaned:
            if not cleaned.lower().endswith(".png"):
                cleaned += ".png"
            return cleaned
    return f"render_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"


def safe_asset_path(rel_path: str | None) -> Path | None:
    if not rel_path:
        return None
    path = (PROJECT_ROOT / rel_path).resolve()
    root = PROJECT_ROOT.resolve()
    if root not in path.parents and path != root:
        raise ValueError("Asset path is outside of project root")
    return path


def pick_layer(items: list[dict[str, str]], keywords: list[str], fallback: str | None) -> str | None:
    for item in items:
        name = f"{item.get('name', '')} {item.get('id', '')} {item.get('path', '')}".lower()
        if any(keyword.lower() in name for keyword in keywords):
            return item.get("path")
    return fallback


def animation_asset_items(manifest: dict[str, Any], state: dict[str, Any], key: str) -> list[dict[str, str]]:
    character_id = str(state.get("characterId") or "")
    for character in manifest.get("characters") or []:
        if character.get("id") == character_id:
            items = character.get(key)
            return items if isinstance(items, list) else []
    items = manifest.get(key, [])
    return items if isinstance(items, list) else []


def resolve_character_paths(state: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    """v4 ID-based state にレイヤーパス系のフィールド（base/cheek/eye/mouth/bangs/back_hair/fronts）を補い、compositor 互換にして返す。

    Phase 4 で base / bangs / back_hair は **髪型プリセット (hairstylePresetId)** から
    解決する。preset 未指定または不正なら base は cut state の baseId にフォールバック、
    bangs / back_hair は無し。`hairstylePresetId` がアセット側 default に解決された
    時点で normalize_character_state がそれを書き戻すため、ここではその id を素直に
    参照すれば良い。
    """
    character_id = str(state.get("characterId") or "")
    character_def = _character_def_for(manifest, character_id)

    def find_path(items_key: str, id_value: Any) -> str:
        if not id_value:
            return ""
        for item in character_def.get(items_key) or []:
            if item.get("id") == id_value:
                return str(item.get("path") or "")
        return ""

    out = dict(state)
    # 髪型プリセットを解決し、bangs / back_hair を引き当てる。
    # base は cut.state.baseId を権威とし、preset の baseId は「preset 選択時に
    # フロント側で elements.base に同期する初期値」としてだけ機能する。
    # (preset の baseId を server 側で常に上書きすると、ユーザーが「ベース」
    # セレクタで体型/衣装だけを切り替える操作が render に反映されない。)
    hairstyle = resolve_hairstyle_preset(character_def, str(state.get("hairstylePresetId") or ""))
    bangs_item = hairstyle.get("bangs") if isinstance(hairstyle, dict) else None
    back_hair_item = hairstyle.get("backHair") if isinstance(hairstyle, dict) else None
    out["base"] = find_path("bases", state.get("baseId"))
    out["bangs"] = str(bangs_item.get("path") or "") if bangs_item else ""
    out["back_hair"] = str(back_hair_item.get("path") or "") if back_hair_item else ""
    out["cheek"] = find_path("cheeks", state.get("cheekId"))
    out["eye"] = find_path("eyes", state.get("eyeId"))
    out["mouth"] = find_path("mouths", state.get("mouthId"))
    fronts: list[str] = []
    for front_id in state.get("frontIds") or []:
        path = find_path("fronts", front_id)
        if path:
            fronts.append(path)
    out["fronts"] = fronts
    out["eyeAboveBangs"] = bool(state.get("eyeAboveBangs", False))
    return out


def _find_layer_by_flag(items: list[dict[str, Any]], flag: str) -> str | None:
    """manifest 上で `flags[flag]=True` が立った最初のレイヤーの path を返す。"""
    for item in items:
        flags = item.get("flags") or {}
        if isinstance(flags, dict) and flags.get(flag):
            return item.get("path") or None
    return None


def _cut_eye_has_blink_open(items: list[dict[str, Any]], cut_eye_id: str) -> bool:
    if not cut_eye_id:
        return False
    for item in items:
        if item.get("id") != cut_eye_id:
            continue
        flags = item.get("flags") or {}
        return bool(isinstance(flags, dict) and flags.get("blinkOpen"))
    return False


def animation_layers(manifest: dict[str, Any], state: dict[str, Any]) -> dict[str, str | None]:
    """フラグベースで目パチ・口パクのレイヤーを解決する。

    返り値:
      eye_open: state["eye"] (= カット選択の目)。`flags.blinkOpen` が立っていない
                目を選んだカットでは目パチ自体を skip するので、ここでは常に
                state["eye"] を返し、blink eligibility は呼び出し側で判定する。
      eye_half / eye_closed: manifest 上で `flags.blinkHalf` / `flags.blinkClosed`
                が立った 1 枚 (見つからなければ None)。
      mouth_default: state["mouth"] (= カット選択の口)。喋っていないとき / 口パク
                OFF 時に使う。
      mouth_closed / mouth_mid / mouth_open: 同 `flags.lipClosed` / `lipMid` /
                `lipOpen`。
    """
    eyes = animation_asset_items(manifest, state, "eyes")
    mouths = animation_asset_items(manifest, state, "mouths")
    cut_eye_id = str(state.get("eyeId") or "")
    return {
        "eye_open": state.get("eye") or None,
        "eye_half": _find_layer_by_flag(eyes, "blinkHalf"),
        "eye_closed": _find_layer_by_flag(eyes, "blinkClosed"),
        "blink_eligible": _cut_eye_has_blink_open(eyes, cut_eye_id),
        "mouth_default": state.get("mouth") or None,
        "mouth_closed": _find_layer_by_flag(mouths, "lipClosed"),
        "mouth_mid": _find_layer_by_flag(mouths, "lipMid"),
        "mouth_open": _find_layer_by_flag(mouths, "lipOpen"),
    }


def animate_character_state(
    character_state: dict[str, Any],
    frame: int,
    fps: int,
    blink_starts: set[int],
    speaking: bool,
    manifest: dict[str, Any],
    options: dict[str, Any],
    volume: float | None,
    config: dict[str, Any],
) -> dict[str, Any]:
    state = resolve_character_paths(character_state, manifest)
    layers = animation_layers(manifest, state)
    layers["lipSyncConfig"] = config.get("lipSync", {})
    # 目パチ: カット選択の目に blinkOpen フラグが無ければ skip し、state["eye"] を維持。
    blink_eligible = bool(layers.get("blink_eligible"))
    if options.get("blink", True) and blink_eligible:
        eye = eye_for_frame(frame, fps, blink_starts, layers)
        if eye is not None:
            state["eye"] = eye
    # 口パク: 全体設定 OFF / 喋っていない / volume<silence → state["mouth"] を維持。
    if options.get("lipSync", True):
        mouth = mouth_for_frame(frame, fps, speaking, layers, volume)
        if mouth is not None:
            state["mouth"] = mouth
    return state


def _blink_pattern(anim_fps: int) -> list[str]:
    """アニメ業界の鉄則「開き→閉じ→中→開き」(スナップ閉じ + 段階開き) を anim fps の
    フレーム配列で返す。

    - 8fps  (3コマ割り): closed, half                      (2 frames @ 8fps  = 0.25s)
    - 12fps (2コマ割り): closed, closed, half              (3 frames @ 12fps = 0.25s)
    - 24fps (フル):      closed×3, half×3 (8fps の 3 回繰り返し)

    half テクスチャが無いキャラは呼び出し側の fallback chain (half → closed →
    open) で closed を再利用するので、ここでは常に "with half" 形を返す。
    """
    if anim_fps <= 8:
        return ["closed", "half"]
    if anim_fps <= 12:
        return ["closed", "closed", "half"]
    return ["closed", "closed", "closed", "half", "half", "half"]


def eye_for_frame(
    frame: int, fps: int, blink_starts: set[int], layers: dict[str, str | None]
) -> str | None:
    """目パチ中のフレームで使う eye path を返す。

    呼び出し側は ``layers['blink_eligible']`` が True のときのみ呼ぶ前提。
    `frame` / `blink_starts` / `fps` はすべて同じ anim fps 単位 (= 書き出しなら
    EXPORT_FPS ∈ {8, 12, 24})。fps から blink パターンを選んで lookup する。
    フォールバック順:
      half:   blinkHalf → blinkClosed → eye_open
      closed: blinkClosed → eye_open
    """
    pattern = _blink_pattern(int(fps))
    pattern_len = len(pattern)
    for start in blink_starts:
        offset = frame - start
        if 0 <= offset < pattern_len:
            key = pattern[offset]
            if key == "half":
                return (
                    layers.get("eye_half")
                    or layers.get("eye_closed")
                    or layers.get("eye_open")
                )
            return layers.get("eye_closed") or layers.get("eye_open")
    return layers.get("eye_open")


def mouth_for_frame(
    frame: int,
    fps: int,
    speaking: bool,
    layers: dict[str, str | None],
    volume: float | None = None,
) -> str | None:
    """口パク中の mouth path を返す。

    - 喋っていない → ``mouth_default`` (= カット選択)。
    - volume が分かるとき: silence 以下なら default、open 閾値以下なら mid、上は open。
    - volume が None で speaking のみ True (legacy フォールバック): phase ベースで循環。
    - 各フラグ付きレイヤーが manifest に無い場合は default にフォールバック (口を変えない)。
    """
    default_mouth = layers.get("mouth_default")
    if not speaking:
        return default_mouth
    if volume is not None:
        lip_sync_config = (
            layers.get("lipSyncConfig")
            if isinstance(layers.get("lipSyncConfig"), dict)
            else {}
        )
        silence_threshold = float(lip_sync_config.get("silenceThreshold", 0.08))
        open_threshold = float(lip_sync_config.get("openThreshold", 0.42))
        if volume < silence_threshold:
            return default_mouth
        if volume < open_threshold:
            return layers.get("mouth_mid") or default_mouth
        return layers.get("mouth_open") or default_mouth
    phase = int((frame / fps) / 0.14) % 4
    if phase == 0:
        return layers.get("mouth_closed") or default_mouth
    if phase == 1:
        return layers.get("mouth_mid") or default_mouth
    if phase == 2:
        return layers.get("mouth_open") or default_mouth
    return layers.get("mouth_mid") or default_mouth

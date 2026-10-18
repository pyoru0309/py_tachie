"""キャラの特殊効果 (オーラ / 雷 / 光の筋) のプリセット。

キャラ・シーン・プロジェクトに依存しない共通データとして app_state/effect_presets.json に置く
(動画書き出しプリセットと同じ扱い)。系統 (kind) ごとに独立していて、保存は kind 単位で置き換える。

    {
      "aura":      [{"id": "...", "name": "...", "values": {...}}],
      "lightning": [...],
      "streaks":   [...]
    }

values は カットのキャラ設定の aura / lightning / streaks と同じ形 (app/character_deform.py の
正規化を通す。enabled は常に True)。
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Any

from .character_deform import (
    normalize_character_aura,
    normalize_character_lightning,
    normalize_character_streaks,
)
from .paths import STATE_DIR

EFFECT_PRESETS_PATH = STATE_DIR / "effect_presets.json"
MAX_PRESETS_PER_KIND = 100

_NORMALIZERS = {
    "aura": normalize_character_aura,
    "lightning": normalize_character_lightning,
    "streaks": normalize_character_streaks,
}
EFFECT_KINDS = tuple(_NORMALIZERS)
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _normalize_preset(kind: str, raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    values_in = raw.get("values") if isinstance(raw.get("values"), dict) else {}
    values = _NORMALIZERS[kind]({**values_in, "enabled": True})
    if not values:
        return None
    name = str(raw.get("name") or "").strip()[:60]
    if not name:
        return None
    preset_id = str(raw.get("id") or "").strip()
    if not _ID_RE.fullmatch(preset_id):
        preset_id = f"{kind}_{uuid.uuid4().hex[:10]}"
    return {"id": preset_id, "name": name, "values": values}


def _normalize_list(kind: str, raw_list: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_list if isinstance(raw_list, list) else []:
        preset = _normalize_preset(kind, raw)
        if not preset:
            continue
        while preset["id"] in seen:
            preset["id"] = f"{kind}_{uuid.uuid4().hex[:10]}"
        seen.add(preset["id"])
        out.append(preset)
        if len(out) >= MAX_PRESETS_PER_KIND:
            break
    return out


def load_effect_presets() -> dict[str, list[dict[str, Any]]]:
    data: Any = {}
    if EFFECT_PRESETS_PATH.exists():
        try:
            data = json.loads(EFFECT_PRESETS_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
    if not isinstance(data, dict):
        data = {}
    return {kind: _normalize_list(kind, data.get(kind)) for kind in EFFECT_KINDS}


def save_effect_presets(payload: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """payload = {"kind": "aura" | "lightning" | "streaks", "presets": [...]}。その系統だけ置き換える。"""
    kind = str((payload or {}).get("kind") or "")
    if kind not in _NORMALIZERS:
        raise ValueError("kind は aura / lightning / streaks のいずれかです")
    presets = load_effect_presets()
    presets[kind] = _normalize_list(kind, payload.get("presets"))
    EFFECT_PRESETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = EFFECT_PRESETS_PATH.with_name(EFFECT_PRESETS_PATH.name + ".tmp")
    tmp.write_text(json.dumps(presets, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(EFFECT_PRESETS_PATH)
    return presets

"""キャラ定義の変形設定 (`character_manifest.json` の `deform`)。

変形の「場所」だけをキャラ定義に持つ (量やリズムはカット側の体の揺れ設定)。
描画は static/js/renderer/effects/char-deform.js、計画は dev_docs/plans/character-deform.md。

    "deform": {
      "stretch": {
        "anchorY": 0.55,  # 伸縮の基準線 (腰)。レイヤー高さ比 0..1 (上端 0)
        "topY": 0.18,     # 伸縮の上端 (首)。None = 上端まで伸縮
        "volume": 0.5     # 体積の保持 0..1
      },
      "pins": [           # 揺れピン (最大 16)
        {"id": "pin_1", "kind": "sway", "x": 0.42, "y": 0.18, "radius": 0.08,
         "amount": 0.15, "angleDeg": 0, "periodSec": 2.0, "phase": 0.0}
      ]
    }
"""
from __future__ import annotations

import re
from typing import Any

MAX_PINS = 16


def _ratio(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return round(max(0.0, min(1.0, number)), 4)


def normalize_character_deform(raw: Any) -> dict[str, Any]:
    """`deform` を正規化する。設定が無ければ空 dict (= 既定の全身伸縮)。"""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    stretch = raw.get("stretch")
    if isinstance(stretch, dict):
        anchor = _ratio(stretch.get("anchorY"))
        if anchor is None:
            anchor = 1.0
        top = _ratio(stretch.get("topY")) if stretch.get("topY") is not None else None
        if top is not None and top >= anchor:
            top = None
        volume = _ratio(stretch.get("volume"))
        out["stretch"] = {
            "anchorY": anchor,
            "topY": top,
            "volume": 0.5 if volume is None else volume,
        }
    pins = [_normalize_pin(item, index) for index, item in enumerate(raw.get("pins") or []) if isinstance(item, dict)]
    pins = [pin for pin in pins if pin][:MAX_PINS]
    if pins:
        out["pins"] = pins
    return out


def _number(value: Any, fallback: float, lo: float, hi: float, digits: int = 4) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    if number != number:  # NaN
        number = fallback
    return round(max(lo, min(hi, number)), digits)


def _normalize_pin(raw: dict[str, Any], index: int) -> dict[str, Any] | None:
    """揺れピン 1 本。位置・半径はレイヤー比、振れ幅は半径比 (0〜0.4)。"""
    x = _ratio(raw.get("x"))
    y = _ratio(raw.get("y"))
    if x is None or y is None:
        return None
    pin_id = str(raw.get("id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", pin_id):
        pin_id = f"pin_{index + 1}"
    angle = _number(raw.get("angleDeg"), 0.0, -360.0, 360.0, 1)
    return {
        "id": pin_id,
        "kind": "fixed" if raw.get("kind") == "fixed" else "sway",
        "x": x,
        "y": y,
        "radius": _number(raw.get("radius"), 0.08, 0.005, 1.0),
        "amount": _number(raw.get("amount"), 0.15, 0.0, 0.4),
        "angleDeg": angle,
        "periodSec": _number(raw.get("periodSec"), 2.0, 0.2, 20.0, 2),
        "phase": _number(raw.get("phase"), 0.0, 0.0, 1.0, 3),
    }


def normalize_character_sway(raw: Any) -> dict[str, Any] | None:
    """カット側の揺れピンの強さ。未設定 (None) = キャラ定義どおり (1.0)。0 = 止める。"""
    if not isinstance(raw, dict):
        return None
    return {"strength": _number(raw.get("strength"), 1.0, 0.0, 3.0, 2)}

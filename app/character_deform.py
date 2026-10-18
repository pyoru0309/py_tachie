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


_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def normalize_character_aura(raw: Any) -> dict[str, Any] | None:
    """カットのキャラ設定のオーラ (dev_docs/plans/character-aura.md)。無効 / 未設定は None。

    描画は static/js/renderer/effects/aura.js (normalizeAura と同じ範囲に揃える)。
    """
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return None

    def color(value: Any, fallback: str) -> str:
        text = str(value or "").strip()
        return text.lower() if _COLOR_RE.fullmatch(text) else fallback

    return {
        "enabled": True,
        "style": raw.get("style") if raw.get("style") in ("glow", "spike") else "flame",
        "color": color(raw.get("color"), "#ffe14a"),
        "color2": color(raw.get("color2"), "#ff9d1a"),
        "size": _number(raw.get("size"), 40.0, 4.0, 300.0, 1),
        # 体との間隔 (px)。0 = 体のすぐ外から
        "margin": _number(raw.get("margin"), 0.0, 0.0, 400.0, 1),
        "rise": _number(raw.get("rise"), 1.5, 0.0, 6.0, 2),
        # 伸ばす向き: 0 = 真上 / 1 = 体の輪郭の外向き (法線方向)
        "outward": _number(raw.get("outward"), 0.0, 0.0, 1.0, 2),
        # 鋭い筋の本数の倍率 (小さいほど少なく太い)
        "density": _number(raw.get("density"), 1.0, 0.2, 3.0, 2),
        # 集中線: 箇所の数 (0 = 出さない) と色
        "lineCount": int(_number(raw.get("lineCount"), 0, 0, 8, 0)),
        "lineColor": color(raw.get("lineColor"), "#000000"),
        "intensity": _number(raw.get("intensity"), 1.0, 0.0, 3.0, 2),
        "speed": _number(raw.get("speed"), 1.0, 0.0, 20.0, 2),
        "detail": _number(raw.get("detail"), 0.5, 0.0, 1.0, 2),
        "front": _number(raw.get("front"), 0.15, 0.0, 1.0, 2),
        "when": "speaking" if raw.get("when") == "speaking" else "always",
        "fadeSec": _number(raw.get("fadeSec"), 0.3, 0.0, 5.0, 2),
    }


def _when(raw: dict[str, Any]) -> str:
    return "speaking" if raw.get("when") == "speaking" else "always"


def _gap_from_frequency(raw: dict[str, Any]) -> float:
    try:
        freq = float(raw.get("frequency") or 0)
        duration = float(raw.get("duration") or 0.25)
    except (TypeError, ValueError):
        return 0.15
    return max(0.0, 1.0 / freq - duration) if freq > 0 else 0.15


def normalize_character_lightning(raw: Any) -> dict[str, Any] | None:
    """カットのキャラ設定の雷 (キャラの特殊効果 Phase B)。無効 / 未設定は None。

    描画は static/js/renderer/effects/char-sparks.js (normalizeLightning と同じ範囲)。
    """
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return None
    color = str(raw.get("color") or "").strip()
    return {
        "enabled": True,
        "color": color.lower() if _COLOR_RE.fullmatch(color) else "#7fd4ff",
        "count": int(_number(raw.get("count"), 6, 1, 60, 0)),
        "length": _number(raw.get("length"), 220.0, 20.0, 1200.0, 1),
        "width": _number(raw.get("width"), 8.0, 0.5, 40.0, 2),
        "duration": _number(raw.get("duration"), 0.3, 0.03, 2.0, 3),
        # 次に光るまでの間 (秒)。旧データの「光る頻度」(frequency) は 1/frequency - duration に読み替え
        "gap": _number(raw.get("gap"), _gap_from_frequency(raw), 0.0, 5.0, 3),
        "shape": raw.get("shape") if raw.get("shape") in ("hug", "mix") else "outward",
        # 体との間隔 (px)
        "margin": _number(raw.get("margin"), 0.0, 0.0, 400.0, 1),
        "branches": int(_number(raw.get("branches"), 2, 0, 4, 0)),
        "jitter": _number(raw.get("jitter"), 0.5, 0.0, 1.0, 2),
        "front": _number(raw.get("front"), 0.5, 0.0, 1.0, 2),
        "when": _when(raw),
        "fadeSec": _number(raw.get("fadeSec"), 0.3, 0.0, 5.0, 2),
    }


def normalize_character_streaks(raw: Any) -> dict[str, Any] | None:
    """カットのキャラ設定の光の筋 (キャラの特殊効果 Phase B)。無効 / 未設定は None。"""
    if not isinstance(raw, dict) or not raw.get("enabled"):
        return None
    color = str(raw.get("color") or "").strip()
    return {
        "enabled": True,
        "color": color.lower() if _COLOR_RE.fullmatch(color) else "#ffe14a",
        "count": int(_number(raw.get("count"), 16, 1, 60, 0)),
        "length": _number(raw.get("length"), 160.0, 10.0, 1200.0, 1),
        "width": _number(raw.get("width"), 6.0, 1.0, 60.0, 1),
        "speed": _number(raw.get("speed"), 900.0, 20.0, 6000.0, 0),
        "spread": _number(raw.get("spread"), 1.1, 0.2, 3.0, 2),
        "front": _number(raw.get("front"), 0.3, 0.0, 1.0, 2),
        "when": _when(raw),
        "fadeSec": _number(raw.get("fadeSec"), 0.3, 0.0, 5.0, 2),
    }


def normalize_character_sway(raw: Any) -> dict[str, Any] | None:
    """カット側の揺れピンの強さ。未設定 (None) = キャラ定義どおり (1.0)。0 = 止める。"""
    if not isinstance(raw, dict):
        return None
    return {"strength": _number(raw.get("strength"), 1.0, 0.0, 3.0, 2)}

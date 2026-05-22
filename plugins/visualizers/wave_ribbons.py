"""ジオメトリックな背景ウェーブ。複数の斜めリボンが緩やかに波打つ。

ベース色の上にハイライト色 / シャドウ色のリボンを重ねて「光のサテン」のような
背景を作る。音や BPM には連動せず、シーン秒だけで決まる closed-form の sin
アニメーションなので、シーク・書き出しでも同じフレームを再現する。
"""
from __future__ import annotations

KEY = "wave_ribbons"
NAME = "ウェーブリボン (ジオメトリック背景)"

GL_MODULE = "/static/js/visualizers/wave_ribbons.js"
GL_VERSION = 1
GL_FRAME_RATE = 24

PARAMS = [
    {"key": "baseColor", "type": "color", "default": "#0a3aab", "label": "ベース色"},
    {"key": "highlightColor", "type": "color", "default": "#5cb3ff", "label": "ハイライト色"},
    {"key": "shadowColor", "type": "color", "default": "#02195a", "label": "シャドウ色"},
    {"key": "ribbonCount", "type": "number", "min": 1, "max": 16, "step": 1,
     "default": 6, "label": "リボン数"},
    {"key": "baseAngle", "type": "number", "min": -180, "max": 180, "step": 1,
     "default": 24, "label": "基本角度 (度)"},
    {"key": "angleSpread", "type": "number", "min": 0, "max": 45, "step": 1,
     "default": 6, "label": "角度のばらつき (度)"},
    {"key": "minWidth", "type": "number", "min": 40, "max": 1200, "step": 10,
     "default": 220, "label": "最小リボン幅 (px)"},
    {"key": "maxWidth", "type": "number", "min": 60, "max": 1600, "step": 10,
     "default": 620, "label": "最大リボン幅 (px)"},
    {"key": "amplitude", "type": "number", "min": 0, "max": 800, "step": 10,
     "default": 240, "label": "波の振幅 (px)"},
    {"key": "wavelength", "type": "number", "min": 200, "max": 4000, "step": 50,
     "default": 1400, "label": "波長 (px)"},
    {"key": "speed", "type": "number", "min": 0, "max": 1.5, "step": 0.02,
     "default": 0.25, "label": "アニメ速度 (rad/秒)"},
    {"key": "highlightRatio", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.6, "label": "ハイライト色比率 (0=全部シャドウ / 1=全部ハイライト)"},
    {"key": "ribbonOpacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.4, "label": "リボンの不透明度"},
    {"key": "edgeSoftness", "type": "number", "min": 0.1, "max": 1, "step": 0.05,
     "default": 0.65, "label": "縁のソフトさ"},
    {"key": "seed", "type": "number", "min": 0, "max": 9999, "step": 1,
     "default": 7, "label": "乱数シード"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 1.0, "label": "全体の不透明度"},
]

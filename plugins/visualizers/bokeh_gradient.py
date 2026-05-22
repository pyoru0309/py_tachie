"""グラデーション背景にぼかし円が漂うビジュアライザ。

音には反応せず、シーン秒だけで決まる closed-form の sin/cos アニメーション。
シーク・書き出し・ライブプレビューのいずれでも同じフレームを描く。
"""
from __future__ import annotations

KEY = "bokeh_gradient"
NAME = "ぼかし円とグラデーション"

GL_MODULE = "/static/js/visualizers/bokeh_gradient.js"
GL_VERSION = 1
GL_FRAME_RATE = 24

PARAMS = [
    {"key": "colorA", "type": "color", "default": "#5bd5ff", "label": "グラデーション 色1"},
    {"key": "colorB", "type": "color", "default": "#ff5bd5", "label": "グラデーション 色2"},
    {"key": "gradientAngle", "type": "number", "min": 0, "max": 360, "step": 5,
     "default": 45, "label": "グラデーション角度 (度)"},
    {"key": "circleColor", "type": "color", "default": "#ffffff", "label": "円の色"},
    {"key": "circleCount", "type": "number", "min": 1, "max": 32, "step": 1,
     "default": 7, "label": "円の数"},
    {"key": "minRadius", "type": "number", "min": 20, "max": 400, "step": 10,
     "default": 80, "label": "最小半径 (px)"},
    {"key": "maxRadius", "type": "number", "min": 50, "max": 600, "step": 10,
     "default": 240, "label": "最大半径 (px)"},
    {"key": "driftRadius", "type": "number", "min": 0, "max": 800, "step": 20,
     "default": 280, "label": "ドリフト半径 (px)"},
    {"key": "driftSpeed", "type": "number", "min": 0.05, "max": 1.0, "step": 0.05,
     "default": 0.18, "label": "ドリフト速度"},
    {"key": "minAlpha", "type": "number", "min": 0.0, "max": 1.0, "step": 0.05,
     "default": 0.2, "label": "円の最小不透明度"},
    {"key": "maxAlpha", "type": "number", "min": 0.0, "max": 1.0, "step": 0.05,
     "default": 0.5, "label": "円の最大不透明度"},
    {"key": "alphaSpeed", "type": "number", "min": 0.05, "max": 2.0, "step": 0.05,
     "default": 0.4, "label": "不透明度変動速度"},
    {"key": "ringPos", "type": "number", "min": 0.4, "max": 0.95, "step": 0.05,
     "default": 0.82, "label": "リング位置 (0=中心 / 1=外周)"},
    {"key": "coreAlpha", "type": "number", "min": 0.0, "max": 1.0, "step": 0.05,
     "default": 0.5, "label": "中心の濃度比"},
    {"key": "seed", "type": "number", "min": 0, "max": 9999, "step": 1,
     "default": 17, "label": "乱数シード"},
    # --- スターダスト (小さな星粒) ---
    {"key": "starColor", "type": "color", "default": "#ffffff", "label": "星粒の色"},
    {"key": "starCount", "type": "number", "min": 0, "max": 400, "step": 5,
     "default": 80, "label": "星粒の数"},
    {"key": "starMinRadius", "type": "number", "min": 0.5, "max": 12, "step": 0.5,
     "default": 1.5, "label": "星粒の最小半径 (px)"},
    {"key": "starMaxRadius", "type": "number", "min": 1, "max": 24, "step": 0.5,
     "default": 4, "label": "星粒の最大半径 (px)"},
    {"key": "starMinAlpha", "type": "number", "min": 0.0, "max": 1.0, "step": 0.05,
     "default": 0.25, "label": "星粒の最小不透明度"},
    {"key": "starMaxAlpha", "type": "number", "min": 0.0, "max": 1.0, "step": 0.05,
     "default": 0.75, "label": "星粒の最大不透明度"},
    {"key": "starTwinkleSpeed", "type": "number", "min": 0.0, "max": 3.0, "step": 0.1,
     "default": 1.0, "label": "星粒の明滅速度"},
    {"key": "starDrift", "type": "number", "min": 0, "max": 100, "step": 1,
     "default": 6, "label": "星粒のドリフト (px)"},
    {"key": "starSeed", "type": "number", "min": 0, "max": 9999, "step": 1,
     "default": 31, "label": "星粒の乱数シード"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 1.0, "label": "全体の不透明度"},
]

"""星屑 / 雪 / 雨が降る (または浮遊する) ビジュアライザ。

背景は透過。音には反応せず、シーン秒の closed-form アニメーションでパーティクル
位置・明滅を決めるので、シーク・書き出しでも同じフレームを描く。
"""
from __future__ import annotations

KEY = "falling_particles"
NAME = "降りそそぐパーティクル (星屑 / 雪 / 雨)"

GL_MODULE = "/static/js/visualizers/falling_particles.js"
GL_VERSION = 1
GL_FRAME_RATE = 24

PARAMS = [
    {"key": "shape", "type": "select", "options": [
        {"value": "star", "label": "星屑 (キラキラ)"},
        {"value": "snow", "label": "雪"},
        {"value": "rain", "label": "雨"},
    ], "default": "star", "label": "形状"},
    {"key": "direction", "type": "select", "options": [
        {"value": "down", "label": "上から下へ降る"},
        {"value": "up", "label": "下から上へ浮かぶ"},
    ], "default": "down", "label": "方向"},
    {"key": "angle", "type": "number", "min": -60, "max": 60, "step": 1,
     "default": 0, "label": "傾き角度 (度)"},
    {"key": "color", "type": "color", "default": "#ffffff", "label": "色"},
    {"key": "count", "type": "number", "min": 1, "max": 400, "step": 5,
     "default": 80, "label": "パーティクル数"},
    {"key": "minSize", "type": "number", "min": 1, "max": 60, "step": 1,
     "default": 4, "label": "最小サイズ (px)"},
    {"key": "maxSize", "type": "number", "min": 2, "max": 120, "step": 1,
     "default": 22, "label": "最大サイズ (px)"},
    {"key": "fallSpeed", "type": "number", "min": 5, "max": 600, "step": 5,
     "default": 60, "label": "落下速度 (px/秒)"},
    {"key": "swayAmp", "type": "number", "min": 0, "max": 300, "step": 5,
     "default": 60, "label": "横揺れ振幅 (px)"},
    {"key": "swaySpeed", "type": "number", "min": 0, "max": 3, "step": 0.05,
     "default": 0.4, "label": "横揺れ速度"},
    {"key": "minAlpha", "type": "number", "min": 0.0, "max": 1.0, "step": 0.05,
     "default": 0.3, "label": "最小不透明度"},
    {"key": "maxAlpha", "type": "number", "min": 0.0, "max": 1.0, "step": 0.05,
     "default": 1.0, "label": "最大不透明度"},
    {"key": "twinkleSpeed", "type": "number", "min": 0.0, "max": 5.0, "step": 0.1,
     "default": 2.0, "label": "明滅速度"},
    {"key": "seed", "type": "number", "min": 0, "max": 9999, "step": 1,
     "default": 42, "label": "乱数シード"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 1.0, "label": "全体の不透明度"},
]

"""ネオン風に光る図形 (角丸四角 / 円 / 三角 / 星) が一定方向に流れる。

背景に水玉・格子・縦横ラインなどの固定模様を置けるオプション付き。音には反応せず
シーン秒の closed-form アニメーション。
"""
from __future__ import annotations

KEY = "glow_shapes"
NAME = "光る図形 (角丸四角 / 円 / 三角 / 星)"

GL_MODULE = "/static/js/visualizers/glow_shapes.js"
GL_VERSION = 1
GL_FRAME_RATE = 24

PARAMS = [
    # --- 形状と動き ---
    {"key": "shapes", "type": "select", "options": [
        {"value": "all", "label": "全種類ミックス"},
        {"value": "square", "label": "四角のみ"},
        {"value": "circle", "label": "円のみ"},
        {"value": "triangle", "label": "三角のみ"},
        {"value": "star", "label": "星のみ"},
    ], "default": "all", "label": "形状"},
    {"key": "direction", "type": "number", "min": 0, "max": 360, "step": 5,
     "default": 65, "label": "進行方向 (度 / 0=右, 90=下, 180=左, 270=上)"},
    {"key": "baseSpeed", "type": "number", "min": 5, "max": 500, "step": 5,
     "default": 70, "label": "基本速度 (px/秒)"},
    {"key": "speedJitter", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.4, "label": "速度のばらつき"},
    {"key": "count", "type": "number", "min": 1, "max": 200, "step": 1,
     "default": 28, "label": "パーティクル数"},
    {"key": "minSize", "type": "number", "min": 10, "max": 300, "step": 5,
     "default": 40, "label": "最小サイズ (px)"},
    {"key": "maxSize", "type": "number", "min": 20, "max": 500, "step": 5,
     "default": 140, "label": "最大サイズ (px)"},
    # --- 色とネオン ---
    {"key": "color1", "type": "color", "default": "#ffe66d", "label": "色1"},
    {"key": "color2", "type": "color", "default": "#ff5dcd", "label": "色2"},
    {"key": "color3", "type": "color", "default": "#5ab7ff", "label": "色3"},
    {"key": "color4", "type": "color", "default": "#7cf4a2", "label": "色4"},
    {"key": "lineWidthMin", "type": "number", "min": 0.01, "max": 0.4, "step": 0.01,
     "default": 0.05, "label": "輪郭の最小太さ"},
    {"key": "lineWidthMax", "type": "number", "min": 0.01, "max": 0.5, "step": 0.01,
     "default": 0.14, "label": "輪郭の最大太さ"},
    {"key": "glowSoftness", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.55, "label": "光のソフトさ"},
    {"key": "rotationSpeed", "type": "number", "min": -180, "max": 180, "step": 5,
     "default": 0, "label": "回転速度 (度/秒)"},
    {"key": "twinkleSpeed", "type": "number", "min": 0, "max": 3, "step": 0.1,
     "default": 0.6, "label": "明滅速度"},
    {"key": "minAlpha", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.85, "label": "最小不透明度"},
    {"key": "maxAlpha", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 1.0, "label": "最大不透明度"},
    {"key": "seed", "type": "number", "min": 0, "max": 9999, "step": 1,
     "default": 11, "label": "乱数シード"},
    # --- 背景模様 ---
    {"key": "bgPattern", "type": "select", "options": [
        {"value": "none", "label": "なし (透過)"},
        {"value": "dots", "label": "水玉"},
        {"value": "grid", "label": "格子"},
        {"value": "horizontal", "label": "横線"},
        {"value": "vertical", "label": "縦線"},
    ], "default": "none", "label": "背景模様"},
    {"key": "bgColor", "type": "color", "default": "#1a1740", "label": "背景の地色"},
    {"key": "bgColorOpacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0, "label": "地色の不透明度"},
    {"key": "patternColor", "type": "color", "default": "#5fa9ff", "label": "模様の色"},
    {"key": "patternOpacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.7, "label": "模様の不透明度"},
    {"key": "patternSize", "type": "number", "min": 1, "max": 60, "step": 1,
     "default": 4, "label": "模様の太さ・直径 (px)"},
    {"key": "patternSpacing", "type": "number", "min": 8, "max": 300, "step": 2,
     "default": 28, "label": "模様の間隔 (px)"},
    # --- 全体 ---
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 1.0, "label": "全体の不透明度"},
]

"""LED スクリーンを拡大したような光るグリッド・ビジュアライザ。

シーン秒だけで決まる closed-form のシェーダ実装。BPM はシーンの「基本」タブで
設定した値を使い、プラグインの `bpm` パラメータで上書き可能 (0 = シーン値)。
"""
from __future__ import annotations

KEY = "led_grid"
NAME = "LED グリッド"

GL_MODULE = "/static/js/visualizers/led_grid.js"
GL_VERSION = 1
GL_FRAME_RATE = 30

PARAMS = [
    {"key": "color1", "type": "color", "default": "#3a8dff", "label": "色1"},
    {"key": "color2", "type": "color", "default": "#a83cff", "label": "色2"},
    {"key": "color3", "type": "color", "default": "#ff3cd6", "label": "色3"},
    {"key": "gridCols", "type": "number", "min": 4, "max": 80, "step": 1,
     "default": 28, "label": "横セル数"},
    {"key": "gridRows", "type": "number", "min": 3, "max": 50, "step": 1,
     "default": 16, "label": "縦セル数"},
    {"key": "cellGap", "type": "number", "min": 0, "max": 0.9, "step": 0.05,
     "default": 0.45, "label": "セル間隔比"},
    {"key": "cornerRadius", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.2, "label": "角丸 (0=正方形 / 1=円)"},
    {"key": "blur", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.6, "label": "ボケ量"},
    {"key": "bpm", "type": "number", "min": 0, "max": 300, "step": 1,
     "default": 0, "label": "BPM (0=シーン値)"},
    {"key": "subdivision", "type": "select", "options": [
        {"value": "1", "label": "1拍 (♩)"},
        {"value": "2", "label": "8分音符 (♪)"},
        {"value": "4", "label": "16分音符"},
    ], "default": "2", "label": "ビート分割"},
    {"key": "litRatio", "type": "number", "min": 0.05, "max": 1.0, "step": 0.05,
     "default": 0.45, "label": "点灯セル率"},
    {"key": "onAlpha", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.9, "label": "点灯不透明度"},
    {"key": "offAlpha", "type": "number", "min": 0, "max": 0.3, "step": 0.01,
     "default": 0.05, "label": "消灯不透明度"},
    {"key": "decay", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.5, "label": "拍内減衰 (0=維持 / 1=瞬時)"},
    {"key": "seed", "type": "number", "min": 0, "max": 9999, "step": 1,
     "default": 5, "label": "乱数シード"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 1.0, "label": "全体の不透明度"},
]

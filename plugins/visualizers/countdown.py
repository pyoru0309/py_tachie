"""カウントダウン。

シーン全体の残時間 (browser 側で計算) を MM:SS / SS / MM:SS.FF 等で表示。
ブラウザの canvas2D で必要な秒境界 (整数秒変化時) のみ再描画する GL plugin。
"""
from __future__ import annotations

KEY = "countdown"
NAME = "カウントダウン"

# GL plugin (browser only). countdown は audio 解析が不要なので
# gl_data_streams は未定義 (= server から binary stream を ship しない)。
GL_MODULE = "/static/js/visualizers/countdown.js"
GL_VERSION = 1

PARAMS = [
    {"key": "format", "type": "select", "options": [
        {"value": "MM:SS", "label": "MM:SS (例 00:08)"},
        {"value": "M:SS", "label": "M:SS (例 0:08)"},
        {"value": "SS", "label": "SS (例 08)"},
        {"value": "MM:SS.FF", "label": "MM:SS.FF (フレーム付)"},
    ], "default": "MM:SS", "label": "表示形式"},
    {"key": "fontSize", "type": "number", "min": 40, "max": 600, "step": 10, "default": 220, "label": "文字サイズ (px)"},
    {"key": "color", "type": "color", "default": "#ffffff", "label": "色"},
    {"key": "outlineColor", "type": "color", "default": "#000000", "label": "アウトライン色"},
    {"key": "outlineWidth", "type": "number", "min": 0, "max": 32, "step": 1, "default": 6, "label": "アウトライン (px)"},
    {"key": "x", "type": "number", "min": 0, "max": 1920, "step": 10, "default": 960, "label": "中心 X"},
    {"key": "y", "type": "number", "min": 0, "max": 1080, "step": 10, "default": 540, "label": "中心 Y"},
    {"key": "prefixText", "type": "select", "options": [
        {"value": "", "label": "(なし)"},
        {"value": "活動限界まで あと", "label": "活動限界まで あと"},
        {"value": "残り", "label": "残り"},
        {"value": "あと", "label": "あと"},
    ], "default": "", "label": "前置テキスト"},
    {"key": "suffixText", "type": "select", "options": [
        {"value": "", "label": "(なし)"},
        {"value": "秒", "label": "秒"},
        {"value": "min", "label": "min"},
        {"value": "STOP", "label": "STOP"},
    ], "default": "", "label": "後置テキスト"},
    {"key": "subTextSize", "type": "number", "min": 20, "max": 200, "step": 5, "default": 56, "label": "前後テキストサイズ (px)"},
    # type=font / font_weight は UI 側 (dialog.js) で manifest.config.fonts /
    # fontWeights から自動生成される。空文字 "" がプロジェクト既定。
    {"key": "fontFamily", "type": "font", "default": "", "label": "書体"},
    {"key": "fontWeight", "type": "font_weight", "default": "bold", "label": "太さ"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 1.0, "label": "不透明度"},
    {"key": "freezeAtZero", "type": "select", "options": [
        {"value": "true", "label": "0 で停止"},
        {"value": "false", "label": "マイナスも表示"},
    ], "default": "true", "label": "0 到達時の挙動"},
]

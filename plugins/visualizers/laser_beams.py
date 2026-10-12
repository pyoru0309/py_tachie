"""ライブステージのレーザー光線 (GL-only、音には反応しない)。

光源の位置は設定値から動かず、各光源から扇形にビームが出る。光源は 2 列まで置ける
(例: 上に 4 つ + 下の両端に 2 つ)。扇の向き・開き・明るさを
シーン秒と BPM から決める closed-form アニメーションなので、シーク / 書き出しでも同じ
フレームになる。数拍ごと (フレーズ) に動きのパターン (左右に振る / 交差 / 開閉 / 束で
走査 / ゆらぎ) と描き方 (細いビーム / ぼんやり広がる面) を乱数シードで切り替える。

BPM はシーンの「基本」タブの値を使い、`bpm` パラメータで上書きできる (0 = シーン値)。
"""
from __future__ import annotations

KEY = "laser_beams"
NAME = "レーザー光線"

GL_MODULE = "/static/js/visualizers/laser_beams.js"
GL_VERSION = 1
GL_FRAME_RATE = 24

PARAMS = [
    # --- 光源 ---
    {"key": "sourceCount", "type": "number", "min": 1, "max": 8, "step": 1,
     "default": 4, "label": "光源の数"},
    {"key": "sourceY", "type": "number", "min": -200, "max": 1280, "step": 10,
     "default": 140, "label": "光源の高さ Y (px)"},
    {"key": "sourceXStart", "type": "number", "min": -400, "max": 2320, "step": 10,
     "default": 260, "label": "光源の左端 X (px)"},
    {"key": "sourceXEnd", "type": "number", "min": -400, "max": 2320, "step": 10,
     "default": 1660, "label": "光源の右端 X (px)"},
    {"key": "direction", "type": "number", "min": 0, "max": 360, "step": 5,
     "default": 90, "label": "ビームの向き (度 / 90=下, 270=上, 0=右)"},
    {"key": "aimSpread", "type": "number", "min": -120, "max": 120, "step": 5,
     "default": 0, "label": "光源ごとの向きの開き (度 / +で外向き, −で内向き=交差)"},
    # --- 光源 (2 列目。例: 上に 4 つ + 下の両端に 2 つ) ---
    {"key": "row2Count", "type": "number", "min": 0, "max": 8, "step": 1,
     "default": 0, "label": "2 列目の光源の数 (0 = 使わない)"},
    {"key": "row2Y", "type": "number", "min": -200, "max": 1280, "step": 10,
     "default": 1000, "label": "2 列目の高さ Y (px)"},
    {"key": "row2XStart", "type": "number", "min": -400, "max": 2320, "step": 10,
     "default": 120, "label": "2 列目の左端 X (px)"},
    {"key": "row2XEnd", "type": "number", "min": -400, "max": 2320, "step": 10,
     "default": 1800, "label": "2 列目の右端 X (px)"},
    {"key": "row2Direction", "type": "number", "min": 0, "max": 360, "step": 5,
     "default": 270, "label": "2 列目のビームの向き (度 / 270=上)"},
    {"key": "row2AimSpread", "type": "number", "min": -120, "max": 120, "step": 5,
     "default": -40, "label": "2 列目の向きの開き (度 / −で内向き)"},
    # --- ビーム ---
    {"key": "beamCount", "type": "number", "min": 1, "max": 48, "step": 1,
     "default": 12, "label": "1 光源あたりのビーム数"},
    {"key": "spread", "type": "number", "min": 0, "max": 170, "step": 5,
     "default": 50, "label": "扇の開き (度)"},
    {"key": "beamWidth", "type": "number", "min": 0.5, "max": 20, "step": 0.5,
     "default": 2.5, "label": "ビームの太さ (px)"},
    {"key": "divergence", "type": "number", "min": 0, "max": 0.05, "step": 0.001,
     "default": 0.006, "label": "遠くで太くなる度合い"},
    {"key": "glow", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.5, "label": "にじみ (グロー)"},
    {"key": "beamLength", "type": "number", "min": 200, "max": 4000, "step": 50,
     "default": 1500, "label": "届く距離 (px / 遠くほど薄く)"},
    {"key": "style", "type": "select", "options": [
        {"value": "mix", "label": "切り替え (細いビーム / ぼんやり広がる面)"},
        {"value": "beams", "label": "細いビームのみ"},
        {"value": "sheet", "label": "ぼんやり広がる面のみ"},
    ], "default": "mix", "label": "描き方"},
    {"key": "sheetRatio", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.35, "label": "面になる割合 (切り替え時)"},
    # --- 動き ---
    {"key": "motion", "type": "select", "options": [
        {"value": "auto", "label": "おまかせ (フレーズごとにランダムに切替)"},
        {"value": "sweep", "label": "そろって左右に振る"},
        {"value": "cross", "label": "交互に振って交差"},
        {"value": "breathe", "label": "扇が開いたり閉じたり"},
        {"value": "scan", "label": "細い束で走査"},
        {"value": "drift", "label": "ゆらゆら (不規則)"},
        {"value": "still", "label": "動かない"},
    ], "default": "auto", "label": "動きのパターン"},
    {"key": "swing", "type": "number", "min": 0, "max": 90, "step": 1,
     "default": 25, "label": "振れ幅 (度)"},
    {"key": "speed", "type": "number", "min": 0.1, "max": 4, "step": 0.1,
     "default": 1, "label": "動きの速さ (倍)"},
    {"key": "bpm", "type": "number", "min": 0, "max": 300, "step": 1,
     "default": 0, "label": "BPM (0=シーン値)"},
    {"key": "phraseBeats", "type": "select", "options": [
        {"value": "4", "label": "4 拍ごと"},
        {"value": "8", "label": "8 拍ごと"},
        {"value": "16", "label": "16 拍ごと"},
        {"value": "32", "label": "32 拍ごと"},
    ], "default": "8", "label": "パターンを切り替える間隔"},
    {"key": "beatPulse", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.3, "label": "拍で明るく光る強さ"},
    # --- 色 ---
    {"key": "color1", "type": "color", "default": "#2f6bff", "label": "色1"},
    {"key": "color2", "type": "color", "default": "#22e07a", "label": "色2"},
    {"key": "color3", "type": "color", "default": "#8a3cff", "label": "色3"},
    {"key": "colorMode", "type": "select", "options": [
        {"value": "source", "label": "光源ごとに色を分ける"},
        {"value": "phrase", "label": "全部同じ色でフレーズごとに切替"},
        {"value": "rotate", "label": "光源ごとの色をフレーズごとに回す"},
    ], "default": "source", "label": "色の付け方"},
    # --- 空気感 ---
    {"key": "haze", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.4, "label": "スモークのむら"},
    {"key": "hotspot", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.6, "label": "光源の輝き"},
    {"key": "intensity", "type": "number", "min": 0.1, "max": 3, "step": 0.05,
     "default": 1, "label": "明るさ"},
    {"key": "blend", "type": "select", "options": [
        {"value": "add", "label": "加算 (光らしく重なる)"},
        {"value": "normal", "label": "通常"},
    ], "default": "add", "label": "重ね方"},
    {"key": "seed", "type": "number", "min": 0, "max": 9999, "step": 1,
     "default": 7, "label": "乱数シード"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 1.0, "label": "全体の不透明度"},
]

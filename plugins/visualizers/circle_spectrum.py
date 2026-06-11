"""サークルスペクトログラム。

中心 (centerX, centerY) を基準に、円周上に等間隔でスペクトルバンドのバーを
外向き (または両側) に伸ばす。dB → バー長は browser 側 (``dbFloor / dbCeil``) で正規化。

GL plugin: サーバ側で per-frame の生 dB スペクトル (FFT 後 log ビン化したもの) を
Float32 binary stream として書き出し、ブラウザの canvas2d で円周バーを描画する。
"""
from __future__ import annotations

import numpy as np

KEY = "circle_spectrum"
NAME = "サークルスペクトログラム"

GL_MODULE = "/static/js/visualizers/circle_spectrum.js"
GL_VERSION = 1

# 解析に影響するのは FFT 系のみ。dbFloor/dbCeil はブラウザ側正規化なので含めない。
ANALYSIS_KEYS = ["bands", "fmin", "fmax", "windowMs"]

PARAMS = [
    {"key": "color", "type": "color", "default": "#ffffff", "label": "色"},
    {"key": "centerX", "type": "number", "min": 0, "max": 1920, "step": 10, "default": 960, "label": "中心 X"},
    {"key": "centerY", "type": "number", "min": 0, "max": 1080, "step": 10, "default": 540, "label": "中心 Y"},
    {"key": "innerRadius", "type": "number", "min": 0, "max": 800, "step": 10, "default": 220, "label": "内側半径 (px)"},
    {"key": "barLength", "type": "number", "min": 10, "max": 800, "step": 10, "default": 180, "label": "最大バー長 (px)"},
    {"key": "lineWidth", "type": "number", "min": 1, "max": 32, "step": 1, "default": 4, "label": "線の太さ (px)"},
    {"key": "bands", "type": "number", "min": 16, "max": 256, "step": 1, "default": 96, "label": "バンド数"},
    {"key": "fmin", "type": "number", "min": 20, "max": 2000, "step": 10, "default": 60, "label": "下限 Hz"},
    {"key": "fmax", "type": "number", "min": 1000, "max": 22000, "step": 100, "default": 12000, "label": "上限 Hz"},
    {"key": "windowMs", "type": "number", "min": 10, "max": 200, "step": 5, "default": 50, "label": "FFT 窓 (ms)"},
    {"key": "dbFloor", "type": "number", "min": -120, "max": -10, "step": 1, "default": -75, "label": "下限 dB"},
    {"key": "dbCeil", "type": "number", "min": -60, "max": 0, "step": 1, "default": -20, "label": "上限 dB"},
    {"key": "rotateDeg", "type": "number", "min": -360, "max": 360, "step": 1, "default": -90, "label": "回転 (°)"},
    {"key": "mirror", "type": "select", "options": [
        {"value": "outer", "label": "外側のみ"},
        {"value": "both", "label": "内外両側"},
    ], "default": "outer", "label": "向き"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.95, "label": "不透明度"},
]


def gl_data_streams(params, audio, time_grid_sec, fps):
    """GL 経路向け per-frame スペクトル (dB) を返す。

    各フレーム (time_grid_sec[i]) を右端とする windowMs 長の窓に Hann + rfft を
    かけ、log ビン化した dB スペクトル (`AudioContext.spectrum_db` と同じ式)
    を ``spectrum`` ストリームとして書き出す。dbFloor / dbCeil の正規化は
    ブラウザ側で実施 (UI で値を動かしたときも再ベイクされて反映される)。

    返却 shape:
      ``spectrum`` -> ``(N_frames, bands)``  float32 dBFS (おおむね -120..0)
    """
    grid = np.asarray(time_grid_sec, dtype=np.float64)
    n_frames = int(grid.size)
    try:
        bands = max(8, int(params.get("bands", 96)))
    except (TypeError, ValueError):
        bands = 96
    if audio is None or n_frames <= 0:
        return {"spectrum": np.full((max(0, n_frames), bands), -120.0, dtype=np.float32)}

    try:
        window_sec = max(0.010, float(params.get("windowMs") or 50) / 1000.0)
    except (TypeError, ValueError):
        window_sec = 0.050
    try:
        fmin = max(1.0, float(params.get("fmin") or 60))
        fmax = max(fmin + 1.0, float(params.get("fmax") or 12000))
    except (TypeError, ValueError):
        fmin, fmax = 60.0, 12000.0

    out = audio.batch_spectrum_db(
        grid,
        n_bands=bands,
        window_sec=window_sec,
        fmin=fmin,
        fmax=fmax,
    )
    return {"spectrum": out}

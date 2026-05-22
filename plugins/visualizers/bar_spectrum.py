"""Bar style spectrum visualizer (GL-only)."""
from __future__ import annotations

import numpy as np

KEY = "bar_spectrum"
NAME = "バー・スペクトラム"

GL_MODULE = "/static/js/visualizers/bar_spectrum.js"
GL_VERSION = 1
GL_FRAME_RATE = 24

PARAMS = [
    {"key": "color", "type": "color", "default": "#ffffff", "label": "色"},
    {"key": "barCount", "type": "number", "min": 16, "max": 240, "step": 1, "default": 96, "label": "バー数"},
    {"key": "x", "type": "number", "min": 0, "max": 1920, "step": 10, "default": 50, "label": "左 X"},
    {"key": "y", "type": "number", "min": 0, "max": 1080, "step": 10, "default": 1080, "label": "基準 Y"},
    {"key": "width", "type": "number", "min": 100, "max": 1920, "step": 10, "default": 1820, "label": "幅 (px)"},
    {"key": "height", "type": "number", "min": 20, "max": 900, "step": 10, "default": 200, "label": "最大高さ (px)"},
    {"key": "barGap", "type": "number", "min": 0, "max": 0.95, "step": 0.05, "default": 0.7, "label": "バー間隔"},
    {"key": "minHeight", "type": "number", "min": 0, "max": 80, "step": 1, "default": 3, "label": "最小高さ (px)"},
    {"key": "mode", "type": "select", "options": [
        {"value": "bottom", "label": "下揃え"},
        {"value": "top", "label": "上揃え"},
        {"value": "mirror", "label": "中央揃え"},
    ], "default": "bottom", "label": "配置"},
    {"key": "fmin", "type": "number", "min": 20, "max": 2000, "step": 10, "default": 100, "label": "下限 Hz"},
    {"key": "fmax", "type": "number", "min": 1000, "max": 22000, "step": 100, "default": 2000, "label": "上限 Hz"},
    {"key": "windowMs", "type": "number", "min": 10, "max": 200, "step": 5, "default": 55, "label": "FFT 窓 (ms)"},
    {"key": "dbFloor", "type": "number", "min": -120, "max": -10, "step": 1, "default": -78, "label": "下限 dB"},
    {"key": "dbCeil", "type": "number", "min": -60, "max": 0, "step": 1, "default": -18, "label": "上限 dB"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 1.0, "label": "不透明度"},
]


def _num(value, fallback: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    return n if np.isfinite(n) else fallback


def _quantize_int8(arr: np.ndarray) -> dict:
    arr = np.clip(arr, 0.0, 1.0).astype(np.float32)
    return {
        "data": np.round(arr * 127.0).astype(np.int8),
        "dtype": "int8",
        "scale": 1.0 / 127.0,
        "offset": 0.0,
    }


def gl_data_streams(params, audio, time_grid_sec, fps):
    p = params or {}
    grid = np.asarray(time_grid_sec, dtype=np.float64)
    n_frames = int(grid.size)
    bars = max(1, min(240, int(round(_num(p.get("barCount"), 96)))))
    out = np.zeros((max(0, n_frames), bars), dtype=np.float32)
    if audio is None or n_frames <= 0:
        return {"spectrum": _quantize_int8(out)}

    fmin = max(1.0, _num(p.get("fmin"), 45.0))
    fmax = max(fmin + 1.0, _num(p.get("fmax"), 16000.0))
    window_sec = max(0.010, _num(p.get("windowMs"), 55.0) / 1000.0)
    db_floor = _num(p.get("dbFloor"), -78.0)
    db_ceil = _num(p.get("dbCeil"), -18.0)
    for i, t in enumerate(grid):
        out[i] = audio.normalized_spectrum(
            float(t),
            n_bands=bars,
            window_sec=window_sec,
            fmin=fmin,
            fmax=fmax,
            db_floor=db_floor,
            db_ceil=db_ceil,
        )
    return {"spectrum": _quantize_int8(out)}

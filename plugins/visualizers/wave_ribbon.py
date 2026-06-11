"""Large soft wave ribbon visualizer (GL-only)."""
from __future__ import annotations

import numpy as np

KEY = "wave_ribbon"
NAME = "ウェーブ・リボン"

GL_MODULE = "/static/js/visualizers/wave_ribbon.js"
GL_VERSION = 1
GL_FRAME_RATE = 24

# gl_data_streams の出力に影響するパラメータのみ (残りは描画専用)。
ANALYSIS_KEYS = ["fmin", "fmax", "windowMs", "dbFloor", "dbCeil"]

PARAMS = [
    {"key": "color", "type": "color", "default": "#8ffcff", "label": "色"},
    {"key": "accentColor", "type": "color", "default": "#a970ff", "label": "アクセント色"},
    {"key": "x", "type": "number", "min": -960, "max": 1920, "step": 10, "default": -120, "label": "開始 X"},
    {"key": "width", "type": "number", "min": 100, "max": 3000, "step": 10, "default": 2160, "label": "幅 (px)"},
    {"key": "centerY", "type": "number", "min": 0, "max": 1080, "step": 10, "default": 540, "label": "中心 Y"},
    {"key": "amplitude", "type": "number", "min": 0, "max": 520, "step": 10, "default": 210, "label": "振幅 (px)"},
    {"key": "thickness", "type": "number", "min": 4, "max": 220, "step": 2, "default": 64, "label": "太さ (px)"},
    {"key": "strandCount", "type": "number", "min": 1, "max": 4, "step": 1, "default": 3, "label": "リボン数"},
    {"key": "frequency", "type": "number", "min": 0.2, "max": 4, "step": 0.1, "default": 1.35, "label": "波数"},
    {"key": "speed", "type": "number", "min": 0, "max": 5, "step": 0.1, "default": 1.15, "label": "速度"},
    {"key": "reactivity", "type": "number", "min": 0, "max": 2.5, "step": 0.1, "default": 1.2, "label": "音反応"},
    {"key": "fmin", "type": "number", "min": 20, "max": 2000, "step": 10, "default": 40, "label": "下限 Hz"},
    {"key": "fmax", "type": "number", "min": 1000, "max": 22000, "step": 100, "default": 12000, "label": "上限 Hz"},
    {"key": "windowMs", "type": "number", "min": 10, "max": 220, "step": 5, "default": 70, "label": "FFT 窓 (ms)"},
    {"key": "dbFloor", "type": "number", "min": -120, "max": -10, "step": 1, "default": -82, "label": "下限 dB"},
    {"key": "dbCeil", "type": "number", "min": -60, "max": 0, "step": 1, "default": -19, "label": "上限 dB"},
    {"key": "glow", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.72, "label": "グロー"},
    {"key": "softness", "type": "number", "min": 0.45, "max": 3, "step": 0.05, "default": 0.85, "label": "柔らかさ"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.82, "label": "不透明度"},
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
    energy = np.zeros((max(0, n_frames), 4), dtype=np.float32)
    onset = np.zeros((max(0, n_frames),), dtype=np.float32)
    if audio is None or n_frames <= 0:
        return {"energy": _quantize_int8(energy), "onset": _quantize_int8(onset)}

    fmin = max(1.0, _num(p.get("fmin"), 40.0))
    fmax = max(fmin + 1.0, _num(p.get("fmax"), 12000.0))
    window_sec = max(0.010, _num(p.get("windowMs"), 70.0) / 1000.0)
    db_floor = _num(p.get("dbFloor"), -82.0)
    db_ceil = _num(p.get("dbCeil"), -19.0)
    energy = audio.batch_energy_bands(
        grid,
        n_subbands=4,
        analysis_bands=32,
        window_sec=window_sec,
        fmin=fmin,
        fmax=fmax,
        db_floor=db_floor,
        db_ceil=db_ceil,
    )
    onset = audio.onset_envelope(grid, window_sec=window_sec, fmin=fmin, fmax=fmax)
    return {"energy": _quantize_int8(energy), "onset": _quantize_int8(onset)}

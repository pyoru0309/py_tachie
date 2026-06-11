"""Linear geometric particle visualizer (GL-only)."""
from __future__ import annotations

import numpy as np

KEY = "geometric_particles"
NAME = "ジオメトリック・パーティクル"

GL_MODULE = "/static/js/visualizers/geometric_particles.js"
GL_VERSION = 1
GL_FRAME_RATE = 24

# gl_data_streams の出力に影響するパラメータのみ。色・座標・粒子数などは
# ブラウザ側描画パラメータなので解析キャッシュを無効化しない。
ANALYSIS_KEYS = ["bands", "fmin", "fmax", "windowMs", "dbFloor", "dbCeil"]

PARAMS = [
    {"key": "color", "type": "color", "default": "#7cf7ff", "label": "色"},
    {"key": "accentColor", "type": "color", "default": "#ffe66d", "label": "アクセント色"},
    {"key": "particleCount", "type": "number", "min": 24, "max": 240, "step": 1, "default": 112, "label": "粒子数"},
    {"key": "bands", "type": "number", "min": 8, "max": 64, "step": 1, "default": 32, "label": "解析バンド数"},
    {"key": "x", "type": "number", "min": 0, "max": 1920, "step": 10, "default": 160, "label": "左 X"},
    {"key": "y", "type": "number", "min": 0, "max": 1080, "step": 10, "default": 150, "label": "上 Y"},
    {"key": "width", "type": "number", "min": 100, "max": 1920, "step": 10, "default": 1600, "label": "幅 (px)"},
    {"key": "height", "type": "number", "min": 100, "max": 1080, "step": 10, "default": 720, "label": "高さ (px)"},
    {"key": "motion", "type": "number", "min": 0, "max": 420, "step": 10, "default": 190, "label": "動き (px)"},
    {"key": "pointSize", "type": "number", "min": 1, "max": 32, "step": 1, "default": 7, "label": "粒子サイズ"},
    {"key": "lineOpacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.42, "label": "線の濃さ"},
    {"key": "fmin", "type": "number", "min": 20, "max": 2000, "step": 10, "default": 55, "label": "下限 Hz"},
    {"key": "fmax", "type": "number", "min": 1000, "max": 22000, "step": 100, "default": 13500, "label": "上限 Hz"},
    {"key": "windowMs", "type": "number", "min": 10, "max": 200, "step": 5, "default": 60, "label": "FFT 窓 (ms)"},
    {"key": "dbFloor", "type": "number", "min": -120, "max": -10, "step": 1, "default": -80, "label": "下限 dB"},
    {"key": "dbCeil", "type": "number", "min": -60, "max": 0, "step": 1, "default": -20, "label": "上限 dB"},
    {"key": "glow", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.55, "label": "グロー"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.88, "label": "不透明度"},
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
    bands = max(8, min(96, int(round(_num(p.get("bands"), 32)))))
    spectrum = np.zeros((max(0, n_frames), bands), dtype=np.float32)
    energy = np.zeros((max(0, n_frames), 4), dtype=np.float32)
    onset = np.zeros((max(0, n_frames),), dtype=np.float32)
    if audio is None or n_frames <= 0:
        return {
            "spectrum": _quantize_int8(spectrum),
            "energy": _quantize_int8(energy),
            "onset": _quantize_int8(onset),
        }

    fmin = max(1.0, _num(p.get("fmin"), 55.0))
    fmax = max(fmin + 1.0, _num(p.get("fmax"), 13500.0))
    window_sec = max(0.010, _num(p.get("windowMs"), 60.0) / 1000.0)
    db_floor = _num(p.get("dbFloor"), -80.0)
    db_ceil = _num(p.get("dbCeil"), -20.0)
    spectrum = audio.batch_normalized_spectrum(
        grid,
        n_bands=bands,
        window_sec=window_sec,
        fmin=fmin,
        fmax=fmax,
        db_floor=db_floor,
        db_ceil=db_ceil,
    )
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
    return {
        "spectrum": _quantize_int8(spectrum),
        "energy": _quantize_int8(energy),
        "onset": _quantize_int8(onset),
    }

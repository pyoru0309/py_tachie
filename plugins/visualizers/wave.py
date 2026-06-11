"""オーディオ波形ビジュアライザ。

時刻 t を中心とした短い窓 (windowMs) の PCM サンプルを画面横幅に引き伸ばし、
中心 Y を基準に振幅 (px) スケールで折れ線を描く。

GL plugin: サーバ側で per-frame の正規化済み波形 (peak で割って [-1, 1]) を
Float32 binary stream として書き出し、ブラウザの canvas2d で折れ線を描画する。
"""
from __future__ import annotations

import numpy as np

KEY = "wave"
NAME = "オーディオ波形"

GL_MODULE = "/static/js/visualizers/wave.js"
GL_VERSION = 1
# スムージング後・peak 正規化後の波形を ship する横解像度。
# canvas 幅 1920 と等倍にしてもデータ量は 1920 * frames * 4 bytes (24fps × 10s ≈ 1.8MB)
# で許容範囲。ブラウザ側の折れ線 1 pixel 精度を保ちたいため等倍を採用。
GL_OUTPUT_WIDTH = 1920

# 解析 (PCM 窓 + スムージング + リサンプル) に影響するのはこの 2 つだけ。
# 色・線幅・振幅などはブラウザ側描画パラメータ。
ANALYSIS_KEYS = ["windowMs", "smoothing"]

PARAMS = [
    {"key": "color", "type": "color", "default": "#ffffff", "label": "色"},
    {"key": "lineWidth", "type": "number", "min": 1, "max": 32, "step": 1, "default": 4, "label": "線の太さ (px)"},
    {"key": "amplitude", "type": "number", "min": 50, "max": 1000, "step": 10, "default": 320, "label": "振幅 (px)"},
    {"key": "centerY", "type": "number", "min": 0, "max": 1080, "step": 10, "default": 540, "label": "中心 Y (px)"},
    {"key": "windowMs", "type": "number", "min": 10, "max": 500, "step": 10, "default": 80, "label": "波形窓 (ms)"},
    {"key": "smoothing", "type": "number", "min": 1, "max": 32, "step": 1, "default": 4, "label": "スムージング (隣接平均)"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.9, "label": "不透明度"},
]


def _smooth(samples: np.ndarray, k: int) -> np.ndarray:
    k = max(1, int(k))
    if k <= 1 or samples.size < 3:
        return samples
    kernel = np.ones(k, dtype=np.float32) / float(k)
    return np.convolve(samples, kernel, mode="same")


def gl_data_streams(params, audio, time_grid_sec, fps):
    """GL 経路向け per-frame 波形データを返す。

    各フレーム (time_grid_sec[i]) を右端とする windowMs 長の PCM 窓を取り、
    スムージング → 出力幅 (GL_OUTPUT_WIDTH) へリサンプル → peak 正規化を経て
    [-1, 1] の float32 を返す。peak が極端に小さい (≒無音) フレームは 0 で
    埋め、ブラウザ側で「線を描かない」を判定できるよう ``peak`` も同梱する。

    返却 shape:
      ``pcm``  -> ``(N_frames, GL_OUTPUT_WIDTH)``
      ``peak`` -> ``(N_frames,)``  (生 PCM 窓のピーク絶対値、無音判定用)
    """
    n_frames = int(np.asarray(time_grid_sec).size)
    w = int(GL_OUTPUT_WIDTH)
    # audio が無いとき: 空ストリームを返す → ブラウザ側は中央線フォールバック表示。
    if audio is None or n_frames <= 0:
        return {
            "pcm": np.zeros((max(0, n_frames), w), dtype=np.float32),
            "peak": np.zeros((max(0, n_frames),), dtype=np.float32),
        }

    try:
        window_sec = max(0.010, float(params.get("windowMs") or 80) / 1000.0)
    except (TypeError, ValueError):
        window_sec = 0.080
    try:
        smoothing = max(1, int(params.get("smoothing") or 1))
    except (TypeError, ValueError):
        smoothing = 1

    pcm_out = np.zeros((n_frames, w), dtype=np.float32)
    peak_out = np.zeros((n_frames,), dtype=np.float32)
    xp_target = np.linspace(0.0, 1.0, w, dtype=np.float32)
    for i, t in enumerate(time_grid_sec):
        win = audio.window(float(t), window_sec)
        if win.size < 2:
            continue
        if smoothing > 1:
            win = _smooth(win, smoothing)
        peak = float(np.max(np.abs(win)) + 1e-6)
        peak_out[i] = peak
        if peak <= 1e-4:
            continue
        if win.size != w:
            xp = np.linspace(0.0, 1.0, win.size, dtype=np.float32)
            resampled = np.interp(xp_target, xp, win.astype(np.float32))
        else:
            resampled = win.astype(np.float32)
        pcm_out[i] = (resampled / peak).astype(np.float32)
    return {"pcm": pcm_out, "peak": peak_out}

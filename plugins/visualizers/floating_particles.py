"""Floating Particles サンプルプラグイン。

`_kit.js` の使い方を示すための最小サンプル:

- N 個のパーティクルが緩やかにふわふわ移動 (シード固定で再現性あり)
- low (kick) で粒子サイズが拍動、high で輝度が点滅
- onset envelope の山で粒子全体が外側へ短く飛ぶ (= 打点に同期した「弾け」)

Python 側 ``render(ctx)`` は **書かない** (新規プラグインの最小例として、GL plugin
だけで成立することを示す)。

stream:
  ``energy`` : ``(N_frames, 4)``  int8 [-1, 127] スケール  = [full, lo, mid, hi] (0..1 量子化)
  ``onset``  : ``(N_frames,)``    int8                    = 0..1 自己正規化済み onset envelope

長尺 BGM でもサイズが破綻しないよう、int8 + scale ship を採用。
"""
from __future__ import annotations

import numpy as np

KEY = "floating_particles"
NAME = "ふわふわパーティクル (サンプル)"

GL_MODULE = "/static/js/visualizers/floating_particles.js"
GL_VERSION = 1
# 12fps で十分。音への反応は onset envelope で「弾け」を別 stream に持つので、
# 滑らかさよりキビキビ感のほうが合う。
GL_FRAME_RATE = 12

PARAMS = [
    {"key": "color", "type": "color", "default": "#9be7ff", "label": "色"},
    {"key": "accentColor", "type": "color", "default": "#ffd166", "label": "アクセント色"},
    {"key": "particleCount", "type": "number", "min": 8, "max": 240, "step": 1,
     "default": 80, "label": "粒子数"},
    {"key": "baseSize", "type": "number", "min": 2, "max": 60, "step": 1,
     "default": 14, "label": "基本サイズ (px)"},
    {"key": "drift", "type": "number", "min": 0, "max": 200, "step": 5,
     "default": 60, "label": "ふわふわ振幅 (px)"},
    {"key": "burst", "type": "number", "min": 0, "max": 400, "step": 10,
     "default": 140, "label": "打点で弾ける幅 (px)"},
    {"key": "reactivity", "type": "number", "min": 0, "max": 2.5, "step": 0.1,
     "default": 1.1, "label": "音反応"},
    {"key": "seed", "type": "number", "min": 0, "max": 9999, "step": 1,
     "default": 7, "label": "乱数シード"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05,
     "default": 0.85, "label": "不透明度"},
]


def _quantize_int8(arr: np.ndarray) -> dict:
    """0..1 の float32 配列を int8 (0..127) にスケールして ship する meta dict を返す。"""
    arr = np.clip(arr, 0.0, 1.0).astype(np.float32)
    quantized = np.round(arr * 127.0).astype(np.int8)
    return {
        "data": quantized,
        "dtype": "int8",
        "scale": 1.0 / 127.0,
        "offset": 0.0,
    }


def gl_data_streams(params, audio, time_grid_sec, fps):
    grid = np.asarray(time_grid_sec, dtype=np.float64)
    n = int(grid.size)
    if n <= 0:
        return {
            "energy": _quantize_int8(np.zeros((0, 4), dtype=np.float32)),
            "onset": _quantize_int8(np.zeros((0,), dtype=np.float32)),
        }
    if audio is None:
        # 音源なしでも空ストリームを ship (ブラウザ側はゼロを読んで静的にふわふわ)。
        return {
            "energy": _quantize_int8(np.zeros((n, 4), dtype=np.float32)),
            "onset": _quantize_int8(np.zeros((n,), dtype=np.float32)),
        }

    # 共通ヘルパでエネルギーとオンセットを取る。
    energy = np.empty((n, 4), dtype=np.float32)
    for i, t in enumerate(grid):
        energy[i] = audio.energy_bands(float(t), n_subbands=4)
    onset = audio.onset_envelope(grid)
    return {
        "energy": _quantize_int8(energy),
        "onset": _quantize_int8(onset),
    }

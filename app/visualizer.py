"""オーディオビジュアライザのプラグイン基盤 (GL 経路のみ)。

- ``plugins/visualizers/<key>.py`` を走査して NAME / PARAMS / GL_MODULE / gl_data_streams を取得。
- ``decode_audio_to_pcm`` が ffmpeg 経由で raw PCM (mono float32) を取得し、
  メモリキャッシュする。
- ``gl_data_streams(params, audio, time_grid_sec, fps)`` の戻り値を binary 化して
  ``cache/<project>/viz/<token>_<name>.bin`` に書き出し、ブラウザの GL plugin が消費する。
"""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .log_setup import app_logger

_log = app_logger("visualizer")

import numpy as np

from .paths import PROJECT_ROOT

PLUGIN_ROOT = PROJECT_ROOT / "plugins" / "visualizers"
DEFAULT_SAMPLE_RATE = 48000


# ---------------------------------------------------------------------------
# Audio context (gl_data_streams へ渡す)
# ---------------------------------------------------------------------------


@dataclass
class AudioContext:
    """ビジュアライザに渡す音声情報。

    pcm: モノミックされた float32 [-1, 1] の連続サンプル。``sample_rate`` Hz。
    プラグインは ``window`` / ``spectrum_db`` / ``amplitude_db`` を呼んで
    必要な情報を取り出す。
    """

    sample_rate: int
    pcm: np.ndarray

    def window(self, time_sec: float, length_sec: float = 0.05) -> np.ndarray:
        """time_sec を中心 (anchor 右端) とした窓を返す。長さが足りない場合は 0 埋め。"""
        if self.pcm.size == 0:
            return np.zeros(max(1, int(length_sec * self.sample_rate)), dtype=np.float32)
        n = max(1, int(round(length_sec * self.sample_rate)))
        # window の右端を time_sec に揃える (時刻 t での「直近 n サンプル」)
        end = int(round(time_sec * self.sample_rate))
        end = max(0, min(self.pcm.size, end))
        start = max(0, end - n)
        chunk = self.pcm[start:end]
        if chunk.size < n:
            pad = np.zeros(n - chunk.size, dtype=np.float32)
            chunk = np.concatenate([pad, chunk])
        return chunk

    def amplitude_db(self, time_sec: float, length_sec: float = 0.05) -> float:
        """RMS amplitude (dBFS, 0 = full scale)。無音は -120 を返す。"""
        win = self.window(time_sec, length_sec)
        rms = float(np.sqrt(np.mean(win.astype(np.float64) ** 2) + 1e-12))
        if rms <= 1e-6:
            return -120.0
        return float(20.0 * np.log10(rms))

    def spectrum_db(
        self,
        time_sec: float,
        n_bands: int = 64,
        window_sec: float = 0.05,
        fmin: float = 30.0,
        fmax: float = 14000.0,
    ) -> np.ndarray:
        """log-空間で n_bands に集約した magnitude スペクトル (dBFS)。``-120 .. 0`` 程度。"""
        win = self.window(time_sec, window_sec)
        if win.size < 2:
            return np.full(n_bands, -120.0, dtype=np.float32)
        # Hann 窓 + rfft
        hann = np.hanning(win.size).astype(np.float32)
        spec = np.fft.rfft(win * hann)
        mag = np.abs(spec).astype(np.float64)
        freqs = np.fft.rfftfreq(win.size, d=1.0 / self.sample_rate)
        # log 軸ビン化
        fmin = max(1.0, float(fmin))
        fmax = max(fmin + 1.0, float(fmax))
        edges = np.geomspace(fmin, fmax, n_bands + 1)
        out_lin = np.zeros(n_bands, dtype=np.float64)
        for i in range(n_bands):
            lo, hi = edges[i], edges[i + 1]
            mask = (freqs >= lo) & (freqs < hi)
            out_lin[i] = mag[mask].mean() if mask.any() else 0.0
        # 正規化: rfft の振幅は信号長に比例するので /N、Hann 窓のゲイン補正もかける。
        norm = max(1, win.size) * 0.5
        out_lin /= norm
        # log10 変換 (dB)。-120 で下限クリップ。
        out_db = 20.0 * np.log10(np.maximum(out_lin, 1e-6))
        return out_db.astype(np.float32)

    # ------------------------------------------------------------------
    # 共通解析ヘルパ (プラグインで再実装されがちな処理を 1 箇所に)
    # ------------------------------------------------------------------

    def normalized_spectrum(
        self,
        time_sec: float,
        n_bands: int = 64,
        window_sec: float = 0.05,
        fmin: float = 30.0,
        fmax: float = 14000.0,
        db_floor: float = -75.0,
        db_ceil: float = -20.0,
    ) -> np.ndarray:
        """``spectrum_db`` を ``db_floor..db_ceil`` で 0..1 にクランプ正規化したもの。

        多くのプラグインで「dB → (db_floor, db_ceil) で 0..1 に正規化 → バーの高さ」
        の流れを書いているので、それを 1 行で取れるようにしておく。
        """
        if db_ceil <= db_floor:
            db_ceil = db_floor + 1.0
        spec = self.spectrum_db(
            time_sec,
            n_bands=n_bands,
            window_sec=window_sec,
            fmin=fmin,
            fmax=fmax,
        )
        return np.clip((spec - db_floor) / (db_ceil - db_floor), 0.0, 1.0).astype(np.float32)

    def energy_bands(
        self,
        time_sec: float,
        n_subbands: int = 4,
        analysis_bands: int = 32,
        window_sec: float = 0.05,
        fmin: float = 40.0,
        fmax: float = 12000.0,
        db_floor: float = -80.0,
        db_ceil: float = -20.0,
    ) -> np.ndarray:
        """``[full, lo, mid, hi]`` (n_subbands=4 の場合) の正規化エネルギーを返す。

        wave_ribbon / geometric_particles で `_energy` として再実装されていたものを
        共通化。``n_subbands`` を 1 にすると ``[full]`` だけ返す。
        """
        n_subbands = max(1, int(n_subbands))
        norm = self.normalized_spectrum(
            time_sec,
            n_bands=max(n_subbands, analysis_bands),
            window_sec=window_sec,
            fmin=fmin,
            fmax=fmax,
            db_floor=db_floor,
            db_ceil=db_ceil,
        )
        out = np.empty(n_subbands, dtype=np.float32)
        # 0 番目は常に full mean。残り (n_subbands - 1) で帯域を等分。
        out[0] = float(norm.mean()) if norm.size else 0.0
        if n_subbands == 1:
            return out
        chunks = np.array_split(norm, n_subbands - 1)
        for i, ch in enumerate(chunks):
            out[i + 1] = float(ch.mean()) if ch.size else 0.0
        return out

    # ------------------------------------------------------------------
    # バッチ解析 API (2026-06-11)
    #
    # per-frame の ``spectrum_db`` 等を 24fps × 数千フレームで回すと、Python の
    # 関数呼び出し + per-band ループが律速して長尺 BGM で数十秒かかる。
    # 全フレームの窓を 1 つの行列に集めて rfft(axis=1) + 帯域集約行列の行列積で
    # 一括処理すると 10〜50 倍速くなる。プラグインの gl_data_streams からは
    # こちらを使うこと。数式は per-frame 版と同一 (Hann + rfft + log-bin 平均)。
    # ------------------------------------------------------------------

    def batch_spectrum_db(
        self,
        time_grid_sec: "np.ndarray | list[float]",
        n_bands: int = 64,
        window_sec: float = 0.05,
        fmin: float = 30.0,
        fmax: float = 14000.0,
    ) -> np.ndarray:
        """``spectrum_db`` の全フレーム一括版。``(N_frames, n_bands)`` float32 (dBFS)。"""
        grid = np.asarray(time_grid_sec, dtype=np.float64)
        nf = int(grid.size)
        n_bands = max(1, int(n_bands))
        out = np.full((max(0, nf), n_bands), -120.0, dtype=np.float32)
        n = max(1, int(round(window_sec * self.sample_rate)))
        if nf == 0 or self.pcm.size == 0 or n < 2:
            return out
        hann = np.hanning(n).astype(np.float32)
        freqs = np.fft.rfftfreq(n, d=1.0 / self.sample_rate)
        fmin = max(1.0, float(fmin))
        fmax = max(fmin + 1.0, float(fmax))
        edges = np.geomspace(fmin, fmax, n_bands + 1)
        # per-band の boolean mask + mean (spectrum_db) と等価な (n_bins, n_bands)
        # 平均化行列。bin が属する band を searchsorted で求め、1/count を立てる。
        band_idx = np.searchsorted(edges, freqs, side="right") - 1
        in_range = (
            (freqs >= edges[0]) & (freqs < edges[-1])
            & (band_idx >= 0) & (band_idx < n_bands)
        )
        counts = np.bincount(band_idx[in_range], minlength=n_bands).astype(np.float64)
        weights = np.zeros((freqs.size, n_bands), dtype=np.float64)
        rows = np.nonzero(in_range)[0]
        cols = band_idx[in_range]
        weights[rows, cols] = 1.0 / np.maximum(counts[cols], 1.0)
        # window() と同じ「右端 = time_sec」の窓を sliding_window_view で一括抽出。
        # 先頭に n 個の 0 を足しておくと padded[end : end+n] == 左 0 埋め窓 になる。
        ends = np.rint(grid * self.sample_rate).astype(np.int64)
        np.clip(ends, 0, self.pcm.size, out=ends)
        padded = np.concatenate([np.zeros(n, dtype=np.float32), self.pcm])
        view = np.lib.stride_tricks.sliding_window_view(padded, n)
        norm = float(n) * 0.5
        # 窓行列が巨大になり得る (frames × window samples) ので ~32MB に分割。
        chunk = max(16, int((8 << 20) / n))
        for s in range(0, nf, chunk):
            e = min(nf, s + chunk)
            wins = view[ends[s:e]] * hann
            mag = np.abs(np.fft.rfft(wins, axis=1)).astype(np.float64)
            out_lin = (mag @ weights) / norm
            out[s:e] = (20.0 * np.log10(np.maximum(out_lin, 1e-6))).astype(np.float32)
        return out

    def batch_normalized_spectrum(
        self,
        time_grid_sec: "np.ndarray | list[float]",
        n_bands: int = 64,
        window_sec: float = 0.05,
        fmin: float = 30.0,
        fmax: float = 14000.0,
        db_floor: float = -75.0,
        db_ceil: float = -20.0,
    ) -> np.ndarray:
        """``normalized_spectrum`` の全フレーム一括版。``(N_frames, n_bands)`` 0..1。"""
        if db_ceil <= db_floor:
            db_ceil = db_floor + 1.0
        spec = self.batch_spectrum_db(
            time_grid_sec,
            n_bands=n_bands,
            window_sec=window_sec,
            fmin=fmin,
            fmax=fmax,
        )
        return np.clip((spec - db_floor) / (db_ceil - db_floor), 0.0, 1.0).astype(np.float32)

    def batch_energy_bands(
        self,
        time_grid_sec: "np.ndarray | list[float]",
        n_subbands: int = 4,
        analysis_bands: int = 32,
        window_sec: float = 0.05,
        fmin: float = 40.0,
        fmax: float = 12000.0,
        db_floor: float = -80.0,
        db_ceil: float = -20.0,
    ) -> np.ndarray:
        """``energy_bands`` の全フレーム一括版。``(N_frames, n_subbands)``。"""
        n_subbands = max(1, int(n_subbands))
        norm = self.batch_normalized_spectrum(
            time_grid_sec,
            n_bands=max(n_subbands, analysis_bands),
            window_sec=window_sec,
            fmin=fmin,
            fmax=fmax,
            db_floor=db_floor,
            db_ceil=db_ceil,
        )
        out = np.zeros((norm.shape[0], n_subbands), dtype=np.float32)
        if norm.shape[1]:
            out[:, 0] = norm.mean(axis=1)
        if n_subbands == 1:
            return out
        chunks = np.array_split(norm, n_subbands - 1, axis=1)
        for i, ch in enumerate(chunks):
            if ch.shape[1]:
                out[:, i + 1] = ch.mean(axis=1)
        return out

    def onset_envelope(
        self,
        time_grid_sec: "np.ndarray | list[float]",
        window_sec: float = 0.04,
        fmin: float = 60.0,
        fmax: float = 12000.0,
    ) -> np.ndarray:
        """time_grid 各点でのスペクトル差分 (positive flux) を返す ``(N,)`` float32。

        値は **時間軸での自己正規化** 済み (= 0..1)。打点 / トランジェントに同期した
        パラメータ (粒子の bursts、リボンの太さ波 等) で使う。
        スペクトルは ``batch_spectrum_db`` で一括計算する (旧実装は per-frame FFT を
        グリッド全長分回していて長尺 BGM の主要ボトルネックだった)。
        """
        grid = np.asarray(time_grid_sec, dtype=np.float64)
        n = int(grid.size)
        if n <= 0 or self.pcm.size == 0:
            return np.zeros(max(0, n), dtype=np.float32)
        spec = self.batch_spectrum_db(
            grid,
            n_bands=64,
            window_sec=window_sec,
            fmin=fmin,
            fmax=fmax,
        )
        flux = np.zeros(n, dtype=np.float32)
        if n >= 2:
            diff = np.maximum(spec[1:] - spec[:-1], 0.0)
            flux[1:] = diff.mean(axis=1)
        # 自己正規化 (相対値で十分なため)
        peak = float(flux.max())
        if peak > 1e-6:
            flux /= peak
        return flux.astype(np.float32)

    def beat_grid(
        self,
        time_grid_sec: "np.ndarray | list[float]",
        window_sec: float = 0.04,
        fmin: float = 60.0,
        fmax: float = 12000.0,
        threshold: float = 0.55,
        min_interval_sec: float = 0.18,
    ) -> np.ndarray:
        """``onset_envelope`` から peak picking で beat フラグ ``(N,)`` を返す (0/1 float32)。

        簡易テンポ推定: ``threshold`` を超えたピークだけ採用、直前 beat から
        ``min_interval_sec`` 経過していれば許容する。"""
        env = self.onset_envelope(
            time_grid_sec,
            window_sec=window_sec,
            fmin=fmin,
            fmax=fmax,
        )
        n = env.size
        out = np.zeros(n, dtype=np.float32)
        if n < 2:
            return out
        last_t = -1.0
        grid = np.asarray(time_grid_sec, dtype=np.float64)
        for i in range(1, n - 1):
            v = env[i]
            if v < threshold:
                continue
            if v < env[i - 1] or v < env[i + 1]:
                continue
            t = float(grid[i])
            if last_t >= 0 and (t - last_t) < min_interval_sec:
                continue
            out[i] = 1.0
            last_t = t
        return out


# ---------------------------------------------------------------------------
# Plugin discovery
# ---------------------------------------------------------------------------


@dataclass
class PluginInfo:
    key: str
    name: str
    params: list[dict[str, Any]]
    # GL plugin: ``/static/js/visualizers/<name>.js`` のような URL。
    # ブラウザ側がこの module を読み込んで自前で描画する。
    gl_module: str
    gl_version: int = 1
    # plugin が任意で実装する解析関数: `(params, audio, time_grid_sec, fps) -> dict[name, ndarray|dict]`。
    # 未定義 (None) なら audio 不要 plugin (countdown など) として扱う。
    gl_data_streams: Callable[..., dict[str, np.ndarray]] | None = None
    # plugin が宣言する更新粒度。サーバ側の time_grid を `1 / gl_frame_rate` で
    # 構築する (None なら project の characterAnimationFps をそのまま使う)。
    gl_frame_rate: int | None = None
    # 解析結果 (gl_data_streams の出力) に影響するパラメータ key の宣言。
    # 解析キャッシュのトークンはこの subset だけを見るため、色や座標のような
    # 描画専用パラメータの変更では再解析が走らない。None (未宣言) なら安全側に
    # 倒して全パラメータをトークンに含める。空リストは「解析はパラメータ非依存」。
    analysis_keys: list[str] | None = None
    # plugin ソースファイルの mtime_ns。解析コード自体の変更でキャッシュを
    # 無効化するためにトークンへ混ぜる。
    source_mtime_ns: int = 0


_DISCOVER_LOCK = threading.Lock()
_DISCOVER_CACHE: dict[str, PluginInfo] | None = None


def _normalize_param_spec(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    key = str(raw.get("key") or "").strip()
    if not key:
        return None
    spec: dict[str, Any] = {
        "key": key,
        "type": str(raw.get("type") or "number"),
        "label": str(raw.get("label") or key),
        "default": raw.get("default"),
    }
    for opt in ("min", "max", "step", "options", "placeholder", "hint"):
        if opt in raw:
            spec[opt] = raw[opt]
    return spec


def _load_plugin_module(path: Path):
    spec = importlib.util.spec_from_file_location(
        f"splite_visualizer.{path.stem}", str(path)
    )
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001
        _log.warning("failed to load plugin %s: %s", path.name, exc)
        return None
    return module


def discover_plugins(force: bool = False) -> dict[str, PluginInfo]:
    """plugins/visualizers/*.py を読み込んで PluginInfo の辞書を返す。"""
    global _DISCOVER_CACHE
    if not force and _DISCOVER_CACHE is not None:
        return _DISCOVER_CACHE
    with _DISCOVER_LOCK:
        if not force and _DISCOVER_CACHE is not None:
            return _DISCOVER_CACHE
        plugins: dict[str, PluginInfo] = {}
        if not PLUGIN_ROOT.exists():
            _DISCOVER_CACHE = plugins
            return plugins
        for path in sorted(PLUGIN_ROOT.glob("*.py")):
            if path.name.startswith("_"):
                continue
            module = _load_plugin_module(path)
            if module is None:
                continue
            name = str(getattr(module, "NAME", path.stem))
            params_raw = getattr(module, "PARAMS", []) or []
            params: list[dict[str, Any]] = []
            for raw in params_raw:
                spec = _normalize_param_spec(raw)
                if spec is not None:
                    params.append(spec)
            key = str(getattr(module, "KEY", path.stem))
            gl_module_raw = getattr(module, "GL_MODULE", None)
            gl_module = str(gl_module_raw).strip() if gl_module_raw else None
            if not gl_module:
                print(
                    f"[visualizer] skipping {path.name}: GL_MODULE が定義されていません",
                    file=sys.stderr,
                )
                continue
            try:
                gl_version = int(getattr(module, "GL_VERSION", 1))
            except (TypeError, ValueError):
                gl_version = 1
            gl_data_streams_fn = getattr(module, "gl_data_streams", None)
            if not callable(gl_data_streams_fn):
                gl_data_streams_fn = None
            try:
                gl_frame_rate_raw = getattr(module, "GL_FRAME_RATE", None)
                gl_frame_rate = int(gl_frame_rate_raw) if gl_frame_rate_raw else None
                if gl_frame_rate is not None and gl_frame_rate <= 0:
                    gl_frame_rate = None
            except (TypeError, ValueError):
                gl_frame_rate = None
            analysis_keys_raw = getattr(module, "ANALYSIS_KEYS", None)
            analysis_keys: list[str] | None = None
            if isinstance(analysis_keys_raw, (list, tuple)):
                analysis_keys = [str(k) for k in analysis_keys_raw]
            try:
                source_mtime_ns = path.stat().st_mtime_ns
            except OSError:
                source_mtime_ns = 0
            plugins[key] = PluginInfo(
                key=key,
                name=name,
                params=params,
                gl_module=gl_module,
                gl_version=gl_version,
                gl_data_streams=gl_data_streams_fn,
                gl_frame_rate=gl_frame_rate,
                analysis_keys=analysis_keys,
                source_mtime_ns=source_mtime_ns,
            )
        _DISCOVER_CACHE = plugins
        return plugins


def plugin_descriptors() -> list[dict[str, Any]]:
    """API レスポンス用の (key, name, params, gl) 一覧。"""
    out: list[dict[str, Any]] = []
    for info in discover_plugins().values():
        gl: dict[str, Any] = {"module": info.gl_module, "version": info.gl_version}
        if info.gl_frame_rate is not None:
            gl["frameRate"] = info.gl_frame_rate
        out.append({
            "key": info.key,
            "name": info.name,
            "params": info.params,
            "gl": gl,
        })
    return out


# ---------------------------------------------------------------------------
# Audio decoding (ffmpeg → mono float32 PCM, in-memory cache)
# ---------------------------------------------------------------------------


# (resolved path, sample_rate) -> np.ndarray
_PCM_CACHE: dict[tuple[str, float, int], np.ndarray] = {}
_PCM_CACHE_LOCK = threading.Lock()


def _ffmpeg_executable() -> str:
    # 既存パターンに揃えるため、環境変数を最優先 → そのまま "ffmpeg" にフォールバック。
    env = os.environ.get("SPLITE_FFMPEG_PATH")
    if env:
        return env
    return "ffmpeg"


def decode_audio_to_pcm(
    audio_path: Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
) -> np.ndarray:
    """audio file を ffmpeg で decode し、mono float32 [-1, 1] の ndarray を返す。"""
    audio_path = Path(audio_path)
    try:
        mtime = audio_path.stat().st_mtime
    except OSError:
        return np.zeros(0, dtype=np.float32)
    cache_key = (str(audio_path.resolve()), float(mtime), int(sample_rate))
    with _PCM_CACHE_LOCK:
        cached = _PCM_CACHE.get(cache_key)
    if cached is not None:
        return cached
    cmd = [
        _ffmpeg_executable(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(audio_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False)
    except FileNotFoundError:
        return np.zeros(0, dtype=np.float32)
    if proc.returncode != 0:
        return np.zeros(0, dtype=np.float32)
    pcm = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    with _PCM_CACHE_LOCK:
        _PCM_CACHE[cache_key] = pcm
    return pcm


# ---------------------------------------------------------------------------
# Render orchestration
# ---------------------------------------------------------------------------


def merge_params(plugin: PluginInfo, user_params: dict[str, Any] | None) -> dict[str, Any]:
    """PARAMS の defaults を base に user_params を上書き。型は深く検査しない (プラグイン責務)。"""
    out: dict[str, Any] = {}
    for spec in plugin.params:
        out[spec["key"]] = spec.get("default")
    if isinstance(user_params, dict):
        for k, v in user_params.items():
            out[str(k)] = v
    return out


# ---------------------------------------------------------------------------
# Scene-level helpers
# ---------------------------------------------------------------------------


_ALLOWED_STREAM_DTYPES: dict[str, np.dtype] = {
    "float32": np.dtype(np.float32),
    "float16": np.dtype(np.float16),
    "int8": np.dtype(np.int8),
    "uint8": np.dtype(np.uint8),
    "int16": np.dtype(np.int16),
}


def _coerce_stream_entry(entry: Any) -> tuple[np.ndarray, str, float, float] | None:
    """``gl_data_streams`` の戻り値 1 要素を ``(ndarray, dtype, scale, offset)`` に揃える。

    プラグインは以下のいずれも返せる:
      - ``np.ndarray`` (= 既定で float32 として ship)
      - ``{"data": ndarray, "dtype": "int8" | "uint8" | "float16" | "int16",
            "scale": float, "offset": float}``
        ブラウザ側は ``value = stored * scale + offset`` で復号する。

    長尺 BGM で float32 が大きすぎる場合の圧縮ストリーム用。``int8`` で振幅
    [-1, 1] を ship するなら ``scale = 1/127, offset = 0`` 等。
    """
    if entry is None:
        return None
    if isinstance(entry, dict):
        data = entry.get("data")
        dtype = str(entry.get("dtype") or "float32").lower()
        try:
            scale = float(entry.get("scale", 1.0))
        except (TypeError, ValueError):
            scale = 1.0
        try:
            offset = float(entry.get("offset", 0.0))
        except (TypeError, ValueError):
            offset = 0.0
    else:
        data = entry
        dtype = "float32"
        scale = 1.0
        offset = 0.0
    if data is None:
        return None
    if not isinstance(data, np.ndarray):
        try:
            data = np.asarray(data)
        except Exception:
            return None
    if dtype not in _ALLOWED_STREAM_DTYPES:
        # 不明 dtype は float32 にフォールバック (ship size は増えるが安全)
        dtype = "float32"
    target = _ALLOWED_STREAM_DTYPES[dtype]
    arr = np.ascontiguousarray(data.astype(target, copy=False))
    return arr, dtype, scale, offset


def render_visualizer_data_streams(
    plugin_key: str,
    user_params: dict[str, Any] | None,
    audio: "AudioContext | None",
    time_grid_sec: "np.ndarray | list[float]",
    fps: int,
    cache_dir: Path,
    file_token: str,
) -> dict[str, dict[str, Any]]:
    """GL plugin の per-frame 解析データを binary stream として書き出す。

    戻り値: ``{stream_name: {"path": str (cache_dir 相対), "dtype": str,
              "shape": [...], "scale": float, "offset": float}}``。
    plugin が GL 非対応 / gl_data_streams 未定義なら空 dict。

    永続化先は ``cache_dir / "viz" / f"{file_token}_{name}.bin"``。FastAPI 側は
    ``/project-cache/{project_id}/viz/...`` でそのまま配信できる。stable な token
    を使えば 2 度目以降の HTTP cache が hit する。

    plugin は要素を ``ndarray`` か ``{"data", "dtype", "scale", "offset"}`` で返せる。
    後者は ``int8`` 等の圧縮ストリーム用。詳細は ``_coerce_stream_entry``。
    """
    plugins = discover_plugins()
    info = plugins.get(plugin_key)
    if info is None or info.gl_data_streams is None:
        return {}
    merged = merge_params(info, user_params)
    grid = np.asarray(time_grid_sec, dtype=np.float64)
    try:
        streams = info.gl_data_streams(merged, audio, grid, int(fps))
    except Exception as exc:  # noqa: BLE001
        _log.warning("plugin %s gl_data_streams raised: %s", plugin_key, exc)
        return {}
    if not isinstance(streams, dict):
        return {}
    viz_dir = cache_dir / "viz"
    viz_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict[str, Any]] = {}
    for name, entry in streams.items():
        coerced = _coerce_stream_entry(entry)
        if coerced is None:
            continue
        arr, dtype, scale, offset = coerced
        # ファイル名の name は plugin が安全な ascii 識別子を返す前提。defensive sanitize。
        safe_name = "".join(c if c.isalnum() or c in ("_", "-") else "_" for c in str(name))
        if not safe_name:
            continue
        # dtype が変わるとファイル内容も変わるので、float32 以外のときだけ token に
        # dtype suffix を付ける。float32 (= 既存挙動) はファイル名互換を保つ。
        if dtype == "float32":
            rel_path = f"viz/{file_token}_{safe_name}.bin"
        else:
            rel_path = f"viz/{file_token}_{safe_name}_{dtype}.bin"
        out_path = cache_dir / rel_path
        if not out_path.exists():
            tmp = out_path.with_suffix(out_path.suffix + ".tmp")
            tmp.write_bytes(arr.tobytes(order="C"))
            os.replace(tmp, out_path)
        meta: dict[str, Any] = {
            "path": rel_path,
            "dtype": dtype,
            "shape": list(arr.shape),
        }
        if scale != 1.0:
            meta["scale"] = scale
        if offset != 0.0:
            meta["offset"] = offset
        manifest[safe_name] = meta
    return manifest


# ---------------------------------------------------------------------------
# 解析キャッシュ (viz 専用トークン + manifest 早期 return)
#
# scene-bundle の token は payload 全体 + 全 telop + キャラレイヤー mtime を含む
# ため、無関係な編集 (テロップ 1 文字、キャラ 1px 移動) でも変わってしまい、
# 解析キャッシュのキーには適さない。ここでは「解析結果を決める入力」だけ —
# 音源ファイルの同一性 / プラグイン / 解析パラメータ / time grid — から
# 独立トークンを作る。シーン ID やカット ID を含めないので、将来の複数シーン
# 構成でも同一音源 + 同一グリッドならキャッシュを共有できる。
# ---------------------------------------------------------------------------

# v2 (2026-06-20): 音源単位キャッシュ導入で onset 系ストリームの自己正規化基準が
# 「カット内 peak」→「音源全長 peak」に変わった (visualizer.py の Phase 4a コメント
# 参照)。旧 v1 の per-cut manifest をそのまま再利用すると、同一シーン内で「旧正規化の
# カット」と「source-slice の新正規化カット」が混在し onset 明滅基準が食い違う。
# version を上げて旧 cache を一度だけ無効化し、正規化基準を全カットで揃える。
VIZ_STREAM_CACHE_VERSION = 2

# 同一トークンの解析が並走しないようにする in-flight lock。warmup の先頭 2 カット
# 同時 fire + renderPreview の並走で同じ 3 分解析が複数本走るのを防ぐ。
# トークン種は「ユニークな解析入力」の数しかないので dict は実質有界。
_STREAM_LOCKS: dict[str, threading.Lock] = {}
_STREAM_LOCKS_GUARD = threading.Lock()


def _stream_lock(token: str) -> threading.Lock:
    with _STREAM_LOCKS_GUARD:
        lock = _STREAM_LOCKS.get(token)
        if lock is None:
            lock = threading.Lock()
            _STREAM_LOCKS[token] = lock
        return lock


def compute_stream_token(
    info: PluginInfo,
    merged_params: dict[str, Any],
    *,
    audio_path: Path | None,
    trim_start_sec: float,
    fps: int,
    time_grid_sec: "np.ndarray | list[float]",
) -> str:
    """解析入力だけから成る 16 桁トークン。

    ``analysis_keys`` 宣言があるプラグインは該当パラメータのみ取り込む
    (= 色・座標などの描画専用パラメータ変更で再解析しない)。未宣言なら
    安全側に全パラメータを使う。
    """
    grid = np.asarray(time_grid_sec, dtype=np.float64)
    if info.analysis_keys is None:
        analysis_params = {k: merged_params.get(k) for k in sorted(merged_params)}
    else:
        analysis_params = {k: merged_params.get(k) for k in sorted(info.analysis_keys)}
    audio_sig = "none"
    if audio_path is not None:
        try:
            audio_sig = f"{audio_path.resolve()}:{audio_path.stat().st_mtime_ns}"
        except OSError:
            audio_sig = f"{audio_path}:missing"
    canonical = json.dumps(
        {
            "v": VIZ_STREAM_CACHE_VERSION,
            "plugin": info.key,
            "glVersion": info.gl_version,
            "pluginMtime": info.source_mtime_ns,
            "params": analysis_params,
            "audio": audio_sig,
            "trimStart": round(float(trim_start_sec or 0.0), 6),
            "fps": int(fps),
            "start": round(float(grid[0]) if grid.size else 0.0, 6),
            "frames": int(grid.size),
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]


def _stream_manifest_path(cache_dir: Path, token: str) -> Path:
    return cache_dir / "viz" / f"{token}_manifest.json"


def _load_stream_manifest(cache_dir: Path, token: str) -> dict[str, dict[str, Any]] | None:
    """manifest を読み、参照する全 .bin の実在を確認できたら streams を返す。

    ヒットした場合は manifest + .bin の mtime を touch して、mtime ベースの
    キャッシュ自動間引きから「使われている entry」を守る。
    """
    manifest_path = _stream_manifest_path(cache_dir, token)
    try:
        raw = json.loads(manifest_path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("version") != VIZ_STREAM_CACHE_VERSION:
        return None
    streams = raw.get("streams")
    if not isinstance(streams, dict):
        return None
    for meta in streams.values():
        if not isinstance(meta, dict) or not meta.get("path"):
            return None
        if not (cache_dir / str(meta["path"])).exists():
            return None
    for meta in streams.values():
        try:
            os.utime(cache_dir / str(meta["path"]), None)
        except OSError:
            pass
    try:
        os.utime(manifest_path, None)
    except OSError:
        pass
    return streams


# ---------------------------------------------------------------------------
# 音源単位の解析キャッシュ (Phase 4a, 2026-06-11)
#
# カット単位のトークンは time grid (開始秒 + フレーム数) を含むため、タイムライン
# でカット尺や開始位置を編集すると後続全カットのトークンが変わり、Phase 1 の
# manifest キャッシュがミスして再解析になる。それを避けるため、音源全長の
# fps 整列グリッド (t_j = j / fps) で gl_data_streams を 1 回だけ実行して
# ``src_<token>_*.bin`` に永続化し、各カットは行スライスで切り出す層を
# カット単位キャッシュの背後に置く。
#
# - 音源トークンは「音源同一性 + プラグイン + 解析パラメータ + fps」のみ。
#   シーン ID / カット ID / カット尺を一切含まないので、シーン編集はもちろん
#   将来の複数シーン構成でも同一音源なら共有できる。
# - カット単位の .bin / manifest (= ブラウザとの契約) はそのまま。スライスは
#   サーバ内部の最適化で、クライアントは無変更。
# - 整列について: タイムラインは PROJECT_FPS=24 固定なので fps=24 の plugin は
#   カット開始が必ずグリッドに乗る (= per-cut 解析と bit 一致)。fps=12/8 の
#   plugin は startFrame が fps の倍数に乗らないカットで最大半フレーム
#   (≦ 1/24 秒) のサンプル位置ずれが出るが、視覚上は判別できない。
# - 音源終端より後のフレームは「最終行の繰り返し」で埋める。per-cut 解析の
#   window() は終端で clamp されて最終窓を返し続けるため、これが等価な挙動。
# - onset 系ストリームの自己正規化は「カット内 peak」から「音源全長 peak」基準に
#   変わる (静かなカットの burst が過剰に増幅されなくなる)。
# ---------------------------------------------------------------------------

# wave プラグイン (1920 float32 / frame) のような太いストリームが長時間音源で
# 肥大しないよう、音源単位キャッシュの対象をこの長さまでに制限する。超える場合は
# per-cut 直接解析にフォールバック (Phase 2 のバッチ解析で十分速い)。
SOURCE_SLICE_MAX_AUDIO_SEC = 30 * 60


def compute_source_token(
    info: PluginInfo,
    merged_params: dict[str, Any],
    *,
    audio_path: Path | None,
    trim_start_sec: float,
    fps: int,
) -> str:
    """音源単位キャッシュのトークン。compute_stream_token から grid 情報を除いたもの。"""
    if info.analysis_keys is None:
        analysis_params = {k: merged_params.get(k) for k in sorted(merged_params)}
    else:
        analysis_params = {k: merged_params.get(k) for k in sorted(info.analysis_keys)}
    audio_sig = "none"
    if audio_path is not None:
        try:
            audio_sig = f"{audio_path.resolve()}:{audio_path.stat().st_mtime_ns}"
        except OSError:
            audio_sig = f"{audio_path}:missing"
    canonical = json.dumps(
        {
            "v": VIZ_STREAM_CACHE_VERSION,
            "scope": "source",
            "plugin": info.key,
            "glVersion": info.gl_version,
            "pluginMtime": info.source_mtime_ns,
            "params": analysis_params,
            "audio": audio_sig,
            "trimStart": round(float(trim_start_sec or 0.0), 6),
            "fps": int(fps),
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]


def _source_manifest_path(cache_dir: Path, src_token: str) -> Path:
    return cache_dir / "viz" / f"src_{src_token}_manifest.json"


def _load_source_manifest(cache_dir: Path, src_token: str) -> dict[str, Any] | None:
    """音源単位 manifest を読み、全 .bin の実在を確認できたら dict を返す (+touch)。"""
    manifest_path = _source_manifest_path(cache_dir, src_token)
    try:
        raw = json.loads(manifest_path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("version") != VIZ_STREAM_CACHE_VERSION:
        return None
    streams = raw.get("streams")
    if not isinstance(streams, dict) or not isinstance(raw.get("frames"), int):
        return None
    for meta in streams.values():
        if not isinstance(meta, dict) or not meta.get("path"):
            return None
        if not (cache_dir / str(meta["path"])).exists():
            return None
    for meta in streams.values():
        try:
            os.utime(cache_dir / str(meta["path"]), None)
        except OSError:
            pass
    try:
        os.utime(manifest_path, None)
    except OSError:
        pass
    return raw


def _ensure_source_streams(
    plugin_key: str,
    info: PluginInfo,
    user_params: dict[str, Any] | None,
    src_token: str,
    *,
    audio_track: dict[str, Any] | None,
    project_root: Path,
    fps: int,
    cache_dir: Path,
) -> dict[str, Any] | None:
    """音源全長グリッドの解析ストリームを ensure する。

    戻り値: ``{"frames": n_src, "sliceable": bool, "streams": {...}}`` 形式の
    manifest。音源なし / 長すぎる / 解析失敗は None (= 呼び出し側で per-cut
    直接解析にフォールバック)。
    """
    cached = _load_source_manifest(cache_dir, src_token)
    if cached is not None:
        return cached
    with _stream_lock(f"src:{src_token}"):
        cached = _load_source_manifest(cache_dir, src_token)
        if cached is not None:
            return cached
        audio = build_audio_context_for_track(audio_track, project_root)
        if audio is None or audio.pcm.size == 0:
            return None
        audio_dur = audio.pcm.size / float(audio.sample_rate)
        if audio_dur > SOURCE_SLICE_MAX_AUDIO_SEC:
            return None
        n_src = max(1, int(np.ceil(audio_dur * fps)))
        grid = np.arange(n_src, dtype=np.float64) / float(fps)
        streams = render_visualizer_data_streams(
            plugin_key=plugin_key,
            user_params=user_params,
            audio=audio,
            time_grid_sec=grid,
            fps=fps,
            cache_dir=cache_dir,
            file_token=f"src_{src_token}",
        )
        if not streams:
            return None
        # 全ストリームの 0 軸がグリッド長と一致するときだけ行スライス可。
        # (時間軸を持たないストリームを返すプラグインを誤って切り刻まないため。)
        sliceable = all(
            isinstance(meta.get("shape"), list)
            and len(meta["shape"]) >= 1
            and meta["shape"][0] == n_src
            for meta in streams.values()
        )
        manifest = {
            "version": VIZ_STREAM_CACHE_VERSION,
            "frames": n_src,
            "sliceable": sliceable,
            "streams": streams,
        }
        manifest_path = _source_manifest_path(cache_dir, src_token)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = manifest_path.with_name(manifest_path.name + ".tmp")
        tmp.write_text(json.dumps(manifest, ensure_ascii=False), "utf-8")
        os.replace(tmp, manifest_path)
        return manifest


def _slice_source_streams(
    source_manifest: dict[str, Any],
    cache_dir: Path,
    *,
    start_idx: int,
    n_frames: int,
    cut_token: str,
) -> dict[str, dict[str, Any]] | None:
    """音源単位ストリームからカット範囲の行を切り出してカット単位 .bin を書く。

    範囲が音源終端を越える分は最終行の繰り返しで埋める (per-cut 解析の終端
    clamp と等価)。失敗時は None (= per-cut 解析フォールバック)。
    """
    if not source_manifest.get("sliceable"):
        return None
    n_src = int(source_manifest["frames"])
    if n_src <= 0 or n_frames <= 0 or start_idx < 0:
        return None
    out: dict[str, dict[str, Any]] = {}
    for name, meta in source_manifest["streams"].items():
        dtype_name = str(meta.get("dtype") or "float32")
        np_dtype = _ALLOWED_STREAM_DTYPES.get(dtype_name)
        if np_dtype is None:
            return None
        shape = [int(v) for v in meta["shape"]]
        # 必要な行だけ読み出す (A-4): np.fromfile は stream 全体 (wave は frames×1920
        # float32 で数十MB) を毎カット読み込むが、np.memmap なら OS page cache 経由で
        # 対象行のバイト範囲だけがフォルトインされる。カット数が多い長尺ほど効く。
        try:
            mm = np.memmap(cache_dir / str(meta["path"]), dtype=np_dtype, mode="r", shape=tuple(shape))
        except (OSError, ValueError):
            return None
        try:
            lo = min(start_idx, n_src)
            hi = min(start_idx + n_frames, n_src)
            rows = np.array(mm[lo:hi])  # 必要行だけ RAM へコピー
            if rows.shape[0] < n_frames:
                pad = np.repeat(
                    np.array(mm[-1:]),  # 最終行 (= 終端 clamp の繰り返し)
                    n_frames - rows.shape[0],
                    axis=0,
                )
                rows = np.concatenate([rows, pad], axis=0) if rows.shape[0] else pad
        finally:
            # memmap を確実に解放 (Windows のファイルロック / キャッシュ間引き対策)。
            del mm
        rows = np.ascontiguousarray(rows)
        # ファイル命名は render_visualizer_data_streams と同一規則 (= ブラウザ契約維持)
        if dtype_name == "float32":
            rel_path = f"viz/{cut_token}_{name}.bin"
        else:
            rel_path = f"viz/{cut_token}_{name}_{dtype_name}.bin"
        out_path = cache_dir / rel_path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if not out_path.exists():
            tmp = out_path.with_suffix(out_path.suffix + ".tmp")
            tmp.write_bytes(rows.tobytes(order="C"))
            os.replace(tmp, out_path)
        entry: dict[str, Any] = {
            "path": rel_path,
            "dtype": dtype_name,
            "shape": list(rows.shape),
        }
        if "scale" in meta:
            entry["scale"] = meta["scale"]
        if "offset" in meta:
            entry["offset"] = meta["offset"]
        out[name] = entry
    return out


def ensure_visualizer_streams(
    plugin_key: str,
    user_params: dict[str, Any] | None,
    *,
    audio_track: dict[str, Any] | None,
    project_root: Path,
    time_grid_sec: "np.ndarray | list[float]",
    fps: int,
    cache_dir: Path,
    allow_source_build: bool = True,
) -> dict[str, dict[str, Any]]:
    """scene-bundle 向けの解析ストリーム入口 (キャッシュ管理付き)。

    1. カット単位 manifest ヒット → ``gl_data_streams`` も ffmpeg decode も呼ばず即返す。
    2. ミス時は音源単位キャッシュ (全長グリッド解析 + 行スライス) を試す。
       カット尺・開始位置の編集はここで吸収され、FFT は走らない。
    3. 音源なし / 長尺超過 / スライス不可のときだけ従来の per-cut 直接解析。

    いずれも per-token lock で重複解析を抑止する。戻り値は
    ``render_visualizer_data_streams`` と同形式の manifest dict。

    ``allow_source_build`` (既定 True):
      対話プレビューの「現カット」表示など初動レイテンシが効く hot path では False
      を渡す。False のときは音源単位キャッシュが *既に存在する場合のみ* スライスし、
      無ければ音源全長解析 (3 分 BGM なら数千フレームの window 解析) を同期実行せず
      per-cut 直接解析で即返す。音源キャッシュの生成は warm 経路 (先読み =
      allow_source_build=True) と書き出し (全カット処理で front-load が割に合う) に
      任せる。これで「最初の 1 カットだけ音源全長ぶんの解析を待たされる」回帰を防ぐ。
    """
    plugins = discover_plugins()
    info = plugins.get(plugin_key)
    if info is None or info.gl_data_streams is None:
        return {}
    merged = merge_params(info, user_params)
    audio_path = resolve_track_audio_path(audio_track, project_root)
    trim_start = 0.0
    if isinstance(audio_track, dict):
        try:
            trim_start = max(0.0, float(audio_track.get("trimStartSec") or 0.0))
        except (TypeError, ValueError):
            trim_start = 0.0
    token = compute_stream_token(
        info,
        merged,
        audio_path=audio_path,
        trim_start_sec=trim_start,
        fps=fps,
        time_grid_sec=time_grid_sec,
    )
    cached = _load_stream_manifest(cache_dir, token)
    if cached is not None:
        return cached
    with _stream_lock(token):
        # lock 待ちの間に先行スレッドが書き終えているケース (double-checked)。
        cached = _load_stream_manifest(cache_dir, token)
        if cached is not None:
            return cached
        manifest: dict[str, dict[str, Any]] | None = None
        # --- 音源単位キャッシュからの行スライスを試す ---
        if audio_path is not None:
            src_token = compute_source_token(
                info,
                merged,
                audio_path=audio_path,
                trim_start_sec=trim_start,
                fps=fps,
            )
            if allow_source_build:
                source_manifest = _ensure_source_streams(
                    plugin_key,
                    info,
                    user_params,
                    src_token,
                    audio_track=audio_track,
                    project_root=project_root,
                    fps=fps,
                    cache_dir=cache_dir,
                )
            else:
                # hot path: 既存の音源単位キャッシュがあるときだけ使う。無ければ
                # ここでは生成せず (= 音源全長解析を同期実行しない) per-cut に倒す。
                source_manifest = _load_source_manifest(cache_dir, src_token)
            if source_manifest is not None:
                grid = np.asarray(time_grid_sec, dtype=np.float64)
                start_idx = int(round(float(grid[0]) * fps)) if grid.size else 0
                manifest = _slice_source_streams(
                    source_manifest,
                    cache_dir,
                    start_idx=max(0, start_idx),
                    n_frames=int(grid.size),
                    cut_token=token,
                )
        # --- フォールバック: per-cut 直接解析 (従来経路) ---
        if manifest is None:
            audio = build_audio_context_for_track(audio_track, project_root)
            manifest = render_visualizer_data_streams(
                plugin_key=plugin_key,
                user_params=user_params,
                audio=audio,
                time_grid_sec=time_grid_sec,
                fps=fps,
                cache_dir=cache_dir,
                file_token=token,
            )
        # 解析失敗 (空 manifest) はキャッシュせず次回リトライに任せる。
        if manifest:
            manifest_path = _stream_manifest_path(cache_dir, token)
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = manifest_path.with_name(manifest_path.name + ".tmp")
            tmp.write_text(
                json.dumps(
                    {"version": VIZ_STREAM_CACHE_VERSION, "streams": manifest},
                    ensure_ascii=False,
                ),
                "utf-8",
            )
            os.replace(tmp, manifest_path)
        return manifest


def find_visualizer_audio_track(
    scene: dict[str, Any], track_id: str
) -> dict[str, Any] | None:
    """シーンの bgmTracks から ``id`` (= 該当 src) のトラックを返す。

    ``bgmTracks`` は ``id`` フィールドを持たないため、``track.src`` をキーに突き合わせる。
    track_id が空文字なら None。
    """
    if not track_id:
        return None
    for track in scene.get("bgmTracks") or []:
        if isinstance(track, dict) and str(track.get("src") or "") == track_id:
            return track
    return None


def resolve_track_audio_path(
    track: dict[str, Any] | None,
    project_root: Path,
) -> Path | None:
    """``bgmTrack.src`` から解析対象の音声ファイルパスを解決する (decode はしない)。

    解析キャッシュのトークン計算で「ffmpeg decode せずに音源の同一性を知る」
    ために build_audio_context_for_track から分離した。
    """
    if not isinstance(track, dict):
        return None
    src = str(track.get("src") or "").strip()
    if not src:
        return None
    if src.startswith("/"):
        path = Path(src)
    else:
        path = project_root / "assets" / src
    if not path.exists():
        path = project_root / src
        if not path.exists():
            return None
    return path


def build_audio_context_for_track(
    track: dict[str, Any] | None,
    project_root: Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
) -> AudioContext | None:
    """``bgmTrack.src`` 相対パスを decode して AudioContext を返す。"""
    path = resolve_track_audio_path(track, project_root)
    if path is None:
        return None
    pcm = decode_audio_to_pcm(path, sample_rate)
    if pcm.size == 0:
        return None
    # trimStartSec を反映 (先頭をスキップした PCM を返す)
    try:
        trim_start = max(0.0, float(track.get("trimStartSec") or 0.0))
    except (TypeError, ValueError):
        trim_start = 0.0
    if trim_start > 0:
        skip = min(pcm.size, int(round(trim_start * sample_rate)))
        pcm = pcm[skip:]
    return AudioContext(sample_rate=sample_rate, pcm=pcm)

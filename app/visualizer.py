"""オーディオビジュアライザのプラグイン基盤 (GL 経路のみ)。

- ``plugins/visualizers/<key>.py`` を走査して NAME / PARAMS / GL_MODULE / gl_data_streams を取得。
- ``decode_audio_to_pcm`` が ffmpeg 経由で raw PCM (mono float32) を取得し、
  メモリキャッシュする。
- ``gl_data_streams(params, audio, time_grid_sec, fps)`` の戻り値を binary 化して
  ``cache/<project>/viz/<token>_<name>.bin`` に書き出し、ブラウザの GL plugin が消費する。
"""
from __future__ import annotations

import importlib.util
import io
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
        """
        grid = np.asarray(time_grid_sec, dtype=np.float64)
        n = int(grid.size)
        if n <= 0 or self.pcm.size == 0:
            return np.zeros(max(0, n), dtype=np.float32)
        prev = None
        flux = np.zeros(n, dtype=np.float32)
        for i, t in enumerate(grid):
            spec = self.spectrum_db(
                float(t),
                n_bands=64,
                window_sec=window_sec,
                fmin=fmin,
                fmax=fmax,
            )
            if prev is not None:
                diff = np.maximum(spec - prev, 0.0)
                flux[i] = float(diff.mean())
            prev = spec
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
            plugins[key] = PluginInfo(
                key=key,
                name=name,
                params=params,
                gl_module=gl_module,
                gl_version=gl_version,
                gl_data_streams=gl_data_streams_fn,
                gl_frame_rate=gl_frame_rate,
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


def build_audio_context_for_track(
    track: dict[str, Any] | None,
    project_root: Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
) -> AudioContext | None:
    """``bgmTrack.src`` 相対パスを decode して AudioContext を返す。"""
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

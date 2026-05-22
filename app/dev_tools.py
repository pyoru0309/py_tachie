"""ビジュアライザ開発支援 (Visualizer Lab)。

`/dev/visualizers/` を本体 UI と独立した開発用ページとして提供し、プラグイン単体で
パラメータ・音源・背景色を切り替えながら動作確認できるようにする。

エンドポイント:
  - GET  /dev/visualizers/                         開発ページ HTML
  - POST /api/dev/visualizer/preview               本番 layerData.visualizer 互換 payload
  - GET  /dev/visualizer-cache/{path}              生成したストリーム binary

ガード:
  - ``SPLITE_DEV_TOOLS=1`` 環境変数、または
  - リクエスト元が loopback (127.0.0.1 / ::1)
  のいずれか。
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse

from . import visualizer as viz_mod
from .paths import ASSETS_DIR, CACHE_DIR, PROJECT_ROOT, STATIC_DIR
from .utils import active_project_id, current_project, project_context

router = APIRouter()

DEV_LAB_TOKEN = "_dev_visualizer_lab"
DEV_LAB_CACHE_DIR = CACHE_DIR / DEV_LAB_TOKEN


def _is_loopback(request: Request) -> bool:
    host = (request.client.host if request.client else "") or ""
    return host in ("127.0.0.1", "::1", "localhost")


def _dev_tools_enabled(request: Request) -> bool:
    if os.environ.get("SPLITE_DEV_TOOLS") == "1":
        return True
    return _is_loopback(request)


def _ensure_dev_tools(request: Request) -> None:
    if not _dev_tools_enabled(request):
        raise HTTPException(
            status_code=403,
            detail="Visualizer Lab は SPLITE_DEV_TOOLS=1 か loopback 接続でのみ有効です",
        )


# ---------------------------------------------------------------------------
# 音源 fixture (silence / sine / beat / sweep / noise / project audio)
# ---------------------------------------------------------------------------


def _fixture_silence(n: int) -> np.ndarray:
    return np.zeros(n, dtype=np.float32)


def _fixture_sine(n: int, sr: int, freq: float = 440.0) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / sr
    return (0.5 * np.sin(2.0 * np.pi * freq * t)).astype(np.float32)


def _fixture_beat(n: int, sr: int, bpm: float = 120.0) -> np.ndarray:
    """4/4 のキック風インパルス + 短い減衰。各 beat で 5kHz 以下の low-mid 成分を含む。"""
    out = np.zeros(n, dtype=np.float32)
    interval = 60.0 / max(1.0, bpm)
    period = int(round(interval * sr))
    if period <= 0:
        return out
    decay_n = max(1, int(round(0.18 * sr)))
    t = np.arange(decay_n, dtype=np.float64) / sr
    # ~80Hz の sin に exp 減衰。
    kick = (
        0.85 * np.sin(2.0 * np.pi * 80.0 * t) * np.exp(-t * 18.0)
        + 0.20 * np.sin(2.0 * np.pi * 220.0 * t) * np.exp(-t * 26.0)
    ).astype(np.float32)
    pos = 0
    while pos < n:
        end = min(n, pos + decay_n)
        out[pos:end] += kick[: end - pos]
        pos += period
    # クリッピング回避
    return np.clip(out, -0.95, 0.95).astype(np.float32)


def _fixture_sweep(n: int, sr: int, f0: float = 50.0, f1: float = 8000.0) -> np.ndarray:
    """対数掃引 (log-sweep)。スペクトルの全帯域を 1 度通過する確認用。"""
    if n <= 1 or sr <= 0:
        return np.zeros(max(0, n), dtype=np.float32)
    t = np.arange(n, dtype=np.float64) / sr
    duration = float(n) / sr
    k = np.log(f1 / max(1.0, f0)) / max(1e-9, duration)
    phase = 2.0 * np.pi * f0 / k * (np.exp(k * t) - 1.0)
    return (0.6 * np.sin(phase)).astype(np.float32)


def _fixture_noise(n: int) -> np.ndarray:
    rng = np.random.default_rng(0)  # 固定シード (再現性確保)
    return (rng.standard_normal(n).astype(np.float32) * 0.18).clip(-0.9, 0.9)


def _fixture_asset_audio(rel_path: str, n: int, sr: int) -> np.ndarray:
    """共通アセット ``assets/audio/<rel_path>`` を ffmpeg 経由でデコードして
    指定サンプル数分だけ取り出す。短ければ末尾を 0 埋め (preview 内のループは
    フロント側 timeline で行う)。"""
    full = (ASSETS_DIR / "audio" / rel_path).resolve()
    try:
        full.relative_to((ASSETS_DIR / "audio").resolve())
    except ValueError:
        return _fixture_silence(n)
    if not full.exists():
        return _fixture_silence(n)
    pcm = viz_mod.decode_audio_to_pcm(full, sample_rate=sr)
    if pcm.size == 0:
        return _fixture_silence(n)
    if pcm.size >= n:
        return pcm[:n].astype(np.float32, copy=False)
    out = np.zeros(n, dtype=np.float32)
    out[: pcm.size] = pcm
    return out


# 合成 fixture: (label, fn, needs_sr)
_SYNTHETIC_FIXTURES = {
    "silence": ("無音", _fixture_silence, False),
    "sine": ("Sine 440Hz", _fixture_sine, True),
    "beat": ("4/4 キック (120BPM)", _fixture_beat, True),
    "sweep": ("対数スイープ 50-8000Hz", _fixture_sweep, True),
    "noise": ("ホワイトノイズ", _fixture_noise, False),
}


_AUDIO_EXTS = ("*.wav", "*.mp3", "*.m4a", "*.aac", "*.ogg", "*.flac")


def _list_common_audio_assets() -> list[dict[str, Any]]:
    """``assets/audio/`` を再帰スキャンしてフィクスチャ用エントリを返す。
    duration は decode_audio_to_pcm の結果 (= ffmpeg) を使う (in-memory cache あり)。
    """
    audio_dir = ASSETS_DIR / "audio"
    if not audio_dir.exists():
        return []
    sr = viz_mod.DEFAULT_SAMPLE_RATE
    entries: list[dict[str, Any]] = []
    paths: list[Path] = []
    for pat in _AUDIO_EXTS:
        paths.extend(audio_dir.rglob(pat))
    for path in sorted(paths):
        if not path.is_file():
            continue
        rel = path.relative_to(audio_dir).as_posix()
        # duration は decode して取得 (キャッシュあり)。decode が壊れていれば 0。
        try:
            pcm = viz_mod.decode_audio_to_pcm(path, sample_rate=sr)
            duration = float(pcm.size) / sr if pcm.size > 0 else 0.0
        except Exception:
            duration = 0.0
        entries.append(
            {
                "key": f"asset:{rel}",
                "label": f"音源: {path.stem}",
                "durationSec": round(duration, 3),
                # /assets は PROJECT_ROOT に mount されているので、共通アセットの
                # URL は `/assets/assets/<rel>` (asset_url 規約と整合) になる。
                "url": f"/assets/assets/audio/{rel}",
            }
        )
    return entries


def _build_audio_fixture(kind: str, duration_sec: float, sample_rate: int) -> np.ndarray:
    n = max(1, int(round(duration_sec * sample_rate)))
    if isinstance(kind, str) and kind.startswith("asset:"):
        return _fixture_asset_audio(kind[len("asset:"):], n, sample_rate)
    entry = _SYNTHETIC_FIXTURES.get(kind)
    if entry is None:
        return _fixture_silence(n)
    _, fn, needs_sr = entry
    if needs_sr:
        return fn(n, sample_rate)
    return fn(n)


# ---------------------------------------------------------------------------
# /api/dev/visualizer/preview
# ---------------------------------------------------------------------------


def _stable_token(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


@router.get("/api/dev/visualizer/fixtures")
def get_fixtures(request: Request) -> dict[str, Any]:
    _ensure_dev_tools(request)
    synthetic = [
        {"key": k, "label": label, "durationSec": None}
        for k, (label, _fn, _sr) in _SYNTHETIC_FIXTURES.items()
    ]
    return {
        "fixtures": synthetic + _list_common_audio_assets(),
        "sampleRate": viz_mod.DEFAULT_SAMPLE_RATE,
    }


@router.post("/api/dev/visualizer/preview")
def post_preview(request: Request, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Visualizer Lab のメイン API。本番 ``layerData.visualizer`` 互換 payload を返す。

    body:
      pluginKey       (str)
      params          (dict)             plugin の PARAMS と同じキー
      durationSec     (float, default 8) シーン長 = カット長
      fps             (int, default 24)  visualizer フレームレート (plugin GL_FRAME_RATE があればそれを優先)
      audioFixture    (str, default beat)
      backgroundColor (str)              プレビュー用 (本 API では shape にのみ含める)

    戻り値: ``{pluginKey, layer, frameDurationSec, frameCount, cutStartSec, sceneTotalSec,
              gl: { module, version, params, streams, frameRate }, fixture, backgroundColor }``
    """
    _ensure_dev_tools(request)
    payload = payload or {}
    plugin_key = str(payload.get("pluginKey") or "").strip()
    if not plugin_key:
        raise HTTPException(status_code=400, detail="pluginKey が必要です")
    plugins = viz_mod.discover_plugins()
    info = plugins.get(plugin_key)
    if info is None:
        raise HTTPException(status_code=404, detail=f"プラグインが見つかりません: {plugin_key}")

    user_params = payload.get("params") or {}
    if not isinstance(user_params, dict):
        raise HTTPException(status_code=400, detail="params は object である必要があります")

    try:
        duration_sec = max(0.1, min(120.0, float(payload.get("durationSec") or 8.0)))
    except (TypeError, ValueError):
        duration_sec = 8.0
    try:
        fps = max(1, min(60, int(payload.get("fps") or 24)))
    except (TypeError, ValueError):
        fps = 24
    if info.gl_frame_rate and info.gl_frame_rate > 0:
        fps = max(1, int(info.gl_frame_rate))

    fixture_key = str(payload.get("audioFixture") or "beat")
    is_asset = fixture_key.startswith("asset:")
    if not is_asset and fixture_key not in _SYNTHETIC_FIXTURES:
        fixture_key = "silence"
    background_color = str(payload.get("backgroundColor") or "#000000")

    sample_rate = viz_mod.DEFAULT_SAMPLE_RATE
    pcm = _build_audio_fixture(fixture_key, duration_sec, sample_rate)
    audio = viz_mod.AudioContext(sample_rate=sample_rate, pcm=pcm) if pcm.size > 0 else None

    n_frames = max(1, int(round(duration_sec * fps)))
    time_grid = [i / float(fps) for i in range(n_frames)]

    DEV_LAB_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    token = _stable_token(
        {
            "k": plugin_key,
            "p": user_params,
            "d": duration_sec,
            "f": fps,
            "a": fixture_key,
        }
    )

    streams = viz_mod.render_visualizer_data_streams(
        plugin_key=plugin_key,
        user_params=user_params,
        audio=audio,
        time_grid_sec=time_grid,
        fps=fps,
        cache_dir=DEV_LAB_CACHE_DIR,
        file_token=token,
    )
    streams_url: dict[str, Any] = {}
    for name, meta in streams.items():
        entry: dict[str, Any] = {
            "url": f"/dev/visualizer-cache/{meta['path']}",
            "dtype": meta["dtype"],
            "shape": meta["shape"],
        }
        if "scale" in meta:
            entry["scale"] = meta["scale"]
        if "offset" in meta:
            entry["offset"] = meta["offset"]
        streams_url[name] = entry

    merged = viz_mod.merge_params(info, user_params)
    gl_payload: dict[str, Any] | None = None
    if info.gl_module:
        gl_payload = {
            "module": info.gl_module,
            "version": info.gl_version,
            "params": merged,
            "streams": streams_url,
        }
        if info.gl_frame_rate:
            gl_payload["frameRate"] = info.gl_frame_rate

    return {
        "pluginKey": plugin_key,
        "layer": str((user_params.get("layer") or "above_bg")),
        "frameDurationSec": round(1.0 / fps, 6),
        "frameCount": n_frames,
        "cutStartSec": 0.0,
        "sceneTotalSec": float(duration_sec),
        "gl": gl_payload,
        "fixture": fixture_key,
        "backgroundColor": background_color,
        "fps": fps,
        "params": merged,
        "paramsSpec": info.params,
    }


# ---------------------------------------------------------------------------
# /dev/visualizers/  HTML
# ---------------------------------------------------------------------------


@router.get("/dev/visualizers/")
def dev_visualizers_page(request: Request) -> HTMLResponse:
    _ensure_dev_tools(request)
    html_path = STATIC_DIR / "dev" / "visualizers.html"
    if not html_path.exists():
        raise HTTPException(status_code=500, detail="dev/visualizers.html が見つかりません")
    # importmap は本体と同じ仕組みで vendor/CDN を切り替える。
    from .main import _render_html_with_importmap  # 局所 import (循環回避)
    return _render_html_with_importmap(html_path)


@router.get("/dev/visualizers")
def dev_visualizers_page_alias(request: Request) -> HTMLResponse:
    """末尾スラッシュ無しでも到達できるように。"""
    return dev_visualizers_page(request)


@router.get("/dev/visualizer-cache/{filename:path}")
def dev_visualizer_cache(request: Request, filename: str) -> FileResponse:
    _ensure_dev_tools(request)
    base = DEV_LAB_CACHE_DIR.resolve()
    path = (DEV_LAB_CACHE_DIR / filename).resolve()
    try:
        path.relative_to(base)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid cache path") from exc
    if not path.exists():
        raise HTTPException(status_code=404, detail="Cache not found")
    response = FileResponse(path)
    # token が hash ベースなので強キャッシュ可。再リクエストは memory cache から即返る。
    response.headers["Cache-Control"] = "public, max-age=300"
    return response

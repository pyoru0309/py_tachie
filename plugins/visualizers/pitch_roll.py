"""歌声ピッチロール ビジュアライザ。

歌声だけの音源から音の高さ (F0) を推定し、歌唱判定 MIDI のノートの上に
「実際に歌った音程の軌跡」を光る線で重ねて、ピアノロールを横スクロールさせる。

- 音源: ビジュアライザの「音源」で選んだ BGM トラック (= 歌声だけの wav)。
- MIDI: ``midiSource`` で選ぶ。既定は音源トラックの歌唱判定 MIDI (``lipSyncMidi``。
  オフセット・トラック指定も口パクと共用)。口パク用は「あいうえお」に合わせて
  打ち直していて実際の歌と合わないことがあるので、ノート表示用の MIDI を別に
  指定できる。MIDI が無くても音程の線だけは描ける。
- 音程推定は numpy だけで書いた YIN (100 Hz)。MIDI があるときは「その時刻に
  鳴っているはずのノート」を手がかりにオクターブ誤りを直し、ノートから離れた
  息・ノイズの区間は捨てる (``midiGate``)。

時間軸: AudioContext.pcm は trimStartSec 適用済みなので、pcm の 0 秒 = シーンの
0 秒 (= time_grid の基準)。MIDI 秒 = ファイル内秒 - offset = t + trim - offset。

GL plugin: カットの time grid の前後 WINDOW_MARGIN_SEC 秒ぶんの音程・音量と
その範囲のノートを返す (行スライス不可なので ``SOURCE_SLICE = False``)。
ブラウザ側 (static/js/visualizers/pitch_roll.js) が sceneSec で横スクロール描画する。
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np

KEY = "pitch_roll"
NAME = "歌声ピッチロール"

GL_MODULE = "/static/js/visualizers/pitch_roll.js"
GL_VERSION = 1
# スクロールの滑らかさのため、更新粒度はタイムラインと同じ 24fps。
GL_FRAME_RATE = 24
SOURCE_SLICE = False

# 解析に効くのはこれだけ。色・配置・速度などは全部ブラウザ側描画パラメータ。
ANALYSIS_KEYS = ["midiGate", "voicingThreshold", "midiSource", "midiTrack", "midiOffsetMs"]

# midiSource の特別値: 音源トラックの口パク用 MIDI (lipSyncMidi) を使う。
MIDI_FROM_LIPSYNC = "__lipsync__"

PARAMS = [
    {"key": "midiSource", "type": "midi_file", "default": MIDI_FROM_LIPSYNC, "label": "ノートに使う MIDI", "options": [
        {"value": MIDI_FROM_LIPSYNC, "label": "音源 BGM の口パク用 MIDI を使う"},
        {"value": "", "label": "MIDI を使わない (音程の線だけ)"},
    ], "hint": "口パク用に打ち込み直した MIDI が実際の歌と合わないときは、ノート表示用の MIDI を選んでください (assets/midi)。"},
    {"key": "midiTrack", "type": "number", "min": 0, "max": 64, "step": 1, "default": 0, "label": "MIDI トラック番号",
     "hint": "0 = 全トラック。口パク用 MIDI を使うときは口パク側の指定に従います。"},
    {"key": "midiOffsetMs", "type": "number", "min": -10000, "max": 10000, "step": 10, "default": 0, "label": "MIDI のオフセット (ms)",
     "hint": "MIDI を後ろへずらす量。口パク用 MIDI を使うときは口パク側の指定に従います。"},
    {"key": "lineColor", "type": "color", "default": "#7fe3ff", "label": "音程線の色"},
    {"key": "noteColor", "type": "color", "default": "#3d6cff", "label": "ノートの色"},
    {"key": "noteStyle", "type": "select", "default": "bevel", "label": "ノートのスタイル", "options": [
        {"value": "bevel", "label": "立体 (上辺にハイライト)"},
        {"value": "flat", "label": "フラット"},
    ]},
    {"key": "noteRadius", "type": "number", "min": 0, "max": 40, "step": 1, "default": 4, "label": "ノートの角丸 (px)"},
    {"key": "noteOpacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 1, "label": "ノートの不透明度"},
    {"key": "gridColor", "type": "color", "default": "#ffffff", "label": "罫線の色"},
    {"key": "gridStyle", "type": "select", "default": "keys", "label": "背景の罫線", "options": [
        {"value": "keys", "label": "罫線 + 鍵盤の帯"},
        {"value": "lines", "label": "罫線のみ"},
        {"value": "none", "label": "表示しない"},
    ]},
    {"key": "playheadLine", "type": "select", "default": "on", "label": "再生位置の縦線", "options": [
        {"value": "on", "label": "表示する"},
        {"value": "off", "label": "表示しない"},
    ]},
    {"key": "x", "type": "number", "min": 0, "max": 1920, "step": 10, "default": 0, "label": "表示範囲 X"},
    {"key": "y", "type": "number", "min": 0, "max": 1080, "step": 10, "default": 0, "label": "表示範囲 Y"},
    {"key": "width", "type": "number", "min": 100, "max": 1920, "step": 10, "default": 1920, "label": "表示範囲 幅"},
    {"key": "height", "type": "number", "min": 100, "max": 1080, "step": 10, "default": 1080, "label": "表示範囲 高さ"},
    {"key": "playheadPos", "type": "number", "min": 0.1, "max": 0.95, "step": 0.05, "default": 0.75, "label": "再生位置 (左端 0 〜 右端 1)"},
    {"key": "pxPerSec", "type": "number", "min": 100, "max": 1200, "step": 10, "default": 320, "label": "流れる速さ (px/秒)"},
    {"key": "rangePadding", "type": "number", "min": 0, "max": 12, "step": 1, "default": 3, "label": "音域の上下余白 (半音)"},
    {"key": "lineWidth", "type": "number", "min": 1, "max": 16, "step": 0.5, "default": 3, "label": "音程線の太さ (px)"},
    {"key": "glow", "type": "number", "min": 0, "max": 2, "step": 0.1, "default": 1, "label": "発光の強さ"},
    {"key": "trailSec", "type": "number", "min": 0.5, "max": 12, "step": 0.5, "default": 4, "label": "光の尾の長さ (秒)"},
    {"key": "backdrop", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 0.6, "label": "暗幕の濃さ (表示範囲を暗くする)"},
    {"key": "showFuture", "type": "select", "default": "dim", "label": "これから歌う音程", "options": [
        {"value": "hide", "label": "表示しない"},
        {"value": "dim", "label": "うっすら表示"},
    ]},
    {"key": "showLyrics", "type": "select", "default": "on", "label": "歌詞", "options": [
        {"value": "on", "label": "表示する"},
        {"value": "off", "label": "表示しない"},
    ]},
    {"key": "midiGate", "type": "select", "default": "on", "label": "ノートから離れた音を消す", "options": [
        {"value": "on", "label": "消す (息・ノイズ対策)"},
        {"value": "off", "label": "消さない"},
    ]},
    {"key": "voicingThreshold", "type": "number", "min": 0.05, "max": 0.6, "step": 0.05, "default": 0.3, "label": "有声判定のゆるさ"},
    {"key": "opacity", "type": "number", "min": 0, "max": 1, "step": 0.05, "default": 1, "label": "不透明度"},
]

ANALYSIS_HZ = 100.0
WINDOW_MARGIN_SEC = 20.0
LYRIC_MAX_CHARS = 8
_YIN_SR = 16000
_FMIN = 70.0
_FMAX = 1400.0


# ---------------------------------------------------------------------------
# MIDI (ビジュアライザ用に指定した MIDI / 音源トラックの口パク用 MIDI)
#
# 口パク用 MIDI は「あいうえお」に合わせて打ち込み直していることがあり
# (英語歌唱を「とらいみー」で打つ等)、実際の歌唱と音程・タイミングが合わない。
# そのためノート表示用の MIDI は ``midiSource`` で別に選べる:
#   "__lipsync__" = 音源トラックの lipSyncMidi (オフセット・トラック指定も共用)
#   ""            = MIDI を使わない (音程の線だけ)
#   "<path>"      = その MIDI。オフセットは midiOffsetMs、トラックは midiTrack (0 = 全部)
# ---------------------------------------------------------------------------

def _resolve_path(src: str) -> Path | None:
    if not src:
        return None
    try:
        from app.render import safe_asset_path

        path = safe_asset_path(src)
    except Exception:  # noqa: BLE001
        return None
    return path if path and path.is_file() else None


def _midi_spec(track: dict[str, Any] | None, params: dict[str, Any]) -> tuple[Path | None, float, set[int], str]:
    """(MIDI パス, オフセット秒, 使うトラック番号 (空 = 全部), 識別用の src)。"""
    source = str(params.get("midiSource") if params.get("midiSource") is not None else MIDI_FROM_LIPSYNC)
    if source == MIDI_FROM_LIPSYNC:
        cfg = (track or {}).get("lipSyncMidi") if isinstance(track, dict) else None
        if not isinstance(cfg, dict) or not cfg.get("src"):
            return None, 0.0, set(), ""
        wanted = {int(t.get("index", -1)) for t in cfg.get("tracks") or [] if isinstance(t, dict)}
        return _resolve_path(str(cfg["src"])), float(cfg.get("offsetMs") or 0) / 1000.0, wanted, str(cfg["src"])
    if not source:
        return None, 0.0, set(), ""
    try:
        offset = float(params.get("midiOffsetMs") or 0) / 1000.0
    except (TypeError, ValueError):
        offset = 0.0
    try:
        index = int(params.get("midiTrack") or 0)
    except (TypeError, ValueError):
        index = 0
    return _resolve_path(source), offset, ({index} if index > 0 else set()), source


def cache_signature(track: dict[str, Any] | None, params: dict[str, Any]) -> str:
    """使う MIDI の差し替え・中身の更新・オフセット・トラック指定で解析キャッシュを無効化する。"""
    path, offset, wanted, src = _midi_spec(track, params)
    if path is None:
        return f"nomidi:{src}"
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        mtime = 0
    return f"{src}:{mtime}:{offset}:{sorted(wanted)}"


def _load_notes(track: dict[str, Any] | None, params: dict[str, Any]) -> list[tuple[float, float, int, str]]:
    """(開始秒, 終了秒, ノート番号, 歌詞) を **ファイル内秒** で返す (offset 適用済み)。"""
    path, offset, wanted, _src = _midi_spec(track, params)
    if path is None:
        return []
    from app import midi_lipsync

    try:
        song = midi_lipsync.load_midi(path)
    except (OSError, ValueError):
        return []
    out: list[tuple[float, float, int, str]] = []
    for mt in song.tracks:
        if wanted and mt.index not in wanted:
            continue
        for note in mt.notes:
            start = song.tick_to_sec(note.start_tick) + offset
            end = song.tick_to_sec(note.end_tick) + offset
            if end > start:
                out.append((start, end, int(note.pitch), note.lyric or ""))
    out.sort(key=lambda n: n[0])
    return out


# ---------------------------------------------------------------------------
# 音程推定 (YIN)
# ---------------------------------------------------------------------------


def _downsample(pcm: np.ndarray, sr: int) -> np.ndarray:
    """sr → _YIN_SR へ。整数比なら窓付き sinc の低域通過 + 間引き。"""
    if sr == _YIN_SR:
        return pcm.astype(np.float32)
    ratio = sr / _YIN_SR
    step = int(round(ratio))
    if abs(ratio - step) > 1e-6 or step < 1:
        # 整数比でないとき: 線形補間 (精度は落ちるが F0 推定には十分)。
        n_out = int(pcm.size / ratio)
        return np.interp(np.arange(n_out) * ratio, np.arange(pcm.size), pcm).astype(np.float32)
    taps = 64 * step + 1
    n = np.arange(taps) - (taps - 1) / 2
    cutoff = 0.45 / step
    kernel = (2 * cutoff * np.sinc(2 * cutoff * n) * np.hamming(taps)).astype(np.float32)
    # FFT 畳み込み (直接畳み込みは長尺で遅い)。
    size = pcm.size + taps - 1
    nfft = 1 << (size - 1).bit_length()
    filtered = np.fft.irfft(np.fft.rfft(pcm, nfft) * np.fft.rfft(kernel, nfft), nfft)[:size]
    filtered = filtered[(taps - 1) // 2:(taps - 1) // 2 + pcm.size]
    return filtered[::step].astype(np.float32)


def _yin(x: np.ndarray, threshold: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """100 Hz の (f0 Hz, 非周期性 0..1, RMS dBFS)。無声は f0 = 0。"""
    sr = _YIN_SR
    hop = int(round(sr / ANALYSIS_HZ))
    w = int(round(sr * 0.032))
    tau_min = int(sr / _FMAX)
    tau_max = int(np.ceil(sr / _FMIN))
    n = w + tau_max
    n_frames = max(0, int(np.ceil(x.size / hop)))
    f0 = np.zeros(n_frames, dtype=np.float32)
    aper = np.ones(n_frames, dtype=np.float32)
    rms_db = np.full(n_frames, -120.0, dtype=np.float32)
    if n_frames == 0:
        return f0, aper, rms_db
    # フレーム中心 = i * hop。左右を 0 埋めして sliding window で一括抽出。
    pad_left = w // 2
    padded = np.concatenate([np.zeros(pad_left, np.float32), x, np.zeros(n + hop, np.float32)])
    view = np.lib.stride_tricks.sliding_window_view(padded, n)
    nfft = 1 << (n + w - 1).bit_length()
    taus = np.arange(tau_max + 1)
    chunk = 2048
    for s in range(0, n_frames, chunk):
        e = min(n_frames, s + chunk)
        frames = view[np.arange(s, e) * hop].astype(np.float64)
        a = frames[:, :w]
        rms = np.sqrt(np.mean(a * a, axis=1) + 1e-12)
        rms_db[s:e] = 20.0 * np.log10(rms)
        # r(τ) = Σ_{j<w} x_j x_{j+τ}
        r = np.fft.irfft(np.conj(np.fft.rfft(a, nfft)) * np.fft.rfft(frames, nfft), nfft)[:, :tau_max + 1]
        cs = np.concatenate([np.zeros((frames.shape[0], 1)), np.cumsum(frames * frames, axis=1)], axis=1)
        e0 = cs[:, w][:, None]
        et = cs[:, taus + w] - cs[:, taus]
        d = np.maximum(e0 + et - 2.0 * r, 0.0)
        # 累積平均正規化差分 (CMNDF)
        cum = np.cumsum(d[:, 1:], axis=1)
        dn = np.ones_like(d)
        dn[:, 1:] = d[:, 1:] * np.arange(1, tau_max + 1) / np.maximum(cum, 1e-12)
        sub = dn[:, tau_min:tau_max]
        below = sub < threshold
        has = below.any(axis=1)
        first = np.where(has, below.argmax(axis=1), sub.argmin(axis=1))
        # 閾値を下回った最初の点から谷底まで降りる。
        rows = np.arange(sub.shape[0])
        idx = first.copy()
        for _ in range(64):
            nxt = np.minimum(idx + 1, sub.shape[1] - 1)
            move = has & (sub[rows, nxt] < sub[rows, idx])
            if not move.any():
                break
            idx = np.where(move, nxt, idx)
        # 放物線補間
        left = sub[rows, np.maximum(idx - 1, 0)]
        mid = sub[rows, idx]
        right = sub[rows, np.minimum(idx + 1, sub.shape[1] - 1)]
        denom = left - 2 * mid + right
        shift = np.where(np.abs(denom) > 1e-12, 0.5 * (left - right) / denom, 0.0)
        shift = np.clip(shift, -1, 1)
        tau = idx + tau_min + shift
        f0[s:e] = np.where(has, sr / np.maximum(tau, 1e-6), 0.0)
        aper[s:e] = np.clip(mid, 0, 1)
    return f0, aper, rms_db


def _median_filter(values: np.ndarray, k: int) -> np.ndarray:
    if values.size < k:
        return values
    pad = k // 2
    padded = np.pad(values, pad, mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(padded, k), axis=1)


def _analyze(audio, notes: list[tuple[float, float, int, str]], trim: float,
             gate: bool, threshold: float) -> tuple[np.ndarray, np.ndarray]:
    """シーン秒 (= pcm 秒) 100 Hz の (ノート番号 or NaN, 音量 0..1)。"""
    x = _downsample(audio.pcm, int(audio.sample_rate))
    f0, aper, rms_db = _yin(x, threshold=min(0.6, max(0.05, threshold)))
    n = f0.size
    peak_db = float(np.percentile(rms_db, 99.5)) if n else -120.0
    voiced = (f0 > 0) & (aper < threshold * 1.5) & (rms_db > max(peak_db - 35.0, -60.0))
    semis = np.full(n, np.nan, dtype=np.float64)
    semis[voiced] = 69.0 + 12.0 * np.log2(f0[voiced] / 440.0)

    if notes:
        # 各フレームで「鳴っているはずのノート」(前後 0.15 秒の余裕込み、最寄り)。
        t_file = np.arange(n) / ANALYSIS_HZ + trim
        starts = np.array([s for s, _e, _p, _l in notes])
        ends = np.array([e for _s, e, _p, _l in notes])
        pitches = np.array([p for _s, _e, p, _l in notes], dtype=np.float64)
        expected = np.full(n, np.nan)
        dist = np.full(n, np.inf)
        for s, e, p in zip(starts, ends, pitches):
            lo = max(0, int(np.floor((s - 0.5 - trim) * ANALYSIS_HZ)))
            hi = min(n, int(np.ceil((e + 0.5 - trim) * ANALYSIS_HZ)) + 1)
            if lo >= hi:
                continue
            t = t_file[lo:hi]
            dd = np.maximum(0.0, np.maximum(s - t, t - e))
            better = dd < dist[lo:hi]
            dist[lo:hi] = np.where(better, dd, dist[lo:hi])
            expected[lo:hi] = np.where(better, p, expected[lo:hi])
        near = dist <= 0.3
        fix = near & ~np.isnan(semis)
        # オクターブ誤り補正: 期待ノートから ±6 半音以内へ 12 の倍数で寄せる。
        semis[fix] -= 12.0 * np.round((semis[fix] - expected[fix]) / 12.0)
        # 寄せても期待ノートから大きく外れる点は子音・息の誤検出。ノートの外側
        # (前後のはみ出し) はしゃくり・フォール程度の幅しか認めない。
        allowed = np.where(dist > 0.0, 3.5, 5.0)
        semis[fix & (np.abs(semis - expected) > allowed)] = np.nan
        if gate:
            semis[~near] = np.nan

    # 前後どちらとも 1 フレームで 2 半音以上離れた点 (= 単発のはね) を捨てる。
    if n >= 3:
        prev_d = np.abs(semis[1:-1] - semis[:-2])
        next_d = np.abs(semis[1:-1] - semis[2:])
        spike = np.zeros(n, dtype=bool)
        spike[1:-1] = (prev_d > 2.0) & (next_d > 2.0)
        semis[spike] = np.nan

    # 単発のはね・短い島を除去してからメディアンで均す。
    valid = ~np.isnan(semis)
    filled = np.where(valid, semis, 0.0)
    smoothed = _median_filter(filled, 5)
    semis = np.where(valid, smoothed, np.nan)
    if n:
        edges = np.flatnonzero(np.diff(np.concatenate([[0], valid.astype(np.int8), [0]])))
        for a, b in zip(edges[::2], edges[1::2]):
            if b - a < 6:
                semis[a:b] = np.nan

    level = np.clip((rms_db - (peak_db - 40.0)) / 40.0, 0.0, 1.0).astype(np.float32)
    return semis.astype(np.float32), level


_CACHE: dict[str, tuple[np.ndarray, np.ndarray, list[tuple[float, float, int, str]]]] = {}
_CACHE_LOCK = threading.Lock()


def _song_data(audio, params):
    track = audio.track if isinstance(audio.track, dict) else {}
    try:
        trim = max(0.0, float(track.get("trimStartSec") or 0.0))
    except (TypeError, ValueError):
        trim = 0.0
    gate = str(params.get("midiGate") or "on") != "off"
    try:
        threshold = float(params.get("voicingThreshold") or 0.3)
    except (TypeError, ValueError):
        threshold = 0.3
    key = f"{audio.source_key}|{cache_signature(track, params)}|{gate}|{threshold}"
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
    if hit is not None:
        return hit
    notes_file = _load_notes(track, params)
    semis, level = _analyze(audio, notes_file, trim, gate, threshold)
    # ノートをシーン秒へ。
    notes = [(s - trim, e - trim, p, lyric) for s, e, p, lyric in notes_file]
    result = (semis, level, notes)
    with _CACHE_LOCK:
        if len(_CACHE) > 8:
            _CACHE.clear()
        _CACHE[key] = result
    return result


def gl_data_streams(params, audio, time_grid_sec, fps):
    """カットの前後 WINDOW_MARGIN_SEC 秒ぶんの音程・音量・ノートを返す。

    返却:
      ``pitch`` (M, 2): [ノート番号 (無声は -1), 音量 0..1]。100 Hz、先頭 = meta[0] 秒。
      ``notes`` (K, 3): [開始秒, 終了秒, ノート番号] (シーン秒)。
      ``lyrics`` (K, LYRIC_MAX_CHARS): 歌詞のコードポイント (0 = なし)。
      ``meta`` (4,): [pitch 先頭秒, 解析 Hz, 表示音域 下端, 上端]。
    """
    grid = np.asarray(time_grid_sec, dtype=np.float64)
    if audio is None or grid.size == 0 or audio.pcm.size == 0:
        return {}
    semis, level, notes = _song_data(audio, params)
    t0 = float(grid[0]) - WINDOW_MARGIN_SEC
    t1 = float(grid[-1]) + WINDOW_MARGIN_SEC
    i0 = int(np.floor(t0 * ANALYSIS_HZ))
    i1 = int(np.ceil(t1 * ANALYSIS_HZ))
    m = max(1, i1 - i0)
    pitch = np.full((m, 2), -1.0, dtype=np.float32)
    pitch[:, 1] = 0.0
    lo = max(0, i0)
    hi = min(semis.size, i1)
    if hi > lo:
        seg = semis[lo:hi]
        pitch[lo - i0:hi - i0, 0] = np.where(np.isnan(seg), -1.0, seg)
        pitch[lo - i0:hi - i0, 1] = level[lo:hi]

    # 表示音域は曲全体で固定 (カットごとに縦がずれないように)。
    if notes:
        all_p = np.array([p for _s, _e, p, _l in notes], dtype=np.float32)
        r_lo, r_hi = float(all_p.min()), float(all_p.max())
    else:
        voiced = semis[~np.isnan(semis)]
        if voiced.size:
            r_lo, r_hi = float(np.percentile(voiced, 2)), float(np.percentile(voiced, 98))
        else:
            r_lo, r_hi = 57.0, 81.0
    in_win = [n for n in notes if n[1] >= t0 and n[0] <= t1]
    k = max(1, len(in_win))
    notes_arr = np.zeros((k, 3), dtype=np.float32)
    lyrics_arr = np.zeros((k, LYRIC_MAX_CHARS), dtype=np.float32)
    if not in_win:
        notes_arr[0] = (0.0, -1.0, -1.0)  # 空 (end < start) の番兵
    for j, (s, e, p, lyric) in enumerate(in_win):
        notes_arr[j] = (s, e, p)
        for c, ch in enumerate(lyric[:LYRIC_MAX_CHARS]):
            lyrics_arr[j, c] = float(ord(ch))
    meta = np.array([i0 / ANALYSIS_HZ, ANALYSIS_HZ, r_lo, r_hi], dtype=np.float32)
    return {"pitch": pitch, "notes": notes_arr, "lyrics": lyrics_arr, "meta": meta}

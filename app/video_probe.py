"""動画素材の PTS gap (= 録画ドロップ起因の時刻飛び) を検査するヘルパ。

NVIDIA ShadowPlay / NVENC 系のリアルタイム録画ソフトは、ホスト負荷で frame drop
した瞬間に container 上の audio decoded frame の pts_time を「飛ばして」記録する
ことがある (mp4 規格としては valid)。この素材を素直に編集経路に流すと、source-time
(= PTS) 駆動の映像と sample-count base の音声で進み方が一致せず、映像と音がズレる。

この module は「素材を VL に attach する直前に検査して、gap > 50ms が 1 箇所でも
あったら ffmpeg で再エンコードして時刻を埋め直すよう促す」目的の probe を提供する。
再エンコード本体は `app.video_fix` 側。
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .global_config import ffprobe_executable
from .log_setup import app_logger
from .paths import PROJECT_ROOT

_log = app_logger("video_probe")

GAP_THRESHOLD_SEC = 0.05


@dataclass(frozen=True)
class PtsGap:
    source_start_sec: float
    source_end_sec: float
    gap_sec: float


def probe_pts_gaps(src_path: Path, *, threshold_sec: float = GAP_THRESHOLD_SEC) -> dict | None:
    """audio decoded frame の pts_time を走査して gap を検出する。

    戻り値 (gap が無くても non-None なら検査成功):
      - sampleRate: int
      - frameCount: int
      - audioDurationSec: float (sample-count base = gap を含まない実音長)
      - sourceDurationSec: float (frame の pts_time + nb_samples/sr 末尾 = container 名目)
      - gaps: list[{sourceStart, sourceEnd, gapSec}]
      - totalGapSec: float
    検査失敗 (audio stream が無い / ffprobe エラー) のときは None。
    """
    sr = _probe_sample_rate(src_path)
    if sr is None:
        return None
    frames = _probe_audio_frames(src_path)
    if not frames:
        return None

    gaps: list[dict] = []
    total_gap = 0.0
    cumulative_samples = 0
    for i, (pts_time, nb_samples) in enumerate(frames):
        if i > 0:
            prev_pts, prev_n = frames[i - 1]
            delta = pts_time - prev_pts - prev_n / sr
            if delta > threshold_sec:
                gaps.append({
                    "sourceStart": prev_pts + prev_n / sr,
                    "sourceEnd": pts_time,
                    "gapSec": delta,
                })
                total_gap += delta
        cumulative_samples += nb_samples

    last_pts, last_n = frames[-1]
    audio_duration = cumulative_samples / float(sr)
    source_duration = last_pts + last_n / float(sr)
    return {
        "sampleRate": sr,
        "frameCount": len(frames),
        "audioDurationSec": audio_duration,
        "sourceDurationSec": source_duration,
        "gaps": gaps,
        "totalGapSec": total_gap,
    }


def file_sha1_short(path: Path, *, length: int = 16) -> str | None:
    """ファイル先頭〜末尾の SHA1 を返す (sidecar の original_sha 用)。

    大きい mp4 でも 1 回 stream で読むだけ。失敗時は None。
    """
    try:
        h = hashlib.sha1()
        with path.open("rb") as fp:
            for chunk in iter(lambda: fp.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()[:length]
    except OSError:
        return None


def fixed_paths_for(src_path: Path) -> tuple[Path, Path]:
    """src_path に対する <basename>.fixed.mp4 と sidecar JSON の Path を返す。

    元素材と同じディレクトリ。拡張子は強制 .mp4 (元が .mov / .mkv でも .mp4 に統一)。
    """
    stem = src_path.stem
    parent = src_path.parent
    fixed = parent / f"{stem}.fixed.mp4"
    sidecar = parent / f"{stem}.fixed.mp4.json"
    return fixed, sidecar


def load_sidecar(sidecar_path: Path) -> dict | None:
    if not sidecar_path.exists():
        return None
    try:
        return json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def check_existing_fixed(src_path: Path) -> dict | None:
    """既に .fixed.mp4 + sidecar があり、sidecar の original_sha が今の src と一致するなら
    その情報 ({fixedPath, sidecar}) を返す。一致しないか欠けていれば None。
    """
    fixed_path, sidecar_path = fixed_paths_for(src_path)
    if not fixed_path.exists():
        return None
    sidecar = load_sidecar(sidecar_path)
    if not sidecar:
        return None
    cur_sha = file_sha1_short(src_path)
    if cur_sha is None or sidecar.get("originalSha1") != cur_sha:
        return None
    try:
        rel = fixed_path.resolve().relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        return None
    return {
        "fixedPath": str(rel).replace("\\", "/"),
        "sidecar": sidecar,
    }


def _probe_sample_rate(src_path: Path) -> int | None:
    cmd = [
        ffprobe_executable(),
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate",
        "-of", "default=nokey=1:noprint_wrappers=1",
        str(src_path),
    ]
    try:
        r = subprocess.run(
            cmd, cwd=PROJECT_ROOT, capture_output=True, text=True,
            timeout=60.0, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    try:
        sr = int(r.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        return None
    return sr if sr > 0 else None


def _probe_audio_frames(src_path: Path) -> list[tuple[float, int]]:
    cmd = [
        ffprobe_executable(),
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "frame=pts_time,nb_samples",
        "-of", "csv=p=0",
        str(src_path),
    ]
    try:
        r = subprocess.run(
            cmd, cwd=PROJECT_ROOT, capture_output=True, text=True,
            timeout=300.0, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if r.returncode != 0:
        _log.warning("ffprobe failed: %s", r.stderr.strip()[:200])
        return []
    out: list[tuple[float, int]] = []
    for line in r.stdout.splitlines():
        parts = line.strip().split(",")
        if len(parts) < 2:
            continue
        try:
            pts = float(parts[0])
            nb = int(parts[1])
        except (ValueError, IndexError):
            continue
        if nb <= 0:
            continue
        out.append((pts, nb))
    return out

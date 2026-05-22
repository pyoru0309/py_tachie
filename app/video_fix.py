"""PTS gap を含む動画素材を「真の CFR + silence 埋め」で再エンコードするヘルパ。

`video_probe.probe_pts_gaps` で gap が検出された素材を、このアプリで扱える正規形
(= source-time と sample-time が完全一致する mp4) に変換する。

- 映像: `-vsync cfr -r {fps}` で PTS gap 区間を直前 frame の複製で埋めて真の CFR 化
- 音声: `-af aresample=async=1000:first_pts=0` で gap 区間に silence sample を挿入
- 容器: H.264 (libx264) + AAC で .mp4 化、faststart で先頭シーク高速化

進捗は ffmpeg `-progress pipe:1 -nostats` の out_time_us を読んで callback で通知する。
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .encoders import build_encoder_args, kind_display_name
from .global_config import ffmpeg_executable
from .log_setup import app_logger
from .paths import PROJECT_ROOT

_log = app_logger("video_fix")


def reencode_with_gap_fill(
    src: Path,
    dest: Path,
    *,
    encoder_kind: str = "hw",
    target_fps: int = 60,
    total_duration_sec: float | None = None,
    progress_cb: Callable[[float], None] | None = None,
    stderr_cb: Callable[[str], None] | None = None,
) -> tuple[bool, str]:
    """ffmpeg で CFR + silence 埋め再エンコードを行う。

    戻り値: (success, resolved_kind)
      - success: True/False
      - resolved_kind: "hw_videotoolbox" / "hw_nvenc" / "balanced" / "quality" 等
        (sidecar / ログ用)

    `encoder_kind`:
      - "hw"  → HW 検出すれば videotoolbox/nvenc/qsv/vaapi、なければ balanced に fallback
      - "balanced" → libx264 medium crf=18
      - "quality"  → libx264 slow   crf=15

    `total_duration_sec` が分かっていれば progress_cb に 0..1 の比率を渡す。
    None なら進捗不明として callback は呼ばない (= 完了時 1.0 だけ呼ぶ)。
    """
    video_args, resolved_kind = build_encoder_args(encoder_kind)
    cmd = [
        ffmpeg_executable(),
        "-y",
        "-fflags", "+genpts",
        "-i", str(src),
        "-vsync", "cfr",
        "-r", str(int(target_fps)),
        "-af", "aresample=async=1000:first_pts=0",
        *video_args,
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        str(dest),
    ]
    _log.info(
        "start: src=%s → %s encoder=%s fps=%d",
        src.name, dest.name, kind_display_name(resolved_kind), target_fps,
    )
    proc = subprocess.Popen(
        cmd,
        cwd=PROJECT_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            if line.startswith("out_time_us="):
                if progress_cb and total_duration_sec and total_duration_sec > 0:
                    try:
                        us = float(line.split("=", 1)[1])
                        ratio = min(0.999, max(0.0, us / 1e6 / total_duration_sec))
                        progress_cb(ratio)
                    except (ValueError, IndexError):
                        pass
            elif line == "progress=end":
                break
        rc = proc.wait(timeout=30.0)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5.0)
        if stderr_cb:
            stderr_cb("ffmpeg wait timeout")
        return False, resolved_kind
    except Exception as exc:  # noqa: BLE001
        proc.kill()
        if stderr_cb:
            stderr_cb(f"unexpected error: {exc!r}")
        return False, resolved_kind

    if rc != 0:
        err = ""
        try:
            assert proc.stderr is not None
            err = proc.stderr.read()[-2000:]
        except Exception:  # noqa: BLE001
            pass
        if stderr_cb and err:
            stderr_cb(err)
        _log.warning("FAILED rc=%d: %s", rc, err[-500:])
        return False, resolved_kind

    if progress_cb:
        progress_cb(1.0)
    _log.info("OK: %s", dest.name)
    return True, resolved_kind


def write_sidecar(
    sidecar_path: Path,
    *,
    original_rel: str,
    original_sha1: str,
    probe: dict,
    encoder_kind_request: str,
    resolved_kind: str,
    target_fps: int,
) -> None:
    """fixed 版に対応する sidecar JSON を書く。

    `originalSha1` は再 attach 時のスキップ判定 (= 元素材が同じなら再変換しない) に
    使う。`probe` は probe_pts_gaps の戻り値スナップショット (= 何 gap を埋めたか)。
    `encoder_kind_request` は UI 上の選択 ("hw" / "balanced" / "quality")、
    `resolved_kind` は実際に走ったエンコーダ (= HW 非検出時の fallback も反映)。
    """
    payload = {
        "originalPath": original_rel,
        "originalSha1": original_sha1,
        "encodedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "params": {
            "encoderKindRequest": str(encoder_kind_request),
            "resolvedKind": str(resolved_kind),
            "targetFps": int(target_fps),
        },
        "probe": {
            "audioDurationSec": probe.get("audioDurationSec"),
            "sourceDurationSec": probe.get("sourceDurationSec"),
            "totalGapSec": probe.get("totalGapSec"),
            "gapCount": len(probe.get("gaps") or []),
        },
    }
    sidecar_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

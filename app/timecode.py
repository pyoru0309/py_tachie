"""タイムコード変換ヘルパ。

プロジェクトの基準 fps (PROJECT_FPS = 24) に対する
秒 ↔ 整数フレームの変換と MM:SS.FF 形式の整形を提供する。
"""

from __future__ import annotations

import re
from typing import Any

PROJECT_FPS = 24
CHARACTER_ANIMATION_FPS_CHOICES = (8, 12, 24)
CHARACTER_ANIMATION_FPS_DEFAULT = 12

_TIMECODE_PATTERN = re.compile(r"^\s*(\d{1,3}):(\d{1,2})\.(\d{1,2})\s*$")


def sec_to_frames(value: Any, fps: int = PROJECT_FPS) -> int:
    if value is None or value == "":
        return 0
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return 0
    if seconds <= 0:
        return 0
    return int(round(seconds * fps))


def frames_to_sec(frames: Any, fps: int = PROJECT_FPS) -> float:
    if frames is None or frames == "":
        return 0.0
    try:
        f = int(frames)
    except (TypeError, ValueError):
        try:
            f = int(round(float(frames)))
        except (TypeError, ValueError):
            return 0.0
    if f <= 0:
        return 0.0
    return f / float(fps)


def format_timecode(frames: int, fps: int = PROJECT_FPS) -> str:
    """`MM:SS.FF` 形式 (FF はフレーム番号 0..fps-1)."""
    f = max(0, int(frames))
    total_seconds = f // fps
    frame_part = f % fps
    minutes = total_seconds // 60
    seconds = total_seconds % 60
    return f"{minutes:02d}:{seconds:02d}.{frame_part:02d}"


def parse_timecode(text: str, fps: int = PROJECT_FPS) -> int | None:
    """`MM:SS.FF` を整数フレームに変換。失敗時 None。"""
    if text is None:
        return None
    m = _TIMECODE_PATTERN.match(str(text))
    if not m:
        return None
    minutes = int(m.group(1))
    seconds = int(m.group(2))
    frames = int(m.group(3))
    if seconds >= 60 or frames >= fps:
        return None
    return (minutes * 60 + seconds) * fps + frames


def normalize_character_animation_fps(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return CHARACTER_ANIMATION_FPS_DEFAULT
    if n in CHARACTER_ANIMATION_FPS_CHOICES:
        return n
    return CHARACTER_ANIMATION_FPS_DEFAULT

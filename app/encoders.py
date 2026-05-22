"""H.264 エンコーダ検出と ffmpeg 引数ビルダ。

video_fix (PTS gap 補正) と v2_export (動画書き出し) の両方で使う。

- `detect_h264_encoders()`: ffmpeg `-hide_banner -encoders` をパースして
  videotoolbox / nvenc / qsv / vaapi の可用性を判定 (起動時 1 回 memoize)
- `build_encoder_args(kind, ...)`: encoder_kind と quality_level (= "balanced" / "quality")
  から `-c:v ... -preset ... -crf/-cq/-q:v ...` の引数列を返す

`kind = "hw"` のときは検出された HW エンコーダを優先順位で 1 つ選ぶ:
  macOS:  videotoolbox
  Windows + NVIDIA: nvenc
  Linux:  vaapi (Intel/AMD) or nvenc (NVIDIA)
  Intel iGPU on Win/Linux: qsv
ふさわしい HW が見つからなければ libx264 にフォールバック (= 利用者向けに「HW 無し」
を別途案内するため `available()` で事前に判定できるようにする)。
"""

from __future__ import annotations

import functools
import subprocess
import sys
from dataclasses import dataclass

from .global_config import ffmpeg_executable
from .log_setup import app_logger

_log = app_logger("encoders")

# HW 優先順 (=「auto/HW」選択時にこの順で実在性を見て採択)
_HW_PRIORITY = ("videotoolbox", "nvenc", "qsv", "vaapi")

# 各 HW エンコーダの ffmpeg 識別子
_ENCODER_NAME = {
    "videotoolbox": "h264_videotoolbox",
    "nvenc": "h264_nvenc",
    "qsv": "h264_qsv",
    "vaapi": "h264_vaapi",
    "software": "libx264",
}


@dataclass(frozen=True)
class EncoderAvailability:
    """利用可能な H.264 エンコーダのスナップショット。"""
    videotoolbox: bool
    nvenc: bool
    qsv: bool
    vaapi: bool
    software: bool  # libx264 = ほぼ常時 True

    @property
    def preferred_hw(self) -> str | None:
        """HW 優先順で見て最初に見つかったキーを返す。無ければ None。"""
        for k in _HW_PRIORITY:
            if getattr(self, k):
                return k
        return None

    @property
    def has_any_hw(self) -> bool:
        return self.preferred_hw is not None

    def to_dict(self) -> dict[str, bool | str | None]:
        return {
            "videotoolbox": self.videotoolbox,
            "nvenc": self.nvenc,
            "qsv": self.qsv,
            "vaapi": self.vaapi,
            "software": self.software,
            "preferredHw": self.preferred_hw,
            "preferredHwEncoder": _ENCODER_NAME[self.preferred_hw] if self.preferred_hw else None,
        }


@functools.lru_cache(maxsize=1)
def detect_h264_encoders() -> EncoderAvailability:
    """ffmpeg の `-encoders` 一覧から H.264 用 HW エンコーダを検出する。

    起動時 1 回 (lru_cache) のみ実行。ffmpeg のバージョン違いで識別子名が変わる
    ことは無いが、念のためエラー時は software 単独で返す。
    """
    cmd = [ffmpeg_executable(), "-hide_banner", "-encoders"]
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=15.0, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        _log.warning("ffmpeg -encoders failed: %r", exc)
        return EncoderAvailability(False, False, False, False, True)
    text = r.stdout or ""
    avail = EncoderAvailability(
        videotoolbox="h264_videotoolbox" in text,
        nvenc="h264_nvenc" in text,
        qsv="h264_qsv" in text,
        vaapi="h264_vaapi" in text,
        software="libx264" in text,
    )
    chosen = avail.preferred_hw or "software"
    _log.info(
        "detected: vt=%s nvenc=%s qsv=%s vaapi=%s sw=%s → preferred HW=%s",
        avail.videotoolbox, avail.nvenc, avail.qsv, avail.vaapi, avail.software, chosen,
    )
    return avail


def resolve_encoder(kind: str) -> tuple[str, str]:
    """`kind` (= "hw" / "balanced" / "quality" / specific HW key) を
    実エンコーダ識別子に解決する。

    戻り値: (encoder_name, resolved_kind)
      - encoder_name: ffmpeg に渡す `-c:v <name>`
      - resolved_kind: "hw_videotoolbox" / "hw_nvenc" / "hw_qsv" / "hw_vaapi" /
                      "balanced" / "quality" (= ログや UI 表示用)

    "hw" でかつ HW 不在のときは "balanced" にフォールバックする。
    """
    avail = detect_h264_encoders()
    if kind == "hw":
        chosen = avail.preferred_hw
        if chosen is None:
            return _ENCODER_NAME["software"], "balanced"
        return _ENCODER_NAME[chosen], f"hw_{chosen}"
    if kind in _HW_PRIORITY:
        if not getattr(avail, kind):
            return _ENCODER_NAME["software"], "balanced"
        return _ENCODER_NAME[kind], f"hw_{kind}"
    if kind in ("balanced", "quality"):
        return _ENCODER_NAME["software"], kind
    # 不明 kind は安全側で balanced
    return _ENCODER_NAME["software"], "balanced"


def build_encoder_args(kind: str) -> tuple[list[str], str]:
    """kind から ffmpeg 引数列 (`-c:v ... -preset ... -crf/-cq/-q:v ...`) を返す。

    戻り値: (args, resolved_kind)
      - args: list[str] (例 `["-c:v", "h264_videotoolbox", "-q:v", "55", ...]`)
      - resolved_kind: ログ表示用 (resolve_encoder と同じ)

    quality 寄り (kind="quality") は software (libx264 -preset slow -crf 15)、
    balanced (kind="balanced") は software (libx264 -preset medium -crf 18)。
    HW (kind="hw" or 個別 HW キー) は HW の品質寄せパラメータで固定。
    """
    encoder, resolved = resolve_encoder(kind)
    args: list[str] = ["-c:v", encoder]
    if resolved == "hw_videotoolbox":
        # Apple Silicon の VideoToolbox は -q:v で品質指定 (0-100, 高いほど高品質)。
        # 55-65 で「視覚的に十分」+「サイズ も妥当」。素材正規化用途には十分。
        args += ["-q:v", "60", "-realtime", "0"]
    elif resolved == "hw_nvenc":
        # NVENC は preset p1..p7 + tune (hq/ll/ull) + cq で指定。
        # p5 + tune hq + cq 22 は libx264 medium crf 22 相当。
        args += ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "22", "-b:v", "0"]
    elif resolved == "hw_qsv":
        args += ["-preset", "slow", "-global_quality", "22", "-look_ahead", "1"]
    elif resolved == "hw_vaapi":
        args += ["-qp", "22"]
    elif resolved == "quality":
        args += ["-preset", "slow", "-crf", "15"]
    else:  # balanced / fallback
        args += ["-preset", "medium", "-crf", "18"]
    args += ["-pix_fmt", "yuv420p"]
    return args, resolved


def kind_display_name(resolved_kind: str) -> str:
    """ログ / UI 表示用の人間可読名を返す。"""
    return {
        "hw_videotoolbox": "ハードウェア (VideoToolbox)",
        "hw_nvenc": "ハードウェア (NVENC)",
        "hw_qsv": "ハードウェア (QSV)",
        "hw_vaapi": "ハードウェア (VA-API)",
        "balanced": "バランス (libx264 medium / crf=18)",
        "quality": "画質重視 (libx264 slow / crf=15)",
    }.get(resolved_kind, resolved_kind)

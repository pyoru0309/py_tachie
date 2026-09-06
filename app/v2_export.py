"""WebGL export 本実装の WebSocket / REST 経路。

ブラウザ側 (`static/js/export/`) が WebGL で 1 frame 描画 → readPixels →
WS binary で raw RGBA を送る。サーバはそれを ffmpeg stdin に流して mp4 に
encode する。`v2_export_bench.py` (測定用) と分けて、export 本線はこちらで
小さく持つ。

API:
    GET  /api/v2/export/capabilities  — encoder 検出結果 (ffmpeg -encoders cache)
    WS   /api/v2/export/ws            — 1 cut 分の export

WS プロトコル:
    最初: JSON (ExportHandshake): width/height/fps/encoder/vflip/totalFrames/
            projectId/cutId/outputPath?
    以降: binary RGBA (W*H*4 bytes) を 1 frame ごと
    終端: client から JSON {"type": "finish"}

サーバ→client:
    {"type":"ready", "outputPath":..., "ffmpegCmd":[...]}
    {"type":"progress", "frames":N, "elapsedSec":...}
    {"type":"done", "fps":..., "ffmpegRc":0, ...}
    {"type":"error", "code": ERR_*, "detail":"..."}
        ERR_INVALID_CONFIG / ERR_OUTPUT_PATH_REJECTED / ERR_FFMPEG_SPAWN_FAILED
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from statistics import mean
from typing import Any, Literal, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

from .assets import asset_url
from .export_video import (
    _build_audio_amix_segments,
    _make_single_cut_scene,
    _scene_total_duration,
    audio_duration_seconds,
    audio_volume_by_frame,
    build_video_codec_args,
    container_args as preset_container_args,
    merge_contiguous_audio_video_layers,
    prepare_clean_pcm,
    source_to_stream_time,
    video_metadata,
)
from .global_config import current_projects_dir, ffmpeg_executable, resolve_video_preset
from .log_setup import app_logger
from .paths import OUTPUT_DIR
from .render import safe_asset_path
from .timecode import PROJECT_FPS
from .utils import current_project

_log = app_logger("v2_export")
from .scenario import ensure_scenario, resolve_effective_scene
from .manifest import ensure_manifest

router = APIRouter()

# 既知 encoder。Literal は Pydantic で素直に検証できる + フロントとの契約を 1 箇所
# に集約できる。新規 encoder 追加時はここと _build_ffmpeg_cmd の両方を更新。
EncoderId = Literal[
    "h264_videotoolbox",
    "h264_nvenc",
    "libx264_fast",
    "prores_4444",       # 透過 ProRes 4444 (.mov, alpha 保持)
    "png_video",         # 透過 QuickTime PNG (.mov, alpha 保持)
    "null",
]
KNOWN_ENCODERS: tuple[str, ...] = (
    "h264_videotoolbox",
    "h264_nvenc",
    "libx264_fast",
    "prores_4444",
    "png_video",
    "null",
)
# 透過出力 = bg を WebGL 側で描かず alpha=0 を保持する codec。
# 自動命名は .mov、他は .mp4。
TRANSPARENT_ENCODERS: frozenset[str] = frozenset({"prores_4444", "png_video"})

# エラーコード規約。client 側はこれを `code` で switch して UI 文言を出す。
ERR_INVALID_CONFIG = "INVALID_CONFIG"
ERR_OUTPUT_PATH_REJECTED = "OUTPUT_PATH_REJECTED"
ERR_FFMPEG_SPAWN_FAILED = "FFMPEG_SPAWN_FAILED"


# ---------- Handshake モデル ----------------------------------------------


class ExportHandshake(BaseModel):
    """`/api/v2/export/ws` の最初のテキストメッセージ。

    フィールド順は `static/js/export/export-session.js` の handshake 構築順と
    揃える。Pydantic v2 の strict 検証に頼って、欠落 / 型不一致を WS error で
    返す (HTTP 400 ではない、WS は既に accept 済みのため)。
    """

    model_config = {"extra": "forbid"}

    width: int = Field(..., gt=0, le=7680, description="出力幅 (px)")
    height: int = Field(..., gt=0, le=4320, description="出力高 (px)")
    fps: int = Field(24, gt=0, le=120)
    encoder: EncoderId = "h264_videotoolbox"
    vflip: bool = True
    totalFrames: int = Field(..., gt=0, le=600_000)
    projectId: str = ""
    cutId: str = "cut"
    # "cut" = 単一カット書き出し (既定)、"project" = シナリオ全体書き出し。
    # サーバ処理は frame 単位では同一で、出力ファイル名のデフォルトと
    # progress / done のラベルだけ変わる。シーン / カット構造はクライアント側
    # だけが知る (サーバは raw RGBA を ffmpeg に流すだけ)。
    mode: Literal["cut", "project"] = "cut"
    # フレーム転送方式。"rawrgba" (既定) = 生 RGBA を pipe で受けて ffmpeg が
    # エンコード (従来経路)。"webcodecs-h264" = ブラウザが WebCodecs で H.264
    # (annexb elementary stream) にエンコード済みのチャンクを送る → サーバは
    # ffmpeg `-f h264 -i pipe:0 -c copy` でコンテナ化のみ (再エンコード無し)。
    # 生 RGBA 8.29MB/frame の転送が律速だった Windows 書き出しの高速化用
    # (2026-06-02)。webcodecs では preset の codec 設定は無視し copy 固定、
    # 出力拡張子だけ preset (.mp4) を流用する。
    transport: Literal["rawrgba", "webcodecs-h264"] = "rawrgba"
    # 明示パス。未指定なら projects/{id}/exports/v2_<cut>_<ts>.mp4 を自動命名。
    # 制約は `_resolve_output_path` で別途検証 (ValidationError ではなく
    # OUTPUT_PATH_REJECTED として返したいため)。
    outputPath: Optional[str] = None
    # v1 互換 preset 経由 (本線 UI から渡る)。set されているとこちらを優先し、
    # `encoder` フィールドは無視する (= /v2-export-bench は preset を渡さず
    # encoder Literal だけで動く既存経路を保つ)。
    videoPresetId: Optional[str] = None
    # preset 内で動的に上書きする項目 (UI のエンコードエンジン / CRF / maxrate /
    # encoderPreset)。`build_video_codec_args(preset, options)` がそのまま読む。
    presetOptions: Optional[dict[str, Any]] = None


# ---------- 出力先解決 ----------------------------------------------------


_SAFE_PATH_RE = re.compile(r"[^A-Za-z0-9._\-]")


def _sanitize_segment(seg: str, fallback: str) -> str:
    """ファイル名に使える文字だけに正規化。空 / `..` 系は fallback に倒す。"""
    cleaned = _SAFE_PATH_RE.sub("_", (seg or "").strip())
    cleaned = cleaned.strip("._")
    return cleaned or fallback


def _is_inside(path: Path, root: Path) -> bool:
    """`path` (resolve 済み) が `root` (resolve 済み) の子孫か。"""
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _resolve_output_path(
    project_id: str,
    cut_id: str,
    explicit: Optional[str],
    encoder: str,
    mode: str = "cut",
    *,
    extension_override: Optional[str] = None,
) -> tuple[Optional[Path], Optional[str]]:
    """出力先を決める。

    encoder == "null" は出力ファイル無し → (None, None)。
    explicit 指定があれば安全制約を通したうえで採用。なければ自動命名:
      - mode="cut"     → projects/{id}/outputs/v2_<cut>_<ts>.mp4
      - mode="project" → projects/{id}/outputs/scenario_<ts>.mp4
    戻り値: (path, error_detail)。error_detail が非 None なら reject。

    出力先は v1 と揃えて `projects/{id}/outputs/` 配下に置く (= 旧 v1 が
    ctx.output_dir = projects/<id>/outputs を使っていたのと同じ場所)。
    `projects/{id}/exports/` (シナリオ・テロップ書き出し) と被らないようにする。

    `extension_override` を渡すと preset に従う (例: ".mov")。透過判定が
    encoder Literal の TRANSPARENT_ENCODERS と一致しない preset (ProRes 422
    proxy/HQ など) もここから来る。
    """
    if encoder == "null":
        return None, None

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_cut = _sanitize_segment(cut_id, "cut")
    if extension_override:
        extension = extension_override
    else:
        # encoder に応じて出力拡張子を決定 (透過は .mov 必須)
        is_transparent = encoder in TRANSPARENT_ENCODERS
        extension = ".mov" if is_transparent else ".mp4"

    # 許可ルート: `projects/<id>/` 配下と `outputs/` (top-level) 配下のみ。
    # シンボリックリンクや `..` を含むパスは resolve で絶対化してから判定する。
    projects_root = current_projects_dir().resolve()
    outputs_root = OUTPUT_DIR.resolve()

    if explicit:
        try:
            cand = Path(explicit).expanduser()
            cand_resolved = cand.resolve() if cand.is_absolute() else (Path.cwd() / cand).resolve()
        except Exception as exc:
            return None, f"outputPath を解決できません: {exc}"

        # 透過 codec は .mov、それ以外は .mp4 を期待。
        if cand_resolved.suffix.lower() != extension:
            return None, (
                f"outputPath の拡張子は {extension} を期待 (got {cand_resolved.suffix or 'なし'})"
            )

        if not (
            _is_inside(cand_resolved, projects_root)
            or _is_inside(cand_resolved, outputs_root)
        ):
            return None, (
                "outputPath は projects/ または outputs/ の配下のみ許可されます: "
                f"{cand_resolved}"
            )

        cand_resolved.parent.mkdir(parents=True, exist_ok=True)
        return cand_resolved, None

    # 自動命名: mode で basename を切り替える、拡張子は透過 codec で .mov
    if mode == "project":
        basename = f"scenario_{ts}{extension}"
    else:
        basename = f"v2_{safe_cut}_{ts}{extension}"
    if project_id:
        try:
            root = current_projects_dir() / project_id
            if root.exists():
                # v1 互換: 動画 / PNG (mov) は projects/{id}/outputs/ に置く。
                # シナリオ・テロップの export/ とは分離する。
                out_dir = root / "outputs"
                out_dir.mkdir(parents=True, exist_ok=True)
                return out_dir / basename, None
        except Exception:
            pass
    fallback = OUTPUT_DIR / "v2_export"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback / basename, None


# ---------- ffmpeg コマンド生成 -------------------------------------------


def _build_ffmpeg_cmd(
    width: int,
    height: int,
    fps: int,
    encoder: str,
    vflip: bool,
    output_path: Optional[Path],
) -> list[str]:
    ffmpeg = ffmpeg_executable()
    cmd: list[str] = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
    ]
    # ffmpeg の進捗を stdout に key=value で吐かせる (1 秒間隔)。stdout を使うので、
    # null encoder (`-f null -` が stdout を使う) のときは添えない。
    if encoder != "null":
        cmd.extend(["-progress", "pipe:1"])
    cmd.extend([
        "-y",
        "-f", "rawvideo",
        "-pix_fmt", "rgba",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "pipe:0",
    ])
    if vflip:
        cmd.extend(["-vf", "vflip"])

    if encoder == "null":
        cmd.extend(["-f", "null", "-"])
        return cmd
    if encoder == "h264_videotoolbox":
        cmd.extend([
            "-c:v", "h264_videotoolbox",
            "-q:v", "50",
            "-pix_fmt", "yuv420p",
            str(output_path),
        ])
        return cmd
    if encoder == "h264_nvenc":
        cmd.extend([
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-rc", "vbr",
            "-cq", "22",
            "-b:v", "0",
            "-pix_fmt", "yuv420p",
            str(output_path),
        ])
        return cmd
    if encoder in ("libx264_fast", "libx264"):
        cmd.extend([
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "20",
            "-pix_fmt", "yuv420p",
            str(output_path),
        ])
        return cmd
    if encoder == "prores_4444":
        # ProRes 4444 with alpha (素材用書き出し)。yuva444p10le で透過保持。
        # profile=4 が ProRes 4444、profile=5 が ProRes 4444 XQ (より高ビットレート)。
        cmd.extend([
            "-c:v", "prores_ks",
            "-profile:v", "4",
            "-pix_fmt", "yuva444p10le",
            "-vendor", "apl0",
            str(output_path),
        ])
        return cmd
    if encoder == "png_video":
        # QuickTime PNG video (素材用、可逆)。フレーム単位 PNG なので尺が長いと
        # 巨大化するが、編集アプリへの「絶対劣化なしの中間素材」として有効。
        cmd.extend([
            "-c:v", "png",
            "-pix_fmt", "rgba",
            str(output_path),
        ])
        return cmd
    raise ValueError(f"unknown encoder: {encoder}")


def _build_ffmpeg_cmd_from_preset(
    width: int,
    height: int,
    fps: int,
    preset: dict[str, Any],
    options: dict[str, Any],
    vflip: bool,
    output_path: Path,
) -> list[str]:
    """v1 BUILTIN_VIDEO_PRESETS の preset 定義から ffmpeg コマンドを組み立てる。

    本線 UI (`#exportOptionsDialog`) はここを通る。書き出しダイアログのプリセット
    select / エンコードエンジン select / CRF / 最大ビットレート / encoderPreset の
    値が `options` に乗ってきて、v1 helper `build_video_codec_args` がそのまま
    解釈する (= v1 経路と同じコーデック設定を生成する)。

    rawvideo (RGBA) を pipe:0 から食わせる以外は v1 と完全に同じ ffmpeg 引数。
    `output_path` は `_resolve_output_path` 側で preset.extension に揃えて
    解決済み。
    """
    ffmpeg = ffmpeg_executable()
    cmd: list[str] = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        # ffmpeg 進捗を stdout に流す (key=value 1 秒毎)。preset 経路はファイル出力
        # 固定なので stdout は空き、競合しない。
        "-progress", "pipe:1",
        "-y",
        "-f", "rawvideo",
        "-pix_fmt", "rgba",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "pipe:0",
    ]
    if vflip:
        cmd.extend(["-vf", "vflip"])
    cmd.extend(build_video_codec_args(preset, options))
    cmd.extend(preset_container_args(preset))
    cmd.append(str(output_path))
    return cmd


def _build_ffmpeg_cmd_copy_h264(
    fps: int,
    output_path: Path,
) -> list[str]:
    """WebCodecs 経路用。H.264 annexb elementary stream を pipe:0 から受け、
    再エンコードせず `-c copy` でコンテナ化するだけのコマンド。

    ブラウザ (WebCodecs VideoEncoder, avc:{format:"annexb"}) が既に H.264 へ
    圧縮済みなので、サーバ側のエンコード負荷はゼロ。フレームのタイムスタンプは
    elementary stream に無いため、入力側 `-r fps` で CFR を付与する。
    vflip は不要 (canvas を VideoFrame でキャプチャするため上下反転しない)。
    出力は preset の拡張子 (.mp4) に合わせて解決済み。
    """
    ffmpeg = ffmpeg_executable()
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-progress", "pipe:1",
        "-y",
        "-r", str(fps),
        "-f", "h264",
        "-i", "pipe:0",
        "-c", "copy",
        "-movflags", "+faststart",
        str(output_path),
    ]


# ---------- capability 検出 -----------------------------------------------


# `ffmpeg -encoders` の出力例 (関心ある行):
#   V..... libx264              libx264 H.264 / AVC ...
#   V..... h264_nvenc           NVIDIA NVENC H.264 encoder ...
#   V..... h264_videotoolbox    VideoToolbox H.264 Encoder
_CAPS_INTEREST = (
    "h264_videotoolbox",
    "h264_nvenc",
    "libx264",
    "prores_ks",     # 将来 ProRes 4444 用
    "png",           # 将来 PNG 動画用
)
_capabilities_cache: dict | None = None


def _detect_capabilities() -> dict:
    """ffmpeg -encoders を 1 回叩いて、関心ある encoder の存在を bool で返す。

    起動毎に 1 回だけ実行 (cache)。失敗時は encoders を空にして platform だけ返す
    — その場合フロントは fallback chain の libx264_fast に倒れる。
    """
    global _capabilities_cache
    if _capabilities_cache is not None:
        return _capabilities_cache

    platform = sys.platform  # darwin / win32 / linux
    found: dict[str, bool] = {name: False for name in _CAPS_INTEREST}
    try:
        proc = subprocess.run(
            [ffmpeg_executable(), "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5.0,
            check=False,
        )
        for line in proc.stdout.splitlines():
            # フォーマット: " V..... <name>  <description>"
            parts = line.split()
            if len(parts) < 2:
                continue
            name = parts[1]
            if name in found:
                found[name] = True
    except Exception:
        # ffmpeg 不在 / timeout / parse 失敗。空 dict のまま続行。
        pass

    encoders: list[str] = []
    if found.get("h264_videotoolbox"):
        encoders.append("h264_videotoolbox")
    if found.get("h264_nvenc"):
        encoders.append("h264_nvenc")
    if found.get("libx264"):
        encoders.append("libx264_fast")
    # 透過素材用 (.mov)。OS や ffmpeg ビルドに関係なく、検出されたものだけ提供。
    if found.get("prores_ks"):
        encoders.append("prores_4444")
    if found.get("png"):
        encoders.append("png_video")

    # OS ごとの優先順。実機に存在しないものは fallback 候補にも入れない。
    if platform == "darwin":
        prefer_chain = ["h264_videotoolbox", "libx264_fast"]
    elif platform.startswith("win"):
        prefer_chain = ["h264_nvenc", "libx264_fast"]
    else:
        prefer_chain = ["libx264_fast"]
    fallback_chain = [e for e in prefer_chain if e in encoders]
    preferred = fallback_chain[0] if fallback_chain else None

    _capabilities_cache = {
        "platform": platform,
        "encoders": encoders,
        "preferred": preferred,
        "fallbackChain": fallback_chain,
        "raw": found,
    }
    return _capabilities_cache


# =============================================================================
# Animation timeline (cut-local, deterministic)
# =============================================================================
#
# v2 export を deterministic にするには、preview の real-time AudioContext +
# AnalyserNode 経路を使えない (= ブラウザのオーディオ再生に依存し、md5 不変が
# 崩れる)。代わりに:
#   - mouth: useForLipSync な BGM (or cut.audio) を ffmpeg + astats RMS_level で
#            per-frame Float32 levels に焼き、Float32Array binary stream として
#            scene-bundle に同梱する (visualizer streams と同じ流儀)。
#            client は levels[frameIdx] から mouthKey を毎フレーム deterministic に
#            算出する。
#   - blink: v1 _build_cut_runtime と同じ random.Random(cut.id+duration) で
#            cut-local frame indices を生成 (= deterministic)。JSON で同梱。
#   - motion: shake_x/y は既に elapsedSec の sin で deterministic。client 側で
#            elapsedSec から計算するだけ (サーバ送信不要)。
# =============================================================================

import random as _random_for_blink
import struct


def _blink_frames_with_seed(seed: str, duration_sec: float, fps: int) -> list[int]:
    """指定 seed の RNG で 1 キャラぶんの blink 開始 frame index を返す。"""
    rng = _random_for_blink.Random(seed)
    starts: set[int] = set()
    cursor = rng.uniform(2.8, 5.2)
    while cursor < duration_sec:
        starts.add(int(round(cursor * fps)))
        cursor += rng.uniform(3.2, 6.0)
    return sorted(starts)


def compute_cut_blink_frames(cut: dict[str, Any], fps: int) -> list[int]:
    """v1 互換: cut 全体で 1 本の blink schedule を返す (per-char ランダム化以前)。

    seed = "<cut.id>:<durationFrame>"。fps は cut-local frame index の単位。
    新規呼び出しは ``compute_cut_blink_frames_by_char`` を使う。
    """
    duration_frame = max(1, int(cut.get("durationFrame") or 0))
    duration_sec = duration_frame / float(PROJECT_FPS)
    return _blink_frames_with_seed(
        f"{cut.get('id', '')}:{duration_frame}", duration_sec, fps,
    )


def compute_cut_blink_frames_by_char(
    cut: dict[str, Any], fps: int, char_ids: list[str],
) -> dict[str, list[int]]:
    """キャラ ID ごとに独立な blink schedule を返す (export の deterministic 化用)。

    seed に char_id を加えるので、同じカット内でキャラ間のタイミングが必ずズレる。
    cut.id + duration + char_id が同じなら結果も同じ (再 export で md5 が動かない)。
    """
    duration_frame = max(1, int(cut.get("durationFrame") or 0))
    duration_sec = duration_frame / float(PROJECT_FPS)
    cut_id = str(cut.get("id", ""))
    out: dict[str, list[int]] = {}
    for cid in char_ids or []:
        if not cid:
            continue
        out[cid] = _blink_frames_with_seed(
            f"{cut_id}:{duration_frame}:{cid}", duration_sec, fps,
        )
    return out


def _ensure_full_track_lipsync_levels(
    audio_path: Path,
    fps: int,
    lip_sync_config: dict[str, Any],
    cache_dir: Path,
) -> Optional[list[float]]:
    """音源全長の per-frame lipsync levels を 1 回だけ ffmpeg astats で解析しキャッシュ。

    複数カットが同じ useForLipSync BGM を共有するとき、従来はカットごとに ffmpeg を
    起動して同じ WAV を解析していた (GL プロジェクトで 80 cut = 80 ffmpeg = 32s)。viz の
    音源単位キャッシュと同じ発想で全長を 1 回解析し、各カットは行スライスで切り出す。

    キャッシュキーは「音源同一性 (path+mtime) + fps + 解析パラメータ」のみで、カット位置
    や尺を含まない。``lipsync/src_<token>.bin`` に Float32 LE で永続化する。失敗時 None。
    """
    import hashlib as _hashlib
    import math as _math
    import os as _os

    try:
        mtime = audio_path.stat().st_mtime_ns
    except OSError:
        mtime = 0
    cfg = lip_sync_config or {}
    key = json.dumps(
        {
            "v": 1,
            "path": str(audio_path.resolve()),
            "mtime": mtime,
            "fps": int(fps),
            "cfg": {k: cfg.get(k) for k in sorted(cfg)},
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    src_token = _hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    out_dir = cache_dir / "lipsync"
    out_dir.mkdir(parents=True, exist_ok=True)
    src_path = out_dir / f"src_{src_token}.bin"

    if src_path.exists():
        try:
            raw = src_path.read_bytes()
            n = len(raw) // 4
            return list(struct.unpack(f"<{n}f", raw))
        except (OSError, struct.error):
            pass

    dur = audio_duration_seconds(audio_path)
    if not dur or dur <= 0:
        return None
    n_frames = max(1, int(_math.ceil(float(dur) * fps)))
    levels = audio_volume_by_frame(audio_path, fps, n_frames, cfg, start_sec=0.0)
    if not levels:
        return None
    tmp = src_path.with_suffix(".bin.tmp")
    tmp.write_bytes(struct.pack(f"<{len(levels)}f", *levels))
    _os.replace(tmp, src_path)
    return levels


def compute_cut_lipsync_levels(
    *,
    cut: dict[str, Any],
    scene: dict[str, Any],
    cache_dir: Path,
    project_id: str,
    token: str,
    fps: int,
    lip_sync_config: dict[str, Any],
) -> Optional[dict]:
    """useForLipSync BGM (or cut.audio) からカット範囲の per-frame Float32 levels を計算。

    成功時は cache_dir/lipsync/lvl_<token>.bin に書き出し、{url, shape, dtype} を返す。
    存在しなければ None。同じ token のファイルがあれば再計算 skip (= cache hit)。
    """
    duration_frame = max(1, int(cut.get("durationFrame") or 0))
    cut_start_sec = max(0, int(cut.get("startFrame") or 0)) / float(PROJECT_FPS)
    cut_total_frames = max(1, int(round(duration_frame * fps / PROJECT_FPS)))

    # cut.audio (= 話者音声) を最優先。なければ scene の useForLipSync BGM。
    # v1 は scene 全体の levels を 1 回計算してカット範囲を slice しているので
    # 同じ流儀にする (= scene 内で複数 cut が同じ BGM を共有するときキャッシュが
    # 効く)。ここでは「カット 1 つ分」を直接計算するのでも結果は同じ。
    audio_path: Optional[Path] = None
    audio_start_sec = 0.0
    # 音源全長キャッシュ+スライスを使うのは「複数カットが同じ音源を共有」するケース
    # (= useForLipSync BGM) だけ。cut.audio (= カットごとに異なる話者音声) は共有されず、
    # 全長キャッシュ化すると ffprobe + 余計な bin I/O のオーバーヘッドだけ増える
    # (口パク中心プロジェクトの回帰)。その場合は従来の per-cut 直接解析を使う。
    use_source_cache = False
    cut_audio = cut.get("audio")
    if cut_audio:
        try:
            ap = safe_asset_path(str(cut_audio))
            if ap and ap.exists():
                audio_path = ap
                audio_start_sec = 0.0  # cut.audio 自体が cut 開始から始まる前提
        except Exception:
            audio_path = None
    if audio_path is None:
        # scene の useForLipSync BGM を採用 (cut 範囲を切り出す)
        for bgm in scene.get("bgmTracks") or []:
            if not isinstance(bgm, dict) or not bgm.get("useForLipSync"):
                continue
            try:
                bp = safe_asset_path(str(bgm.get("src") or ""))
            except Exception:
                bp = None
            if bp and bp.exists():
                audio_path = bp
                try:
                    bgm_trim = max(0.0, float(bgm.get("trimStartSec") or 0.0))
                except (TypeError, ValueError):
                    bgm_trim = 0.0
                # BGM の bgm_trim 後を 0 秒として扱い、シーン上の `cut_start_sec` から開始
                audio_start_sec = bgm_trim + cut_start_sec
                use_source_cache = True  # 同一 BGM を全カットが共有 → 全長 1 回解析が効く
                break

    if audio_path is None:
        return None

    # cache .bin
    out_dir = cache_dir / "lipsync"
    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = out_dir / f"lvl_{token}.bin"
    rel_path = f"lipsync/lvl_{token}.bin"

    if not bin_path.exists():
        # 音源全長キャッシュからカット範囲をスライスする (= 同一 BGM 共有時に ffmpeg を
        # カット数ぶん起動しない)。フル解析が失敗したときだけ従来の per-cut ffmpeg に倒す。
        levels: Optional[list[float]] = None
        if use_source_cache:
            full = _ensure_full_track_lipsync_levels(audio_path, fps, lip_sync_config or {}, cache_dir)
            if full is not None:
                start_frame = max(0, int(round(audio_start_sec * fps)))
                levels = list(full[start_frame : start_frame + cut_total_frames])
        if not levels:
            levels = audio_volume_by_frame(
                audio_path,
                fps,
                cut_total_frames,
                lip_sync_config or {},
                start_sec=audio_start_sec,
            )
        if not levels:
            # 計算失敗 (ffmpeg エラー等)。None で返す。
            return None
        # 長さ揃え (audio_volume_by_frame は要求 frames 数で初期化済みだが念のため)
        if len(levels) < cut_total_frames:
            levels = list(levels) + [0.0] * (cut_total_frames - len(levels))
        elif len(levels) > cut_total_frames:
            levels = levels[:cut_total_frames]
        # Float32 LE で書き出す
        with bin_path.open("wb") as f:
            f.write(struct.pack(f"<{len(levels)}f", *levels))

    return {
        "url": f"/project-cache/{project_id}/{rel_path}",
        "shape": [cut_total_frames],
        "dtype": "float32",
    }


@router.get("/api/v2/export/plan")
def get_export_plan() -> dict:
    """multi-cut export 用の frame budget + sceneBackground まとめ。

    シナリオ全体を 1 つの mp4 に書き出すクライアントが、各シーンの:
      - sceneTotalFrames (= ceil(scene_total_duration * PROJECT_FPS))
      - cuts[] (id / startFrame / durationFrame)
      - sceneBackground (gap frame で使う背景画像 / null=透過)
    を 1 リクエストで取得できるようにする。client 側で `_scene_total_duration`
    相当を再実装させない (= ロジック分散の防止) のが目的。

    PROJECT_FPS = 24 固定 (CLAUDE.md 非機能事項)。export fps != PROJECT_FPS の
    decimation は別フェーズで扱う。

    レスポンス:
      {
        "fps": 24,
        "grandTotalFrames": int,
        "scenes": [
          {
            "sceneIdx": int,
            "sceneTotalFrames": int,
            "sceneBackground": {"type": "image", "url": "/assets/..."} | null,
            "cuts": [{"id": str, "startFrame": int, "durationFrame": int}, ...]
          },
          ...
        ]
      }
    """
    ctx = current_project()
    manifest = ensure_manifest(ctx)
    scenario = ensure_scenario(manifest, ctx)

    fps = PROJECT_FPS  # 当面 24 固定
    scenes_out: list[dict] = []
    grand_total = 0

    for sidx, scene in enumerate(scenario.get("scenes") or []):
        if not isinstance(scene, dict):
            continue
        # bedScope に従いプロジェクト通し設定を反映した「解決済みシーン」で読む。
        scene = resolve_effective_scene(scenario, scene)

        # v1 と同じロジックで scene 末尾を求める。fps == PROJECT_FPS なので
        # ceil(duration_sec * fps) は frame と一致する。
        duration_sec = _scene_total_duration(scene)
        scene_total_frames = max(1, int(round(duration_sec * fps)))

        # 背景: scene["background"] は assets 相対パス文字列 (`scene_background`
        # が空文字 or 存在しないこともある)。
        bg_path = (scene.get("background") or "").strip()
        if bg_path:
            bg_url = asset_url(bg_path)
            scene_background = {"type": "image", "url": bg_url} if bg_url else None
        else:
            scene_background = None  # gap は透過扱い

        cuts_out: list[dict] = []
        for cut in scene.get("cuts") or []:
            if not isinstance(cut, dict):
                continue
            cuts_out.append({
                "id": str(cut.get("id") or ""),
                "startFrame": max(0, int(cut.get("startFrame") or 0)),
                "durationFrame": max(1, int(cut.get("durationFrame") or 0)),
            })

        scenes_out.append({
            "sceneIdx": sidx,
            "sceneTotalFrames": scene_total_frames,
            "sceneBackground": scene_background,
            "cuts": cuts_out,
        })
        grand_total += scene_total_frames

    return {
        "fps": fps,
        "grandTotalFrames": grand_total,
        "scenes": scenes_out,
        "projectId": ctx.id,
    }


# =============================================================================
# 音声 mux endpoint
# =============================================================================
#
# v2 video export が出力した映像のみの mp4 に、シナリオの cut speech / BGM を
# amix した音声トラックを 1 ffmpeg call で乗せる。映像は **再エンコードしない**
# (-c:v copy)。この設計により:
#   - mux のオーバーヘッドが小さい (= 数秒)
#   - 映像ストリームの bit-exact 一致が保証される (mux 前後で md5 不変)
#   - 設定ミス時の再 mux も安価
#
# プロトコル: POST /api/v2/export/mux
#   request : ExportMuxRequest
#   response: { outputPath, audioRendered, ffmpegRc, ffmpegStderrTail, elapsedSec }
# =============================================================================


class ExportMuxRequest(BaseModel):
    """音声 mux 要求。video は v2 export が出力した映像のみ mp4。"""

    model_config = {"extra": "forbid"}

    videoPath: str = Field(..., min_length=1, description="入力映像 (絶対パス、.mp4 / .mov)")
    # 出力先。未指定なら videoPath を上書き (atomic rename)。指定時は projects/ または
    # outputs/ 配下のみ許可。拡張子は videoPath と一致させる。
    outputPath: Optional[str] = None
    # シナリオ範囲。"project" は scenario 全体、"cut" は単一カット (cutId 必須)。
    scope: Literal["project", "cut"] = "project"
    cutId: Optional[str] = None
    # mono → stereo 変換 (= ffmpeg `-ac 2`)。v1 既定と一致。
    monoToStereo: bool = True
    # AAC 音声ビットレート。preset と独立に上書きしたい場合のみ指定。
    audioBitrate: str = Field("192k", min_length=1, max_length=16)
    # 先頭プリロール (秒)。映像側は client が leadInFrames 個だけ blank を先送り
    # しているので、ここでは音声を adelay で同じだけ後ろにずらす。
    leadInSec: float = Field(0.0, ge=0.0, le=10.0)


def _validate_input_video_path(p: str) -> Path:
    """videoPath を絶対化、projects/ または outputs/ 配下のみ許可。"""
    cand = Path(p).expanduser()
    cand_resolved = cand.resolve() if cand.is_absolute() else (Path.cwd() / cand).resolve()
    projects_root = current_projects_dir().resolve()
    outputs_root = OUTPUT_DIR.resolve()
    if not (_is_inside(cand_resolved, projects_root) or _is_inside(cand_resolved, outputs_root)):
        raise ValueError(
            f"videoPath は projects/ または outputs/ 配下のみ許可されます: {cand_resolved}"
        )
    if not cand_resolved.exists():
        raise ValueError(f"videoPath が存在しません: {cand_resolved}")
    return cand_resolved


def _build_project_mux_command(
    *,
    video_path: Path,
    output_path: Path,
    scenario: dict,
    mono_to_stereo: bool,
    audio_bitrate: str,
    lead_in_sec: float = 0.0,
) -> tuple[list[str], bool]:
    """シナリオ全体の音声を映像に mux する ffmpeg コマンドを組み立てる。

    各シーンの amix を v1 helper (`_build_audio_amix_segments`) で作り、複数シーン
    なら最後に concat フィルタで時系列連結する。input 0 は映像、以降がシーン横断の
    オーディオ inputs。

    戻り値: (cmd, has_audio)。has_audio=False なら anullsrc で無音 mux する。
    """
    ffmpeg = ffmpeg_executable()
    cmd: list[str] = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path),  # input 0 = 映像
    ]
    input_count = 1  # 0 は映像
    filter_segments: list[str] = []
    scene_audio_labels: list[tuple[str, float]] = []  # (label, scene_duration)

    scenes = [
        resolve_effective_scene(scenario, s)
        for s in (scenario.get("scenes") or []) if isinstance(s, dict)
    ]
    for scene_index, scene in enumerate(scenes):
        scene_duration = _scene_total_duration(scene)

        # video track audio (現状 v2 export で videoTrack は muted=True 既定だが、
        # 非 muted ケースのために clean PCM 経路を通す。録画素材を背景動画に置く
        # ユースケースでも PTS gap 起因の末尾無音を回避できる)。
        # videoTrack は scene 全体に敷く前提なので trim 概念なし → -ss/-t は付けず
        # 入力ファイルだけ clean PCM に差し替える。
        video_audio_input_idx = None
        raw_video_track = scene.get("videoTrack")
        if isinstance(raw_video_track, dict) and not bool(raw_video_track.get("muted", True)):
            vt_path = safe_asset_path(raw_video_track.get("src"))
            if vt_path and vt_path.exists():
                vt_clean_result = prepare_clean_pcm(vt_path)
                if vt_clean_result is not None:
                    vt_audio_input_path = vt_clean_result[0]
                    vt_kind = "clean_pcm"
                else:
                    vt_audio_input_path = vt_path
                    vt_kind = "raw_src"
                cmd += ["-i", str(vt_audio_input_path)]
                video_audio_input_idx = input_count
                input_count += 1
                _log.debug(
                    "[scene=%d] videoTrack input_idx=%d kind=%s src=%r",
                    scene_index, video_audio_input_idx, vt_kind, raw_video_track.get("src"),
                )

        # cut speech audio
        cut_audio_entries: list[tuple[int, dict]] = []
        for cut in scene.get("cuts") or []:
            if not isinstance(cut, dict):
                continue
            audio_rel = cut.get("audio")
            if not audio_rel:
                continue
            audio_path = safe_asset_path(audio_rel)
            if not audio_path or not audio_path.exists():
                continue
            cmd += ["-i", str(audio_path)]
            cut_audio_entries.append((input_count, cut))
            input_count += 1

        # scene-level BGM (useForLipSync=True は出力 mix から除外)
        bgm_entries: list[tuple[int, dict]] = []
        for bgm in scene.get("bgmTracks") or []:
            if not isinstance(bgm, dict):
                continue
            if bgm.get("useForLipSync"):
                continue
            bgm_path = safe_asset_path(bgm.get("src")) if bgm.get("src") else None
            if not bgm_path or not bgm_path.exists():
                continue
            try:
                bgm_trim_start = max(0.0, float(bgm.get("trimStartSec") or 0.0))
            except (TypeError, ValueError):
                bgm_trim_start = 0.0
            # ループ ON のときは ffmpeg の -stream_loop -1 で input を無限化。
            # 初回は -ss で trim 位置から再生、EOF 到達後は (ffmpeg 仕様により)
            # 入力の先頭 (= source-time 0) に巻き戻ってループする。BGM 用途として
            # 自然な挙動 (= 最初は途中再生、その後はフル尺で繰り返し)。
            if bgm.get("loop"):
                cmd += ["-stream_loop", "-1"]
            if bgm_trim_start > 0:
                cmd += ["-ss", f"{bgm_trim_start:.3f}"]
            cmd += ["-i", str(bgm_path)]
            bgm_entries.append((input_count, bgm))
            input_count += 1

        # scene-level 効果音 (soundEffects)。区間 (durationFrame) / ループ / フェード
        # を持つ。loop=True なら -stream_loop -1 で input を無限化し、後段 filter
        # 側の atrim で region 終端に切る (= BGM と同じ思想)。
        # asset duration を `_resolvedAssetDurSec` として stash しておき、filter 側
        # で fade-out 位置 (effectiveEnd = min(durFrame, assetDur) for loop=False) の
        # 算出に使う。
        #
        # audioOffsetSec (素材内頭出し) の扱いは loop 有無で経路を分ける:
        #   - loop=False: `-ss audio_offset` を input 側に付ける (= 高速 seek、
        #     PTS は seek 点を起点に増加、`atrim=duration=region` で素直に切れる)。
        #   - loop=True : `-ss` は使わず、フィルタ側 `atrim=start=audio_offset:
        #     duration=region` に集約する。
        #     **理由**: `-stream_loop -1` + `-ss BEFORE -i` の組合せは ffmpeg の
        #     PTS 採番がループ境界で不連続になり、後段の `atrim=duration=R` が
        #     周回を跨ぐ判定でしくじって `R + (file_dur - audio_offset)` 秒まで
        #     音が漏れる (2026-05-22 動画テスト: `talk_02.m4a` で SE 終端後に
        #     +26 秒の bleed が再現)。フィルタ側 `atrim=start=...:duration=...`
        #     なら周回境界をまたいでも samples を正しく [start, start+duration]
        #     で切ってくれる。
        se_entries: list[tuple[int, dict]] = []
        for se in scene.get("soundEffects") or []:
            if not isinstance(se, dict):
                continue
            se_path = safe_asset_path(se.get("src")) if se.get("src") else None
            if not se_path or not se_path.exists():
                continue
            loop_active = bool(se.get("loop"))
            if loop_active:
                cmd += ["-stream_loop", "-1"]
            try:
                audio_offset = max(0.0, float(se.get("audioOffsetSec") or 0.0))
            except (TypeError, ValueError):
                audio_offset = 0.0
            # loop=False のときだけ input 側 `-ss` を使う。loop=True ではフィルタ
            # 側 atrim に逃がす (= 上記 bleed バグ回避)。
            if audio_offset > 0 and not loop_active:
                cmd += ["-ss", f"{audio_offset:.3f}"]
            cmd += ["-i", str(se_path)]
            se_with_meta = dict(se)
            if audio_offset > 0 and loop_active:
                se_with_meta["_audioOffsetForFilter"] = float(audio_offset)
            try:
                adur = audio_duration_seconds(se_path)
                if adur is not None and adur > 0:
                    se_with_meta["_resolvedAssetDurSec"] = float(adur)
            except Exception:
                pass
            se_entries.append((input_count, se_with_meta))
            input_count += 1

        # scene-level 動画レイヤー (videoLayers) の音声トラック。
        # 映像 (frame 焼き込み) は別経路。ここでは音声 mux のためだけに ffmpeg に -i する。
        #   - muted=True は除外
        #   - hasAudio=False (= 音声ストリーム無し動画) は ffprobe で判定して除外
        #     しないと amix で「stream 不在エラー」になる
        #   - 隣接同 src の VL は merge_contiguous_audio_video_layers で 1 group に
        #     まとめ、**group 単位で 1 input** にする。clean PCM 採用時も _members
        #     展開はしない (理由は下記)
        #   - **source-time edit + stream-time audio proxy** (2026-05-21):
        #     audio input は `prepare_clean_pcm` で sample-count base に振り直した
        #     連続 PCM (= AAC decoder の連続出力と等価) に差し替える。編集 UI 上の
        #     trimStartSec/trimEndSec は source-time のままだが、clean PCM 内の
        #     stream-time に `source_to_stream_time` で変換してから -ss/-t に渡す。
        #     これをやらないと、source-time 上の gap (録画中断 / 風切り音 NC 等) が
        #     stream-time では消えているため、`-ss source_value` で取ると本来より
        #     先の音が出て映像とズレる
        #   - startFrame (scene 配置) は group の最初の VL の値を使う (= 編集 UI と一致)
        #
        # **連続 VL の _members 展開はしない (clean PCM でも)**: source-time で連続
        # した同 src の疑似分割 VL (= 編集で「動画分割」した結果) を _members 単位で
        # 別 input にすると、各 member の stream span が gap 分縮んで member 境界に
        # silence が出る (例: source[87.583..104.5] span=16.917 が stream span=14.017
        # に縮み、scene 14.017..16.917 が apad silence、その後 scene 16.917 で
        # 次 member が始まって続きが鳴る → 「ファンファーレ後に VL が消える」)。
        # preview は同 src 連続 VL を 1 element + 1 provider に統合 (97b959b) して
        # 境界で seek しないので、AAC decoder の連続 sample をそのまま流す = scene 内
        # では「連続音→末尾 silence」の挙動。export も group 1 input にまとめると
        # 一致する。
        vl_entries: list[tuple[int, dict]] = []
        vl_audio_groups = merge_contiguous_audio_video_layers(
            scene.get("videoLayers"), PROJECT_FPS, video_metadata_fn=video_metadata,
        )
        # DEBUG (2026-05-21): VL audio mux のトレース (= 過大ログ抑止のため DEBUG)
        _log.debug(
            "[scene=%d] vl_audio_groups: %d group(s)",
            scene_index, len(vl_audio_groups),
        )
        for group in vl_audio_groups:
            vl_path = safe_asset_path(group["src"]) if group.get("src") else None
            if not vl_path or not vl_path.exists():
                _log.warning(
                    "[scene=%d]   SKIP missing src=%r", scene_index, group.get("src"),
                )
                continue
            meta = video_metadata(vl_path)
            if not meta or not meta.get("hasAudio"):
                _log.info(
                    "[scene=%d]   SKIP no-audio src=%r meta=%s",
                    scene_index, group.get("src"),
                    "None" if not meta else "present(hasAudio=False)",
                )
                continue

            trim_start = float(group["trimStartSec"])
            trim_end_raw = float(group["trimEndSec"])
            duration_total = float(meta.get("duration") or 0.0)
            trim_end_clamped = max(trim_start + 0.05, min(duration_total, trim_end_raw))
            members_n = len(group.get("_members") or [])
            clamped_flag = "CLAMPED" if abs(trim_end_clamped - trim_end_raw) > 1e-3 else "ok"

            # clean PCM 経由を優先。失敗時 (= 戻り値 None) は原 src + source-time の
            # `-ss/-t` をそのまま使う (= 旧挙動、PTS gap で後半 sample drop の可能性)。
            clean_result = prepare_clean_pcm(vl_path)
            if clean_result is not None:
                clean_pcm, map_info = clean_result
                audio_input_path = clean_pcm
                # group 全体の trim 範囲を source-time → stream-time に変換。
                # _members 展開はしない (= 上記コメント参照)。
                audio_ss = source_to_stream_time(map_info, trim_start, side="start")
                audio_end = source_to_stream_time(map_info, trim_end_clamped, side="end")
                audio_t = max(0.05, audio_end - audio_ss)
                input_kind = "clean_pcm"
            else:
                audio_input_path = vl_path
                audio_ss = trim_start
                audio_t = max(0.05, trim_end_clamped - trim_start)
                input_kind = "raw_src"

            span_source = trim_end_clamped - trim_start

            _log.debug(
                "[scene=%d]   input_idx=%d members=%d kind=%s src=%r "
                "startFrame=%s source[%.3f..%.3f] span_src=%.3f "
                "stream[%.3f..%.3f] span_stm=%.3f "
                "duration_total=%.3f volume=%s trimEndRaw=%.3f clamp=%s",
                scene_index, input_count, members_n, input_kind, group.get("src"),
                group.get("startFrame"), trim_start, trim_end_clamped, span_source,
                audio_ss, audio_ss + audio_t, audio_t,
                duration_total, group.get("volume"), trim_end_raw, clamped_flag,
            )
            if audio_ss > 0:
                cmd += ["-ss", f"{audio_ss:.3f}"]
            cmd += ["-t", f"{audio_t:.3f}"]
            cmd += ["-i", str(audio_input_path)]
            # group dict は _build_audio_amix_segments が読む `startFrame` / `volume`
            # / `fadeIn*` / `fadeOut*` を持つ。afade=t=out の起点は asetpts 後の
            # 「フィルタ内 0 起算時間軸」 = 上の `-ss/-t` で切り出した実際の長さ
            # (= audio_t) なので、PTS gap でソース span と乖離する場合に備えて
            # 明示的に渡す。clean PCM / raw_src どちらの経路でも安全。
            group["_audioFilterDurationSec"] = float(audio_t)
            vl_entries.append((input_count, group))
            input_count += 1

        # シーン amix を v1 helper で組み立て (出力 length = scene_duration)
        scene_segments, scene_audio_label = _build_audio_amix_segments(
            scene_duration,
            cut_audio_inputs=cut_audio_entries,
            bgm_inputs=bgm_entries,
            video_audio_input_idx=video_audio_input_idx,
            sound_effect_inputs=se_entries,
            video_layer_inputs=vl_entries,
        )
        filter_segments += scene_segments

        if scene_audio_label is not None:
            # ラベル名を per-scene に正規化 (helper は単一シーン前提なので名前衝突回避)
            normalized_label = f"sa{scene_index}"
            # `[scene_a]` 形式 → 中身を取り出して正規化ラベルでもう 1 段
            # コピー (anull で 0 コスト)。helper の最終ラベル形式が `[name]` 1 個
            # なので素朴にリネームする。
            stripped = scene_audio_label.strip("[]")
            filter_segments.append(f"[{stripped}]anull[{normalized_label}]")
            scene_audio_labels.append((normalized_label, scene_duration))

    has_audio = bool(scene_audio_labels)

    if has_audio:
        if len(scene_audio_labels) == 1:
            final_audio_label = scene_audio_labels[0][0]
        else:
            # シーン跨ぎ concat: [sa0][sa1]...concat=n=N:v=0:a=1[final_a]
            inputs_concat = "".join(f"[{name}]" for name, _ in scene_audio_labels)
            n = len(scene_audio_labels)
            filter_segments.append(
                f"{inputs_concat}concat=n={n}:v=0:a=1[final_a]"
            )
            final_audio_label = "final_a"
        # 先頭プリロール: 映像は client が blank で先送りしているので、音声も
        # 同じだけ adelay で後ろへ。L/R 両 chan に同じ delay。
        if lead_in_sec > 0:
            delay_ms = int(round(lead_in_sec * 1000))
            filter_segments.append(
                f"[{final_audio_label}]adelay={delay_ms}|{delay_ms}[final_lead]"
            )
            final_audio_label = "final_lead"
        cmd += ["-filter_complex", ";".join(filter_segments)]
        cmd += ["-map", "0:v", "-map", f"[{final_audio_label}]"]
        # DEBUG (2026-05-21): VL 関連 filter segment だけ抜き出して stderr に出す。
        # `vl_` ラベルは _build_audio_amix_segments が VL audio branch に付ける prefix。
        for seg in filter_segments:
            if "[vl_" in seg or "]vl_" in seg:
                _log.debug("  vl_filter: %s", seg)
    else:
        # 無音 mux: anullsrc で全長の無音トラックを足す。leadInSec は先頭で映像も
        # 無音なので、anullsrc 側に追加で延ばす必要はない (= -shortest が映像側に揃う)。
        total_dur = sum(d for _, d in scene_audio_labels) or sum(
            _scene_total_duration(s) for s in scenes
        ) or 1.0
        total_dur += max(0.0, float(lead_in_sec))
        cmd += [
            "-f", "lavfi",
            "-t", f"{total_dur:.3f}",
            "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        ]
        silence_idx = input_count
        input_count += 1
        cmd += ["-map", "0:v", "-map", f"{silence_idx}:a"]

    cmd += ["-c:v", "copy"]
    cmd += ["-c:a", "aac", "-b:a", audio_bitrate]
    if mono_to_stereo:
        cmd += ["-ac", "2"]
    cmd += ["-shortest", str(output_path)]
    return cmd, has_audio


@router.post("/api/v2/export/mux")
def post_export_mux(req: ExportMuxRequest) -> dict:
    started = time.perf_counter()

    # 1) 入力映像の検証
    try:
        video_path = _validate_input_video_path(req.videoPath)
    except ValueError as exc:
        return {"type": "error", "code": ERR_OUTPUT_PATH_REJECTED, "detail": str(exc)}

    # 2) 出力先の決定。video の suffix (.mp4 / .mov) を保持。
    video_suffix = video_path.suffix.lower() or ".mp4"
    # _resolve_output_path は encoder で拡張子を決めるので、video_suffix と整合する
    # encoder ID を渡す (= .mov なら prores_4444 相当の拡張子チェックに通す)。
    encoder_for_path = "prores_4444" if video_suffix == ".mov" else "h264_videotoolbox"
    if req.outputPath:
        out_path, path_err = _resolve_output_path(
            "", "scenario", req.outputPath, encoder_for_path, "project",
        )
        if path_err is not None:
            return {"type": "error", "code": ERR_OUTPUT_PATH_REJECTED, "detail": path_err}
        explicit_output = True
    else:
        # 既定: 映像と同じディレクトリに同 suffix の `_av_tmp` で書き出し、成功後に
        # 元の映像ファイルへ atomic rename する (= 結果として元のファイル名が
        # 音声付きに置き換わる)。.mp4 なら .mp4、.mov なら .mov。
        out_path = video_path.with_name(video_path.stem + "_av_tmp" + video_suffix)
        explicit_output = False

    # 3) シナリオ取得 (cut scope なら _make_single_cut_scene で 1 scene に変換)
    ctx = current_project()
    manifest = ensure_manifest(ctx)
    scenario = ensure_scenario(manifest, ctx)

    if req.scope == "cut":
        if not req.cutId:
            return {"type": "error", "code": ERR_INVALID_CONFIG, "detail": "scope=cut のとき cutId は必須"}
        target_scene = None
        target_cut = None
        for sc in scenario.get("scenes") or []:
            for cu in (sc.get("cuts") or []):
                if str(cu.get("id") or "") == req.cutId:
                    target_scene = sc
                    target_cut = cu
                    break
            if target_cut is not None:
                break
        if target_cut is None:
            return {"type": "error", "code": ERR_INVALID_CONFIG, "detail": f"cutId={req.cutId} not found"}
        # 単一カット書き出しもベッド設定を解決してから 1 シーンに畳む。
        synthetic_scene = _make_single_cut_scene(
            resolve_effective_scene(scenario, target_scene), target_cut,
        )
        scenario_for_mux = {"scenes": [synthetic_scene]}
    else:
        scenario_for_mux = scenario

    # 4) ffmpeg コマンド組み立て + 実行
    cmd, has_audio = _build_project_mux_command(
        video_path=video_path,
        output_path=out_path,
        scenario=scenario_for_mux,
        mono_to_stereo=req.monoToStereo,
        audio_bitrate=req.audioBitrate,
        lead_in_sec=req.leadInSec,
    )

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600.0, check=False,
            encoding="utf-8", errors="replace",
        )
    except FileNotFoundError as exc:
        return {
            "type": "error", "code": ERR_FFMPEG_SPAWN_FAILED,
            "detail": f"ffmpeg を起動できません ({ffmpeg_executable()}): {exc}",
        }

    elapsed = time.perf_counter() - started
    rc = proc.returncode
    stderr_tail = (proc.stderr or "")[-1000:]

    # 5) atomic rename (出力先未指定時は元の映像を mux 後ファイルで上書き)
    final_path = out_path
    if rc == 0 and not explicit_output:
        try:
            out_path.replace(video_path)  # mv -f
            final_path = video_path
        except Exception as exc:
            return {
                "type": "error", "code": "RENAME_FAILED",
                "detail": f"mux 後 rename 失敗 ({out_path} → {video_path}): {exc}",
                "ffmpegStderrTail": stderr_tail,
            }

    return {
        "type": "done",
        "outputPath": str(final_path),
        "audioRendered": bool(has_audio),
        "ffmpegRc": rc,
        "ffmpegStderrTail": stderr_tail,
        "elapsedSec": elapsed,
        "ffmpegCmd": cmd,
    }


@router.get("/api/v2/export/capabilities")
def get_export_capabilities() -> dict:
    """encoder 利用可否 + OS 推奨。client 起動時に 1 回 fetch する想定。

    レスポンス:
      {
        "platform": "darwin",
        "encoders": ["h264_videotoolbox", "libx264_fast"],
        "preferred": "h264_videotoolbox",
        "fallbackChain": ["h264_videotoolbox", "libx264_fast"],
        "raw": {"h264_videotoolbox": true, ...}  // デバッグ用
      }
    """
    return _detect_capabilities()


# ---------- WS endpoint --------------------------------------------------


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_v = sorted(values)
    k = max(0, min(len(sorted_v) - 1, int(round((p / 100.0) * (len(sorted_v) - 1)))))
    return sorted_v[k]


async def _send_error(ws: WebSocket, code: str, detail: str) -> None:
    """エラー JSON 1 通投げて close。WS は accept 済の前提。"""
    try:
        await ws.send_text(json.dumps({"type": "error", "code": code, "detail": detail}))
    except Exception:
        pass
    try:
        await ws.close()
    except Exception:
        pass


@router.websocket("/api/v2/export/ws")
async def v2_export_ws(ws: WebSocket) -> None:
    """1 cut 分の export を捌く WebSocket。"""
    await ws.accept()
    proc: asyncio.subprocess.Process | None = None
    output_path_str: Optional[str] = None
    write_times_ms: list[float] = []
    drain_times_ms: list[float] = []
    frame_count = 0
    received_bytes = 0

    # 複数タスクから ws.send_text を呼ぶときに frame をまたいだ書き込み混線を
    # 防ぐ lock。frame ループの 30frame ごと progress と、ffmpeg progress reader
    # の 1 秒ごと encoderProgress が並走するため必要。
    ws_send_lock = asyncio.Lock()

    async def _safe_send_text(text: str) -> bool:
        try:
            async with ws_send_lock:
                await ws.send_text(text)
            return True
        except Exception:
            return False

    # client が提示した sec-websocket-extensions request header (= offered)。
    # 実際に negotiated されたかは client 側 ws.extensions でしか取れない。
    ws_extensions_offered = ws.headers.get("sec-websocket-extensions") or ""

    try:
        # 1) 始端ハンドシェイク + Pydantic 検証
        handshake_text = await ws.receive_text()
        try:
            payload = json.loads(handshake_text)
            cfg = ExportHandshake.model_validate(payload)
        except json.JSONDecodeError as exc:
            await _send_error(ws, ERR_INVALID_CONFIG, f"handshake が JSON ではありません: {exc}")
            return
        except ValidationError as exc:
            # Pydantic のエラー詳細をそのまま乗せる (フロントで読める形にしている)。
            await _send_error(ws, ERR_INVALID_CONFIG, exc.json(include_url=False))
            return

        # 2) preset 経路 / encoder Literal 経路の切り分け。
        #    本線 UI は preset 経由 (videoPresetId)、bench page は encoder Literal。
        preset_for_export: dict[str, Any] | None = None
        extension_override: Optional[str] = None
        if cfg.videoPresetId:
            preset_for_export = resolve_video_preset(cfg.videoPresetId)
            if not preset_for_export or preset_for_export.get("id") != cfg.videoPresetId:
                # resolve_video_preset は見つからない時 BUILTIN[0] にフォールバックする。
                # UI がカスタム preset id を渡した可能性もあるので、id 一致を厳格チェック。
                await _send_error(
                    ws, ERR_INVALID_CONFIG,
                    f"unknown videoPresetId: {cfg.videoPresetId}",
                )
                return
            extension_override = preset_for_export.get("extension") or ".mp4"

        # 3) outputPath の解決 (override / 自動命名 / 安全制約)
        output_path, path_err = _resolve_output_path(
            cfg.projectId, cfg.cutId, cfg.outputPath, cfg.encoder, cfg.mode,
            extension_override=extension_override,
        )
        if path_err is not None:
            await _send_error(ws, ERR_OUTPUT_PATH_REJECTED, path_err)
            return
        output_path_str = str(output_path) if output_path else None

        # 4) ffmpeg コマンド組み立て + 起動
        try:
            if cfg.transport == "webcodecs-h264":
                # WebCodecs 経路: ブラウザが H.264 (annexb) に圧縮済み。preset の
                # codec 設定は無視し copy でコンテナ化のみ。出力先は preset 拡張子
                # (.mp4) で解決済み (preset 未指定なら自動命名の .mp4)。
                if output_path is None:
                    await _send_error(
                        ws, ERR_INVALID_CONFIG,
                        "webcodecs-h264 経路では outputPath が必要です",
                    )
                    return
                cmd = _build_ffmpeg_cmd_copy_h264(cfg.fps, output_path)
            elif preset_for_export is not None:
                if output_path is None:
                    # preset 経路では output_path は必須 (encoder=null の null 出力は
                    # bench 専用)。preset 側で encoder=null を選べないので、ここに
                    # 来た時点で内部矛盾。
                    await _send_error(
                        ws, ERR_INVALID_CONFIG,
                        "preset 経路では outputPath が必要です",
                    )
                    return
                cmd = _build_ffmpeg_cmd_from_preset(
                    cfg.width, cfg.height, cfg.fps,
                    preset_for_export, cfg.presetOptions or {},
                    cfg.vflip, output_path,
                )
            else:
                cmd = _build_ffmpeg_cmd(
                    cfg.width, cfg.height, cfg.fps, cfg.encoder, cfg.vflip, output_path,
                )
        except ValueError as exc:
            # 既知 encoder の Literal 通過後にここへ来るのは想定外だが安全側で握る。
            await _send_error(ws, ERR_INVALID_CONFIG, str(exc))
            return

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            await _send_error(
                ws, ERR_FFMPEG_SPAWN_FAILED,
                f"ffmpeg を起動できません ({ffmpeg_executable()}): {exc}",
            )
            return
        except NotImplementedError as exc:
            # Windows + SelectorEventLoop は asyncio.create_subprocess_exec 非対応で
            # NotImplementedError (str() が空) を投げる。uvicorn の reload / workers>1 で
            # use_subprocess=True になると Windows は SelectorEventLoop を選ぶのが原因。
            # str(exc) が空だとフロントが "server error" にフォールバックして原因不明に
            # なるため、ここで具体的な対処を detail に載せる。
            await _send_error(
                ws, ERR_FFMPEG_SPAWN_FAILED,
                "このイベントループは非同期サブプロセスに対応していません"
                f" [{type(exc).__name__}]。Windows では autoreload / 複数 worker での"
                " 起動だと動画書き出しができません。reload を無効にして起動してください"
                " (python -m app は Windows で自動的に reload を無効化します)。",
            )
            return
        except Exception as exc:  # noqa: BLE001
            # str(exc) が空の例外でも原因が追えるよう型名を必ず添える。
            await _send_error(
                ws, ERR_FFMPEG_SPAWN_FAILED, f"{type(exc).__name__}: {exc}",
            )
            return

        await ws.send_text(json.dumps({
            "type": "ready",
            "ffmpegCmd": cmd,
            "outputPath": output_path_str,
            "expectedFrameBytes": cfg.width * cfg.height * 4,
            "totalFrames": cfg.totalFrames,
            "wsExtensionsOffered": ws_extensions_offered,
        }))

        # ffmpeg の `-progress pipe:1` 出力を読み続けて、1 ブロック (= 1 秒分) ごとに
        # `encoderProgress` メッセージとして client に転送する task を並走させる。
        # block は key=value 行の連続で、`progress=continue` または `progress=end` で
        # 区切られる。bench 経路 (encoder=null) では -progress を添えていないので
        # stdout は空のまま、readline が即 EOF で抜ける = 何も送信しない。
        async def _read_ffmpeg_progress() -> None:
            if proc is None or proc.stdout is None:
                return
            block: dict[str, str] = {}
            try:
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        return
                    s = line.decode("utf-8", errors="replace").rstrip()
                    if "=" not in s:
                        continue
                    k, _, v = s.partition("=")
                    v = v.strip()
                    if k == "progress":
                        try:
                            frame_val = int(block.get("frame", "0"))
                        except ValueError:
                            frame_val = 0
                        try:
                            fps_val = float(block.get("fps", "0"))
                        except ValueError:
                            fps_val = 0.0
                        ok = await _safe_send_text(json.dumps({
                            "type": "encoderProgress",
                            "frame": frame_val,
                            "fps": fps_val,
                            "outTime": block.get("out_time", ""),
                            "speed": block.get("speed", ""),
                            "status": v,
                        }))
                        if not ok:
                            return  # ws closed
                        block = {}
                        if v == "end":
                            return
                    else:
                        block[k] = v
            except (asyncio.CancelledError, ConnectionError):
                return
            except Exception:
                # 進捗ストリームが死んでも export 本体は止めない。
                return

        prog_task = asyncio.create_task(_read_ffmpeg_progress())

        started = time.perf_counter()

        # 4) フレームループ
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            data = msg.get("bytes")
            if data is None:
                text = msg.get("text") or ""
                try:
                    obj = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "finish":
                    break
                continue

            received_bytes += len(data)

            if proc is None or proc.stdin is None:
                break
            t0 = time.perf_counter()
            proc.stdin.write(data)
            t1 = time.perf_counter()
            await proc.stdin.drain()
            t2 = time.perf_counter()
            write_times_ms.append((t1 - t0) * 1000.0)
            drain_times_ms.append((t2 - t1) * 1000.0)
            frame_count += 1

            if frame_count % 30 == 0:
                await _safe_send_text(json.dumps({
                    "type": "progress",
                    "frames": frame_count,
                    "elapsedSec": time.perf_counter() - started,
                    "totalFrames": cfg.totalFrames,
                }))

        # 5) ffmpeg stdin close → wait
        rc = 0
        stderr_data = b""
        if proc is not None:
            if proc.stdin is not None:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
            try:
                stderr_data = await asyncio.wait_for(
                    proc.stderr.read(), timeout=5.0,
                ) if proc.stderr else b""
            except asyncio.TimeoutError:
                stderr_data = b""
            try:
                rc = await asyncio.wait_for(proc.wait(), timeout=60.0)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except Exception:
                    pass
                rc = -1

        # progress reader を確実に終了させる (proc.wait 後は stdout EOF で自然終了
        # するはずだが、念のため timeout で打ち切る)。
        try:
            await asyncio.wait_for(prog_task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            prog_task.cancel()

        elapsed = time.perf_counter() - started
        avg_fps = frame_count / elapsed if elapsed > 0 else 0.0
        throughput_mbps = (received_bytes / 1e6) / elapsed if elapsed > 0 else 0.0

        await _safe_send_text(json.dumps({
            "type": "done",
            "frames": frame_count,
            "totalFrames": cfg.totalFrames,
            "elapsedSec": elapsed,
            "fps": avg_fps,
            "throughputMBps": throughput_mbps,
            "ffmpegRc": rc,
            "ffmpegStderrTail": stderr_data.decode("utf-8", errors="replace")[-1000:],
            "outputPath": output_path_str,
            "wsExtensionsOffered": ws_extensions_offered,
            "stdinWriteMs": {
                "p50": _percentile(write_times_ms, 50),
                "p95": _percentile(write_times_ms, 95),
                "mean": (mean(write_times_ms) if write_times_ms else 0.0),
                "max": (max(write_times_ms) if write_times_ms else 0.0),
            },
            "drainMs": {
                "p50": _percentile(drain_times_ms, 50),
                "p95": _percentile(drain_times_ms, 95),
                "mean": (mean(drain_times_ms) if drain_times_ms else 0.0),
                "max": (max(drain_times_ms) if drain_times_ms else 0.0),
            },
        }))
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        try:
            await ws.send_text(json.dumps({
                "type": "error",
                "code": "INTERNAL",
                "detail": str(exc),
            }))
        except Exception:
            pass
    finally:
        if proc is not None and proc.returncode is None:
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
            except Exception:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            await ws.close()
        except Exception:
            pass

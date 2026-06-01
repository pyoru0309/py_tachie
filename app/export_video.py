"""動画書き出しヘルパ。

v1 (Pillow + ProcessPool) 描画パイプラインは撤去済み。本 module は v2 (WebGL → WS
→ ffmpeg) 経路から使われる音声ヘルパと ffmpeg 引数生成のみを提供する。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from .global_config import ffmpeg_executable, ffprobe_executable
from .log_setup import app_logger
from .paths import CACHE_DIR, PROJECT_ROOT

_log = app_logger("export_video")
from .timecode import PROJECT_FPS


# ---------------------------------------------------------------------------
# 音声ヘルパ (lip-sync 用 RMS / duration / sample rate)
# ---------------------------------------------------------------------------


def audio_duration_seconds(audio_path: Path) -> float | None:
    result = subprocess.run(
        [
            ffprobe_executable(),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            str(audio_path),
        ],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        return None
    try:
        duration = float(result.stdout.strip().splitlines()[0])
    except (IndexError, ValueError):
        return None
    return duration if math.isfinite(duration) and duration > 0 else None


_CLEAN_PCM_DIR = CACHE_DIR / "clean_pcm"

# clean PCM 生成方式のバージョン。生成 filter / map スキーマを変えたら更新する。
# 同じ src でも version が違えば cache key が変わって自動再生成。
# - v1-async1000  : aresample=async=1000 (source-time 尊重 / gap silence) — 廃止
# - v2-nsrtb      : aresample=48000,asetpts=N/SR/TB + source→stream マップ
_CLEAN_PCM_VERSION = "v2-nsrtb"


def prepare_clean_pcm(src_path: Path) -> tuple[Path, dict] | None:
    """動画素材の音声を「AAC decoder の連続 sample 出力」と等価な連続 PCM
    (WAV s16le 48k stereo) としてキャッシュ生成する。

    録画素材 (BlueArchive / OBS 等) は AAC packet の PTS が連続せず gap を含む。
    ffmpeg は `-i src.mp4` を直接読むと:
      - `-ss N -t D` で D 秒要求しても、packet 数 × frame_size しか sample が
        出ない (= 後半が drop)
      - `aresample=async=1000` で「source-time を尊重して」gap を silence で
        埋めると、gap 位置にぴったり SE / cut audio が並んだ場合に「VL が消える」
        ように聞こえる
    一方で、HTML `<video>` element の AAC decoder は PTS を見ず packet を順番に
    decode して連続 sample を出すので、preview では gap が「無視」されて連続音に
    聞こえる。

    この差を埋めるため、`aresample=48000,asetpts=N/SR/TB` で **sample-count
    base に PTS を振り直し** た PCM を生成する。これは AAC decoder の連続出力と
    等価で、preview で確認したのと同じ音が export でも鳴る。

    副作用: stream-time と source-time の対応がズレる (= 元素材 119.86 秒なら
    clean PCM は ~107.80 秒)。編集 UI 上 source-time で trim 範囲を指定した
    値は、clean PCM の同じ「秒数」位置を指す = sample-time 上の同じ位置。これは
    preview と一致するため UX 的には妥当 (= 編集中に preview で聞こえた音が
    そのまま export に乗る)。

    戻り値: `(wav_path, map_info)` または `None` (= 失敗時、呼び出し側で
    原 src フォールバック)。`map_info` は `source_to_stream_time` に渡して
    編集 UI 上の `trimStartSec/trimEndSec` (= source-time) を clean PCM 内の
    stream-time に変換するために使う。これをやらないと、source-time 上で
    trim_start より前にあった gap の分だけ「先走った」音が export に乗る。

    map_info の形:
        {
          "sample_rate": int,  # 元 src の audio sample rate
          "frames": [
            [pts_time, stream_time, nb_samples],
            ...
          ],
        }
    `frames` は元 src の audio frame 単位で `(source-time, stream-time, sample 数)`
    を持つ。`stream_time = (累積 nb_samples) / sample_rate` で計算する
    (packet duration / PTS delta は信用しない / nb_samples 直接累積)。

    キャッシュキーは「src の絶対パス + mtime_ns + size + 方式バージョン」の
    sha1 (16 chars)。生成 filter / map スキーマが変われば `_CLEAN_PCM_VERSION`
    を上げることで自動再生成される。失敗 (音声ストリーム無し / ffmpeg エラー /
    timeout) は None を返し、呼び出し側で原 src へフォールバックする。

    本関数は書き出し (export) 経路でのみ使う。preview は HTML video element /
    WebCodecsVideoProvider のままで OK (= 元から AAC decoder の連続出力で
    再生している)。
    """
    try:
        st = src_path.stat()
    except OSError:
        return None
    key = f"{src_path.resolve()}|{st.st_mtime_ns}|{st.st_size}|{_CLEAN_PCM_VERSION}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    try:
        _CLEAN_PCM_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    out_path = _CLEAN_PCM_DIR / f"{digest}.wav"
    map_path = _CLEAN_PCM_DIR / f"{digest}.map.json"
    # cache hit: WAV と map の両方が揃っている時のみ採用
    if out_path.exists() and out_path.stat().st_size > 0 and map_path.exists():
        try:
            map_info = json.loads(map_path.read_text(encoding="utf-8"))
            if (
                isinstance(map_info, dict)
                and isinstance(map_info.get("sample_rate"), int)
                and isinstance(map_info.get("frames"), list)
                and map_info["frames"]
            ):
                return out_path, map_info
        except (OSError, json.JSONDecodeError):
            pass
        # map 壊れ / 旧形式 → 再生成 (= ファイル削除)
        try:
            map_path.unlink(missing_ok=True)
        except OSError:
            pass

    # tmp filename: ffmpeg は拡張子から muxer を推測するので `.tmp.wav` 順にして
    # WAV format を明示しなくてもよくする。並行 export からの衝突を避けるため pid 付。
    tmp_path = out_path.with_name(f"{out_path.stem}.{os.getpid()}.tmp.wav")
    cmd = [
        ffmpeg_executable(),
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", str(src_path),
        "-vn",
        "-map", "0:a:0",
        # aresample で SR を 48k に揃え、asetpts=N/SR/TB で sample-count base に
        # 振り直す (= source の PTS gap を squash、AAC decoder の連続出力と等価)。
        # async= は指定しない (= 既定 async=0 で stretch/silence-fill を抑止)。
        "-af", "aresample=48000,asetpts=N/SR/TB",
        "-ac", "2",
        "-c:a", "pcm_s16le",
        "-f", "wav",
        str(tmp_path),
    ]
    try:
        result = subprocess.run(
            cmd, cwd=PROJECT_ROOT, capture_output=True, timeout=600.0, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        _log.warning("clean_pcm preprocess failed: %s", exc)
        return None
    if result.returncode != 0:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        tail = (result.stderr or b"")[-400:].decode("utf-8", errors="replace")
        _log.warning("clean_pcm ffmpeg rc=%d src=%s: %s", result.returncode, src_path.name, tail)
        return None
    # 対応表生成 (= ffprobe で frame の pts_time + nb_samples から累積 sample 数で
    # stream-time を算出)
    map_info = _build_clean_pcm_map(src_path)
    if map_info is None:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        _log.warning("clean_pcm map build failed for src=%s", src_path.name)
        return None
    try:
        tmp_path.replace(out_path)
        map_path.write_text(json.dumps(map_info), encoding="utf-8")
    except OSError as exc:
        _log.warning("clean_pcm rename/map save failed: %s", exc)
        return None
    return out_path, map_info


def _build_clean_pcm_map(src_path: Path) -> dict | None:
    """元 src の audio frame 情報から source-time → stream-time 対応表を作る。

    各 frame の `(pts_time, nb_samples)` を ffprobe で取得し、累積 sample 数を
    sample_rate で割った値を stream_time に採用する。packet duration / PTS delta
    は使わない (= ユーザー指摘の point 1)。PTS gap (= frame n の pts_time + nb_samples/sr
    と frame n+1 の pts_time の差) は accumulated samples には載らないので、
    自然に「source-time 側だけ進んで stream-time は連続」する map になる。
    """
    # 1) 元 src の audio sample rate
    cmd_sr = [
        ffprobe_executable(),
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate",
        "-of", "default=nokey=1:noprint_wrappers=1",
        str(src_path),
    ]
    try:
        sr_result = subprocess.run(
            cmd_sr, cwd=PROJECT_ROOT, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=60.0, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if sr_result.returncode != 0:
        return None
    try:
        sample_rate = int(sr_result.stdout.strip().splitlines()[0])
    except (ValueError, IndexError):
        return None
    if sample_rate <= 0:
        return None

    # 2) audio frame の (pts_time, nb_samples) を CSV で取得
    cmd_fr = [
        ffprobe_executable(),
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "frame=pts_time,nb_samples",
        "-of", "csv=p=0",
        str(src_path),
    ]
    try:
        fr_result = subprocess.run(
            cmd_fr, cwd=PROJECT_ROOT, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=300.0, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if fr_result.returncode != 0:
        return None

    frames: list[list[float | int]] = []
    cumulative = 0  # 累積 sample 数 (元 src の sr 基準)
    for line in fr_result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(",")
        if len(parts) < 2:
            continue
        try:
            pts_time = float(parts[0])
            nb_samples = int(parts[1])
        except (ValueError, IndexError):
            continue
        if nb_samples <= 0:
            continue
        stream_time = cumulative / float(sample_rate)
        frames.append([pts_time, stream_time, nb_samples])
        cumulative += nb_samples
    if not frames:
        return None
    return {"sample_rate": sample_rate, "frames": frames}


def source_to_stream_time(
    map_info: dict,
    source_sec: float,
    *,
    side: str = "start",
) -> float:
    """source-time (= 編集 UI 上の trim 値) を clean PCM 内の stream-time に変換。

    map_info: `prepare_clean_pcm` の 2 つめの戻り値。`{"sample_rate": int,
        "frames": [[pts_time, stream_time, nb_samples], ...]}`
    side: 半開区間 `[start, end)` 解釈で:
        - "start" (= trim_start 用): source_sec が gap 中なら **次 frame の頭** に寄せる
          (= gap silence を入れず、gap 直後の音から始める)
        - "end" (= trim_end 用): source_sec が gap 中なら **前 frame の終端** に寄せる
          (= gap silence を入れず、gap 直前の音で打ち切る)

    範囲外:
        - source_sec が最初の frame より前 → 0 (= clean PCM 先頭)
        - source_sec が最後の frame の終端より後 → clean PCM 末尾
    """
    sample_rate = int(map_info.get("sample_rate") or 0)
    frames = map_info.get("frames") or []
    if sample_rate <= 0 or not frames:
        return max(0.0, float(source_sec))

    first_pts = float(frames[0][0])
    if source_sec <= first_pts:
        return float(frames[0][1])

    last_pts, last_stream, last_n = frames[-1]
    last_pts = float(last_pts)
    last_stream = float(last_stream)
    last_n = int(last_n)
    last_src_end = last_pts + last_n / sample_rate
    last_stream_end = last_stream + last_n / sample_rate
    if source_sec >= last_src_end:
        return last_stream_end

    # 二分探索: frames[lo][0] <= source_sec となる最大の lo
    lo, hi = 0, len(frames) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if float(frames[mid][0]) <= source_sec:
            lo = mid
        else:
            hi = mid

    src_lo = float(frames[lo][0])
    str_lo = float(frames[lo][1])
    n_lo = int(frames[lo][2])
    src_lo_end = src_lo + n_lo / sample_rate

    if source_sec < src_lo_end:
        # lo frame 内 (= gap でない通常区間): 線形補間
        if n_lo <= 0:
            return str_lo
        ratio = (source_sec - src_lo) / (n_lo / sample_rate)
        return str_lo + ratio * (n_lo / sample_rate)

    # gap 中 (= source_sec が lo frame 終端より後、 hi frame 開始より前)
    if side == "end":
        # 前 frame の終端で打ち切る
        return str_lo + n_lo / sample_rate
    # "start": 次 frame の頭に寄せる
    if lo + 1 < len(frames):
        return float(frames[lo + 1][1])
    return last_stream_end


def video_metadata(video_path: Path) -> dict[str, Any] | None:
    """動画ファイルの duration / width / height / hasAudio をまとめて取得。

    /api/video-duration エンドポイントと、書き出し時の音声 mux 判定 (`hasAudio=False`
    なら amix から除外) で共有する。
    """
    # 1) 映像 stream の duration / width / height
    result = subprocess.run(
        [
            ffprobe_executable(),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,duration",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1",
            str(video_path),
        ],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        return None
    width = 0
    height = 0
    duration: float | None = None
    format_duration: float | None = None
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key == "width":
            try:
                width = int(value)
            except ValueError:
                pass
        elif key == "height":
            try:
                height = int(value)
            except ValueError:
                pass
        elif key == "duration":
            try:
                parsed = float(value)
                if math.isfinite(parsed) and parsed > 0:
                    # 最初の `duration=` は stream の duration、二つめは format の duration。
                    # 順番に上書きするが、format 側を優先したいので両方覚えておく。
                    if duration is None:
                        duration = parsed
                    else:
                        format_duration = parsed
            except ValueError:
                pass
    final_duration = format_duration if format_duration is not None else duration
    if final_duration is None or final_duration <= 0:
        return None
    # 2) audio stream の有無 (`-select_streams a:0` でヒットすれば 1 行は出る)
    audio_result = subprocess.run(
        [
            ffprobe_executable(),
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            str(video_path),
        ],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    has_audio = audio_result.returncode == 0 and bool(audio_result.stdout.strip())
    return {
        "duration": float(final_duration),
        "width": int(width),
        "height": int(height),
        "hasAudio": bool(has_audio),
    }


def audio_sample_rate(audio_path: Path) -> int:
    result = subprocess.run(
        [
            ffprobe_executable(),
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            str(audio_path),
        ],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        return 48000
    try:
        return max(8000, int(result.stdout.strip().splitlines()[0]))
    except (IndexError, ValueError):
        return 48000


def normalize_rms_db(value: str, lip_sync_config: dict[str, Any] | None = None) -> float:
    lip_sync_config = lip_sync_config or {}
    db_floor = float(lip_sync_config.get("dbFloor", -55))
    db_ceil = float(lip_sync_config.get("dbCeil", -18))
    if db_ceil <= db_floor:
        db_ceil = db_floor + 1
    try:
        db = float(value)
    except ValueError:
        return 0.0
    if not math.isfinite(db) or db <= db_floor:
        return 0.0
    if db >= db_ceil:
        return 1.0
    return (db - db_floor) / (db_ceil - db_floor)


def smooth_levels(levels: list[float], smoothing: float = 0.2) -> list[float]:
    if len(levels) < 3:
        return levels
    smoothing = max(0.0, min(0.45, smoothing))
    center = 1.0 - (smoothing * 2)
    smoothed = []
    for index, level in enumerate(levels):
        previous_level = levels[index - 1] if index > 0 else level
        next_level = levels[index + 1] if index + 1 < len(levels) else level
        smoothed.append((previous_level * smoothing) + (level * center) + (next_level * smoothing))
    return smoothed


def audio_volume_by_frame(
    audio_path: Path,
    fps: int,
    total_frames: int,
    lip_sync_config: dict[str, Any] | None = None,
    *,
    start_sec: float = 0.0,
) -> list[float]:
    lip_sync_config = lip_sync_config or {}
    sample_rate = audio_sample_rate(audio_path)
    samples_per_frame = max(256, round(sample_rate / fps))
    cmd: list[str] = [ffmpeg_executable(), "-hide_banner"]
    start_sec = max(0.0, float(start_sec or 0.0))
    if start_sec > 0:
        cmd += ["-ss", f"{start_sec:.3f}"]
    cmd += [
        "-i",
        str(audio_path),
        "-af",
        (
            f"asetnsamples=n={samples_per_frame},"
            "astats=metadata=1:reset=1,"
            "ametadata=print:key=lavfi.astats.Overall.RMS_level"
        ),
        "-f",
        "null",
        "-",
    ]
    result = subprocess.run(
        cmd,
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        return []

    levels = [0.0 for _ in range(total_frames)]
    current_time: float | None = None
    found = False
    for line in result.stderr.splitlines():
        time_match = re.search(r"pts_time:([0-9.]+)", line)
        if time_match:
            current_time = float(time_match.group(1))
            continue
        level_match = re.search(r"lavfi\.astats\.Overall\.RMS_level=([-+A-Za-z0-9.]+)", line)
        if not level_match or current_time is None:
            continue
        frame = round(current_time * fps)
        if 0 <= frame < total_frames:
            levels[frame] = normalize_rms_db(level_match.group(1), lip_sync_config)
            found = True

    return smooth_levels(levels, float(lip_sync_config.get("smoothing", 0.2))) if found else []


# ---------------------------------------------------------------------------
# シーン期間と単一カット抽出 (v2_export.py が利用)
# ---------------------------------------------------------------------------


def _scene_total_duration(scene: dict[str, Any]) -> float:
    """シーン上で「絵が必要な」時間長を返す。

    cuts / telops の末尾のうち最も遅いもの。
    videoTrack / BGM / videoLayers では延ばさない (= シーン全体に敷くトラックなので
    length を伸ばす意味が無い)。VL が cuts/telops 終端を越えて配置されていても
    export では cut 終端で自動 trim される (= bgmTracks と同じ思想、2026-05-21 確定)。
    """
    fps = PROJECT_FPS
    end_frame = 0
    for cut in scene.get("cuts") or []:
        if not isinstance(cut, dict):
            continue
        start = max(0, int(cut.get("startFrame") or 0))
        duration = max(1, int(cut.get("durationFrame") or 0))
        end_frame = max(end_frame, start + duration)
    for telop in scene.get("telops") or []:
        if not isinstance(telop, dict):
            continue
        start = max(0, int(telop.get("startFrame") or 0))
        duration = max(0, int(telop.get("durationFrame") or 0))
        end_frame = max(end_frame, start + duration)
    return max(1, end_frame) / float(fps)


def _make_single_cut_scene(orig_scene: dict[str, Any], cut: dict[str, Any]) -> dict[str, Any]:
    """元 scene の background/videoTrack/bgmTracks/telops を引き継ぎつつ、
    指定 cut だけを 1 つ持つ新しい scene を返す (時間軸は cut 開始 = 0)。

    - telops は元 cut と時間範囲が重なる部分だけを抽出し、新時間軸に再マップ。
    - videoTrack / bgmTracks の `trimStartSec` には元 cut の開始秒を加算 (元素材の
      該当時刻から再生し直すため)。
    """
    old_start_frame = max(0, int(cut.get("startFrame") or 0))
    duration_frame = max(1, int(cut.get("durationFrame") or 0))
    fps_f = float(PROJECT_FPS)
    old_start_sec = old_start_frame / fps_f
    old_end_sec = (old_start_frame + duration_frame) / fps_f

    new_cut = dict(cut)
    new_cut["startFrame"] = 0

    new_telops: list[dict[str, Any]] = []
    for telop in orig_scene.get("telops") or []:
        if not isinstance(telop, dict):
            continue
        old_t_start_frame = max(0, int(telop.get("startFrame") or 0))
        old_t_dur_frame = max(0, int(telop.get("durationFrame") or 0))
        old_t_start = old_t_start_frame / fps_f
        old_t_end = (old_t_start_frame + old_t_dur_frame) / fps_f
        overlap_start = max(old_t_start, old_start_sec)
        overlap_end = min(old_t_end, old_end_sec)
        if overlap_end <= overlap_start:
            continue
        new_t = dict(telop)
        new_t["startFrame"] = int(round((overlap_start - old_start_sec) * fps_f))
        new_t["durationFrame"] = max(1, int(round((overlap_end - overlap_start) * fps_f)))
        new_telops.append(new_t)

    new_video_track: dict[str, Any] | None = None
    if isinstance(orig_scene.get("videoTrack"), dict):
        vt = dict(orig_scene["videoTrack"])
        try:
            base_trim = float(vt.get("trimStartSec") or 0.0)
        except (TypeError, ValueError):
            base_trim = 0.0
        vt["trimStartSec"] = base_trim + old_start_sec
        new_video_track = vt

    new_bgm_tracks: list[dict[str, Any]] = []
    for bgm in orig_scene.get("bgmTracks") or []:
        if not isinstance(bgm, dict):
            continue
        new_bgm = dict(bgm)
        try:
            base_trim = float(bgm.get("trimStartSec") or 0.0)
        except (TypeError, ValueError):
            base_trim = 0.0
        new_bgm["trimStartSec"] = base_trim + old_start_sec
        new_bgm_tracks.append(new_bgm)

    # 効果音 (soundEffects): SE は startFrame だけのモデル (長さは素材依存)。
    # cut の時間範囲に SE の開始位置が入るものだけを抽出して、新時間軸 (cut 先頭 = 0)
    # に再マップする。SE の素材長が cut 末端を超えても apad/atrim で scene_duration に
    # 切られる (= mux 側に任せる)。これをやらないと cut scope 書き出しに scene 全体の
    # SE が全部入って各 SE が cut 先頭で鳴る filter graph になる。
    new_sound_effects: list[dict[str, Any]] = []
    for se in orig_scene.get("soundEffects") or []:
        if not isinstance(se, dict):
            continue
        try:
            old_se_start_frame = max(0, int(se.get("startFrame") or 0))
        except (TypeError, ValueError):
            continue
        old_se_start_sec = old_se_start_frame / fps_f
        if old_se_start_sec < old_start_sec or old_se_start_sec >= old_end_sec:
            continue
        new_se = dict(se)
        new_se["startFrame"] = int(round((old_se_start_sec - old_start_sec) * fps_f))
        new_sound_effects.append(new_se)

    # 動画レイヤー (videoLayers): cut の時間範囲に重なる区間だけ抽出し、新時間軸に
    # 再マップする。telop と同じ思想。素材内の使用範囲 (trimStartSec / trimEndSec) も
    # 「cut と layer の重なり区間」に合わせて再計算する。
    new_video_layers: list[dict[str, Any]] = []
    for vl in orig_scene.get("videoLayers") or []:
        if not isinstance(vl, dict):
            continue
        try:
            old_vl_start_frame = max(0, int(vl.get("startFrame") or 0))
        except (TypeError, ValueError):
            continue
        try:
            trim_start = max(0.0, float(vl.get("trimStartSec") or 0.0))
        except (TypeError, ValueError):
            trim_start = 0.0
        raw_trim_end = vl.get("trimEndSec")
        try:
            trim_end = float(raw_trim_end) if raw_trim_end not in (None, "") else None
        except (TypeError, ValueError):
            trim_end = None
        # trim_end が未確定の場合は ffprobe で素材長を解決して終端を確定させる
        # (cut とのオーバーラップ判定で span が必要)。
        if trim_end is None:
            from .render import safe_asset_path
            src = str(vl.get("src") or "").strip()
            resolved_path = safe_asset_path(src) if src else None
            if resolved_path and resolved_path.exists():
                meta = video_metadata(resolved_path)
                if meta and float(meta.get("duration") or 0) > 0:
                    trim_end = float(meta["duration"])
        if trim_end is None or trim_end <= trim_start:
            # 解決不能 / 不正範囲: drop (映像も音声も出さない)
            continue
        span_sec = trim_end - trim_start
        old_vl_start_sec = old_vl_start_frame / fps_f
        old_vl_end_sec = old_vl_start_sec + span_sec
        overlap_start = max(old_vl_start_sec, old_start_sec)
        overlap_end = min(old_vl_end_sec, old_end_sec)
        if overlap_end <= overlap_start:
            continue
        # 新時間軸: cut 先頭からのオフセット
        new_start_sec = overlap_start - old_start_sec
        # layer 内ローカル時刻 (= 素材内秒) で「cut とのオーバーラップ開始/終了」
        overlap_local_start = overlap_start - old_vl_start_sec  # >= 0
        overlap_local_end = overlap_end - old_vl_start_sec      # > overlap_local_start
        new_vl = dict(vl)
        new_vl["startFrame"] = int(round(new_start_sec * fps_f))
        new_vl["trimStartSec"] = round(trim_start + overlap_local_start, 3)
        new_vl["trimEndSec"] = round(trim_start + overlap_local_end, 3)
        new_video_layers.append(new_vl)

    new_scene = dict(orig_scene)
    new_scene["cuts"] = [new_cut]
    new_scene["telops"] = new_telops
    if new_video_track is not None:
        new_scene["videoTrack"] = new_video_track
    new_scene["bgmTracks"] = new_bgm_tracks
    new_scene["soundEffects"] = new_sound_effects
    new_scene["videoLayers"] = new_video_layers
    return new_scene


# ---------------------------------------------------------------------------
# ffmpeg 引数生成 (v2_export.py が利用)
# ---------------------------------------------------------------------------


def build_video_codec_args(preset: dict[str, Any], options: dict[str, Any] | None = None) -> list[str]:
    """preset (BUILTIN_VIDEO_PRESETS の項目) と UI options から ffmpeg の `-c:v ...` 引数列を組む。

    options["videoEncoder"] が preset の alternateEncoders にあれば alternate へ差し替える。
    CRF / encoder preset / maxrate などのオプションは inline で `extra` に上書き挿入する。
    """
    options = options or {}
    requested_encoder = str(options.get("videoEncoder") or "").strip()
    base_codec = str(preset.get("videoCodec") or "libx264")
    video_codec = base_codec
    video_args = list(preset.get("videoArgs") or [])
    is_alternate = False
    if requested_encoder and requested_encoder != base_codec:
        for alt in preset.get("alternateEncoders") or []:
            if isinstance(alt, dict) and str(alt.get("id") or "") == requested_encoder:
                video_codec = requested_encoder
                video_args = list(alt.get("videoArgs") or [])
                is_alternate = True
                break

    def _override(extra: list[str], key: str, value: str) -> list[str]:
        """``extra`` 内の ``key value`` ペアを差し替え (無ければ末尾追加)。"""
        for i in range(len(extra) - 1):
            if extra[i] == key:
                return extra[:i] + [key, value] + extra[i + 2:]
        return extra + [key, value]

    args: list[str] = ["-c:v", video_codec]
    extra = video_args
    # SW 専用の crf / preset (libx264/libx265 の preset 名) は alternate (HW) では
    # 引数体系が違うので流さない。-maxrate は NVENC でも使えるので許可。
    if not is_alternate:
        crf_value = options.get("crf")
        if crf_value not in (None, ""):
            try:
                extra = _override(extra, "-crf", str(int(crf_value)))
            except (TypeError, ValueError):
                pass
        preset_value = options.get("encoderPreset")
        if isinstance(preset_value, str) and preset_value.strip():
            extra = _override(extra, "-preset", preset_value.strip())
    maxrate_value = options.get("maxrate")
    if isinstance(maxrate_value, str) and maxrate_value.strip():
        rate = maxrate_value.strip()
        extra = _override(extra, "-maxrate", rate)
        if "-bufsize" not in extra:
            extra += ["-bufsize", rate]
    args.extend(str(item) for item in extra)
    pix_fmt = preset.get("pixFmt")
    if pix_fmt:
        args += ["-pix_fmt", str(pix_fmt)]
    color_space = preset.get("colorSpace")
    if color_space:
        args += ["-colorspace", str(color_space), "-color_primaries", str(color_space), "-color_trc", str(color_space)]
    return args


def container_args(preset: dict[str, Any]) -> list[str]:
    extra = preset.get("containerArgs") or []
    if not isinstance(extra, list):
        return []
    return [str(item) for item in extra]


def merge_contiguous_audio_video_layers(
    video_layers: list[dict[str, Any]] | None,
    fps: int,
    video_metadata_fn=None,
) -> list[dict[str, Any]]:
    """隣接する同一 src の videoLayer を音声 mux 用に統合する。

    同じ素材を `-ss/-t -i` で 2 本に分けて開くと、AAC frame 境界や priming で
    隣接区間に微小なズレ・被りが入り、preview で「同じ音が一瞬繰り返される」/
    export で境界が荒れる原因になる (2026-05-20 動画テスト2 で再現)。
    隣接条件を満たすものは 1 本の `-i` にまとめて、AAC 連続デコードに乗せる。

    隣接条件 (= 全部満たすときだけマージ):
      - src 一致
      - layer 一致
      - 直前 group の trimEndSec ≈ 次 layer の trimStartSec (素材内連続)
      - 直前 group の終端 frame ≈ 次 layer の startFrame (timeline 連続)
      - volume 一致 (mux で adelay/volume を group 単位 1 回ずつしか掛けない設計)
      - 境界に fade なし (= 分割で fadeIn/Out を 0 化した綺麗な継ぎ目だけマージ)
      - muted=False (呼び出し側で muted=True は除外済みの前提だが防御で再確認)

    返り値: 統合後の dict のリスト。元 videoLayer と互換キー (`src`, `layer`,
    `startFrame`, `trimStartSec`, `trimEndSec`, `volume`) を持ち、内部利用キー
    `_members` に元 VL のリストを記録する。
    """
    eligible: list[dict[str, Any]] = []
    for vl in video_layers or []:
        if not isinstance(vl, dict):
            continue
        if vl.get("muted"):
            continue
        if not vl.get("src"):
            continue
        eligible.append(vl)
    if not eligible:
        return []
    eligible.sort(
        key=lambda v: (str(v.get("layer") or ""), int(v.get("startFrame") or 0))
    )

    groups: list[dict[str, Any]] = []
    fps_f = float(fps)
    for vl in eligible:
        try:
            trim_start = max(0.0, float(vl.get("trimStartSec") or 0.0))
        except (TypeError, ValueError):
            trim_start = 0.0
        raw_trim_end = vl.get("trimEndSec")
        try:
            trim_end_val = float(raw_trim_end) if raw_trim_end not in (None, "") else None
        except (TypeError, ValueError):
            trim_end_val = None
        # trim_end が null のときだけ素材長で解決 (= 無駄な ffprobe を避ける)
        if trim_end_val is None and video_metadata_fn is not None:
            try:
                from .render import safe_asset_path as _safe
                p = _safe(vl.get("src"))
                if p and p.exists():
                    meta = video_metadata_fn(p)
                    if meta:
                        trim_end_val = float(meta.get("duration") or 0.0)
            except Exception:
                trim_end_val = None
        if trim_end_val is None or trim_end_val <= trim_start:
            continue
        try:
            volume_val = float(vl.get("volume")) if vl.get("volume") is not None else 1.0
        except (TypeError, ValueError):
            volume_val = 1.0
        fade_in_active = bool(vl.get("fadeInEnabled"))
        fade_out_active = bool(vl.get("fadeOutEnabled"))
        start_frame = int(vl.get("startFrame") or 0)

        # 直前 group とマージ可能か?
        if groups:
            g = groups[-1]
            mergeable = (
                g["src"] == vl.get("src")
                and g["layer"] == (vl.get("layer") or "above_bg")
                and abs(g["trimEndSec"] - trim_start) < 0.05
                and abs(g["_endFrame"] - start_frame) <= 1
                and abs(float(g["volume"]) - volume_val) < 1e-3
                and not g["_lastFadeOut"]
                and not fade_in_active
            )
            if mergeable:
                g["trimEndSec"] = trim_end_val
                g["_endFrame"] = int(round(
                    g["startFrame"] + (trim_end_val - g["trimStartSec"]) * fps_f
                ))
                g["_lastFadeOut"] = fade_out_active
                # 末尾メンバーの fadeOut を group の値として持ち回す。
                # マージは「直前 group の最終メンバが fadeOut 無し」かつ
                # 「次メンバが fadeIn 無し」のときだけ走るので、
                # group の fadeIn は最初のメンバ固定、fadeOut は最後のメンバ固定。
                if fade_out_active:
                    try:
                        g["fadeOutSec"] = max(0.0, min(60.0, float(vl.get("fadeOutSec") or 0.0)))
                    except (TypeError, ValueError):
                        g["fadeOutSec"] = 0.0
                    g["fadeOutEnabled"] = True
                else:
                    g["fadeOutEnabled"] = False
                    g["fadeOutSec"] = 0.0
                g["_members"].append(vl)
                continue

        try:
            first_fade_in_sec = max(0.0, min(60.0, float(vl.get("fadeInSec") or 0.0))) if fade_in_active else 0.0
        except (TypeError, ValueError):
            first_fade_in_sec = 0.0
        try:
            last_fade_out_sec = max(0.0, min(60.0, float(vl.get("fadeOutSec") or 0.0))) if fade_out_active else 0.0
        except (TypeError, ValueError):
            last_fade_out_sec = 0.0
        groups.append({
            "src": vl.get("src"),
            "layer": vl.get("layer") or "above_bg",
            "startFrame": start_frame,
            "trimStartSec": trim_start,
            "trimEndSec": trim_end_val,
            "volume": volume_val,
            # group 全体の fade 情報。VL audio に afade を被せるための値を保持する。
            "fadeInEnabled": bool(fade_in_active),
            "fadeInSec": first_fade_in_sec,
            "fadeOutEnabled": bool(fade_out_active),
            "fadeOutSec": last_fade_out_sec,
            "_endFrame": int(round(start_frame + (trim_end_val - trim_start) * fps_f)),
            "_lastFadeOut": fade_out_active,
            "_members": [vl],
        })
    return groups


def _build_audio_amix_segments(
    scene_duration: float,
    *,
    cut_audio_inputs: list[tuple[int, dict[str, Any]]],
    bgm_inputs: list[tuple[int, dict[str, Any]]],
    video_audio_input_idx: int | None,
    sound_effect_inputs: list[tuple[int, dict[str, Any]]] | None = None,
    video_layer_inputs: list[tuple[int, dict[str, Any]]] | None = None,
) -> tuple[list[str], str | None]:
    """シーン音声 amix の filter 断片と最終ラベルを返す。

    返り値の audio_label は `[name]` 形式 (-map にそのまま渡せる)。
    入力が一つも無ければ (segments, None) を返す。
    """
    segments: list[str] = []
    # amix 入力順: SE は点配置で短いため、長尺音源 (cut_audio / BGM / videoTrack /
    # videoLayer) の **後ろ** に積むと「SE 終端時点で先行 long-form の音が落ちる」
    # 現象が起きていた (= 2026-05-20 動画テスト2 で 14.04s〜16.917s の不自然な
    # 無音として再現)。これは sample rate 不一致 (= SE=44100Hz / VL=48000Hz など)
    # と amix 入力順の組合せに起因するため、両方を直す:
    #   (a) 各 branch 末尾で `aresample=48000:async=1:first_pts=0` で全 input を
    #       48kHz / PTS=0 始まりに揃える
    #   (b) labels の順序を「long-form を先、SE を最後」に組み替える
    cut_labels: list[str] = []
    bgm_labels: list[str] = []
    vt_labels: list[str] = []
    vl_labels: list[str] = []
    se_labels: list[str] = []

    # adelay 後の PTS 再生成。MP4/AAC 入力では adelay が出力フレームの PTS を
    # 「入力 PTS + delay」で書き出すが、入力 PTS が NOPTS / 巨大な負値の場合に
    # 後段フィルタ (apad/atrim) の duration 判定が狂って後半フレームが落ちる。
    # 「asetpts=N/SR/TB」で 0 起算のサンプル番号ベースに振り直すと安定する。
    # cut audio / SE の adelay 経路で利用する。
    #
    # videoLayer (動画レイヤー) では使わない: 呼び出し側 (v2_export.py) で
    # `prepare_clean_pcm` を通して PTS gap を sample-time 側で吸収済みの連続 PCM
    # を入力にするため、ここで N/SR/TB の追加正規化は不要。`asetpts=PTS-STARTPTS`
    # で 0 起算化のみ行う。詳細は下の videoLayer ブロックを参照。
    PTS_RESET_AFTER_DELAY = "asetpts=N/SR/TB"
    # amix 入力の SR / PTS 起点を branch で揃えるための末尾フィルタ。
    #
    # **短尺ソース (SE / BGM / cut audio)** には async=1:first_pts=0 を使う。
    #   - 短い素材で PTS gap がほぼ無い前提
    #   - amix 入力アライメント + sample drift 補正に効く
    #
    # **長尺ソース (VL / videoTrack)** には async を使わず単純 resample のみ。
    #   - 入力側 (v2_export.py) で `prepare_clean_pcm` を通して `aresample=async=1000`
    #     で PTS gap を吸収済みの WAV (s16le 48k stereo) を渡している
    #   - したがって filter graph 側では SR を 48k に揃え直すだけで十分
    #   - clean PCM 生成失敗時 (= 戻り値 None で原 src フォールバック) でも、
    #     async を入れない方が source time との対応が崩れにくい
    AMIX_BRANCH_NORMALIZE = "aresample=48000:async=1:first_pts=0"
    AMIX_BRANCH_NORMALIZE_LONG = "aresample=48000"

    for input_idx, cut in cut_audio_inputs:
        start_frame = max(0, int(cut.get("startFrame") or 0))
        duration_frame = max(1, int(cut.get("durationFrame") or 0))
        start_sec = start_frame / float(PROJECT_FPS)
        duration = duration_frame / float(PROJECT_FPS)
        delay_ms = int(round(start_sec * 1000))
        label = f"ca_{input_idx}"
        parts = [f"atrim=duration={duration:.3f}", "asetpts=PTS-STARTPTS"]
        if delay_ms > 0:
            parts.append(f"adelay={delay_ms}|{delay_ms}")
            parts.append(PTS_RESET_AFTER_DELAY)
        parts.append(f"apad=whole_dur={scene_duration:.3f}")
        parts.append(f"atrim=duration={scene_duration:.3f}")
        parts.append(AMIX_BRANCH_NORMALIZE)
        segments.append(f"[{input_idx}:a]" + ",".join(parts) + f"[{label}]")
        cut_labels.append(label)

    for input_idx, bgm in bgm_inputs:
        try:
            fade_in = max(0.0, float(bgm.get("fadeInSec") or 0.0))
        except (TypeError, ValueError):
            fade_in = 0.0
        try:
            fade_out = max(0.0, float(bgm.get("fadeOutSec") or 0.0))
        except (TypeError, ValueError):
            fade_out = 0.0
        try:
            volume = max(0.0, float(bgm.get("volume") or 1.0))
        except (TypeError, ValueError):
            volume = 1.0
        label = f"bgm_{input_idx}"
        # 入力側で -ss でトリム済みの想定。あとは fade / volume / 長さ整形。
        parts: list[str] = ["asetpts=PTS-STARTPTS"]
        if fade_in > 0:
            parts.append(f"afade=t=in:st=0:d={fade_in:.3f}")
        if fade_out > 0:
            fade_out_start = max(0.0, scene_duration - fade_out)
            parts.append(f"afade=t=out:st={fade_out_start:.3f}:d={fade_out:.3f}")
        if abs(volume - 1.0) > 1e-3:
            parts.append(f"volume={volume:.3f}")
        parts.append(f"apad=whole_dur={scene_duration:.3f}")
        parts.append(f"atrim=duration={scene_duration:.3f}")
        parts.append(AMIX_BRANCH_NORMALIZE)
        segments.append(f"[{input_idx}:a]" + ",".join(parts) + f"[{label}]")
        bgm_labels.append(label)

    for input_idx, se in (sound_effect_inputs or []):
        try:
            start_frame = max(0, int(se.get("startFrame") or 0))
        except (TypeError, ValueError):
            start_frame = 0
        try:
            volume = max(0.0, float(se.get("volume") or 1.0))
        except (TypeError, ValueError):
            volume = 1.0
        try:
            duration_frame = max(0, int(se.get("durationFrame") or 0))
        except (TypeError, ValueError):
            duration_frame = 0
        try:
            fade_in = max(0.0, float(se.get("fadeInSec") or 0.0))
        except (TypeError, ValueError):
            fade_in = 0.0
        try:
            fade_out = max(0.0, float(se.get("fadeOutSec") or 0.0))
        except (TypeError, ValueError):
            fade_out = 0.0
        loop = bool(se.get("loop") or False)
        asset_dur_sec = se.get("_resolvedAssetDurSec")
        try:
            asset_dur_sec = float(asset_dur_sec) if asset_dur_sec is not None else None
        except (TypeError, ValueError):
            asset_dur_sec = None
        # loop=True で audioOffsetSec>0 のケースは v2_export.py 側で `-ss` を
        # 落として `_audioOffsetForFilter` として渡している (= `-stream_loop -1`
        # + `-ss BEFORE -i` の組合せが atrim 終端をすり抜けて余分な音を流す
        # ffmpeg バグの回避)。ここではフィルタ側 atrim で start を指定する。
        try:
            audio_offset_for_filter = float(se.get("_audioOffsetForFilter") or 0.0)
        except (TypeError, ValueError):
            audio_offset_for_filter = 0.0
        audio_offset_for_filter = max(0.0, audio_offset_for_filter)

        start_sec = start_frame / float(PROJECT_FPS)
        delay_ms = int(round(start_sec * 1000))

        # region: ユーザ指定 durationFrame があればそれ、無ければ asset 長。
        region_sec: float | None = None
        if duration_frame > 0:
            region_sec = duration_frame / float(PROJECT_FPS)
        elif asset_dur_sec and asset_dur_sec > 0:
            region_sec = asset_dur_sec

        # effective_end: 実際に音が鳴り終わる時刻 (region 内ローカル秒)。
        # loop=True なら region いっぱい、loop=False なら min(region, asset)。
        effective_end_sec: float | None = None
        if region_sec is not None:
            if loop:
                effective_end_sec = region_sec
            elif asset_dur_sec is not None and asset_dur_sec > 0:
                effective_end_sec = min(region_sec, asset_dur_sec)
            else:
                effective_end_sec = region_sec

        # fade を region の半分以内にクランプ。
        if effective_end_sec is not None:
            fade_max = effective_end_sec / 2.0
            fade_in = min(fade_in, fade_max)
            fade_out = min(fade_out, fade_max)

        label = f"se_{input_idx}"
        parts: list[str] = ["asetpts=PTS-STARTPTS"]
        # 区間で切る (loop なら stream_loop されたストリームをここで終端切り、
        # 非 loop なら素材末尾より遠ければ atrim は no-op で素材末尾終了)。
        # `_audioOffsetForFilter > 0` のときは `-ss` を使わずフィルタで頭出し
        # するので、atrim に start も渡す ([offset, offset+region] を抜き出す)。
        if region_sec is not None:
            if audio_offset_for_filter > 0:
                parts.append(
                    f"atrim=start={audio_offset_for_filter:.3f}:"
                    f"duration={region_sec:.3f}"
                )
            else:
                parts.append(f"atrim=duration={region_sec:.3f}")
            # atrim 後は PTS を 0 起算に戻す (後段 fade の `st=` 起算を素直にするため)。
            parts.append("asetpts=PTS-STARTPTS")
        elif audio_offset_for_filter > 0:
            # region 未指定でも頭出しだけは必要 (loop=True で region_sec が
            # asset_dur 由来でセットされていない経路 = asset_dur 解決失敗時)。
            parts.append(f"atrim=start={audio_offset_for_filter:.3f}")
            parts.append("asetpts=PTS-STARTPTS")
        # フェードは「区間全体の先頭と末尾」だけに掛ける。region 末尾と素材末尾が
        # ズレるとき (loop=False で region > asset) は asset 末尾基準で out を置く。
        if fade_in > 0:
            parts.append(f"afade=t=in:st=0:d={fade_in:.3f}")
        if fade_out > 0 and effective_end_sec is not None:
            fade_out_start = max(0.0, effective_end_sec - fade_out)
            parts.append(f"afade=t=out:st={fade_out_start:.3f}:d={fade_out:.3f}")
        if abs(volume - 1.0) > 1e-3:
            parts.append(f"volume={volume:.3f}")
        if delay_ms > 0:
            parts.append(f"adelay={delay_ms}|{delay_ms}")
            parts.append(PTS_RESET_AFTER_DELAY)
        # SE は scene 末尾でクランプ (region 越えは既に上で切られている)。
        parts.append(f"apad=whole_dur={scene_duration:.3f}")
        parts.append(f"atrim=duration={scene_duration:.3f}")
        parts.append(AMIX_BRANCH_NORMALIZE)
        segments.append(f"[{input_idx}:a]" + ",".join(parts) + f"[{label}]")
        se_labels.append(label)

    if video_audio_input_idx is not None:
        label = f"vta_{video_audio_input_idx}"
        # 源 PTS をそのまま (PTS-STARTPTS で 0 起算化のみ) 保持し、末尾は単純
        # resample のみ。PTS gap は player 側に判断を委ねる (= 0 無音 sample で
        # 強制 fill しない / squash で末尾無音を作らない)。
        segments.append(
            f"[{video_audio_input_idx}:a]asetpts=PTS-STARTPTS,"
            f"apad=whole_dur={scene_duration:.3f},atrim=duration={scene_duration:.3f},"
            f"{AMIX_BRANCH_NORMALIZE_LONG}[{label}]"
        )
        vt_labels.append(label)

    # 動画レイヤー音声: v2_export.py 側で `prepare_clean_pcm` を通した連続 PCM
    # (s16le 48k stereo, async=1000 で PTS gap を sample-time 側に吸収済み) を
    # 入力に取り、`-ss trimStart -t span` で trim 範囲を切り出してから渡す。
    # muted=True または hasAudio=False のレイヤーは呼び出し側で除外して渡らない。
    #
    # ここでは adelay (startFrame 換算) + volume + 全体長クランプ + SR 再正規化を
    # 乗せる。clean PCM を経由しているので入力 PTS は 0 起算で連続しており、
    # adelay の duration 判定問題 (NOPTS / 巨大負値) は元から起きない。よって
    # `asetpts=N/SR/TB` は使わず、`asetpts=PTS-STARTPTS` で 0 起算化のみ行う。
    #
    # 連続 VL マージ (`merge_contiguous_audio_video_layers`) は維持 (= 1 frame
    # ≈ 41ms / trim 差 50ms 以内の境界丸め誤差を 1 input にまとめて吸収)。
    for input_idx, vl in (video_layer_inputs or []):
        try:
            start_frame = max(0, int(vl.get("startFrame") or 0))
        except (TypeError, ValueError):
            start_frame = 0
        try:
            volume = max(0.0, float(vl.get("volume") if vl.get("volume") is not None else 1.0))
        except (TypeError, ValueError):
            volume = 1.0
        # VL audio の filter 内 duration。
        # v2_export.py が `_audioFilterDurationSec` を渡してくれる場合はそちらを優先
        # (clean_pcm 経路で PTS gap を吸収済みの実 stream-time 尺)。無いときは
        # source-time の trim 差分にフォールバック (= raw_src 経路と同じ)。
        explicit_dur = vl.get("_audioFilterDurationSec")
        try:
            trim_start = max(0.0, float(vl.get("trimStartSec") or 0.0))
        except (TypeError, ValueError):
            trim_start = 0.0
        try:
            trim_end = float(vl.get("trimEndSec")) if vl.get("trimEndSec") is not None else trim_start
        except (TypeError, ValueError):
            trim_end = trim_start
        try:
            vl_duration = float(explicit_dur) if explicit_dur is not None else max(0.0, trim_end - trim_start)
        except (TypeError, ValueError):
            vl_duration = max(0.0, trim_end - trim_start)
        try:
            fade_in = max(0.0, float(vl.get("fadeInSec") or 0.0)) if vl.get("fadeInEnabled") else 0.0
        except (TypeError, ValueError):
            fade_in = 0.0
        try:
            fade_out = max(0.0, float(vl.get("fadeOutSec") or 0.0)) if vl.get("fadeOutEnabled") else 0.0
        except (TypeError, ValueError):
            fade_out = 0.0
        # 合計が vl_duration を越えると afade が壊れるので半分ずつにクランプ。
        # (映像側の _computeVideoLayerAlpha は乗算なのでクランプ不要、こちらだけ
        #  ffmpeg の `st` が duration 内に収まる必要があるため明示的に縮める)
        if vl_duration > 0:
            fade_max = vl_duration / 2.0
            fade_in = min(fade_in, fade_max)
            fade_out = min(fade_out, fade_max)
        start_sec = start_frame / float(PROJECT_FPS)
        delay_ms = int(round(start_sec * 1000))
        label = f"vl_{input_idx}"
        # 注: afade は **adelay の前** に置く。adelay 後の時間軸は scene 内位置に
        # シフトされてしまい `afade=t=out:st=...` の意味が崩れるため、clip-internal
        # な 0..vl_duration の時間軸で fade を完結させてから shift する。
        parts: list[str] = ["asetpts=PTS-STARTPTS"]
        if fade_in > 0:
            parts.append(f"afade=t=in:st=0:d={fade_in:.3f}")
        if fade_out > 0 and vl_duration > 0:
            fade_out_start = max(0.0, vl_duration - fade_out)
            parts.append(f"afade=t=out:st={fade_out_start:.3f}:d={fade_out:.3f}")
        if abs(volume - 1.0) > 1e-3:
            parts.append(f"volume={volume:.3f}")
        if delay_ms > 0:
            parts.append(f"adelay={delay_ms}|{delay_ms}")
        parts.append(f"apad=whole_dur={scene_duration:.3f}")
        parts.append(f"atrim=duration={scene_duration:.3f}")
        parts.append(AMIX_BRANCH_NORMALIZE_LONG)
        segments.append(f"[{input_idx}:a]" + ",".join(parts) + f"[{label}]")
        vl_labels.append(label)

    # amix 入力順を long-form (cut audio / BGM / videoTrack / videoLayer) 先、
    # 短尺の SE を最後に組み上げる (= 2026-05-20 動画テスト2 リグレッション対策)。
    labels: list[str] = (
        cut_labels + bgm_labels + vt_labels + vl_labels + se_labels
    )
    if not labels:
        return segments, None
    if len(labels) == 1:
        return segments, f"[{labels[0]}]"
    amix_inputs = "".join(f"[{name}]" for name in labels)
    final = "scene_a"
    segments.append(
        f"{amix_inputs}amix=inputs={len(labels)}:duration=longest:dropout_transition=0:normalize=0[{final}]"
    )
    return segments, f"[{final}]"

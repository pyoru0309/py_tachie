"""グローバル設定（動画書き出しプリセット / ffmpeg / プロジェクトフォルダ等）。

依存先は app.paths のみ + 標準ライブラリ。"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .paths import DEFAULT_PROJECTS_DIR, GLOBAL_CONFIG_PATH


# 既定の H.264 alternate エンコーダ。preset.alternateEncoders に載せて
# 書き出しダイアログから即座に切替できる。ファイルサイズは SW より少し大きいが
# 1.5-3x 高速。capability detection で実際に利用可能な encoder のみ UI に出る。
_H264_ALTERNATE_VIDEOTOOLBOX = {
    "id": "h264_videotoolbox",
    "name": "VideoToolbox (Apple Silicon HW)",
    "description": "ハードウェア encoder。1.3-1.5x 高速だがファイルは少し大きい",
    # videotoolbox は -preset/-crf 非対応。-q:v 50 (≒ x264 crf 22 相当)。
    "videoArgs": ["-q:v", "50"],
}

# NVENC (NVIDIA RTX/GTX) — 標準/高画質それぞれ用。
# `-preset pN`: p1=最速, p4=medium 相当, p7=最高画質。
# `-rc vbr -cq Q -b:v 0`: CQ で画質目標を指定 (低いほど高画質)。-b:v 0 を入れないと
# 最大ビットレートが効いて狙った画質にならないので必須。
_H264_ALTERNATE_NVENC = {
    "id": "h264_nvenc",
    "name": "NVENC (NVIDIA HW)",
    "description": "NVIDIA RTX/GTX のハードウェア encoder。CPU 負荷ほぼゼロで大幅高速化",
    "videoArgs": ["-preset", "p4", "-rc", "vbr", "-cq", "22", "-b:v", "0"],
}

_H264_ALTERNATE_NVENC_HIGH = {
    "id": "h264_nvenc",
    "name": "NVENC (NVIDIA HW)",
    "description": "NVIDIA RTX/GTX のハードウェア encoder。-cq 19 で高画質寄り",
    "videoArgs": ["-preset", "p6", "-rc", "vbr", "-cq", "19", "-b:v", "0"],
}

_HEVC_ALTERNATE_NVENC = {
    "id": "hevc_nvenc",
    "name": "NVENC HEVC (NVIDIA HW)",
    "description": "NVIDIA RTX/GTX のハードウェア HEVC encoder",
    "videoArgs": ["-preset", "p4", "-rc", "vbr", "-cq", "24", "-b:v", "0"],
}

_HEVC_ALTERNATE_VIDEOTOOLBOX = {
    "id": "hevc_videotoolbox",
    "name": "VideoToolbox HEVC (Apple Silicon HW)",
    "description": "Apple Silicon のハードウェア HEVC encoder",
    "videoArgs": ["-q:v", "55"],
}

BUILTIN_VIDEO_PRESETS: list[dict[str, Any]] = [
    {
        "id": "mp4_h264_standard",
        "name": "MP4 (H.264) 標準",
        "description": "汎用 web/視聴向け。圧縮率と互換性のバランス",
        "extension": ".mp4",
        "fps": 24,
        "videoCodec": "libx264",
        "videoArgs": ["-preset", "medium", "-crf", "20"],
        "pixFmt": "yuv420p",
        "colorSpace": "bt709",
        "audioCodec": "aac",
        "audioBitrate": "192k",
        "containerArgs": ["-movflags", "+faststart"],
        "alternateEncoders": [_H264_ALTERNATE_NVENC, _H264_ALTERNATE_VIDEOTOOLBOX],
        "builtIn": True,
    },
    {
        "id": "mp4_h264_high",
        "name": "MP4 (H.264) 高画質",
        "description": "MP4 のままで CRF を下げて高画質化。配信前マスタ用途",
        "extension": ".mp4",
        "fps": 24,
        "videoCodec": "libx264",
        "videoArgs": ["-preset", "slow", "-crf", "16"],
        "pixFmt": "yuv420p",
        "colorSpace": "bt709",
        "audioCodec": "aac",
        "audioBitrate": "256k",
        "containerArgs": ["-movflags", "+faststart"],
        # 高画質プリセットの HW 版は -q:v / -cq をやや下げて (高画質側にして) 追加。
        "alternateEncoders": [
            _H264_ALTERNATE_NVENC_HIGH,
            {
                "id": "h264_videotoolbox",
                "name": "VideoToolbox (Apple Silicon HW)",
                "description": "ハードウェア encoder。-q:v 65 で高画質寄り",
                "videoArgs": ["-q:v", "65"],
            },
        ],
        "builtIn": True,
    },
    {
        "id": "mp4_h265_efficient",
        "name": "MP4 (H.265) 高効率",
        "description": "HEVC でファイルサイズを抑えつつ画質を維持",
        "extension": ".mp4",
        "fps": 24,
        "videoCodec": "libx265",
        "videoArgs": ["-preset", "medium", "-crf", "22"],
        "pixFmt": "yuv420p",
        "colorSpace": "bt709",
        "audioCodec": "aac",
        "audioBitrate": "192k",
        "containerArgs": ["-movflags", "+faststart", "-tag:v", "hvc1"],
        "alternateEncoders": [_HEVC_ALTERNATE_NVENC, _HEVC_ALTERNATE_VIDEOTOOLBOX],
        "builtIn": True,
    },
    {
        "id": "mov_prores_proxy",
        "name": "ProRes 422 Proxy (mov)",
        "description": "編集ソフト用に軽量。Premiere/DaVinci/FCP 取り込みに最適",
        "extension": ".mov",
        "fps": 24,
        "videoCodec": "prores_ks",
        "videoArgs": ["-profile:v", "0", "-vendor", "apl0"],
        "pixFmt": "yuv422p10le",
        "colorSpace": "bt709",
        "audioCodec": "pcm_s16le",
        "audioBitrate": "",
        "containerArgs": [],
        "builtIn": True,
    },
    {
        "id": "mov_prores_hq",
        "name": "ProRes 422 HQ (mov)",
        "description": "視覚的にロスレスな編集中間コーデック。ファイルは大きめ",
        "extension": ".mov",
        "fps": 24,
        "videoCodec": "prores_ks",
        "videoArgs": ["-profile:v", "3", "-vendor", "apl0"],
        "pixFmt": "yuv422p10le",
        "colorSpace": "bt709",
        "audioCodec": "pcm_s16le",
        "audioBitrate": "",
        "containerArgs": [],
        "builtIn": True,
    },
    {
        "id": "mov_prores_4444",
        "name": "ProRes 4444 (mov, アルファ対応)",
        "description": "アルファチャンネル付きの中間コーデック。背景なしの透過書き出し用",
        "extension": ".mov",
        "fps": 24,
        "videoCodec": "prores_ks",
        "videoArgs": ["-profile:v", "4", "-vendor", "apl0", "-alpha_bits", "16"],
        "pixFmt": "yuva444p10le",
        "colorSpace": "bt709",
        "audioCodec": "pcm_s16le",
        "audioBitrate": "",
        "containerArgs": [],
        "alpha": True,
        "builtIn": True,
    },
    {
        "id": "mov_qt_png",
        "name": "QuickTime PNG (mov, アルファ対応・完全可逆)",
        "description": "PNGコーデックのQuickTimeコンテナ。完全可逆＆アルファ対応で編集ソフト互換性が高い（ファイルサイズは大きい）",
        "extension": ".mov",
        "fps": 24,
        "videoCodec": "png",
        "videoArgs": [],
        "pixFmt": "rgba",
        "colorSpace": "",
        "audioCodec": "pcm_s16le",
        "audioBitrate": "",
        "containerArgs": [],
        "alpha": True,
        "builtIn": True,
    },
]

def default_global_config() -> dict[str, Any]:
    return {
        "version": 1,
        "videoExport": {
            "defaultPresetId": "mp4_h264_standard",
            "customPresets": [],
            "monoToStereo": True,
            "promptBeforeExport": False,
            # WebSocket backpressure threshold (MB)。GL → RGBA → WS → ffmpeg の経路で
            # `ws.bufferedAmount` がこの値 (バイト換算) を超えたら send 側で setTimeout
            # 待ち。0 にすると無効化されて長尺 export で Chromium タブが落ちる。
            # 16 が `/v2-export` の完走実績ある既定。32 / 64 でスループットが上がる
            # 環境もあるので調整可能にしてある。範囲: 1〜1024。
            "bpThresholdMB": 16,
        },
        "editorHistorySize": 50,
        "ffmpegPath": "",
        "projectsPath": "",
        # 新規インストール時のデフォルトは ON (= 抑制)。詳細ログは「開発者モード」
        # 位置付けで、ユーザは全体設定で OFF にしたとき初めて INFO が流れる。
        # quietMode=True で uvicorn 系 + splite_anime logger を WARNING 化 (詳細は
        # app/log_setup.py 参照)。既存ユーザの設定ファイルに値があればそちらが優先。
        "logging": {
            "quietMode": True,
        },
        # 描画エンジン（全プロジェクト共通）。v2 = WebGL + three.js 固定。
        # 旧 v1 (Pillow + Canvas2D) はサーバ・クライアントとも撤去済み。値は
        # load/save 経路の整合性のために残しているが、書き換えても挙動は変わらない。
        "renderer": {
            "version": "v2",
        },
        # JS ライブラリ (three.js / mp4box.js) の取得元。
        # useCdn=False: static/vendor/ にインストール済みなら local、無ければ CDN
        #               フォールバック (オフライン運用するなら事前 install 必須)。
        # useCdn=True : 常に CDN (jsdelivr) を使う。
        "vendor": {
            "useCdn": False,
        },
        # 自動認識を上書きしたいフォントファイルがあるとき、ここで明示する。
        # 例: {"assets/fonts/AwesomeFont-XYZ.otf": "bold"}
        # キーは PROJECT_ROOT からの POSIX 相対パス、値は fontWeights の id。
        # 通常は OS/2.usWeightClass で十分なので空のままで OK。
        "fontWeightOverrides": {},
        # 音声合成 (VOICEVOX / Voicepeak) 連携。空欄なら OS 別のデフォルトパスを
        # 自動検出する。voicevoxBaseUrl 空欄時は http://127.0.0.1:50021 を使う。
        "tts": {
            "voicevoxAppPath": "",
            "voicevoxBaseUrl": "",
            "voicepeakBinPath": "",
        },
        # 編集画面のショートカットキー。値は "" (= 無効化) または
        # "Shift+ArrowLeft" / "Space" / "Delete" 等の正規化キー文字列。
        # ここに無いキーはフロント側 SHORTCUT_ACTIONS の default が使われる。
        "shortcuts": {},
        # プレビュー再生のスライディング・ウィンドウ prefetch 制御。
        # prefetchLookahead: 再生中、現カットから何カット先までを裏で温めるか。
        #   0 = 先読みなし (現カットのみ)、大きいほど境界ラグに強いがサーバ側の
        #   bake 処理 (visualizer / dialogue / telop / 背景) が前倒しで走るため
        #   重い構成では負荷が上がる。範囲: 0〜20。
        "preview": {
            "prefetchLookahead": 3,
            # プレビュー表示の品質。
            # - "sharp":  WebGL canvas をそのままブラウザの CSS スケーリングで表示
            #             (= 既定)。文字は鋭く、縮小時にポリゴンエッジがジャギーに
            #             見えることがある (特に Windows + ANGLE)。
            # - "smooth": 2D canvas overlay を毎フレーム drawImage で再描画して
            #             高品質バイリニア縮小をかける。アンチエイリアスが効くが、
            #             文字はやや柔らかく見える。
            "smoothing": "sharp",
        },
        # scenarios/main.json 自動バックアップ。
        # autoIntervalMinutes: 周期バックアップの間隔 (分)。1〜120 にクランプ。
        # autoRetentionCount: auto バックアップを何件保持するか (古い順に削除)。
        #                     manual / preRestore は対象外で常に保持される。1〜1000。
        "backup": {
            "autoIntervalMinutes": 5,
            "autoRetentionCount": 50,
        },
        # キャッシュ自動破棄 (アプリ起動時に preview/lipsync/clean_pcm から古いものを間引く)。
        # autoPruneOnStartup: True で起動時に prune_old_cache_files を実行。
        # autoPruneOlderThanHours: mtime がこれより古いキャッシュファイルを削除。
        #   既定 6 時間は「半日の連続編集中に数 GB 蓄積する」現実値からの逆算。
        #   キャッシュ生成コストはユーザー体感で気付かない (= 数 ms) のでデフォルトを
        #   短く倒して、ディスク使用量を低く保つ。1〜8760 (= 1 年) にクランプ。
        #   旧 autoPruneOlderThanDays (= 日単位) は load 時に Hours に migration する。
        "cache": {
            "autoPruneOnStartup": True,
            "autoPruneOlderThanHours": 6,
        },
    }


def _clamp_history_size(value: Any, fallback: int = 50) -> int:
    try:
        size = int(value)
    except (TypeError, ValueError):
        return fallback
    if size < 1:
        return 1
    if size > 500:
        return 500
    return size


def load_global_config() -> dict[str, Any]:
    base = default_global_config()
    if not GLOBAL_CONFIG_PATH.exists():
        return base
    try:
        data = json.loads(GLOBAL_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return base
    if not isinstance(data, dict):
        return base
    config = base
    video = data.get("videoExport") if isinstance(data.get("videoExport"), dict) else {}
    if isinstance(video.get("defaultPresetId"), str) and video.get("defaultPresetId"):
        config["videoExport"]["defaultPresetId"] = video["defaultPresetId"]
    if isinstance(video.get("customPresets"), list):
        config["videoExport"]["customPresets"] = video["customPresets"]
    if "monoToStereo" in video:
        config["videoExport"]["monoToStereo"] = bool(video["monoToStereo"])
    if "promptBeforeExport" in video:
        config["videoExport"]["promptBeforeExport"] = bool(video["promptBeforeExport"])
    if "bpThresholdMB" in video:
        try:
            bp = float(video["bpThresholdMB"])
        except (TypeError, ValueError):
            bp = config["videoExport"]["bpThresholdMB"]
        config["videoExport"]["bpThresholdMB"] = max(1.0, min(1024.0, bp))
    if "editorHistorySize" in data:
        config["editorHistorySize"] = _clamp_history_size(
            data.get("editorHistorySize"), config.get("editorHistorySize", 50)
        )
    if isinstance(data.get("ffmpegPath"), str):
        config["ffmpegPath"] = data["ffmpegPath"].strip()
    if isinstance(data.get("projectsPath"), str):
        config["projectsPath"] = data["projectsPath"].strip()
    logging_in = data.get("logging") if isinstance(data.get("logging"), dict) else {}
    if "quietMode" in logging_in:
        config["logging"]["quietMode"] = bool(logging_in["quietMode"])
    # renderer.version は v2 固定。旧 "v1" が書かれていても silent migration。
    config["renderer"]["version"] = "v2"
    vendor_in = data.get("vendor") if isinstance(data.get("vendor"), dict) else {}
    if "useCdn" in vendor_in:
        config["vendor"]["useCdn"] = bool(vendor_in["useCdn"])
    overrides_in = data.get("fontWeightOverrides")
    if isinstance(overrides_in, dict):
        cleaned: dict[str, str] = {}
        for k, v in overrides_in.items():
            if not isinstance(k, str) or not isinstance(v, str):
                continue
            k = k.strip()
            v = v.strip()
            if k and v:
                cleaned[k] = v
        config["fontWeightOverrides"] = cleaned
    tts_in = data.get("tts") if isinstance(data.get("tts"), dict) else {}
    tts_out = config["tts"]
    for key in ("voicevoxAppPath", "voicevoxBaseUrl", "voicepeakBinPath"):
        if isinstance(tts_in.get(key), str):
            tts_out[key] = tts_in[key].strip()
    shortcuts_in = data.get("shortcuts") if isinstance(data.get("shortcuts"), dict) else {}
    cleaned_shortcuts: dict[str, str] = {}
    for key, value in shortcuts_in.items():
        if not isinstance(key, str):
            continue
        if isinstance(value, str):
            cleaned_shortcuts[key.strip()] = value.strip()
    config["shortcuts"] = cleaned_shortcuts
    preview_in = data.get("preview") if isinstance(data.get("preview"), dict) else {}
    if "prefetchLookahead" in preview_in:
        try:
            la = int(preview_in["prefetchLookahead"])
        except (TypeError, ValueError):
            la = config["preview"]["prefetchLookahead"]
        config["preview"]["prefetchLookahead"] = max(0, min(20, la))
    if "smoothing" in preview_in:
        s = str(preview_in["smoothing"] or "sharp").strip().lower()
        config["preview"]["smoothing"] = "smooth" if s == "smooth" else "sharp"
    backup_in = data.get("backup") if isinstance(data.get("backup"), dict) else {}
    if "autoIntervalMinutes" in backup_in:
        try:
            interval = int(backup_in["autoIntervalMinutes"])
        except (TypeError, ValueError):
            interval = config["backup"]["autoIntervalMinutes"]
        config["backup"]["autoIntervalMinutes"] = max(1, min(120, interval))
    if "autoRetentionCount" in backup_in:
        try:
            retention = int(backup_in["autoRetentionCount"])
        except (TypeError, ValueError):
            retention = config["backup"]["autoRetentionCount"]
        config["backup"]["autoRetentionCount"] = max(1, min(1000, retention))
    cache_in = data.get("cache") if isinstance(data.get("cache"), dict) else {}
    if "autoPruneOnStartup" in cache_in:
        config["cache"]["autoPruneOnStartup"] = bool(cache_in["autoPruneOnStartup"])
    # 旧キー autoPruneOlderThanDays (日単位) → autoPruneOlderThanHours (時間単位) に migration。
    # 新キーが書かれていればそれを優先、無ければ旧キーを 24 倍して取り込む。
    if "autoPruneOlderThanHours" in cache_in:
        try:
            hours = int(cache_in["autoPruneOlderThanHours"])
        except (TypeError, ValueError):
            hours = config["cache"]["autoPruneOlderThanHours"]
        config["cache"]["autoPruneOlderThanHours"] = max(1, min(8760, hours))
    elif "autoPruneOlderThanDays" in cache_in:
        try:
            days = int(cache_in["autoPruneOlderThanDays"])
            hours = days * 24
        except (TypeError, ValueError):
            hours = config["cache"]["autoPruneOlderThanHours"]
        config["cache"]["autoPruneOlderThanHours"] = max(1, min(8760, hours))
    return config


def save_global_config(payload: dict[str, Any]) -> dict[str, Any]:
    global _ffmpeg_capability_cache
    config = load_global_config()
    previous_ffmpeg = config.get("ffmpegPath", "")
    if isinstance(payload, dict):
        ve_in = payload.get("videoExport")
        if isinstance(ve_in, dict):
            ve = config.setdefault("videoExport", {})
            if isinstance(ve_in.get("defaultPresetId"), str) and ve_in["defaultPresetId"]:
                ve["defaultPresetId"] = ve_in["defaultPresetId"]
            if isinstance(ve_in.get("customPresets"), list):
                ve["customPresets"] = ve_in["customPresets"]
            if "monoToStereo" in ve_in:
                ve["monoToStereo"] = bool(ve_in["monoToStereo"])
            if "promptBeforeExport" in ve_in:
                ve["promptBeforeExport"] = bool(ve_in["promptBeforeExport"])
            if "bpThresholdMB" in ve_in:
                try:
                    bp = float(ve_in["bpThresholdMB"])
                except (TypeError, ValueError):
                    raise ValueError("bpThresholdMB must be a number")
                ve["bpThresholdMB"] = max(1.0, min(1024.0, bp))
        if "editorHistorySize" in payload:
            config["editorHistorySize"] = _clamp_history_size(
                payload.get("editorHistorySize"), config.get("editorHistorySize", 50)
            )
        if "ffmpegPath" in payload:
            raw_path = payload.get("ffmpegPath")
            if isinstance(raw_path, str):
                normalized = raw_path.strip()
                if normalized:
                    candidate = Path(normalized).expanduser()
                    if not candidate.is_absolute() or not candidate.exists() or not candidate.is_file():
                        raise ValueError(f"ffmpeg のパスが見つかりません: {normalized}")
                    normalized = str(candidate)
                config["ffmpegPath"] = normalized
        if "projectsPath" in payload:
            raw_path = payload.get("projectsPath")
            if isinstance(raw_path, str):
                normalized = raw_path.strip()
                if normalized:
                    candidate = Path(normalized).expanduser()
                    if not candidate.is_absolute():
                        raise ValueError("プロジェクトフォルダは絶対パスで指定してください")
                    try:
                        candidate.mkdir(parents=True, exist_ok=True)
                    except OSError as exc:
                        raise ValueError(f"プロジェクトフォルダを作成できません: {exc}") from exc
                    if not candidate.is_dir():
                        raise ValueError(f"プロジェクトフォルダがディレクトリではありません: {normalized}")
                    normalized = str(candidate)
                config["projectsPath"] = normalized
        logging_in = payload.get("logging") if isinstance(payload.get("logging"), dict) else None
        if logging_in is not None and "quietMode" in logging_in:
            config.setdefault("logging", {})["quietMode"] = bool(logging_in["quietMode"])
        # renderer.version は v2 固定。payload に "v1" が乗ってきても silent migration。
        if isinstance(payload.get("renderer"), dict) and "version" in payload["renderer"]:
            config.setdefault("renderer", {})["version"] = "v2"
        vendor_in = payload.get("vendor") if isinstance(payload.get("vendor"), dict) else None
        if vendor_in is not None and "useCdn" in vendor_in:
            config.setdefault("vendor", {})["useCdn"] = bool(vendor_in["useCdn"])
        if "fontWeightOverrides" in payload:
            overrides_in = payload.get("fontWeightOverrides")
            if not isinstance(overrides_in, dict):
                raise ValueError("fontWeightOverrides は dict (パス → weight_id) で指定してください")
            cleaned: dict[str, str] = {}
            for k, v in overrides_in.items():
                if not isinstance(k, str) or not isinstance(v, str):
                    continue
                k = k.strip()
                v = v.strip()
                if k and v:
                    cleaned[k] = v
            config["fontWeightOverrides"] = cleaned
        tts_in = payload.get("tts") if isinstance(payload.get("tts"), dict) else None
        if tts_in is not None:
            tts_out = config.setdefault("tts", {
                "voicevoxAppPath": "",
                "voicevoxBaseUrl": "",
                "voicepeakBinPath": "",
            })
            for key in ("voicevoxAppPath", "voicevoxBaseUrl", "voicepeakBinPath"):
                if key in tts_in:
                    raw = tts_in.get(key)
                    if isinstance(raw, str):
                        tts_out[key] = raw.strip()
        if "shortcuts" in payload:
            shortcuts_in = payload.get("shortcuts")
            if not isinstance(shortcuts_in, dict):
                raise ValueError("shortcuts は dict (action_id → key_string) で指定してください")
            cleaned: dict[str, str] = {}
            for k, v in shortcuts_in.items():
                if not isinstance(k, str) or not isinstance(v, str):
                    continue
                cleaned[k.strip()] = v.strip()
            config["shortcuts"] = cleaned
        preview_in = payload.get("preview") if isinstance(payload.get("preview"), dict) else None
        if preview_in is not None:
            preview_out = config.setdefault("preview", {"prefetchLookahead": 3, "smoothing": "sharp"})
            if "prefetchLookahead" in preview_in:
                try:
                    la = int(preview_in["prefetchLookahead"])
                except (TypeError, ValueError):
                    raise ValueError("prefetchLookahead must be an integer")
                preview_out["prefetchLookahead"] = max(0, min(20, la))
            if "smoothing" in preview_in:
                s = str(preview_in["smoothing"] or "sharp").strip().lower()
                preview_out["smoothing"] = "smooth" if s == "smooth" else "sharp"
        backup_in = payload.get("backup") if isinstance(payload.get("backup"), dict) else None
        if backup_in is not None:
            backup_out = config.setdefault(
                "backup", {"autoIntervalMinutes": 5, "autoRetentionCount": 50}
            )
            if "autoIntervalMinutes" in backup_in:
                try:
                    interval = int(backup_in["autoIntervalMinutes"])
                except (TypeError, ValueError):
                    raise ValueError("autoIntervalMinutes must be an integer")
                backup_out["autoIntervalMinutes"] = max(1, min(120, interval))
            if "autoRetentionCount" in backup_in:
                try:
                    retention = int(backup_in["autoRetentionCount"])
                except (TypeError, ValueError):
                    raise ValueError("autoRetentionCount must be an integer")
                backup_out["autoRetentionCount"] = max(1, min(1000, retention))
        cache_in = payload.get("cache") if isinstance(payload.get("cache"), dict) else None
        if cache_in is not None:
            cache_out = config.setdefault(
                "cache", {"autoPruneOnStartup": True, "autoPruneOlderThanHours": 6}
            )
            if "autoPruneOnStartup" in cache_in:
                cache_out["autoPruneOnStartup"] = bool(cache_in["autoPruneOnStartup"])
            if "autoPruneOlderThanHours" in cache_in:
                try:
                    hours = int(cache_in["autoPruneOlderThanHours"])
                except (TypeError, ValueError):
                    raise ValueError("autoPruneOlderThanHours must be an integer")
                cache_out["autoPruneOlderThanHours"] = max(1, min(8760, hours))
            elif "autoPruneOlderThanDays" in cache_in:
                # 旧クライアントから日単位で送られてきた場合の互換取り込み
                try:
                    days = int(cache_in["autoPruneOlderThanDays"])
                except (TypeError, ValueError):
                    raise ValueError("autoPruneOlderThanDays must be an integer")
                cache_out["autoPruneOlderThanHours"] = max(1, min(8760, days * 24))
            # 旧フィールドはディスクに残さない (新クライアントに混乱を与えるため)
            cache_out.pop("autoPruneOlderThanDays", None)
    GLOBAL_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    GLOBAL_CONFIG_PATH.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if config.get("ffmpegPath", "") != previous_ffmpeg:
        _ffmpeg_capability_cache = None
    return config


def all_video_presets(config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    config = config or load_global_config()
    customs = config.get("videoExport", {}).get("customPresets", []) or []
    return [*BUILTIN_VIDEO_PRESETS, *[p for p in customs if isinstance(p, dict)]]


def current_projects_dir() -> Path:
    config = load_global_config()
    raw = (config.get("projectsPath") or "").strip()
    if raw:
        candidate = Path(raw).expanduser()
        if candidate.is_absolute():
            return candidate
    return DEFAULT_PROJECTS_DIR


def ffmpeg_executable() -> str:
    raw = (load_global_config().get("ffmpegPath") or "").strip()
    if raw:
        candidate = Path(raw).expanduser()
        if candidate.is_absolute() and candidate.exists():
            return str(candidate)
    return "ffmpeg"


def ffprobe_executable() -> str:
    config = load_global_config()
    explicit = (config.get("ffmpegPath") or "").strip()
    if explicit:
        ffmpeg_path = Path(explicit).expanduser()
        if ffmpeg_path.is_absolute() and ffmpeg_path.exists():
            directory = ffmpeg_path.parent
            for name in ("ffprobe", "ffprobe.exe"):
                candidate = directory / name
                if candidate.exists():
                    return str(candidate)
    return "ffprobe"


_ffmpeg_capability_cache: dict[str, Any] | None = None


def detect_ffmpeg_capabilities(force: bool = False) -> dict[str, Any]:
    """`ffmpeg -encoders` の結果から、利用可能なエンコーダ名の集合を返す。"""
    global _ffmpeg_capability_cache
    if _ffmpeg_capability_cache is not None and not force:
        return _ffmpeg_capability_cache
    encoders: set[str] = set()
    available = False
    error: str | None = None
    try:
        result = subprocess.run(
            [ffmpeg_executable(), "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
        if result.returncode == 0:
            available = True
            in_table = False
            for raw in result.stdout.splitlines():
                line = raw.rstrip()
                if not in_table:
                    if line.strip().startswith("------"):
                        in_table = True
                    continue
                if len(line) < 8 or not line.startswith(" "):
                    continue
                # 例: " V..... libx264   H.264 / AVC / MPEG-4 AVC ..."
                tokens = line.split()
                if len(tokens) >= 2:
                    encoders.add(tokens[1])
        else:
            error = (result.stderr or result.stdout or "").strip()[:200] or "ffmpeg returned non-zero status"
    except FileNotFoundError:
        error = "ffmpeg が見つかりません（PATH を確認してください）"
    except subprocess.TimeoutExpired:
        error = "ffmpeg -encoders の実行がタイムアウトしました"
    except Exception as exc:  # noqa: BLE001
        error = f"ffmpeg の能力検出に失敗しました: {exc}"
    _ffmpeg_capability_cache = {
        "available": available,
        "encoders": encoders,
        "error": error,
    }
    return _ffmpeg_capability_cache


def preset_with_availability(preset: dict[str, Any], capabilities: dict[str, Any] | None = None) -> dict[str, Any]:
    capabilities = capabilities or detect_ffmpeg_capabilities()
    decorated = dict(preset)
    if not capabilities.get("available"):
        decorated["available"] = False
        decorated["unavailableReason"] = capabilities.get("error") or "ffmpeg が利用できません"
        return decorated
    encoders: set[str] = capabilities.get("encoders") or set()
    video_codec = str(preset.get("videoCodec") or "")
    audio_codec = str(preset.get("audioCodec") or "")
    missing: list[str] = []
    if video_codec and video_codec not in encoders:
        missing.append(video_codec)
    if audio_codec and audio_codec not in encoders:
        missing.append(audio_codec)
    if missing:
        decorated["available"] = False
        decorated["unavailableReason"] = f"このffmpegにはエンコーダ {', '.join(missing)} が含まれていません"
    else:
        decorated["available"] = True
        decorated["unavailableReason"] = ""
    # alternateEncoders の各 entry に available フラグを付ける (UI で disable 表示用)。
    alternates = preset.get("alternateEncoders")
    if isinstance(alternates, list):
        decorated_alternates: list[dict[str, Any]] = []
        for alt in alternates:
            if not isinstance(alt, dict):
                continue
            alt_decorated = dict(alt)
            alt_codec = str(alt.get("id") or "")
            alt_decorated["available"] = bool(alt_codec) and alt_codec in encoders
            if not alt_decorated["available"]:
                alt_decorated["unavailableReason"] = (
                    f"このffmpegにはエンコーダ {alt_codec} が含まれていません"
                )
            decorated_alternates.append(alt_decorated)
        decorated["alternateEncoders"] = decorated_alternates
    return decorated


def decorate_video_presets(presets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    capabilities = detect_ffmpeg_capabilities()
    return [preset_with_availability(preset, capabilities) for preset in presets]


def resolve_video_preset(
    preset_id: str | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = config or load_global_config()
    target_id = preset_id or config.get("videoExport", {}).get("defaultPresetId") or "mp4_h264_standard"
    for preset in all_video_presets(config):
        if preset.get("id") == target_id:
            return preset
    return BUILTIN_VIDEO_PRESETS[0]


def initialize_ffmpeg_path_default() -> None:
    config = load_global_config()
    if (config.get("ffmpegPath") or "").strip():
        return
    discovered = shutil.which("ffmpeg")
    if not discovered:
        return
    config["ffmpegPath"] = discovered
    GLOBAL_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    GLOBAL_CONFIG_PATH.write_text(
        json.dumps(config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

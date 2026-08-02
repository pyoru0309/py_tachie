from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .paths import PROJECT_ROOT
from .timecode import frames_to_sec
from .utils import ProjectContext, read_project_file


def yaml_quote(value: str) -> str:
    """YAML スカラーとして安全な形に整形（特殊文字を含む場合だけクォート）"""
    if not value:
        return '""'
    if any(c in value for c in [':', '#', '!', '&', '*', '?', '|', '>', '%', '@', '`', '\n']):
        # シングルクォート内の ' は '' にエスケープ
        return "'" + value.replace("'", "''") + "'"
    return value


def _load_manifest_characters(ctx: ProjectContext) -> list[dict[str, Any]]:
    """ディスクの generated/manifest.json から characters[] を取り出す。

    なお:
    - 永続化された manifest.json には voice や character defs が無い場合がある
      (attach_character_definitions はランタイム動的付与)。
    - そのため呼び出し側 (main.py) は事前に manifest を解決して
      generate_export_text に ``manifest_characters`` 引数で渡すのが望ましい。
    - この関数はフォールバック扱い。
    """
    try:
        if ctx.manifest_path.exists():
            with ctx.manifest_path.open("r", encoding="utf-8") as handle:
                manifest = json.load(handle)
            if isinstance(manifest, dict):
                chars = manifest.get("characters")
                if isinstance(chars, list):
                    return chars
    except (OSError, json.JSONDecodeError):
        pass
    return []


def _resolve_voice_for_speaker(
    cut_state: dict[str, Any],
    speaker_id: str,
    manifest_characters: list[dict[str, Any]],
) -> dict[str, str]:
    """cut の state.characters と manifest.characters から
    speaker (character_XXXX) → 紐付け voice {id, emotion} を引く。

    紐付けなしの場合は {"id": "", "emotion": ""}。
    """
    if not speaker_id or not isinstance(cut_state, dict):
        return {"id": "", "emotion": ""}
    live_chars = cut_state.get("characters")
    if not isinstance(live_chars, list):
        return {"id": "", "emotion": ""}
    live = next((c for c in live_chars if isinstance(c, dict) and c.get("id") == speaker_id), None)
    if not live:
        return {"id": "", "emotion": ""}
    character_def_id = str(live.get("characterId") or "").strip()
    if not character_def_id:
        return {"id": "", "emotion": ""}
    char_def = next(
        (c for c in manifest_characters if isinstance(c, dict) and c.get("id") == character_def_id),
        None,
    )
    voice = (char_def or {}).get("voice") or {}
    return {
        "id": str(voice.get("id") or "").strip(),
        "emotion": str(voice.get("emotion") or "").strip(),
    }




def generate_export_text(
    payload: dict[str, Any] | None,
    ctx: ProjectContext,
    manifest_characters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """セリフとテロップをプロジェクトの export/ 配下に YAML で書き出す。

    ``manifest_characters`` を渡すと、各カットの speaker (cut-instance ID) →
    キャラ定義 → 紐付け voice を引いて voiceapp / voice / emotion 列を埋める。
    None のときはディスクの manifest.json をフォールバック参照する (voice 列が
    空になるケースあり)。
    """
    export_dir = ctx.root / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    scenario = payload.get("scenario") if isinstance(payload, dict) else None
    if not isinstance(scenario, dict):
        # フォールバック: ディスク上のシナリオを読む
        if ctx.scenario_path.exists():
            with ctx.scenario_path.open("r", encoding="utf-8") as handle:
                scenario = json.load(handle)
        else:
            scenario = {}
    cuts = []
    if isinstance(scenario.get("scenes"), list) and scenario["scenes"]:
        scene = scenario["scenes"][0]
        cuts = scene.get("cuts") or []
        telops = scene.get("telops") or []
    else:
        cuts = scenario.get("cuts") or []
        telops = []
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    serif_path = export_dir / f"{timestamp}-serif.yaml"
    telop_path = export_dir / f"{timestamp}-telop.yaml"

    def yaml_block(text: str, indent: int) -> str:
        """YAML literal block scalar (|) で改行を含むテキストを書く。"""
        if not text:
            return '""'
        lines = str(text).split("\n")
        prefix = " " * indent
        body = "\n".join(prefix + line for line in lines)
        return "|\n" + body

    if manifest_characters is None:
        manifest_characters = _load_manifest_characters(ctx)
    serif_lines = [
        "# セリフ書き出し",
        f"# 生成: {datetime.now().isoformat(timespec='seconds')}",
        f"# プロジェクト: {read_project_file(ctx).get('title', ctx.id)}",
        "# フィールド: index / speaker / voice / duration_sec / text",
        "# - speaker は cut 内の登場キャラ ID (character_XXXX)。絵の再現のため変更しない。",
        "# - voice はキャラ→音声アプリの紐付けから自動付与。形式は",
        "#   'voicevox:四国めたん/ノーマル' / 'voicepeak:Miyamai Moca' のように",
        "#   先頭にアプリ名 prefix を含む。Voicepeak は感情を含めて",
        "#   'voicepeak:Miyamai Moca/honwaka' とも書ける。未紐付けは空欄。",
        "# - duration_sec は「お芝居」タブの『表示時間』を秒に直したもの。",
        "# - 一括追加で読み込むときに pause_sec: 0.5 を追記すればそのカットだけ尺を伸ばせる。",
        "",
    ]
    for index, cut in enumerate(cuts, start=1):
        if not isinstance(cut, dict):
            continue
        state = cut.get("state") or {}
        speaker = str(state.get("speakerCharacterId") or "")
        # 表示時間: v4 スキーマでは durationFrame (整数フレーム / PROJECT_FPS=24)。
        # 旧 cut.duration (秒) は既に存在しないが、fallback として残す。
        duration_sec = frames_to_sec(cut.get("durationFrame")) if cut.get("durationFrame") else float(cut.get("duration") or 0)
        text = str(state.get("text") or "")
        voice = _resolve_voice_for_speaker(state, speaker, manifest_characters)
        # voicepeak は感情を voice ID に含めて単一フィールドで表現する
        # (voicevox は元から style を含むので合流の必要なし)。
        voice_id = voice["id"]
        emotion = voice["emotion"]
        if voice_id.startswith("voicepeak:") and emotion:
            voice_id = f"{voice_id}/{emotion}"
        serif_lines.append(f"- index: {index}")
        serif_lines.append(f"  speaker: {yaml_quote(speaker)}")
        serif_lines.append(f"  voice: {yaml_quote(voice_id)}")
        serif_lines.append(f"  duration_sec: {duration_sec:.2f}")
        serif_lines.append(f"  text: {yaml_block(text, 4)}")
    serif_path.write_text("\n".join(serif_lines) + "\n", encoding="utf-8")

    telop_lines = ["# テロップ書き出し", f"# 生成: {datetime.now().isoformat(timespec='seconds')}",
                   f"# プロジェクト: {read_project_file(ctx).get('title', ctx.id)}",
                   "# フィールド: index / start_sec / duration_sec / text", ""]
    for index, telop in enumerate(telops, start=1):
        if not isinstance(telop, dict):
            continue
        start = (
            frames_to_sec(telop.get("startFrame"))
            if telop.get("startFrame") is not None
            else float(telop.get("startSec") or 0)
        )
        duration = (
            frames_to_sec(telop.get("durationFrame"))
            if telop.get("durationFrame") is not None
            else float(telop.get("duration") or 0)
        )
        text = str(telop.get("text") or "")
        telop_lines.append(f"- index: {index}")
        telop_lines.append(f"  start_sec: {start:.2f}")
        telop_lines.append(f"  duration_sec: {duration:.2f}")
        telop_lines.append(f"  text: {yaml_block(text, 4)}")
    telop_path.write_text("\n".join(telop_lines) + "\n", encoding="utf-8")

    return {
        "serif": serif_path.relative_to(PROJECT_ROOT).as_posix(),
        "telop": telop_path.relative_to(PROJECT_ROOT).as_posix(),
        "serifAbsolute": str(serif_path),
        "telopAbsolute": str(telop_path),
        "serifCount": len(cuts),
        "telopCount": len(telops),
        "exportDir": str(export_dir),
    }


# ===========================================================================
# 字幕 (SRT / VTT) 書き出し
#
# テロップ (画面上のキャプション) とセリフ (キャラの発話) を、それぞれ SRT と
# VTT の 2 形式で outputs/ に同時出力する。
#   - テロップ: telop.startFrame / durationFrame から絶対時刻を計算。
#   - セリフ:   cut.startFrame / durationFrame から絶対時刻を計算 (連番なので
#              startFrame が欠けていても累積フレームでフォールバックする)。
#   - 話者名:   cut.state.characters[] のうち speakerCharacterId 一致要素の name。
#              VTT では <v 話者名>、SRT では行頭「話者名：」として付与する。
# VTT はスタイル/配置情報を含めず、本文と最小限のボイスタグのみ (要件どおり)。
# 文字コードは両形式とも UTF-8。
# ===========================================================================


def _format_timestamp(seconds: float, sep: str) -> str:
    """秒を `HH:MM:SS<sep>mmm` に整形する。SRT は sep=',' / VTT は sep='.'。"""
    total_ms = int(round(max(0.0, float(seconds)) * 1000))
    hours = total_ms // 3_600_000
    minutes = (total_ms % 3_600_000) // 60_000
    secs = (total_ms % 60_000) // 1000
    millis = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{millis:03d}"


def _escape_vtt_text(text: str) -> str:
    """VTT キュー本文用に & < > をエスケープ (ボイスタグ markup は別途組み立て)。"""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _resolve_speaker_name(cut_state: dict[str, Any], speaker_id: str) -> str:
    """cut の state.characters から speaker (character_XXXX) の表示名を引く。"""
    if not speaker_id or not isinstance(cut_state, dict):
        return ""
    chars = cut_state.get("characters")
    if not isinstance(chars, list):
        return ""
    live = next((c for c in chars if isinstance(c, dict) and c.get("id") == speaker_id), None)
    if not live:
        return ""
    return str(live.get("name") or "").strip()


def _collect_subtitle_entries(scenario: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    """kind ('telop' | 'serif') に応じて {start, end, text, speaker} の一覧を作る。

    - text が空 (または表示尺 0) の要素は字幕として無意味なので除外する。
    - start 昇順に並べる (SRT/VTT のキュー番号を素直に振るため)。
    """
    if isinstance(scenario.get("scenes"), list) and scenario["scenes"]:
        scene = scenario["scenes"][0]
        cuts = scene.get("cuts") or []
        telops = scene.get("telops") or []
    else:
        cuts = scenario.get("cuts") or []
        telops = []

    entries: list[dict[str, Any]] = []
    if kind == "telop":
        for telop in telops:
            if not isinstance(telop, dict):
                continue
            text = str(telop.get("text") or "").strip()
            if not text:
                continue
            start = (
                frames_to_sec(telop.get("startFrame"))
                if telop.get("startFrame") is not None
                else float(telop.get("startSec") or 0)
            )
            duration = (
                frames_to_sec(telop.get("durationFrame"))
                if telop.get("durationFrame") is not None
                else float(telop.get("duration") or 0)
            )
            end = start + duration
            if end <= start:
                continue
            entries.append({"start": start, "end": end, "text": text, "speaker": ""})
    else:  # serif
        acc_frame = 0
        for cut in cuts:
            if not isinstance(cut, dict):
                continue
            duration_frame = int(cut.get("durationFrame") or 0)
            start_frame = cut.get("startFrame")
            start_frame = int(start_frame) if start_frame is not None else acc_frame
            end_frame = start_frame + duration_frame
            acc_frame = end_frame  # 次カットの startFrame 欠落時のフォールバック
            state = cut.get("state") or {}
            text = str(state.get("text") or "").strip()
            if not text:
                continue
            start = frames_to_sec(start_frame)
            end = frames_to_sec(end_frame)
            if end <= start:
                continue
            speaker = _resolve_speaker_name(state, str(state.get("speakerCharacterId") or ""))
            entries.append({"start": start, "end": end, "text": text, "speaker": speaker})

    entries.sort(key=lambda e: e["start"])
    return entries


def _render_srt(entries: list[dict[str, Any]]) -> str:
    blocks: list[str] = []
    for index, entry in enumerate(entries, start=1):
        start = _format_timestamp(entry["start"], ",")
        end = _format_timestamp(entry["end"], ",")
        text = entry["text"]
        speaker = entry.get("speaker") or ""
        body = f"{speaker}：{text}" if speaker else text
        blocks.append(f"{index}\n{start} --> {end}\n{body}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def _render_vtt(entries: list[dict[str, Any]]) -> str:
    blocks: list[str] = ["WEBVTT"]
    for entry in entries:
        start = _format_timestamp(entry["start"], ".")
        end = _format_timestamp(entry["end"], ".")
        text = _escape_vtt_text(entry["text"])
        speaker = entry.get("speaker") or ""
        if speaker:
            # ボイスタグ内は '>' だけ避ければよい (markup と衝突するため)
            body = f"<v {speaker.replace('>', '')}>{text}"
        else:
            body = text
        blocks.append(f"{start} --> {end}\n{body}")
    return "\n\n".join(blocks) + "\n"


def generate_subtitles(
    payload: dict[str, Any] | None,
    ctx: ProjectContext,
    kind: str,
) -> dict[str, Any]:
    """テロップ / セリフを SRT と VTT で outputs/ に同時書き出しする。

    ``kind`` は 'telop' か 'serif'。返り値の path は render-png と同じ
    ``/project-outputs/{id}/{name}`` 形式。
    """
    if kind not in ("telop", "serif"):
        raise ValueError(f"unknown subtitle kind: {kind!r}")

    scenario = payload.get("scenario") if isinstance(payload, dict) else None
    if not isinstance(scenario, dict):
        if ctx.scenario_path.exists():
            with ctx.scenario_path.open("r", encoding="utf-8") as handle:
                scenario = json.load(handle)
        else:
            scenario = {}

    entries = _collect_subtitle_entries(scenario, kind)
    if not entries:
        # 空ファイルで outputs を汚さない。呼び出し側は count==0 で警告表示する。
        return {
            "kind": kind,
            "srt": None,
            "vtt": None,
            "srtName": None,
            "vttName": None,
            "count": 0,
            "outputDir": str(ctx.output_dir),
        }

    srt_text = _render_srt(entries)
    vtt_text = _render_vtt(entries)

    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    srt_name = f"{kind}_{timestamp}.srt"
    vtt_name = f"{kind}_{timestamp}.vtt"
    (ctx.output_dir / srt_name).write_text(srt_text, encoding="utf-8")
    (ctx.output_dir / vtt_name).write_text(vtt_text, encoding="utf-8")

    return {
        "kind": kind,
        "srt": f"/project-outputs/{ctx.id}/{srt_name}",
        "vtt": f"/project-outputs/{ctx.id}/{vtt_name}",
        "srtName": srt_name,
        "vttName": vtt_name,
        "count": len(entries),
        "outputDir": str(ctx.output_dir),
    }

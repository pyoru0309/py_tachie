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

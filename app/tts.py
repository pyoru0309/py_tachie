"""音声合成 (VOICEVOX / Voicepeak) 連携モジュール。

外部の音声合成アプリは標準ライブラリ + subprocess + urllib のみで叩く。
TTS の状態を呼び出し側へ返す共通 API として:

- ``detect_state()`` … パス検証 + 起動チェックの結果を返す
- ``refresh_catalog(state)`` … VOICEVOX /speakers / Voicepeak --list-narrator 等を取得
- ``synthesize(...)`` … 単発合成 (wav バイナリと所要時間メタを返す)

voice ID 規約は ``"voicevox:{styleId}"`` / ``"voicepeak:{narratorName}"``。
これにより キャラ → voice の紐付けと一括登録 YAML の voice/voiceapp 指定が
ID ひとつで完結する。

カタログは ``app_state/voice_catalog.json`` に永続化する。話者一覧は
ユーザー環境ごとに大きく異なるので、明示的に「ボイスを登録」を押した時だけ
更新する設計 (起動時の自動 refresh は重い & VOICEVOX 起動依存になるため避ける)。
"""

from __future__ import annotations

import json
import platform
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .paths import ASSETS_DIR, DEFAULT_PROJECTS_DIR, STATE_DIR


VOICE_CATALOG_PATH = STATE_DIR / "voice_catalog.json"

# OS 別のデフォルトインストール先。settings 上で空欄なら順に試す。
_VOICEVOX_DEFAULT_APP_PATHS = [
    Path("/Applications/VOICEVOX.app"),
    Path("C:/Program Files/VOICEVOX/VOICEVOX.exe"),
    Path.home() / "AppData" / "Local" / "Programs" / "VOICEVOX" / "VOICEVOX.exe",
]

_VOICEPEAK_DEFAULT_BIN_PATHS = [
    Path("/Applications/voicepeak.app/Contents/MacOS/voicepeak"),
    Path("C:/Program Files/VOICEPEAK/voicepeak.exe"),
]

DEFAULT_VOICEVOX_BASE_URL = "http://127.0.0.1:50021"


# ---------------------------------------------------------------------------
# パス検出
# ---------------------------------------------------------------------------

def _expand_path(raw: str | None) -> Path | None:
    if not raw:
        return None
    text = str(raw).strip()
    if not text:
        return None
    return Path(text).expanduser()


def detect_voicevox_app_path(explicit: str | None = None) -> Path | None:
    """VOICEVOX アプリ本体のパスを探す。明示指定 → デフォルト候補の順。"""
    candidate = _expand_path(explicit)
    if candidate and candidate.exists():
        return candidate
    for path in _VOICEVOX_DEFAULT_APP_PATHS:
        if path.exists():
            return path
    return None


def detect_voicepeak_bin_path(explicit: str | None = None) -> Path | None:
    candidate = _expand_path(explicit)
    if candidate and candidate.exists() and candidate.is_file():
        return candidate
    for path in _VOICEPEAK_DEFAULT_BIN_PATHS:
        if path.exists() and path.is_file():
            return path
    return None


def resolve_voicevox_base_url(explicit: str | None = None) -> str:
    text = (explicit or "").strip()
    if text:
        return text.rstrip("/")
    return DEFAULT_VOICEVOX_BASE_URL


# ---------------------------------------------------------------------------
# VOICEVOX HTTP
# ---------------------------------------------------------------------------

def _http_get_json(base_url: str, path: str, timeout: float = 10.0) -> Any:
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def _http_post(
    base_url: str,
    path: str,
    params: dict[str, Any],
    body: Any | None = None,
    accept: str = "application/json",
    timeout: float = 60.0,
) -> bytes:
    url = base_url.rstrip("/") + path + "?" + urllib.parse.urlencode(params)
    headers = {"Accept": accept}
    if body is None:
        data = b""
    else:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def fetch_voicevox_speakers(base_url: str) -> list[dict[str, Any]]:
    """``GET /speakers`` の結果を共通 voice カタログ形式に整形して返す。

    voice ID は ``voicevox:{話者名}/{スタイル名}`` 形式 (例:
    ``voicevox:四国めたん/ノーマル``)。VOICEVOX の数値 ``style.id`` は
    話者追加で順序が変わりうるため、人にも読めて再登録に強い「名前ペア」
    を 1 次キーにする。 同時に ``styleId`` と ``speakerUuid`` も保持し、
    合成時の解決と将来のフォールバックに使う。
    """
    raw = _http_get_json(base_url, "/speakers")
    voices: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return voices
    for speaker in raw:
        if not isinstance(speaker, dict):
            continue
        name = str(speaker.get("name") or "").strip()
        speaker_uuid = str(speaker.get("speaker_uuid") or "").strip()
        styles = speaker.get("styles") or []
        if not isinstance(styles, list):
            continue
        for style in styles:
            if not isinstance(style, dict):
                continue
            style_id = style.get("id")
            style_name = str(style.get("name") or "").strip()
            if style_id is None:
                continue
            voice_id = (
                f"voicevox:{name}/{style_name}" if style_name else f"voicevox:{name}"
            )
            label = f"{name}（{style_name}）" if style_name else name
            voices.append(
                {
                    "id": voice_id,
                    "app": "voicevox",
                    "narrator": name,
                    "speakerUuid": speaker_uuid,
                    "styleId": int(style_id),
                    "styleName": style_name,
                    "label": f"{label} (VOICEVOX)",
                    # VOICEVOX には emotion 概念は無し (style がそれに相当)。空配列。
                    "emotions": [],
                }
            )
    return voices


def synthesize_voicevox(
    *,
    base_url: str,
    style_id: int,
    text: str,
    speed_scale: float | None = None,
    pitch_scale: float | None = None,
    intonation_scale: float | None = None,
    volume_scale: float | None = None,
) -> bytes:
    """VOICEVOX で wav バイナリを生成して返す。"""
    query_bytes = _http_post(
        base_url,
        "/audio_query",
        {"text": text, "speaker": int(style_id)},
    )
    query = json.loads(query_bytes.decode("utf-8"))
    if speed_scale is not None:
        query["speedScale"] = float(speed_scale)
    if pitch_scale is not None:
        query["pitchScale"] = float(pitch_scale)
    if intonation_scale is not None:
        query["intonationScale"] = float(intonation_scale)
    if volume_scale is not None:
        query["volumeScale"] = float(volume_scale)
    return _http_post(
        base_url,
        "/synthesis",
        {"speaker": int(style_id), "enable_interrogative_upspeak": "true"},
        body=query,
        accept="audio/wav",
    )


def voicevox_alive(base_url: str, timeout: float = 1.5) -> bool:
    """VOICEVOX Engine が起動しているか軽く ping する。"""
    try:
        _http_get_json(base_url, "/version", timeout=timeout)
        return True
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        return False


def launch_voicevox_app(app_path: Path) -> None:
    """OS 別に VOICEVOX アプリを起動する。

    - macOS: ``.app`` バンドルなので ``open <app>`` を呼ぶ (非同期起動)
    - Windows: ``.exe`` を直接 Popen。親プロセスから切り離して uvicorn の停止に
      巻き込まれないようにする (DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP)
    - その他 (Linux 等): 直接 Popen で実行ファイルを起動
    """
    if not app_path or not Path(app_path).exists():
        raise FileNotFoundError(f"VOICEVOX のパスが存在しません: {app_path}")
    system = platform.system()
    if system == "Darwin":
        subprocess.Popen(
            ["open", str(app_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        return
    if system == "Windows":
        # CPython 3.7+ で定義されている定数。古い環境向けにリテラルでフォールバック。
        DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        CREATE_NEW_PROCESS_GROUP = getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
        )
        subprocess.Popen(
            [str(app_path)],
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        return
    subprocess.Popen(
        [str(app_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )


def wait_for_voicevox_engine(base_url: str, timeout_sec: float = 20.0, interval_sec: float = 0.5) -> bool:
    """VOICEVOX Engine の /version が応答するまでポーリング待機。"""
    deadline = time.monotonic() + max(0.0, timeout_sec)
    while time.monotonic() < deadline:
        if voicevox_alive(base_url, timeout=1.0):
            return True
        time.sleep(interval_sec)
    return False


# ---------------------------------------------------------------------------
# Voicepeak CLI
# ---------------------------------------------------------------------------

def _run_voicepeak(
    bin_path: Path,
    args: list[str],
    timeout: float = 30.0,
) -> tuple[int, str, str]:
    """voicepeak CLI を呼び出して (returncode, stdout, stderr) を返す。"""
    result = subprocess.run(
        [str(bin_path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    return result.returncode, result.stdout or "", result.stderr or ""


def _voicepeak_clean_lines(stdout: str, stderr: str) -> list[str]:
    """voicepeak の `iconv_open is not supported` などのノイズを除いた行を返す。"""
    lines: list[str] = []
    for raw in (stdout + "\n" + stderr).splitlines():
        line = raw.strip()
        if not line:
            continue
        if "iconv_open is not supported" in line:
            continue
        if line.startswith("[debug]"):
            continue
        lines.append(line)
    return lines


def fetch_voicepeak_narrators(bin_path: Path) -> list[str]:
    code, stdout, stderr = _run_voicepeak(bin_path, ["--list-narrator"], timeout=15.0)
    if code != 0:
        # 出力に narrator が含まれていれば 0 でなくても拾う運用にしたいが、
        # 通常 voicepeak は narrator 一覧時 0 で返す。失敗時は raise。
        raise RuntimeError(
            f"voicepeak --list-narrator failed (code={code}): "
            + (stderr.strip() or stdout.strip())
        )
    return _voicepeak_clean_lines(stdout, stderr)


def fetch_voicepeak_emotions(bin_path: Path, narrator: str) -> list[str]:
    code, stdout, stderr = _run_voicepeak(
        bin_path,
        ["--list-emotion", narrator],
        timeout=15.0,
    )
    if code != 0:
        # 一部の話者は emotion 0 件で空のまま 0 を返すこともあるので、
        # 出力空 + returncode 非ゼロの場合だけ raise。
        if not (stdout.strip() or stderr.strip()):
            raise RuntimeError(f"voicepeak --list-emotion {narrator!r} failed (code={code})")
    return _voicepeak_clean_lines(stdout, stderr)


def fetch_voicepeak_voices(bin_path: Path) -> list[dict[str, Any]]:
    """narrators × emotions を 1 通り合成して voice カタログ形式へ。"""
    voices: list[dict[str, Any]] = []
    narrators = fetch_voicepeak_narrators(bin_path)
    for narrator in narrators:
        try:
            emotions = fetch_voicepeak_emotions(bin_path, narrator)
        except Exception:
            emotions = []
        voices.append(
            {
                "id": f"voicepeak:{narrator}",
                "app": "voicepeak",
                "narrator": narrator,
                "styleId": None,
                "styleName": "",
                "label": f"{narrator} (Voicepeak)",
                "emotions": emotions,
            }
        )
    return voices


def synthesize_voicepeak(
    *,
    bin_path: Path,
    narrator: str,
    text: str,
    output_path: Path,
    emotion: str | None = None,
    emotion_strength: int = 100,
    speed: int | None = None,
    pitch: int | None = None,
    timeout: float = 120.0,
) -> None:
    """voicepeak で wav を ``output_path`` に書き込む。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "-n",
        narrator,
        "-s",
        text,
        "-o",
        str(output_path),
    ]
    if emotion:
        args.extend(["-e", f"{emotion}={int(emotion_strength)}"])
    if speed is not None:
        args.extend(["--speed", str(int(speed))])
    if pitch is not None:
        args.extend(["--pitch", str(int(pitch))])
    code, stdout, stderr = _run_voicepeak(bin_path, args, timeout=timeout)
    if code != 0 or not output_path.exists() or output_path.stat().st_size == 0:
        if output_path.exists():
            try:
                output_path.unlink()
            except OSError:
                pass
        details = (stderr or stdout or "").strip()
        raise RuntimeError(f"voicepeak 合成に失敗しました (code={code}): {details[:400]}")


# ---------------------------------------------------------------------------
# 共通カタログ
# ---------------------------------------------------------------------------

@dataclass
class TtsState:
    """検出結果＋カタログをまとめて UI / API へ返す型。"""

    voicevox_app_path: str = ""           # 検出された VOICEVOX.app のパス (UI 表示用)
    voicevox_base_url: str = DEFAULT_VOICEVOX_BASE_URL
    voicevox_engine_alive: bool = False
    voicevox_voices: list[dict[str, Any]] | None = None

    voicepeak_bin_path: str = ""
    voicepeak_voices: list[dict[str, Any]] | None = None

    catalog_updated_at: str = ""
    catalog_errors: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        voicevox_voices = self.voicevox_voices or []
        voicepeak_voices = self.voicepeak_voices or []
        return {
            "voicevox": {
                "appPath": self.voicevox_app_path,
                "baseUrl": self.voicevox_base_url,
                "engineAlive": self.voicevox_engine_alive,
                "available": bool(self.voicevox_app_path) and bool(voicevox_voices),
                "voices": voicevox_voices,
            },
            "voicepeak": {
                "binPath": self.voicepeak_bin_path,
                "available": bool(self.voicepeak_bin_path) and bool(voicepeak_voices),
                "voices": voicepeak_voices,
            },
            "voices": [*voicevox_voices, *voicepeak_voices],
            "available": bool(voicevox_voices) or bool(voicepeak_voices),
            "catalogUpdatedAt": self.catalog_updated_at,
            "errors": self.catalog_errors or [],
        }


def load_voice_catalog() -> dict[str, Any]:
    if not VOICE_CATALOG_PATH.exists():
        return {"voicevox": [], "voicepeak": [], "updatedAt": ""}
    try:
        return json.loads(VOICE_CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"voicevox": [], "voicepeak": [], "updatedAt": ""}


def save_voice_catalog(data: dict[str, Any]) -> None:
    VOICE_CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    VOICE_CATALOG_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def detect_state(
    *,
    voicevox_app_path: str | None = None,
    voicevox_base_url: str | None = None,
    voicepeak_bin_path: str | None = None,
) -> TtsState:
    """設定を渡してパスの検出 + (任意で) カタログ JSON を読み込む。

    エンジン /speakers の取得はここではしない。``refresh_catalog`` 側で行う。
    """
    state = TtsState()
    vv_app = detect_voicevox_app_path(voicevox_app_path)
    state.voicevox_app_path = str(vv_app) if vv_app else ""
    state.voicevox_base_url = resolve_voicevox_base_url(voicevox_base_url)
    state.voicevox_engine_alive = voicevox_alive(state.voicevox_base_url)
    vp_bin = detect_voicepeak_bin_path(voicepeak_bin_path)
    state.voicepeak_bin_path = str(vp_bin) if vp_bin else ""

    catalog = load_voice_catalog()
    state.voicevox_voices = catalog.get("voicevox") or []
    state.voicepeak_voices = catalog.get("voicepeak") or []
    state.catalog_updated_at = catalog.get("updatedAt") or ""
    return state


def refresh_catalog(
    *,
    voicevox_app_path: str | None = None,
    voicevox_base_url: str | None = None,
    voicepeak_bin_path: str | None = None,
    auto_launch_voicevox: bool = True,
    launch_timeout_sec: float = 20.0,
) -> TtsState:
    from datetime import datetime

    state = detect_state(
        voicevox_app_path=voicevox_app_path,
        voicevox_base_url=voicevox_base_url,
        voicepeak_bin_path=voicepeak_bin_path,
    )
    errors: list[str] = []
    # VOICEVOX が「アプリは検出できているが Engine が応答しない」時は起動を試みる。
    # ユーザーが「ボイスを登録」を押した時の素直な期待 (= 起動して話者一覧を出す)
    # に合わせるため、refresh では既定で auto_launch ON。
    if (
        auto_launch_voicevox
        and state.voicevox_app_path
        and not state.voicevox_engine_alive
    ):
        try:
            launch_voicevox_app(Path(state.voicevox_app_path))
            launched = wait_for_voicevox_engine(
                state.voicevox_base_url, timeout_sec=launch_timeout_sec
            )
            state.voicevox_engine_alive = launched
            if not launched:
                errors.append(
                    "VOICEVOX を起動しましたが Engine が応答しませんでした"
                    f"（{int(launch_timeout_sec)}秒タイムアウト）。VOICEVOX 側の起動完了を待ってからもう一度お試しください。"
                )
        except FileNotFoundError as exc:
            errors.append(str(exc))
        except OSError as exc:
            errors.append(f"VOICEVOX の起動に失敗しました: {exc}")

    if state.voicevox_app_path and state.voicevox_engine_alive:
        try:
            state.voicevox_voices = fetch_voicevox_speakers(state.voicevox_base_url)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            errors.append(
                f"VOICEVOX Engine に接続できませんでした ({state.voicevox_base_url}): {exc}"
            )
            state.voicevox_voices = []
    else:
        state.voicevox_voices = []

    if state.voicepeak_bin_path:
        try:
            state.voicepeak_voices = fetch_voicepeak_voices(Path(state.voicepeak_bin_path))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"voicepeak の話者一覧取得に失敗しました: {exc}")
            state.voicepeak_voices = []
    else:
        state.voicepeak_voices = []

    state.catalog_errors = errors
    state.catalog_updated_at = datetime.now().isoformat(timespec="seconds")
    save_voice_catalog(
        {
            "voicevox": state.voicevox_voices,
            "voicepeak": state.voicepeak_voices,
            "updatedAt": state.catalog_updated_at,
            "errors": errors,
        }
    )
    # 既存の永続データに残っている旧形式 voice ID (voicevox:{number}) を、
    # 新カタログから引き直して新形式 (voicevox:{narrator}/{styleName}) に置換。
    # 1 回だけ書き換えれば次回以降は no-op。
    try:
        migrated = migrate_character_manifest_voice_ids(state.voicevox_voices or [])
        if migrated:
            errors.append(f"既存 {migrated} 件のキャラ voice ID を新形式へ更新しました")
            state.catalog_errors = errors
    except Exception as exc:  # noqa: BLE001
        errors.append(f"キャラ voice ID の自動更新に失敗しました: {exc}")
        state.catalog_errors = errors
    return state


# ---------------------------------------------------------------------------
# 共通の合成 entry
# ---------------------------------------------------------------------------

def parse_voice_id(voice_id: str) -> tuple[str, str]:
    """``voicevox:3`` / ``voicepeak:Miyamai Moca`` を (app, sub_id) に分割。"""
    if not isinstance(voice_id, str) or ":" not in voice_id:
        raise ValueError(f"voice_id 形式が不正です: {voice_id!r}")
    app, _, sub = voice_id.partition(":")
    app = app.strip().lower()
    sub = sub.strip()
    if app not in {"voicevox", "voicepeak"}:
        raise ValueError(f"未知の音声アプリです: {app!r}")
    if not sub:
        raise ValueError("voice_id の話者部分が空です")
    return app, sub


@dataclass
class SynthesisResult:
    audio_path: Path
    app: str
    voice_id: str
    narrator: str
    emotion: str
    text: str
    duration_seconds: float | None


def synthesize(
    *,
    voice_id: str,
    text: str,
    output_path: Path,
    emotion: str | None = None,
    voicevox_base_url_value: str | None = None,
    voicepeak_bin: Path | None = None,
    voice_catalog: list[dict[str, Any]] | None = None,
) -> SynthesisResult:
    """voice_id を解決して wav を ``output_path`` に書き出す。

    呼び出し側は事前に detect_state でパスを解決し、必要なバイナリ / URL を渡す。
    emotion が voice の対応リストに無い場合は ``None`` で再フォールバックする
    (=ノーマル合成)。
    """
    app, sub = parse_voice_id(voice_id)
    text = (text or "").strip()
    if not text:
        raise ValueError("合成するテキストが空です")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    catalog_entry: dict[str, Any] | None = None
    if voice_catalog:
        catalog_entry = next((v for v in voice_catalog if v.get("id") == voice_id), None)

    if app == "voicevox":
        # voicevox の voice_id 形式は ``voicevox:{narrator}/{styleName}``。
        # catalog から完全一致で styleId を引いて /synthesis に渡す。
        if not catalog_entry or catalog_entry.get("styleId") is None:
            raise ValueError(
                f"voicevox の voice_id を解決できませんでした ({voice_id!r})。"
                "VOICEVOX を起動して、全体設定 → 音声読み上げ → 「ボイスを登録」を押してカタログを更新してください。"
            )
        style_id = int(catalog_entry["styleId"])
        narrator_label = str(catalog_entry.get("narrator") or "")
        base_url = resolve_voicevox_base_url(voicevox_base_url_value)
        wav = synthesize_voicevox(base_url=base_url, style_id=style_id, text=text)
        output_path.write_bytes(wav)
        return SynthesisResult(
            audio_path=output_path,
            app=app,
            voice_id=voice_id,
            narrator=narrator_label,
            emotion="",  # VOICEVOX には emotion 概念なし
            text=text,
            duration_seconds=None,
        )

    if app == "voicepeak":
        if voicepeak_bin is None or not Path(voicepeak_bin).exists():
            raise RuntimeError("voicepeak の実行ファイルが見つかりません")
        # emotion 妥当性チェック (なければノーマルにフォールバック)
        applied_emotion: str | None = (emotion or "").strip() or None
        if applied_emotion and catalog_entry and catalog_entry.get("emotions"):
            valid = set(catalog_entry.get("emotions") or [])
            if applied_emotion not in valid:
                applied_emotion = None
        synthesize_voicepeak(
            bin_path=Path(voicepeak_bin),
            narrator=sub,
            text=text,
            output_path=output_path,
            emotion=applied_emotion,
        )
        return SynthesisResult(
            audio_path=output_path,
            app=app,
            voice_id=voice_id,
            narrator=sub,
            emotion=applied_emotion or "",
            text=text,
            duration_seconds=None,
        )

    raise ValueError(f"未対応の音声アプリです: {app}")


# ---------------------------------------------------------------------------
# 雑用
# ---------------------------------------------------------------------------

def voicepeak_default_bin_or_none() -> Path | None:
    """設定が空の状態でデフォルトを試したいとき用のショートカット。"""
    return detect_voicepeak_bin_path(None)


def voicevox_default_app_or_none() -> Path | None:
    return detect_voicevox_app_path(None)


# 自動検出パスがあれば config 未設定でもそれを使ってよい、という UI ヒントに使う。
def discover_defaults() -> dict[str, str]:
    vv = voicevox_default_app_or_none()
    vp = voicepeak_default_bin_or_none()
    return {
        "voicevoxAppPath": str(vv) if vv else "",
        "voicepeakBinPath": str(vp) if vp else "",
    }


# ---------------------------------------------------------------------------
# 永続データの voice ID マイグレーション (一度きりのデータクレンジング)
# 旧 voicevox:{styleId} 形式 → 新 voicevox:{narrator}/{styleName} 形式。
# refresh_catalog 後 / 起動時の検出後にお声掛けする想定。
# 互換コードは別途撤去済み (受信側は新形式のみを扱う)。
# ---------------------------------------------------------------------------

def _voicevox_legacy_to_new(voice_id: str, voicevox_voices: list[dict[str, Any]]) -> str:
    if not isinstance(voice_id, str) or not voice_id.startswith("voicevox:"):
        return voice_id
    sub = voice_id.split(":", 1)[1]
    if "/" in sub:
        return voice_id  # 既に新形式
    stripped = sub.strip().lstrip("-")
    if not stripped.isdigit():
        return voice_id
    sid = int(stripped)
    matched = next(
        (v for v in voicevox_voices if v.get("app") == "voicevox" and v.get("styleId") == sid),
        None,
    )
    if not matched or not matched.get("id"):
        return voice_id
    return str(matched["id"])


def _iter_character_manifest_paths() -> list[Path]:
    """共通キャラ + 全プロジェクト配下の character_manifest.json を列挙する。"""
    candidates: list[Path] = []
    common_root = ASSETS_DIR / "characters"
    if common_root.exists():
        for child in common_root.iterdir():
            if child.is_dir():
                p = child / "character_manifest.json"
                if p.exists():
                    candidates.append(p)
    if DEFAULT_PROJECTS_DIR.exists():
        for project_dir in DEFAULT_PROJECTS_DIR.iterdir():
            chars_root = project_dir / "assets" / "characters"
            if not chars_root.exists():
                continue
            for child in chars_root.iterdir():
                if child.is_dir():
                    p = child / "character_manifest.json"
                    if p.exists():
                        candidates.append(p)
    return candidates


def migrate_character_manifest_voice_ids(voicevox_voices: list[dict[str, Any]]) -> int:
    """共通 / プロジェクトキャラの ``character_manifest.json`` を走査し、
    ``voice.id`` が旧 ``voicevox:{number}`` 形式なら新形式に置換する。

    返り値: 書き換えたファイル数。
    """
    if not voicevox_voices:
        return 0
    changed = 0
    for path in _iter_character_manifest_paths():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        voice = data.get("voice")
        if not isinstance(voice, dict):
            continue
        old_id = voice.get("id")
        new_id = _voicevox_legacy_to_new(old_id or "", voicevox_voices)
        if new_id != old_id:
            voice["id"] = new_id
            data["voice"] = voice
            try:
                path.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                changed += 1
            except OSError:
                continue
    return changed


# linting / 補助 (mypy 用) — 不要だがエクスポート確認に
__all__ = [
    "DEFAULT_VOICEVOX_BASE_URL",
    "TtsState",
    "SynthesisResult",
    "detect_state",
    "refresh_catalog",
    "synthesize",
    "parse_voice_id",
    "load_voice_catalog",
    "save_voice_catalog",
    "discover_defaults",
    "voicevox_alive",
]

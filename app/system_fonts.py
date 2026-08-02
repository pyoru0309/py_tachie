"""PC インストール済みフォント (システムフォント) の列挙・カタログ化。

アセット内 (``assets/fonts/`` / ``projects/<id>/assets/fonts/``) のフォントとは
独立に、PC にインストールされているフォントをフォント一覧へ載せるための機構。

設計 (hanko プロジェクトの知見を移植):

- **列挙**: OS 標準フォントディレクトリの再帰走査に加えて、
  - macOS: CoreText (pyobjc, optional) で「登録済みフォントの実ファイル URL」を
    取得する。Adobe Fonts (CoreSync) のような *仮想インストール* フォントは
    標準ディレクトリに実体が無いため、これが唯一の正攻法。pyobjc 未導入時は
    CoreSync の livetype ディレクトリ直接走査でフォールバックする。
  - Windows: レジストリ (HKLM/HKCU の Fonts) + Adobe CoreSync ディレクトリ
    (拡張子なしファイルはマジックバイトで判定) を追加走査する。
- **メタデータ**: fontTools lazy load で name テーブル (和名/英名) と
  OS/2.usWeightClass を読み、family → weight_id → face の形にグループ化する。
  TTC (ヒラギノ等) は face 単位に展開する。
- **レンダリング**: ブラウザには family 名 (``cssFamilies``) だけ渡す。
  OS にインストール済みのフォントはブラウザがローカル名で解決できるため
  FontFace 登録もファイル配信も不要 (TTC もそのまま使える)。サーバ側 Pillow
  (`compositor.get_font`) は本モジュールの ``resolve_face`` で得た
  絶対パス + TTC index を直接開く。
- **キャッシュ**: ``app_state/system_fonts_cache.json``。全ファイルの
  (path, mtime_ns, size) manifest が一致すればパース済みカタログを再利用し、
  1 ファイルでも追加/削除/更新があれば全再スキャンする。

永続 ID は ``sys_<family名のASCIIスラグ>`` (非 ASCII のみなら SHA1)。シナリオの
``fontFamily`` にはこの ID が保存されるため、生成ロジックは原則変更しないこと。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .font_inspect import _NAME_LOOKUP_JA, _name_record, weight_id_from_class
from .log_setup import app_logger
from .paths import STATE_DIR

_log = app_logger("system_fonts")

CACHE_VERSION = 1
CACHE_PATH = STATE_DIR / "system_fonts_cache.json"

FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".otc"}
# sfnt 系フォントの先頭 4 バイト。拡張子なしファイル (Adobe CoreSync) の判定に使う。
_FONT_MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"ttcf", b"true")


# ---------------------------------------------------------------------------
# 候補ファイルの列挙
# ---------------------------------------------------------------------------


def _font_directories() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        return [
            Path("/System/Library/Fonts"),
            Path("/Library/Fonts"),
            home / "Library" / "Fonts",
            # Adobe Fonts (CoreSync) の実体。通常は CoreText 列挙で拾えるが、
            # pyobjc 未導入環境向けのフォールバックとして直接走査もする。
            home
            / "Library"
            / "Application Support"
            / "Adobe"
            / "CoreSync"
            / "plugins"
            / "livetype"
            / ".r",
        ]
    if os.name == "nt":
        windir = Path(os.environ.get("WINDIR", r"C:\Windows"))
        return [
            windir / "Fonts",
            home / "AppData" / "Local" / "Microsoft" / "Windows" / "Fonts",
            # Adobe Fonts (CoreSync)。Windows は CoreText 相当の API を使わない
            # ので、ディレクトリ直接走査が主経路 (ファイルは拡張子なしのことがある)。
            home / "AppData" / "Roaming" / "Adobe" / "CoreSync" / "plugins" / "livetype" / "r",
        ]
    return [
        Path("/usr/share/fonts"),
        Path("/usr/local/share/fonts"),
        home / ".fonts",
        home / ".local" / "share" / "fonts",
    ]


def _sniff_font_magic(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(4) in _FONT_MAGIC
    except OSError:
        return False


def _is_font_file(path: Path) -> bool:
    suffix = path.suffix.lower()
    if suffix in FONT_EXTENSIONS:
        return True
    if suffix == "":
        # Adobe CoreSync 等の拡張子なしファイルはマジックバイトで判定する。
        return _sniff_font_magic(path)
    return False


def _coretext_font_files() -> list[Path]:
    """macOS: CoreText の登録情報から実体フォントファイルを得る。

    Adobe Fonts のような仮想インストール (標準フォントディレクトリ外に実体を
    置いて CoreText へ登録するタイプ) はここでしか検出できない。
    """
    if sys.platform != "darwin":
        return []
    try:
        from CoreText import (  # type: ignore[import-not-found]
            CTFontCollectionCreateFromAvailableFonts,
            CTFontCollectionCreateMatchingFontDescriptors,
            CTFontDescriptorCopyAttribute,
            kCTFontURLAttribute,
        )
    except Exception:  # noqa: BLE001 - pyobjc 未導入は正常系 (ディレクトリ走査のみ)
        return []

    paths: list[Path] = []
    try:
        collection = CTFontCollectionCreateFromAvailableFonts(None)
        descriptors = CTFontCollectionCreateMatchingFontDescriptors(collection) or ()
        for descriptor in descriptors:
            url = CTFontDescriptorCopyAttribute(descriptor, kCTFontURLAttribute)
            if url is None:
                continue
            raw = url.path()
            if not raw:
                continue
            path = Path(raw)
            try:
                if path.is_file() and _is_font_file(path):
                    paths.append(path)
            except OSError:
                continue
    except Exception as exc:  # noqa: BLE001
        _log.warning("CoreText enumeration failed: %s", exc)
    return paths


def _windows_registry_font_files() -> list[Path]:
    """Windows: レジストリの Fonts キーからインストール済みフォントを得る。

    HKLM 側は ``%WINDIR%\\Fonts`` 相対のファイル名、HKCU 側 (per-user install)
    は絶対パスが入る。ディレクトリ走査で拾えない場所のフォントを補完する。
    """
    if os.name != "nt":
        return []
    import winreg  # noqa: PLC0415 - Windows 専用 stdlib

    results: list[Path] = []
    windir_fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    keys = (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows NT\CurrentVersion\Fonts"),
    )
    for hive, key_path in keys:
        try:
            with winreg.OpenKey(hive, key_path) as handle:
                index = 0
                while True:
                    try:
                        _name, value, _type = winreg.EnumValue(handle, index)
                    except OSError:
                        break
                    index += 1
                    if not isinstance(value, str) or not value:
                        continue
                    path = Path(value)
                    if not path.is_absolute():
                        path = windir_fonts / value
                    try:
                        if path.is_file() and _is_font_file(path):
                            results.append(path)
                    except OSError:
                        continue
        except OSError:
            continue
    return results


def _candidate_files() -> list[Path]:
    seen: dict[str, Path] = {}

    def add(path: Path) -> None:
        try:
            key = str(path.resolve())
        except OSError:
            return
        seen.setdefault(key, Path(key))

    for directory in _font_directories():
        try:
            if not directory.is_dir():
                continue
            for path in directory.rglob("*"):
                try:
                    if path.is_file() and _is_font_file(path):
                        add(path)
                except OSError:
                    continue
        except OSError:
            continue
    for path in _coretext_font_files():
        add(path)
    for path in _windows_registry_font_files():
        add(path)
    return sorted(seen.values(), key=str)


# ---------------------------------------------------------------------------
# face 単位のメタデータ抽出
# ---------------------------------------------------------------------------


def _face_info(path: Path) -> tuple[int, bool]:
    """(face 数, TTC かどうか)。ヘッダだけ読むので TTCollection より速い。"""
    try:
        with path.open("rb") as handle:
            header = handle.read(12)
    except OSError:
        return 0, False
    if len(header) < 4:
        return 0, False
    if header[:4] == b"ttcf" and len(header) >= 12:
        num = int.from_bytes(header[8:12], "big")
        # 壊れたヘッダで巨大な face 数が出ても暴走しないよう上限を置く
        return max(1, min(num, 64)), True
    return 1, False


# (path, mtime_ns, size, index) → face メタ。失敗は {} を記録して再パースを避ける。
_FACE_CACHE: dict[tuple[str, int, int, int], dict[str, Any]] = {}


def _inspect_face(path: Path, font_number: int, stat: os.stat_result) -> dict[str, Any]:
    cache_key = (str(path), stat.st_mtime_ns, stat.st_size, font_number)
    cached = _FACE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    result: dict[str, Any] = {}
    try:
        from fontTools.ttLib import TTFont, TTLibError
    except ImportError:
        return result
    try:
        tt = TTFont(str(path), fontNumber=font_number, lazy=True)
    except (TTLibError, OSError, ValueError, IndexError):
        _FACE_CACHE[cache_key] = result
        return result
    try:
        try:
            name_table = tt["name"]
            family_en = _name_record(name_table, 16) or _name_record(name_table, 1)
            subfamily_en = _name_record(name_table, 17) or _name_record(name_table, 2)
            family_ja = _name_record(name_table, 16, _NAME_LOOKUP_JA) or _name_record(
                name_table, 1, _NAME_LOOKUP_JA
            )
            subfamily_ja = _name_record(name_table, 17, _NAME_LOOKUP_JA) or _name_record(
                name_table, 2, _NAME_LOOKUP_JA
            )
        except KeyError:
            family_en = subfamily_en = family_ja = subfamily_ja = ""

        weight_class = 0
        italic = False
        try:
            os2 = tt["OS/2"]
            weight_class = int(getattr(os2, "usWeightClass", 0) or 0)
            italic = bool(int(getattr(os2, "fsSelection", 0) or 0) & 0x01)
        except (KeyError, ValueError, TypeError):
            pass
        if not italic:
            italic = "italic" in (subfamily_en or "").lower() or "oblique" in (subfamily_en or "").lower()

        result = {
            "family": (family_en or "").strip(),
            "subfamily": (subfamily_en or "").strip(),
            "family_localized": (family_ja or "").strip(),
            "subfamily_localized": (subfamily_ja or "").strip(),
            "weight_id": weight_id_from_class(weight_class) or "regular",
            "italic": italic,
        }
    except Exception:  # noqa: BLE001 - 壊れたフォントは黙ってスキップ
        result = {}
    finally:
        try:
            tt.close()
        except Exception:  # noqa: BLE001
            pass
    _FACE_CACHE[cache_key] = result
    return result


def _family_id(name: str) -> str:
    """family 名から永続 ID を作る。config.family_id_from_stem と同思想。"""
    base = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").lower()
    if base:
        return f"sys_{base}"
    return "sys_" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:10]


def _build_catalog(files: list[Path]) -> list[dict[str, Any]]:
    from .config import display_name_for_font  # 遅延 import (config → font_inspect と一方向を保つ)

    families: dict[str, dict[str, Any]] = {}
    for path in files:
        try:
            stat = path.stat()
        except OSError:
            continue
        face_count, is_collection = _face_info(path)
        for index in range(face_count):
            font_number = index if is_collection else -1
            meta = _inspect_face(path, font_number, stat)
            if not meta:
                continue
            family_en = meta["family"]
            family_ja = meta["family_localized"]
            key_source = family_en or family_ja or path.stem
            if key_source.startswith("."):
                # ".SF NS" 等の OS 内部 UI フォントは選択肢に出さない
                continue
            display_name = display_name_for_font(meta, key_source)
            group_key = key_source.casefold()
            item = families.setdefault(
                group_key,
                {
                    "id": _family_id(key_source),
                    "name": display_name,
                    "cssFamilies": [],
                    "weights": {},
                    "system": True,
                },
            )
            if len(display_name) < len(item["name"]):
                item["name"] = display_name
            for css_name in (family_ja, family_en):
                if css_name and css_name not in item["cssFamilies"]:
                    item["cssFamilies"].append(css_name)
            item["weights"].setdefault(meta["weight_id"], []).append(
                {
                    "path": str(path),
                    "index": max(font_number, 0) if is_collection else -1,
                    "italic": bool(meta["italic"]),
                }
            )

    for item in families.values():
        # 同 weight に立体 (upright) と italic が並存する場合は upright を優先する。
        for weight_id, faces in item["weights"].items():
            item["weights"][weight_id] = sorted(faces, key=lambda face: bool(face["italic"]))
        if not item["cssFamilies"]:
            item["cssFamilies"] = [item["name"]]
    return sorted(families.values(), key=lambda item: str(item["name"]).lower())


# ---------------------------------------------------------------------------
# ディスクキャッシュ (manifest 不一致で全再スキャン)
# ---------------------------------------------------------------------------


def _files_manifest(files: list[Path]) -> list[dict[str, Any]]:
    manifest = []
    for path in files:
        try:
            stat = path.stat()
        except OSError:
            continue
        manifest.append({"path": str(path), "mtimeNs": stat.st_mtime_ns, "size": stat.st_size})
    return manifest


def _load_cache(manifest: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
        return None
    if data.get("files") != manifest:
        return None
    fonts = data.get("fonts")
    if not isinstance(fonts, list):
        return None
    return fonts


def _save_cache(manifest: list[dict[str, Any]], fonts: list[dict[str, Any]]) -> None:
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = CACHE_PATH.with_suffix(".json.tmp")
        tmp_path.write_text(
            json.dumps({"version": CACHE_VERSION, "files": manifest, "fonts": fonts}, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(tmp_path, CACHE_PATH)
    except OSError as exc:
        _log.warning("system font cache write failed: %s", exc)


# ---------------------------------------------------------------------------
# スキャン状態と公開 API
# ---------------------------------------------------------------------------

_lock = threading.Lock()  # _state アクセスの排他
_scan_lock = threading.Lock()  # スキャン実行の直列化 (rescan 連打対策)
_state: dict[str, Any] = {
    "status": "idle",  # idle | scanning | ready | failed
    "fonts": [],
    "count": 0,
    "faceCount": 0,
    "error": "",
    "scannedAt": 0.0,
    "fromCache": False,
}


def enabled() -> bool:
    try:
        from .global_config import load_global_config

        cfg = load_global_config().get("systemFonts")
        if isinstance(cfg, dict):
            return bool(cfg.get("enabled", True))
    except Exception:  # noqa: BLE001
        pass
    return True


def run_scan(force: bool = False) -> dict[str, Any]:
    """同期スキャン。キャッシュが有効ならパースを省略する。"""
    with _scan_lock:
        with _lock:
            if _state["status"] == "ready" and not force:
                return status_payload()
            _state["status"] = "scanning"
            _state["error"] = ""
        try:
            started = time.time()
            files = _candidate_files()
            manifest = _files_manifest(files)
            fonts = None if force else _load_cache(manifest)
            from_cache = fonts is not None
            if fonts is None:
                fonts = _build_catalog(files)
                _save_cache(manifest, fonts)
            face_count = sum(len(faces) for font in fonts for faces in font["weights"].values())
            with _lock:
                _state.update(
                    status="ready",
                    fonts=fonts,
                    count=len(fonts),
                    faceCount=face_count,
                    scannedAt=time.time(),
                    fromCache=from_cache,
                )
            _log.info(
                "system fonts: %d families / %d faces (%s, %.1fs)",
                len(fonts),
                face_count,
                "cache" if from_cache else "full scan",
                time.time() - started,
            )
        except Exception as exc:  # noqa: BLE001
            _log.warning("system font scan failed: %s", exc)
            with _lock:
                _state.update(status="failed", error=str(exc))
    return status_payload()


def start_background_scan(force: bool = False) -> None:
    """起動時などに呼ぶ非ブロッキング版。無効時・実行中・完了済みは no-op。"""
    if not enabled():
        return
    with _lock:
        if _state["status"] == "scanning":
            return
        if _state["status"] == "ready" and not force:
            return
    threading.Thread(
        target=run_scan, kwargs={"force": force}, name="system-font-scan", daemon=True
    ).start()


def status_payload() -> dict[str, Any]:
    is_enabled = enabled()
    with _lock:
        return {
            "enabled": is_enabled,
            "status": _state["status"],
            "familyCount": _state["count"],
            "faceCount": _state["faceCount"],
            "fromCache": _state["fromCache"],
            "error": _state["error"],
        }


def manifest_entries() -> list[dict[str, Any]]:
    """manifest の ``config.fonts`` に追記するクライアント向けエントリ。

    実ファイルパスはクライアントに不要 (ブラウザはローカル family 名で解決する)
    ため、weights は「存在する weight_id のキー」だけを空リストで返す。
    未スキャン (idle) ならバックグラウンドスキャンを蹴って空を返す。
    """
    if not enabled():
        return []
    with _lock:
        status = _state["status"]
        fonts = _state["fonts"]
    if status == "idle":
        start_background_scan()
        return []
    return [
        {
            "id": font["id"],
            "name": font["name"],
            "system": True,
            "cssFamilies": list(font.get("cssFamilies") or []),
            "weights": {weight_id: [] for weight_id in (font.get("weights") or {})},
        }
        for font in fonts
    ]


def ensure_ready() -> None:
    """カタログを同期的に利用可能へ (Pillow 経路用)。

    scanning 中なら ``_scan_lock`` 待ちで完了に追随する。キャッシュヒット時は
    数十 ms なので、scene payload 生成のスレッドプール内でブロックしてよい。
    """
    if not enabled():
        return
    with _lock:
        if _state["status"] == "ready":
            return
    run_scan()


def resolve_face(family_id: str, weight_id: str) -> tuple[str, int] | None:
    """family_id + weight_id から Pillow 用の (絶対パス, TTC index) を返す。

    weight フォールバック順は compositor.paths_for_weight / JS の
    resolveFontWeightCss と同じ: 指定 → regular → medium → bold → 先頭。
    """
    if not family_id or not str(family_id).startswith("sys_"):
        return None
    ensure_ready()
    with _lock:
        fonts = _state["fonts"]
    for font in fonts:
        if font.get("id") != family_id:
            continue
        weights = font.get("weights") or {}
        faces = (
            weights.get(weight_id)
            or weights.get("regular")
            or weights.get("medium")
            or weights.get("bold")
            or next(iter(weights.values()), [])
        )
        for face in faces:
            path = face.get("path")
            if path and Path(path).is_file():
                return str(path), int(face.get("index", -1))
        return None
    return None


__all__ = [
    "enabled",
    "ensure_ready",
    "run_scan",
    "start_background_scan",
    "status_payload",
    "manifest_entries",
    "resolve_face",
]

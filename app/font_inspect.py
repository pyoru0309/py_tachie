"""フォントファイルから family / weight / variable axis 情報を取り出す。

OS/2 テーブルの ``usWeightClass`` (1-1000) と name テーブルの NameID 16/17/1 を読む
正攻法。filename からの推定 (``font_family_and_weight``) より権威があるので、
``scan_fonts`` ではこちらを優先し、欠落時のみ filename にフォールバックする。

参考:
- OS/2: https://docs.microsoft.com/en-us/typography/opentype/spec/os2#usweightclass
- name table: NameID 16 = Typographic Family Name (推奨)、17 = Typographic Subfamily、
  1 = Family Name (legacy 4-style 制約あり)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

# 内部 weight id ↔ CSS / OS/2 weight class
WEIGHT_ID_TO_CLASS: dict[str, int] = {
    "thin": 100,
    "extra_light": 200,
    "light": 300,
    "demi_light": 350,  # Source Han Sans 系固有
    "regular": 400,
    "medium": 500,
    "semi_bold": 600,
    "bold": 700,
    "extra_bold": 800,
    "black": 900,
}


def weight_id_from_class(weight_class: int) -> str:
    """OS/2.usWeightClass を最も近い内部 weight id にマップする。

    ``weight_class`` が 0 (= フォント側で未指定) や負の場合は ``""`` (空) を返し、
    呼び出し側で filename フォールバックさせる。
    """
    if not weight_class or weight_class <= 0:
        return ""
    nearest_id = "regular"
    nearest_diff = 10**6
    for wid, css in WEIGHT_ID_TO_CLASS.items():
        diff = abs(css - weight_class)
        if diff < nearest_diff:
            nearest_diff = diff
            nearest_id = wid
    return nearest_id


# (path_str, mtime_ns, size) → metadata の in-process キャッシュ。
# 素材再スキャンが何度走っても、未変更フォントの再パースを避ける。
_METADATA_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}


# (platformID, encodingID, languageID) tuple for name table lookup.
# 言語 ID の数値はそれぞれの platform で独立。
# - Microsoft (platformID=3): langID は LCID (0x411=ja-JP, 0x409=en-US)
# - Macintosh (platformID=1): langID は Mac script code (11=Japanese, 0=English)
_NAME_LOOKUP_JA = (
    (3, 1, 0x411),  # Microsoft Unicode BMP, ja-JP
    (1, 1, 11),     # Mac Japanese script
)
_NAME_LOOKUP_EN = (
    (3, 1, 0x409),  # Microsoft Unicode BMP, en-US
    (1, 0, 0),      # Mac Roman, English
)


def _name_record(name_table, name_id: int, lookups=_NAME_LOOKUP_EN) -> str:
    """name テーブルから NameID の表記を best-effort で取り出す。

    ``lookups`` は (platformID, encodingID, languageID) のタプル列。先頭から順に
    試し、最初に decode 成功したものを返す。同一 nameID に複数言語の record が
    あることを利用して、日本語名 (``_NAME_LOOKUP_JA``) と英語名 (``_NAME_LOOKUP_EN``)
    を別々に取り出せる。
    """
    for platform_id, encoding_id, lang_id in lookups:
        rec = name_table.getName(name_id, platform_id, encoding_id, lang_id)
        if rec is None:
            continue
        try:
            text = rec.toUnicode()
        except Exception:  # noqa: BLE001
            continue
        if text:
            return text
    try:
        debug = name_table.getDebugName(name_id)
    except Exception:  # noqa: BLE001
        debug = None
    return debug or ""


def inspect_font(path: Path) -> dict[str, Any]:
    """フォントファイルから family / weight / variable axis 情報を抽出する。

    返り値::
        {
            "family":             "Chihaya Jyun",   # en-US 由来 (空文字なら不明)
            "subfamily":          "Regular",
            "family_localized":   "ちはや純",       # ja-JP / Mac-ja 由来 (空文字なら無し)
            "subfamily_localized":"Regular",
            "weight_id":          "regular",        # OS/2 由来 (空文字なら不明)
            "weight_class":       400,
            "is_variable":        False,
        }

    fontTools が無い、ファイルが壊れている、必要テーブルが無い等で失敗した場合は
    空の dict ではなく上記キーが空/0 で埋まった dict を返す (呼び出し側の分岐を簡素化)。
    """
    blank = {
        "family": "",
        "subfamily": "",
        "family_localized": "",
        "subfamily_localized": "",
        "weight_id": "",
        "weight_class": 0,
        "is_variable": False,
    }
    try:
        stat = path.stat()
    except OSError:
        return blank
    cache_key = (str(path), stat.st_mtime_ns, stat.st_size)
    cached = _METADATA_CACHE.get(cache_key)
    if cached is not None:
        return cached

    try:
        from fontTools.ttLib import TTFont, TTLibError
    except ImportError:
        return blank

    try:
        # lazy=True で OS/2 と name 以外のテーブルは触れない (パース時間短縮)。
        tt = TTFont(str(path), lazy=True)
    except (TTLibError, OSError, ValueError):
        return blank

    family = ""
    subfamily = ""
    family_localized = ""
    subfamily_localized = ""
    weight_class = 0
    is_variable = False
    try:
        try:
            name_table = tt["name"]
            family = _name_record(name_table, 16) or _name_record(name_table, 1)
            subfamily = _name_record(name_table, 17) or _name_record(name_table, 2)
            family_localized = (
                _name_record(name_table, 16, _NAME_LOOKUP_JA)
                or _name_record(name_table, 1, _NAME_LOOKUP_JA)
            )
            subfamily_localized = (
                _name_record(name_table, 17, _NAME_LOOKUP_JA)
                or _name_record(name_table, 2, _NAME_LOOKUP_JA)
            )
        except KeyError:
            pass

        try:
            os2 = tt["OS/2"]
            weight_class = int(getattr(os2, "usWeightClass", 0) or 0)
        except (KeyError, ValueError, TypeError):
            weight_class = 0

        try:
            is_variable = "fvar" in tt
        except Exception:  # noqa: BLE001
            is_variable = False
    finally:
        try:
            tt.close()
        except Exception:  # noqa: BLE001
            pass

    result = {
        "family": (family or "").strip(),
        "subfamily": (subfamily or "").strip(),
        "family_localized": (family_localized or "").strip(),
        "subfamily_localized": (subfamily_localized or "").strip(),
        "weight_id": weight_id_from_class(weight_class),
        "weight_class": weight_class,
        "is_variable": is_variable,
    }
    _METADATA_CACHE[cache_key] = result
    return result


def clear_metadata_cache() -> None:
    """テスト用: metadata cache を空にする。"""
    _METADATA_CACHE.clear()


__all__ = [
    "WEIGHT_ID_TO_CLASS",
    "weight_id_from_class",
    "inspect_font",
    "clear_metadata_cache",
]

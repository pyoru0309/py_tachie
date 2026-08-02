"""縦書きテロップ用の OpenType GSUB `vert` 情報抽出。

Canvas2D には縦書き API が無いため、クライアントは 1 文字ずつ自前レイアウト
する。その際、句読点 (、。) / 括弧類 (「」（）等) / 長音 (ー) / 小書き仮名
(っゃ 等) は横書き字形のままでは正しくない。フォント自身が持つ縦書き用
代替字形 (GSUB の `vert` / `vrt2` feature、単一置換) が正解なので、本モジュール
が fontTools で:

1. cmap で文字 → グリフ名
2. GSUB `vert`/`vrt2` の単一置換 map でグリフ名 → 縦書きグリフ名
3. 縦書きグリフのアウトラインを SVG path 文字列化 (SVGPathPen、フォント座標系
   = y-up, unitsPerEm スケール)
4. vmtx から縦送り量、OS/2 sTypoAscender/Descender から em ボックス比率

を取り出して返す。クライアントは Path2D(d) を translate+scale(1,-1) で描画する。

置換が無い文字はレスポンスに含めない → クライアントは Unicode 分類による
回転/シフトのフォールバック描画を行う (UAX #50 相当の近似)。

参考: https://learn.microsoft.com/en-us/typography/opentype/spec/
  - GSUB: LookupType 1 (Single Substitution) / 7 (Extension)
  - vmtx / OS/2.sTypoAscender
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from .log_setup import app_logger

_log = app_logger("vertical_text")

# (path, mtime_ns, index) → per-font 解析結果。フォント数 × 数十 KB 程度なので
# 上限管理は簡素に (エントリ数のみ)。
_FONT_INFO_CACHE: dict[tuple[str, int, int], "_FontVerticalInfo | None"] = {}
_CACHE_LIMIT = 64
_lock = threading.Lock()


class _FontVerticalInfo:
    """1 フォント (face) 分の縦書き情報。グリフ path は文字単位で遅延抽出。"""

    def __init__(self, path: Path, font_number: int):
        from fontTools.ttLib import TTFont

        self._path = path
        self._font_number = font_number
        tt = TTFont(str(path), fontNumber=font_number, lazy=True)
        self._tt = tt
        self.upem = int(tt["head"].unitsPerEm or 1000)
        self.cmap = tt.getBestCmap()
        self.vert_map = self._extract_vert_map(tt)
        self.em_ascent, self.em_descent = self._extract_em_box(tt)
        self._glyph_set = None
        self._glyph_cache: dict[str, dict[str, Any] | None] = {}

    @staticmethod
    def _extract_vert_map(tt) -> dict[str, str]:
        """GSUB の vert / vrt2 feature から単一置換 map を集める。

        vrt2 (縦書き 90° 回転済み字形) を持つフォントは稀だが、あれば vert より
        優先される仕様なので、vert → vrt2 の順で update して vrt2 を勝たせる。
        Extension (LookupType 7) にラップされた Single Substitution も展開する。
        """
        try:
            gsub = tt["GSUB"].table
        except KeyError:
            return {}
        if not getattr(gsub, "FeatureList", None) or not getattr(gsub, "LookupList", None):
            return {}
        indices_by_tag: dict[str, set[int]] = {"vert": set(), "vrt2": set()}
        for record in gsub.FeatureList.FeatureRecord:
            if record.FeatureTag in indices_by_tag:
                indices_by_tag[record.FeatureTag].update(record.Feature.LookupListIndex)
        mapping: dict[str, str] = {}
        for tag in ("vert", "vrt2"):
            for lookup_index in sorted(indices_by_tag[tag]):
                try:
                    lookup = gsub.LookupList.Lookup[lookup_index]
                except IndexError:
                    continue
                for subtable in lookup.SubTable:
                    if lookup.LookupType == 7 and hasattr(subtable, "ExtSubTable"):
                        subtable = subtable.ExtSubTable
                    if hasattr(subtable, "mapping"):
                        mapping.update(subtable.mapping)
        return mapping

    @staticmethod
    def _extract_em_box(tt) -> tuple[float, float]:
        """baseline からの em ボックス上端/下端比率 (upem 正規化)。

        優先: OS/2 sTypoAscender/Descender。無ければ hhea。それも無ければ
        和文の慣行値 0.88/0.12。合計が upem とずれるフォントは比率で按分する。
        """
        upem = int(tt["head"].unitsPerEm or 1000)
        ascent = descent = 0
        try:
            os2 = tt["OS/2"]
            ascent = int(getattr(os2, "sTypoAscender", 0) or 0)
            descent = abs(int(getattr(os2, "sTypoDescender", 0) or 0))
        except KeyError:
            pass
        if ascent <= 0:
            try:
                hhea = tt["hhea"]
                ascent = int(getattr(hhea, "ascent", 0) or 0)
                descent = abs(int(getattr(hhea, "descent", 0) or 0))
            except KeyError:
                pass
        total = ascent + descent
        if ascent <= 0 or total <= 0:
            return 0.88, 0.12
        return ascent / total, descent / total

    def glyph_entry(self, ch: str) -> dict[str, Any] | None:
        """文字の縦書き代替グリフ情報。置換が無ければ None。"""
        if ch in self._glyph_cache:
            return self._glyph_cache[ch]
        entry = self._build_glyph_entry(ch)
        self._glyph_cache[ch] = entry
        return entry

    def _build_glyph_entry(self, ch: str) -> dict[str, Any] | None:
        if len(ch) != 1:
            return None
        glyph_name = self.cmap.get(ord(ch))
        if not glyph_name:
            return None
        vert_name = self.vert_map.get(glyph_name)
        if not vert_name or vert_name == glyph_name:
            return None
        try:
            from fontTools.pens.svgPathPen import SVGPathPen

            if self._glyph_set is None:
                self._glyph_set = self._tt.getGlyphSet()
            glyph_set = self._glyph_set
            if vert_name not in glyph_set:
                return None
            pen = SVGPathPen(glyph_set)
            glyph_set[vert_name].draw(pen)
            d = pen.getCommands()
        except Exception as exc:  # noqa: BLE001 - 壊れたグリフは黙ってフォールバックへ
            _log.debug("vert glyph outline failed (%s %r): %s", self._path.name, ch, exc)
            return None
        if not d:
            return None

        v_adv = 1.0
        try:
            vmtx = self._tt["vmtx"]
            v_adv = float(vmtx.metrics[vert_name][0]) / self.upem
        except (KeyError, IndexError, TypeError):
            pass
        h_adv = 1.0
        try:
            h_adv = float(glyph_set[vert_name].width) / self.upem
        except (AttributeError, TypeError):
            pass
        return {"d": d, "vAdv": v_adv, "hAdv": h_adv}


def _font_info(path: Path, font_number: int) -> _FontVerticalInfo | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    key = (str(path), stat.st_mtime_ns, font_number)
    with _lock:
        if key in _FONT_INFO_CACHE:
            return _FONT_INFO_CACHE[key]
    try:
        info = _FontVerticalInfo(path, font_number)
    except Exception as exc:  # noqa: BLE001
        _log.warning("vertical font info failed (%s): %s", path.name, exc)
        info = None
    with _lock:
        if len(_FONT_INFO_CACHE) >= _CACHE_LIMIT:
            _FONT_INFO_CACHE.pop(next(iter(_FONT_INFO_CACHE)))
        _FONT_INFO_CACHE[key] = info
    return info


def vertical_glyph_payload(
    path: Path, font_number: int, chars: str
) -> dict[str, Any]:
    """クライアント向けレスポンスを組み立てる。

    ``glyphs`` に含まれない文字 = フォントに縦書き代替が無い文字。クライアントは
    Unicode 分類のフォールバック (回転 / シフト / 正立) で描画する。
    """
    info = _font_info(path, font_number)
    if info is None:
        return {"available": False, "glyphs": {}, "upem": 1000, "emAscent": 0.88, "emDescent": 0.12}
    glyphs: dict[str, Any] = {}
    seen: set[str] = set()
    for ch in chars:
        if ch in seen or ch.isspace():
            continue
        seen.add(ch)
        entry = info.glyph_entry(ch)
        if entry:
            glyphs[ch] = entry
    return {
        "available": True,
        "upem": info.upem,
        "emAscent": info.em_ascent,
        "emDescent": info.em_descent,
        "glyphs": glyphs,
    }


__all__ = ["vertical_glyph_payload"]

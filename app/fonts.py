"""``assets/fonts/`` にデフォルトフォント (Noto Sans JP 等) をインストールするヘルパ。

このソフトはルートの ``assets/fonts/`` を基本的に使うが、配布 zip は空の状態で
出している。最低限「日本語が描画できる」ヘルパとして、UI から 1 クリックで
Noto Sans JP を ``assets/fonts/NotoSansJP/`` に取得する。

設計指針:
- Noto Sans JP は ``notofonts/noto-cjk`` リポジトリの ``Sans/SubsetOTF/JP/`` から
  static OTF を 7 weight (Thin / Light / DemiLight / Regular / Medium / Bold / Black)
  まとめて取得する。
- variable font (``NotoSansJP[wght].ttf``) ではなく static 7 ファイルにする理由:
  既存の ``scan_fonts`` (config.py) は stem 末尾から weight を判定する設計で、
  variable font だと「Regular しか出てこない」結果になる。LINE Seed JP / Zen Maru /
  M PLUS と挙動を揃えるため、static 配置で UI セレクタに 7 weight を並べる。
- インストール先は ``assets/fonts/NotoSansJP/`` にまとめ、再 install 時は丸ごと
  上書き (rmtree → mkdir → 書き出し)。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
import shutil

from .paths import ASSETS_DIR


FONTS_DIR = ASSETS_DIR / "fonts"

# 取得元 URL テンプレート (jsdelivr 経由の GitHub mirror)。直接
# raw.githubusercontent.com を叩くより rate limit / TLS の安定度が高い。
_NOTO_SANS_JP_WEIGHTS = ("Thin", "Light", "DemiLight", "Regular", "Medium", "Bold", "Black")
_NOTO_SANS_JP_PRIMARY = (
    "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/JP/"
    "NotoSansJP-{weight}.otf"
)
_NOTO_SANS_JP_FALLBACK = (
    "https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/JP/"
    "NotoSansJP-{weight}.otf"
)


def _noto_sans_jp_files() -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for weight in _NOTO_SANS_JP_WEIGHTS:
        files.append({
            "filename": f"NotoSansJP-{weight}.otf",
            "urls": (
                _NOTO_SANS_JP_PRIMARY.format(weight=weight),
                _NOTO_SANS_JP_FALLBACK.format(weight=weight),
            ),
        })
    return files


# UI で「インストール候補」として見せる定義。
INSTALLABLE_FONTS: dict[str, dict[str, Any]] = {
    "NotoSansJP": {
        "family": "Noto Sans JP",
        "license": "SIL Open Font License 1.1",
        "files": _noto_sans_jp_files(),
        "subdir": "NotoSansJP",
    },
}


def _httpx_client():
    import httpx

    return httpx.Client(timeout=120.0, follow_redirects=True)


def installed_font_packages() -> list[dict[str, Any]]:
    """``assets/fonts/<NAME>/`` 配下にインストール済みのフォントパッケージを列挙。

    ``install_font_package`` で入れたものだけが対象。直置きの単発フォントは含めない。
    """
    if not FONTS_DIR.exists():
        return []
    out: list[dict[str, Any]] = []
    for name, spec in INSTALLABLE_FONTS.items():
        sub = FONTS_DIR / spec["subdir"]
        if not sub.exists():
            continue
        files = []
        for f in spec["files"]:
            target = sub / f["filename"]
            if target.exists():
                files.append({"filename": f["filename"], "size": target.stat().st_size})
        if files:
            out.append({
                "name": name,
                "family": spec["family"],
                "files": files,
            })
    return out


def install_font_package(name: str) -> dict[str, Any]:
    spec = INSTALLABLE_FONTS.get(name)
    if not spec:
        raise ValueError(f"未対応のフォントです: {name}")

    sub = FONTS_DIR / spec["subdir"]
    if sub.exists():
        shutil.rmtree(sub)
    sub.mkdir(parents=True, exist_ok=True)

    saved: list[dict[str, Any]] = []
    with _httpx_client() as client:
        for fdef in spec["files"]:
            data: bytes | None = None
            last_error: Exception | None = None
            for url in fdef["urls"]:
                try:
                    resp = client.get(url)
                    if resp.status_code != 200:
                        last_error = RuntimeError(
                            f"{url}: HTTP {resp.status_code}"
                        )
                        continue
                    data = resp.content
                    break
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    continue
            if data is None:
                raise RuntimeError(
                    f"{fdef['filename']} の取得に失敗しました: {last_error}"
                )
            target = sub / fdef["filename"]
            target.write_bytes(data)
            saved.append({"filename": fdef["filename"], "size": target.stat().st_size})

    return {
        "name": name,
        "family": spec["family"],
        "subdir": spec["subdir"],
        "files": saved,
    }

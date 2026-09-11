"""プロジェクトディレクトリ ZIP 出力 (ディレクトリ依存性無し版)。

設計指針:
- 出力 zip は ``<project_id>/`` を root とする 1 段ネスト構造。
  ``project_import.py`` 側で取り込み時に「単一トップディレクトリ」を期待する。
- 揮発性 / 派生物 (cache / outputs / exports / generated) は除外。
- 内部で参照するアセットは ``assets/`` 配下に直接置かれているため、
  プロジェクト ZIP だけでは「共通アセット (assets/characters/<id>/)」が
  含まれないことに注意。共通キャラを含めて完全に再現したい場合は別アーカイブを
  作る方針 (将来課題)。
- いまは小〜中規模 (数 GB 以下) を想定し、メモリ上に zip を構築せず、
  一時ファイルに書き出してから FileResponse で返す。
"""

from __future__ import annotations

import re
import shutil
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from typing import Iterable
from urllib.parse import quote

# 除外ディレクトリ名 (project_root 直下に対するマッチ + 任意階層の同名 dir)。
_EXCLUDE_DIR_NAMES: frozenset[str] = frozenset({
    "cache",
    "outputs",
    "exports",
    "generated",
    "__pycache__",
    ".DS_Store",
})

# 除外ファイル拡張子 (大量の中間 npy / 一時 mp4 などを除外)。
_EXCLUDE_FILE_SUFFIXES: frozenset[str] = frozenset({
    ".pyc",
    ".pyo",
})


def _iter_archive_entries(project_root: Path) -> Iterable[Path]:
    """zip に含めるファイルを yield する。"""
    for path in project_root.rglob("*"):
        if not path.is_file():
            continue
        # 任意階層に出る除外ディレクトリ名を含むパスは除外。
        if any(part in _EXCLUDE_DIR_NAMES for part in path.relative_to(project_root).parts[:-1]):
            continue
        if path.name in _EXCLUDE_DIR_NAMES:
            continue
        if path.suffix.lower() in _EXCLUDE_FILE_SUFFIXES:
            continue
        yield path


def build_project_archive(project_root: Path, project_id: str, dest_dir: Path | None = None) -> Path:
    """プロジェクトディレクトリを ZIP 化して、書き出した一時ファイルパスを返す。

    呼び出し側で FileResponse 等を経て送り出した後、必要に応じて削除すること。

    zip エントリ名は必ず **NFC** で書き込む。macOS (HFS+ 由来 / Finder 経由で持ち込んだ
    ファイル) はディレクトリ名・ファイル名を NFD (基底文字 + 結合濁点) で保持することが
    あり、そのまま arcname にすると
      - Windows で解凍したとき NFD のままのファイル名になり、NFC で引く側から見つからない
      - トップディレクトリ名が NFD と NFC で混在し、取り込み側の「トップは単一
        ディレクトリ」判定が 2 個と誤検出する
    という事故になる (dev_docs: NFC 正規化 3 層)。
    """
    if not project_root.exists() or not project_root.is_dir():
        raise FileNotFoundError(project_root)

    top_name = unicodedata.normalize("NFC", project_id)
    dest_dir = dest_dir or Path(tempfile.gettempdir())
    dest_dir.mkdir(parents=True, exist_ok=True)
    # tmp ファイル名は ASCII に落とす (tempfile は prefix をそのままファイル名に使う
    # ため、日本語 + 非 UTF-8 ロケールの一時ディレクトリで落ちうる)。
    prefix_safe = re.sub(r"[^A-Za-z0-9._-]+", "_", top_name)[:32] or "project"
    out_path = Path(tempfile.mkstemp(prefix=f"splite_archive_{prefix_safe}_", suffix=".zip", dir=dest_dir)[1])

    with zipfile.ZipFile(out_path, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        # トップに "<project_id>/" を必ず作る (空 dir でも入る)。
        zf.writestr(f"{top_name}/", b"")
        for path in _iter_archive_entries(project_root):
            rel = unicodedata.normalize("NFC", path.relative_to(project_root).as_posix())
            zf.write(path, f"{top_name}/{rel}")

    return out_path


# ---------------------------------------------------------------------------
# ダウンロード名 (Content-Disposition)
# ---------------------------------------------------------------------------
# Windows / macOS どちらでも弾かれる文字 + パス区切り + 制御文字を除去する。
_FILENAME_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]+')


def archive_download_name(title: str, project_id: str) -> str:
    """アーカイブ zip の**表示用**ファイル名 (NFC / 日本語そのまま) を組み立てる。"""
    raw = unicodedata.normalize("NFC", (title or "").strip()) or unicodedata.normalize("NFC", project_id)
    cleaned = _FILENAME_FORBIDDEN.sub("_", raw).strip(" .")
    # 長すぎる名前は FS 上限 (255 バイト) に当たるので、拡張子ぶんを残して切る。
    while len(cleaned.encode("utf-8")) > 180:
        cleaned = cleaned[:-1]
    return f"{cleaned or project_id}.splite.zip"


def content_disposition_attachment(filename: str) -> str:
    r"""RFC 5987 準拠の Content-Disposition 値を返す。

    Starlette の ``FileResponse(filename=...)`` は非 ASCII 名だと ``filename*`` **だけ**を
    出す。旧クライアント (``filename*`` 非対応) では名前が丸ごと落ちるうえ、旧実装は
    ``re.sub(r"[^A-Za-z0-9._\-]+", "_", title)`` で ASCII へ潰していたため、**日本語だけの
    プロジェクト名が「_.splite.zip」になって名前が消えていた**。

    ここでは ``filename="<ASCII フォールバック>"; filename*=UTF-8''<NFC の percent-encode>``
    を両方出す。``filename*`` を読めるクライアント (現行ブラウザはすべて) は日本語名を
    そのまま受け取り、読めないクライアントでも意味のある ASCII 名になる。
    """
    nfc = unicodedata.normalize("NFC", filename)
    stem, _, ext = nfc.partition(".splite.zip")
    ascii_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._")
    # 日本語だけの名前は ASCII 化するとほぼ何も残らない。中途半端な残骸
    # (例: "2") を出すくらいなら汎用名のほうが親切。
    if len(ascii_stem) < 3:
        ascii_stem = "project"
    return (
        f'attachment; filename="{ascii_stem}.splite.zip"; '
        f"filename*=UTF-8''{quote(nfc, safe='')}"
    )


def cleanup_archive_file(path: Path) -> None:
    """build_project_archive で作った tmp zip を消す。失敗しても黙殺。"""
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


__all__ = [
    "archive_download_name",
    "build_project_archive",
    "cleanup_archive_file",
    "content_disposition_attachment",
]

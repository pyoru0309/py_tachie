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

import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable

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
    """
    if not project_root.exists() or not project_root.is_dir():
        raise FileNotFoundError(project_root)

    dest_dir = dest_dir or Path(tempfile.gettempdir())
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(tempfile.mkstemp(prefix=f"splite_archive_{project_id}_", suffix=".zip", dir=dest_dir)[1])

    with zipfile.ZipFile(out_path, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        # トップに "<project_id>/" を必ず作る (空 dir でも入る)。
        zf.writestr(f"{project_id}/", b"")
        for path in _iter_archive_entries(project_root):
            arcname = f"{project_id}/{path.relative_to(project_root).as_posix()}"
            zf.write(path, arcname)

    return out_path


def cleanup_archive_file(path: Path) -> None:
    """build_project_archive で作った tmp zip を消す。失敗しても黙殺。"""
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


__all__ = [
    "build_project_archive",
    "cleanup_archive_file",
]

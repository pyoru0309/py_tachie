"""scenarios/main.json のバックアップ管理。

ファイルレイアウト:
    projects/<id>/backups/
        scenario_auto_YYYYMMDD_HHMMSS.json       # 周期 / 切替時の自動バックアップ
        scenario_manual_YYYYMMDD_HHMMSS.json     # ユーザが「バックアップ」ボタンを押した
        scenario_preRestore_YYYYMMDD_HHMMSS.json # restore 直前に自動で取った安全網

種類 (kind):
    auto       — 周期/切替時。global_config.backup.autoRetentionCount で世代管理 (古い順に削除)
    manual     — ユーザ操作。設定 UI からのみ削除可
    preRestore — restore 直前の安全網。設定 UI からのみ削除可

直前の auto と内容が同一なら auto は skip (SHA-256 一致で判定)。
manual / preRestore は常に作成 (ハッシュ判定なし)。
"""
from __future__ import annotations

import hashlib
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from .utils import ProjectContext

BACKUP_DIR_NAME = "backups"
BackupKind = Literal["auto", "manual", "preRestore"]
_KIND_VALUES: tuple[BackupKind, ...] = ("auto", "manual", "preRestore")
# (kind)_(YYYYMMDD)_(HHMMSS) 形式。同秒衝突回避の連番 (_1, _2, ...) も許容。
_FILENAME_RE = re.compile(
    r"^scenario_(?P<kind>auto|manual|preRestore)_(?P<date>\d{8})_(?P<time>\d{6})(?:_(?P<seq>\d+))?\.json$"
)


def backup_dir(ctx: ProjectContext) -> Path:
    return ctx.root / BACKUP_DIR_NAME


def _scenario_source(ctx: ProjectContext) -> Path:
    """バックアップ対象。scenarios/main.json 固定 (project.json は touch しない)。"""
    return ctx.scenario_path


@dataclass(frozen=True)
class BackupInfo:
    id: str           # 拡張子を除いたファイル名 (= API 引数)
    kind: BackupKind
    created_at: str   # ISO 8601 (秒)
    timestamp: str    # YYYYMMDD_HHMMSS (ソート用)
    size: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "createdAt": self.created_at,
            "timestamp": self.timestamp,
            "size": self.size,
        }


def _parse_filename(path: Path) -> BackupInfo | None:
    match = _FILENAME_RE.match(path.name)
    if not match:
        return None
    kind = match.group("kind")
    if kind not in _KIND_VALUES:
        return None
    date_part = match.group("date")
    time_part = match.group("time")
    try:
        dt = datetime.strptime(f"{date_part}_{time_part}", "%Y%m%d_%H%M%S")
    except ValueError:
        return None
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    seq = match.group("seq")
    timestamp = f"{date_part}_{time_part}"
    if seq:
        timestamp = f"{timestamp}_{int(seq):04d}"
    return BackupInfo(
        id=path.stem,
        kind=kind,  # type: ignore[arg-type]
        created_at=dt.isoformat(timespec="seconds"),
        timestamp=timestamp,
        size=size,
    )


def _hash_file(path: Path) -> str | None:
    if not path.exists():
        return None
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _backup_files(ctx: ProjectContext) -> list[Path]:
    bdir = backup_dir(ctx)
    if not bdir.exists():
        return []
    return [p for p in bdir.iterdir() if p.is_file() and p.suffix == ".json"]


def list_backups(ctx: ProjectContext) -> list[dict[str, Any]]:
    """すべてのバックアップを新しい順で返す。"""
    items: list[BackupInfo] = []
    for path in _backup_files(ctx):
        info = _parse_filename(path)
        if info is not None:
            items.append(info)
    items.sort(key=lambda b: b.timestamp, reverse=True)
    return [b.to_dict() for b in items]


def _latest_auto_hash(ctx: ProjectContext) -> str | None:
    auto_files = [p for p in _backup_files(ctx) if _parse_filename(p) and _parse_filename(p).kind == "auto"]  # type: ignore[union-attr]
    if not auto_files:
        return None
    auto_files.sort(key=lambda p: p.name, reverse=True)
    return _hash_file(auto_files[0])


def _unique_target(bdir: Path, kind: BackupKind, ts: str) -> Path:
    """同秒衝突を避けて空きの target Path を返す。"""
    base = bdir / f"scenario_{kind}_{ts}.json"
    if not base.exists():
        return base
    seq = 1
    while True:
        candidate = bdir / f"scenario_{kind}_{ts}_{seq}.json"
        if not candidate.exists():
            return candidate
        seq += 1


def create_backup(
    ctx: ProjectContext,
    kind: BackupKind,
    *,
    retention: int | None = None,
    skip_if_unchanged: bool | None = None,
) -> dict[str, Any] | None:
    """``scenarios/main.json`` のスナップショットを作成して info を返す。

    skip_if_unchanged: 指定なしのとき auto はスキップ判定あり、manual / preRestore は常に作成。
    retention: auto 作成後の prune に使う件数。None は prune しない (manual / preRestore)。
    """
    src = _scenario_source(ctx)
    if not src.exists():
        return None

    should_check_hash = (
        skip_if_unchanged if skip_if_unchanged is not None else (kind == "auto")
    )
    if should_check_hash:
        current_hash = _hash_file(src)
        latest_hash = _latest_auto_hash(ctx)
        if current_hash and current_hash == latest_hash:
            return None

    bdir = backup_dir(ctx)
    bdir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    target = _unique_target(bdir, kind, ts)
    shutil.copy2(src, target)

    if kind == "auto" and retention is not None:
        prune_auto_backups(ctx, retention)

    info = _parse_filename(target)
    return info.to_dict() if info else None


def prune_auto_backups(ctx: ProjectContext, retention: int) -> int:
    """auto バックアップのみを古い順に削除し、新しい ``retention`` 件を残す。

    manual / preRestore は削除対象外。retention <= 0 は全 auto を削除。
    返り値: 削除した件数。
    """
    auto_paths: list[Path] = []
    for path in _backup_files(ctx):
        info = _parse_filename(path)
        if info and info.kind == "auto":
            auto_paths.append(path)
    if not auto_paths:
        return 0
    auto_paths.sort(key=lambda p: p.name, reverse=True)
    retention = max(0, int(retention))
    removed = 0
    for path in auto_paths[retention:]:
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def _resolve_backup_path(ctx: ProjectContext, backup_id: str) -> Path:
    """backup_id (拡張子なしステム) から実ファイルパスを返す。

    .. や / 等を弾いて、必ず backups/ 配下にいることを確認する。
    """
    # 厳格に: 受け入れるのは _FILENAME_RE の stem 部分にマッチするものだけ。
    if "/" in backup_id or "\\" in backup_id or ".." in backup_id:
        raise ValueError("Invalid backup id")
    if not _FILENAME_RE.match(f"{backup_id}.json"):
        raise ValueError("Invalid backup id")
    target = backup_dir(ctx) / f"{backup_id}.json"
    target_resolved = target.resolve()
    bdir_resolved = backup_dir(ctx).resolve()
    if bdir_resolved not in target_resolved.parents:
        raise ValueError("Backup path escapes project")
    return target


def restore_backup(
    ctx: ProjectContext,
    backup_id: str,
    *,
    snapshot_current: bool = True,
) -> dict[str, Any]:
    """``backup_id`` を scenarios/main.json に上書きする。

    snapshot_current=True (既定): 復元前に preRestore バックアップを 1 件作成して
    「間違って古いものを戻した」状態から戻れるようにする。
    """
    src = _resolve_backup_path(ctx, backup_id)
    if not src.is_file():
        raise FileNotFoundError(f"backup not found: {backup_id}")

    pre_snapshot: dict[str, Any] | None = None
    if snapshot_current:
        pre_snapshot = create_backup(
            ctx,
            "preRestore",
            retention=None,
            skip_if_unchanged=False,  # 復元前 snapshot は必ず作る
        )

    dest = _scenario_source(ctx)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)

    info = _parse_filename(src)
    return {
        "restored": info.to_dict() if info else {"id": backup_id},
        "preSnapshot": pre_snapshot,
    }


def delete_backup(ctx: ProjectContext, backup_id: str) -> bool:
    target = _resolve_backup_path(ctx, backup_id)
    if not target.is_file():
        return False
    target.unlink()
    return True

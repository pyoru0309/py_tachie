"""ZIP アーカイブからプロジェクトを取り込む / スキーマ移行を行う独立モジュール。

設計指針:
- 取り込みは ``import_project_zip(zip_bytes, projects_dir, ...) -> dict`` の純関数。
  FastAPI から切り離して呼び出せるようにする (CLI / テストでも使える)。
- 将来「保存スキーマのバージョンが上がった」とき、本モジュールを「移行ツール」として
  使い回す。``MIGRATIONS`` レジストリに ``(from_version, to_version, fn)`` を順次
  追記していく。``MIGRATIONS`` は ``run_migrations`` から呼ばれ、新しい version まで
  逐次適用される。

zip 構造 (project_archive.py と対):
    <project_id>/
      project.json
      config.json
      expression_presets.json
      scenarios/main.json
      assets/...
      ...

エラーハンドリング:
- 入力 zip が壊れている / 構造が想定外 / version が未来 (= 本ビルドで未対応) の
  ケースは ``ProjectImportError`` を投げる。FastAPI 側で 400 にマップする。
"""

from __future__ import annotations

import io
import json
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .utils import slugify_project_id, unique_project_id

# 現行スキーマ version (project.json / scenarios/main.json で使う共通の論理値)。
CURRENT_PROJECT_SCHEMA_VERSION = 4

# zip 内から「禁止パス」(absolute / parent traversal) を弾くためのチェック。
def _safe_zip_member(member_name: str) -> bool:
    if not member_name:
        return False
    if member_name.startswith("/") or "\\" in member_name:
        return False
    parts = member_name.split("/")
    for part in parts:
        if part in {"", ".", ".."}:
            return False
    return True


class ProjectImportError(Exception):
    """ZIP 取り込みで発生する想定済みエラー (UI に表示する)。"""


@dataclass
class ImportContext:
    """migration 関数に渡すコンテキスト。

    ``project_root``: 解凍直後の一時ディレクトリ内の ``<project_id>/`` 相当パス。
    ``project_data``: ``project.json`` を読み込んだ dict (in-place 編集 OK)。
    ``warnings``:    UI に表示する非致命的メッセージのリスト。
    """

    project_root: Path
    project_data: dict[str, Any]
    warnings: list[str] = field(default_factory=list)


# (from_version, to_version, fn) の順に並べ、最古から順に apply する。
# 例: ("3 -> 4", lambda ctx: ...). 新規追加時はここに行を増やすだけ。
MIGRATIONS: list[tuple[int, int, Callable[[ImportContext], None]]] = [
    # 例: v1 / v2 / v3 → v4 の本体は scenario.py 側 (normalize_scenario / ensure_*)
    # で処理されるため、ここでは「project.json / config.json レベルの最小限の整合
    # 取り」だけが残る予定。現時点では特別な前処理が無いので空。
]


# ---------------------------------------------------------------------------
# 1: zip 解凍
# ---------------------------------------------------------------------------


def _extract_zip_to_tmp(zip_bytes: bytes) -> tuple[Path, str]:
    """zip を一時ディレクトリへ解凍し、(tmp_root, top_dir_name) を返す。

    トップ階層が「単一ディレクトリ」であることを期待する。複数 entry がトップに
    出る zip は ``ProjectImportError`` を投げる。
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes), mode="r")
    except zipfile.BadZipFile as exc:
        raise ProjectImportError(f"ZIP として読み取れません: {exc}") from exc

    members = zf.namelist()
    if not members:
        zf.close()
        raise ProjectImportError("ZIP が空です")

    # トップ階層の dir を集計。"<top>/..." 形式以外は弾く。
    tops: set[str] = set()
    for name in members:
        if not _safe_zip_member(name.rstrip("/")):
            zf.close()
            raise ProjectImportError(f"安全でない ZIP エントリです: {name}")
        first = name.split("/", 1)[0]
        if first:
            tops.add(first)
    if len(tops) != 1:
        zf.close()
        raise ProjectImportError(
            f"ZIP のトップは単一ディレクトリである必要があります (現在 {len(tops)} 個)"
        )
    top_dir = next(iter(tops))

    tmp_root = Path(tempfile.mkdtemp(prefix="splite_import_"))
    try:
        zf.extractall(tmp_root)
    finally:
        zf.close()

    project_root = tmp_root / top_dir
    if not project_root.is_dir():
        shutil.rmtree(tmp_root, ignore_errors=True)
        raise ProjectImportError("トップディレクトリの解凍に失敗しました")
    return project_root, top_dir


# ---------------------------------------------------------------------------
# 2: 検証
# ---------------------------------------------------------------------------


def _read_project_json(project_root: Path) -> dict[str, Any]:
    project_file = project_root / "project.json"
    if not project_file.exists():
        raise ProjectImportError("project.json が含まれていません")
    try:
        with project_file.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ProjectImportError(f"project.json を読めません: {exc}") from exc
    if not isinstance(data, dict):
        raise ProjectImportError("project.json は dict でなければなりません")
    return data


def _detect_project_version(data: dict[str, Any]) -> int:
    """project.json から現行 schema version を推定する。

    project.json には歴史的経緯で ``version: 1`` (= レコード形式の version、
    ずっと 1) が入っているが、これは論理スキーマとは別物。論理スキーマは
    ``schemaVersion`` で表現する (本ビルドで初めて書き込む)。

    - ``schemaVersion`` キーがあれば優先。
    - 無い場合は CURRENT 扱い (scenario / manifest 等のロード時正規化に委譲)。
    """
    raw = data.get("schemaVersion")
    if isinstance(raw, int) and raw > 0:
        return raw
    if isinstance(raw, str):
        try:
            v = int(raw)
            if v > 0:
                return v
        except ValueError:
            pass
    return CURRENT_PROJECT_SCHEMA_VERSION


# ---------------------------------------------------------------------------
# 3: migration
# ---------------------------------------------------------------------------


def run_migrations(ctx: ImportContext, from_version: int, to_version: int) -> None:
    """登録済みの ``MIGRATIONS`` を順次適用する。

    既存スキーマ (v1〜v4) は scenario.py / manifest.py / config.py の正規化が
    動作時に賄うため、現状は no-op となる migration が多い。明示的な「ここで
    一回だけ走らせるべき変換」が必要になったら、本リストに足す。
    """
    if from_version >= to_version:
        return
    current = from_version
    for src, dst, fn in MIGRATIONS:
        if src < current:
            continue
        if src >= to_version:
            break
        if src != current:
            raise ProjectImportError(
                f"スキーマ {current} → {to_version} へ進めません (連続した migration が無い: {src})"
            )
        try:
            fn(ctx)
        except Exception as exc:  # noqa: BLE001
            raise ProjectImportError(f"migration {src}→{dst} に失敗: {exc}") from exc
        current = dst
    if current < to_version:
        # 直接ジャンプの migration が無いケースは、scenario.py / manifest.py の
        # ロード時正規化に委ねる (ここでは fail にしない)。
        ctx.warnings.append(
            f"明示的な migration を経ずに {current} → {to_version} へ更新しました "
            "(ロード時の正規化に委譲)"
        )


# ---------------------------------------------------------------------------
# 4: 配置
# ---------------------------------------------------------------------------


def _allocate_project_id(preferred: str, projects_dir: Path) -> str:
    """projects_dir 配下で衝突しない project_id を確保する。

    ``unique_project_id`` は内部で ``current_projects_dir()`` を見るが、テスト等で
    違うディレクトリに展開したいケースがあるので、ここでは独自に走査する。
    """
    base = slugify_project_id(preferred)
    candidate = base
    suffix = 2
    while (projects_dir / candidate / "project.json").exists():
        candidate = f"{base}_{suffix}"
        suffix += 1
    return candidate


def _write_project_metadata(
    project_root: Path, project_data: dict[str, Any], new_id: str
) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    project_data["id"] = new_id
    project_data["schemaVersion"] = CURRENT_PROJECT_SCHEMA_VERSION
    project_data.setdefault("createdAt", now)
    project_data["updatedAt"] = now
    project_data["lastOpenedAt"] = now
    with (project_root / "project.json").open("w", encoding="utf-8") as handle:
        json.dump(project_data, handle, ensure_ascii=False, indent=2)


def import_project_zip(
    zip_bytes: bytes,
    projects_dir: Path,
    *,
    original_filename: str = "",
    target_id: str | None = None,
) -> dict[str, Any]:
    """ZIP からプロジェクトを取り込み、最終的な project_id 等を返す。

    - 既存と衝突する場合は suffix を付けて新 ID を割り当てる (上書きはしない)。
    - スキーマ移行は ``MIGRATIONS`` を順次適用。
    - 戻り値: ``{"id": str, "title": str, "from_version": int, "to_version": int, "warnings": list[str]}``
    """
    project_root, top_dir = _extract_zip_to_tmp(zip_bytes)
    cleanup_root = project_root.parent

    try:
        project_data = _read_project_json(project_root)
        from_version = _detect_project_version(project_data)
        if from_version > CURRENT_PROJECT_SCHEMA_VERSION:
            raise ProjectImportError(
                f"このビルドが未対応の新しいスキーマです (zip: v{from_version} / "
                f"current: v{CURRENT_PROJECT_SCHEMA_VERSION})"
            )

        ctx = ImportContext(project_root=project_root, project_data=project_data)
        run_migrations(ctx, from_version, CURRENT_PROJECT_SCHEMA_VERSION)

        # ID 割り当て: target_id 指定 → zip 内 project_data.id → top_dir の順
        preferred = (
            target_id
            or str(project_data.get("id") or "").strip()
            or top_dir
            or Path(original_filename).stem
            or "imported_project"
        )
        new_id = _allocate_project_id(preferred, projects_dir)

        _write_project_metadata(project_root, project_data, new_id)

        # 最終配置 (renames)
        dest = projects_dir / new_id
        if dest.exists():  # 念のため (race にはならないが安全側)
            raise ProjectImportError(f"配置先がすでに存在します: {dest}")
        projects_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(project_root), str(dest))
    except Exception:
        # 解凍途中で失敗したら一時ディレクトリを掃除
        shutil.rmtree(cleanup_root, ignore_errors=True)
        raise
    else:
        # 成功時も一時 root の残骸を削除
        try:
            shutil.rmtree(cleanup_root, ignore_errors=True)
        except OSError:
            pass

    return {
        "id": new_id,
        "title": str(project_data.get("title") or new_id),
        "fromVersion": from_version,
        "toVersion": CURRENT_PROJECT_SCHEMA_VERSION,
        "warnings": ctx.warnings,
    }


__all__ = [
    "CURRENT_PROJECT_SCHEMA_VERSION",
    "ImportContext",
    "MIGRATIONS",
    "ProjectImportError",
    "import_project_zip",
    "run_migrations",
]

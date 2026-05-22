"""プロジェクトコンテキスト・ID 操作・パスヘルパー。

ProjectContext は各プロジェクトのファイル位置をまとめた frozen dataclass。
他の app/ モジュールからは「`from .utils import project_context, ProjectContext, ...`」で参照される。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .global_config import current_projects_dir
from .paths import ACTIVE_PROJECT_PATH, DEFAULT_PROJECT_ID, PROJECT_ROOT, STATE_DIR


@dataclass(frozen=True)
class ProjectContext:
    id: str
    root: Path
    project_file: Path
    config_path: Path
    presets_path: Path
    scenario_path: Path
    manifest_path: Path
    psd_manifest_path: Path
    cache_dir: Path
    output_dir: Path


def slugify_project_id(value: str) -> str:
    # macOS のファイルシステム (HFS+/APFS) は濁音・半濁音を NFD 形式 (基底文字 +
    # 結合濁点 ◌゙) で返す。Python の `\w` は category Mn (結合マーク) を含まない
    # ので、`re.sub(r"[^\w-]+", "_", "だ")` は ◌゙ を `_` に置換し「た_」になる。
    # NFC 正規化で基底文字 + 結合濁点を「だ」一文字へ合成してから regex を当てる。
    normalized = unicodedata.normalize("NFC", value.strip())
    slug = re.sub(r"[^\w-]+", "_", normalized, flags=re.UNICODE).strip("_")
    return slug or f"project_{datetime.now().strftime('%Y%m%d_%H%M%S')}"


def unique_project_id(raw_id: str) -> str:
    base_id = slugify_project_id(raw_id)
    project_id = base_id
    suffix = 2
    while (current_projects_dir() / project_id / "project.json").exists():
        project_id = f"{base_id}_{suffix}"
        suffix += 1
    return project_id


def project_context(project_id: str | None = None) -> ProjectContext:
    project_id = slugify_project_id(project_id or active_project_id())
    root = current_projects_dir() / project_id
    return ProjectContext(
        id=project_id,
        root=root,
        project_file=root / "project.json",
        config_path=root / "config.json",
        presets_path=root / "expression_presets.json",
        scenario_path=root / "scenarios" / "main.json",
        manifest_path=root / "generated" / "manifest.json",
        psd_manifest_path=root / "assets" / "character_manifest.json",
        cache_dir=root / "cache",
        output_dir=root / "outputs",
    )


def active_project_id() -> str:
    if ACTIVE_PROJECT_PATH.exists():
        text = ACTIVE_PROJECT_PATH.read_text(encoding="utf-8").strip()
        if text and (current_projects_dir() / slugify_project_id(text) / "project.json").exists():
            return slugify_project_id(text)
    project_files = sorted(current_projects_dir().glob("*/project.json"))
    return project_files[0].parent.name if project_files else ""


def set_active_project(project_id: str) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    ACTIVE_PROJECT_PATH.write_text(slugify_project_id(project_id) if project_id else "", encoding="utf-8")


def relative_to_root(path: Path) -> str:
    """PROJECT_ROOT からの相対パスを **POSIX セパレータ** で返す。

    保存される JSON / URL ルーティング / FontFace 登録 (canvas) は全て `/` 区切り前提。
    Windows 上で OS native の ``str(Path)`` を使うとバックスラッシュが入って
    フォント未登録・前景解決失敗・JSON 異種混在を引き起こす (実際 Windows 移行で
    プレビュー描画が崩れる事例があった)。よって常に POSIX に正規化して返す。
    """
    return path.relative_to(PROJECT_ROOT).as_posix()


def copy_if_missing(source: Path, destination: Path) -> None:
    if source.exists() and not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def ensure_project(project_id: str | None = None) -> ProjectContext:
    ctx = project_context(project_id)
    for directory in [
        ctx.root,
        ctx.root / "scenarios",
        ctx.root / "assets" / "backgrounds",
        ctx.root / "assets" / "audio",
        ctx.root / "assets" / "fonts",
        ctx.root / "assets" / "overlays",
        ctx.root / "assets" / "characters",
        ctx.root / "generated",
        ctx.cache_dir,
        ctx.output_dir,
    ]:
        directory.mkdir(parents=True, exist_ok=True)

    if not ctx.project_file.exists():
        project = {
            "version": 1,
            "id": ctx.id,
            "title": "Default Project" if ctx.id == DEFAULT_PROJECT_ID else ctx.id,
            "currentScenario": "scenarios/main.json",
            "createdAt": datetime.now().isoformat(timespec="seconds"),
            "updatedAt": datetime.now().isoformat(timespec="seconds"),
        }
        with ctx.project_file.open("w", encoding="utf-8") as handle:
            json.dump(project, handle, ensure_ascii=False, indent=2)
    return ctx


def current_project() -> ProjectContext:
    project_id = active_project_id()
    if not project_id:
        raise HTTPException(status_code=404, detail="No active project")
    return ensure_project(project_id)


def read_project_file(ctx: ProjectContext) -> dict[str, Any]:
    """``project.json`` を読む。並列書き込み中の "瞬間 0 バイト" を回避する safety net 付き。

    write_project_file はアトミック (tmp → os.replace) になっているが、別の場所で
    非アトミック書き込みが残っている可能性、および環境によっては replace 直前の
    fsync flush タイミングを衝突する可能性に備えて、JSONDecodeError を最大 3 回
    短時間 retry する。"""
    ensure_project(ctx.id)
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with ctx.project_file.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except (json.JSONDecodeError, ValueError) as exc:
            last_err = exc
            if attempt < 2:
                time.sleep(0.01 * (attempt + 1))
    assert last_err is not None
    raise last_err


def write_project_file(
    ctx: ProjectContext,
    updates: dict[str, Any] | None = None,
    *,
    bump_updated_at: bool = True,
) -> dict[str, Any]:
    """``project.json`` をアトミックに更新する。

    bump_updated_at=False は再生ヘッド保存等の「内容変更ではない軽量メタ更新」用。
    updatedAt はプロジェクト一覧のソート順に効くため、頻繁に書き換えると並びが乱れる。

    並列性: 旧実装は ``open("w")`` で truncate-then-write していて、別 thread の
    ``read_project_file`` がその瞬間に走ると JSONDecodeError ("Expecting value: line 1
    column 1") を起こした (再生中の playhead 連続保存で顕在化)。本実装は tmp に
    書いてから ``os.replace`` で atomic rename する (POSIX / Windows 共に保証)。
    """
    project = read_project_file(ctx)
    if updates:
        project.update(updates)
    if bump_updated_at:
        project["updatedAt"] = datetime.now().isoformat(timespec="seconds")
    target = ctx.project_file
    # 並列 write 衝突を避けるため tmp 名にユニーク suffix (pid + monotonic ns)。
    # 複数スレッドが同時に書きに来ても、別々の tmp に書いて別々に rename する
    # (rename は最終勝者で確定。中間の writer は替わるが、内容はどれも同等の
    # 「最新の project state」なのでデータは欠けない)。
    unique = f".{os.getpid()}.{time.monotonic_ns()}.tmp"
    tmp = target.with_suffix(target.suffix + unique)
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(project, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, target)
    return project


def project_thumbnail_path(ctx: ProjectContext) -> str | None:
    # v2 GL canvas から captureSceneSnapshot('image/png') で保存されたサムネを
    # 最優先。次に旧 webp (= 過去 build で書き出されたまま再保存されていない
    # プロジェクト用の transitional fallback)、最後に legacy preview.png に
    # フォールバック。
    # URL には mtime を ?v= で付与して、no-cache HTTP ヘッダの 304 round-trip
    # を待たずブラウザに新しいファイルを fetch させる (一覧表示は静的 img タグ
    # のため、cache busting がないと書き換え後も古い絵が残ることがある)。
    for name in ("thumbnail.png", "thumbnail.webp", "preview.png"):
        candidate = ctx.cache_dir / name
        if candidate.exists():
            try:
                mtime = int(candidate.stat().st_mtime)
            except OSError:
                mtime = 0
            return f"/project-cache/{ctx.id}/{name}?v={mtime}"
    return None

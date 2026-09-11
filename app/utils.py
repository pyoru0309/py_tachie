"""プロジェクトコンテキスト・ID 操作・パスヘルパー。

ProjectContext は各プロジェクトのファイル位置をまとめた frozen dataclass。
他の app/ モジュールからは「`from .utils import project_context, ProjectContext, ...`」で参照される。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .log_setup import app_logger
from .paths import ACTIVE_PROJECT_PATH, DEFAULT_PROJECT_ID, PROJECT_ROOT, STATE_DIR
from .project_locations import (
    default_projects_dir,
    find_project_location,
    invalidate_project_scan_cache,
    iter_project_files,
    load_locations,
    project_id_exists,
)

_log = app_logger("project")


@dataclass(frozen=True)
class ProjectContext:
    id: str
    root: Path
    project_file: Path
    config_path: Path
    presets_path: Path
    placement_presets_path: Path
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
    """**全保管場所を通じて**衝突しない project_id を返す。

    project_id はディスク上のディレクトリ名であると同時に、URL
    (``/project-cache/<id>/``) やシナリオ内のアセットパス (``projects/<id>/assets/...``)
    のキーでもある。保管場所が複数あっても一意でないと参照が曖昧になるので、
    衝突判定は 1 箇所ではなく全保管場所に対して行う。
    """
    base_id = slugify_project_id(raw_id)
    project_id = base_id
    suffix = 2
    while project_id_exists(project_id):
        project_id = f"{base_id}_{suffix}"
        suffix += 1
    return project_id


def project_context(project_id: str | None = None) -> ProjectContext:
    project_id = slugify_project_id(project_id or active_project_id())
    # 既存プロジェクトなら「どの保管場所の、ディスク上のどの綴りか」を引く
    # (NFD/NFC のブレ吸収 + 外付けディスク等の別保管場所への追従)。
    # 新規作成時は実在しないので slug のまま、既定保管場所の下に置く。
    found = find_project_location(project_id)
    if found is not None:
        _location, project_dir = found
        project_id = project_dir.name
        root = project_dir
    else:
        root = default_projects_dir() / project_id
    return ProjectContext(
        id=project_id,
        root=root,
        project_file=root / "project.json",
        config_path=root / "config.json",
        presets_path=root / "expression_presets.json",
        placement_presets_path=root / "placement_presets.json",
        scenario_path=root / "scenarios" / "main.json",
        manifest_path=root / "generated" / "manifest.json",
        psd_manifest_path=root / "assets" / "character_manifest.json",
        cache_dir=root / "cache",
        output_dir=root / "outputs",
    )


def resolve_project_dir_name(candidate: str) -> str | None:
    """`candidate` が指すプロジェクトの **ディスク上の実フォルダ名** を返す。無ければ None。

    macOS (APFS) はフォルダ名を NFD (基底文字 + 結合濁点) で保持することがある一方、
    `slugify_project_id` は regex を効かせるため NFC へ正規化する。APFS はパス照合が
    normalization-insensitive なので `exists()` は通るが、**返る文字列がディスク上の
    名前と一致しない**。この不一致は
      - `active_project_id() == ctx.id` のような文字列比較
      - 正規化に無頓着な Windows (NTFS) 上での解決
    で表面化する。そこで「存在するなら実名を返す」に寄せる。
    """
    if not candidate:
        return None
    found = find_project_location(candidate)
    return found[1].name if found is not None else None


def fallback_project_id() -> str:
    """アクティブ指定が失われたときに開くプロジェクト。

    **最後に開いたもの (`project.json.lastOpenedAt` が最新)** を選ぶ。旧実装は
    `sorted(glob(...))[0]` = アルファベット順の先頭だったため、まったく関係の無い
    プロジェクトが「アクティブ」として返り、しかも黙って起きるので原因が分からなかった。
    """
    best_name = ""
    best_key = ""
    for project_file in sorted(iter_project_files(), key=lambda p: p.parent.name):
        name = project_file.parent.name
        try:
            with project_file.open("r", encoding="utf-8") as handle:
                opened = str(json.load(handle).get("lastOpenedAt") or "")
        except (OSError, ValueError):
            opened = ""
        # (lastOpenedAt, name) の辞書順最大。lastOpenedAt は ISO8601 なので文字列比較で足りる。
        if not best_name or (opened, name) > (best_key, best_name):
            best_name, best_key = name, opened
    return best_name


def active_project_id() -> str:
    if ACTIVE_PROJECT_PATH.exists():
        text = ACTIVE_PROJECT_PATH.read_text(encoding="utf-8").strip()
        if text:
            resolved = resolve_project_dir_name(slugify_project_id(text))
            if resolved:
                return resolved
            _log.warning(
                "active project %r が見つかりません (%s)。最後に開いたプロジェクトへ切り替えます。"
                " Finder でフォルダ名を変更・移動していないか確認してください。",
                text, ACTIVE_PROJECT_PATH,
            )
        else:
            _log.warning(
                "active project の記録 (%s) が空です。最後に開いたプロジェクトへ切り替えます。",
                ACTIVE_PROJECT_PATH,
            )
    fallback = fallback_project_id()
    if fallback:
        _log.warning("active project fallback -> %r", fallback)
    return fallback


def set_active_project(project_id: str) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    # ディスク上に実在するならその綴りで保存する (NFD/NFC のブレを持ち込まない)。
    if project_id:
        value = resolve_project_dir_name(slugify_project_id(project_id)) or slugify_project_id(project_id)
    else:
        value = ""
    ACTIVE_PROJECT_PATH.write_text(value, encoding="utf-8")


def relative_to_root(path: Path) -> str:
    """PROJECT_ROOT からの相対パスを **POSIX セパレータ** で返す。

    保存される JSON / URL ルーティング / FontFace 登録 (canvas) は全て `/` 区切り前提。
    Windows 上で OS native の ``str(Path)`` を使うとバックスラッシュが入って
    フォント未登録・前景解決失敗・JSON 異種混在を引き起こす (実際 Windows 移行で
    プレビュー描画が崩れる事例があった)。よって常に POSIX に正規化して返す。

    ★ 保管場所が複数ある場合、プロジェクトは PROJECT_ROOT の外 (外付けディスク等) に
      置かれうる。その場合でも **論理パスは従来どおり ``projects/<id>/...``** を返す。
      シナリオ JSON に埋まっているアセットパスや ``/assets/...`` ルートの形を変えずに
      済ませるためで、逆変換は ``resolve_root_rel`` が保管場所を横断して行う。
    """
    try:
        return path.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        pass
    resolved = path.resolve(strict=False)
    for location in load_locations():
        try:
            rel = resolved.relative_to(location.path.resolve(strict=False))
        except ValueError:
            continue
        # <保管場所>/<project_id>/... → projects/<project_id>/...
        return Path("projects").joinpath(rel).as_posix()
    raise ValueError(f"{path!r} is not under PROJECT_ROOT or any project location")


def allowed_asset_roots() -> list[Path]:
    """アセットとして読み書きを許すディレクトリの一覧 (resolve 済み)。

    従来は PROJECT_ROOT だけだったが、プロジェクトの保管場所を複数持てるように
    なったため、**登録済み保管場所も許可範囲に含める**。ここに含まれないパスへの
    アクセスは traversal とみなして拒否する (allowlist 方式は据え置き)。
    """
    roots = [PROJECT_ROOT.resolve()]
    for location in load_locations():
        try:
            resolved = location.path.resolve(strict=False)
        except OSError:
            continue
        if resolved not in roots:
            roots.append(resolved)
    return roots


def is_inside_allowed_roots(path: Path) -> bool:
    """``path`` が PROJECT_ROOT か登録済み保管場所の内側にあるか。"""
    try:
        target = path.resolve(strict=False)
    except OSError:
        return False
    for root in allowed_asset_roots():
        try:
            target.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def resolve_root_rel(rel_path: str | Path) -> Path:
    """``relative_to_root`` の逆。論理相対パスを実ファイルパスへ解決する。

    ``projects/<id>/...`` はプロジェクトの実際の保管場所を引いてから join する。
    それ以外 (``assets/...`` / ``static/...`` など) は従来どおり PROJECT_ROOT 起点。
    存在チェックはしないので、呼び出し側で ``is_file()`` 等を確認すること。
    """
    rel = str(rel_path).replace("\\", "/").lstrip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if len(parts) >= 2 and parts[0] == "projects":
        found = find_project_location(parts[1])
        if found is not None:
            return found[1].joinpath(*parts[2:]) if len(parts) > 2 else found[1]
    return PROJECT_ROOT.joinpath(*parts) if parts else PROJECT_ROOT


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
        # 新しいプロジェクトディレクトリが増えるので、保管場所の索引を落とす。
        # (ディレクトリ mtime でも大抵は外れるが、粒度をすり抜けたときの保険)
        invalidate_project_scan_cache()
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


# project.json 直列化用の per-project Lock。
# Windows では os.replace 中に並列 open() が PermissionError [Errno 13] になる
# ことがある (例: 再生中の playhead 連続保存 + scenario auto-save の並列衝突)。
# プロセス内で「read → write tmp → os.replace」を 1 プロジェクト 1 直列に制約し、
# 衝突窓そのものを潰す。ロックは ctx.id 単位、テナント間は独立。
_project_file_locks: dict[str, threading.Lock] = {}
_project_file_locks_guard = threading.Lock()


def _get_project_file_lock(project_id: str) -> threading.Lock:
    lock = _project_file_locks.get(project_id)
    if lock is not None:
        return lock
    with _project_file_locks_guard:
        lock = _project_file_locks.get(project_id)
        if lock is None:
            lock = threading.Lock()
            _project_file_locks[project_id] = lock
    return lock


def read_project_file(ctx: ProjectContext) -> dict[str, Any]:
    """``project.json`` を読む。並列書き込み中の "瞬間 0 バイト" を回避する safety net 付き。

    write_project_file はアトミック (tmp → os.replace) になっているが、別の場所で
    非アトミック書き込みが残っている可能性、および環境によっては replace 直前の
    fsync flush タイミングを衝突する可能性に備えて、JSONDecodeError を最大 3 回
    短時間 retry する。

    PermissionError も retry する: Windows で os.replace と open() が極短時間
    競合すると Errno 13 を起こす (POSIX は通常踏まないが harmless)。
    """
    ensure_project(ctx.id)
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with ctx.project_file.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except (json.JSONDecodeError, ValueError, PermissionError) as exc:
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
    さらに per-project Lock で read→write→replace の三段を直列化し、Windows での
    PermissionError 競合窓も潰す。
    """
    with _get_project_file_lock(ctx.id):
        project = read_project_file(ctx)
        if updates:
            project.update(updates)
        if bump_updated_at:
            project["updatedAt"] = datetime.now().isoformat(timespec="seconds")
        target = ctx.project_file
        # tmp 名にユニーク suffix (pid + monotonic ns)。同一プロセス内は Lock で
        # 直列化されるが、別プロセス (例: dev で複数 uvicorn 起動) からの並列も
        # ありうるので tmp 衝突自体は防いでおく。
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

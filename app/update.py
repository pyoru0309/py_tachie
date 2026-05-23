"""アプリ内アップデータ (git pull ラッパ).

GUI から「アップデートを確認」「アップデートを適用」できるようにするための薄い
レイヤー。git の知識がないユーザーでも安全に最新版を取得できることを目指す。

設計方針:
- 通常のソフトのアップデータと同じ挙動を目指す ── ユーザーの追加カスタマイズや
  プロジェクトデータを壊さない。
- ``projects/`` ``app_state/`` ``cache/`` ``outputs/`` ``assets/fonts/``
  ``assets/sound_effects/`` ``title_compositions/`` 等は元から ``.gitignore``
  済みなので、git pull で消えない。
- ``assets/backgrounds/`` 等の配布領域に独自素材を入れているユーザーのために、
  「共通アセットを更新する」トグルを用意。デフォルト OFF。OFF の場合は git pull
  実行後に backup から ``assets/`` を復元することで、配布領域は不変に保つ。
- アップデート前にバックアップ ``app_state/backups/update_<timestamp>/`` を取る
  オプション (デフォルト ON)。事故時は手動で戻せる。
- subprocess で git を呼ぶ。git が PATH に無い環境は ``isGitRepo=False`` を返して
  GUI 側で「git をインストールしてください」案内に倒す。

実装上の注意:
- modified/staged な tracked file があると git pull が "uncommitted changes
  prevent merge" で失敗する。事前検出して GUI で「ローカル変更を破棄して
  進める / キャンセル」を選んでもらう。
- untracked file は git pull に影響しない (ユーザーが UI でアップロードした
  ファイルはここに該当)。
"""

from __future__ import annotations

import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from .log_setup import app_logger
from .paths import ASSETS_DIR, PROJECT_ROOT, STATE_DIR

_log = app_logger("update")

_BACKUP_ROOT = STATE_DIR / "backups"


def _git(*args: str, cwd: Path | None = None) -> tuple[int, str, str]:
    """git コマンドを実行して (returncode, stdout, stderr) を返す。

    UTF-8 で decode し、改行は trim 前のまま返す。失敗時は returncode=127 等。
    git 自体が見つからない場合 (PATH に無い) は FileNotFoundError を捕捉して
    returncode=127 + "git not found" を返す。
    """
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd or PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError:
        return 127, "", "git not found"


def is_git_repo() -> bool:
    code, *_ = _git("rev-parse", "--git-dir")
    return code == 0


def _current_branch() -> str | None:
    code, out, _ = _git("rev-parse", "--abbrev-ref", "HEAD")
    return out.strip() if code == 0 else None


def _describe_tag(ref: str) -> str | None:
    code, out, _ = _git("describe", "--tags", "--abbrev=0", ref)
    return out.strip() if code == 0 and out.strip() else None


def _short_sha(ref: str) -> str | None:
    code, out, _ = _git("rev-parse", "--short", ref)
    return out.strip() if code == 0 and out.strip() else None


def _status_porcelain() -> list[tuple[str, str]]:
    """git status --porcelain の結果を [(status, path), ...] で返す。

    status は 2 文字 (例: "??" untracked, " M" modified, "MM" staged+modified)。
    """
    code, out, _ = _git("status", "--porcelain")
    if code != 0:
        return []
    result = []
    for line in out.splitlines():
        if len(line) < 3:
            continue
        status = line[:2]
        # ファイル名は3文字目以降。rename "src -> dst" の場合は dst を取る。
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        result.append((status, path))
    return result


def check_for_updates() -> dict[str, Any]:
    """origin/main を fetch して、HEAD との差分を返す。"""
    if not is_git_repo():
        return {
            "ok": False,
            "isGitRepo": False,
            "message": (
                "git リポジトリではないため自動アップデートできません。"
                "GitHub から ZIP で再ダウンロードしてください。"
            ),
        }

    branch = _current_branch()
    if branch != "main":
        return {
            "ok": False,
            "isGitRepo": True,
            "branch": branch,
            "message": (
                f"現在のブランチは '{branch}' です。"
                "アップデートは main ブランチでのみ動作します。"
            ),
        }

    # origin/main を fetch (取得のみ、マージしない)
    code, _out, err = _git("fetch", "origin", "main")
    if code != 0:
        return {
            "ok": False,
            "isGitRepo": True,
            "message": f"リモートからの取得に失敗しました: {err.strip() or 'unknown error'}",
        }

    # 何 commits 遅れているか
    code, out, _ = _git("rev-list", "--count", "HEAD..origin/main")
    behind = int(out.strip() or 0) if code == 0 else 0

    # 変更ファイル一覧 (origin/main にあって HEAD に無い差分)
    code, out, _ = _git("diff", "--name-only", "HEAD", "origin/main")
    changed_files = [f for f in out.splitlines() if f] if code == 0 else []

    # ローカルの変更
    porcelain = _status_porcelain()
    dirty_modified = [path for status, path in porcelain if not status.startswith("??")]
    dirty_untracked = [path for status, path in porcelain if status.startswith("??")]

    return {
        "ok": True,
        "isGitRepo": True,
        "branch": branch,
        "behind": behind,
        "currentTag": _describe_tag("HEAD"),
        "currentSha": _short_sha("HEAD"),
        "latestTag": _describe_tag("origin/main"),
        "latestSha": _short_sha("origin/main"),
        "changedFiles": changed_files,
        "dirtyModified": dirty_modified,
        "dirtyUntracked": dirty_untracked,
    }


def _make_backup(label: str = "update") -> Path:
    """配布アセット領域とローカル状態をバックアップする。

    対象:
    - assets/ (全部)
    - app_state/ (current_project, ui_state, voice_catalog, global_config 等)

    projects/ はサイズが大きく、ユーザーデータは git pull で影響を受けないため
    バックアップ対象外 (代わりにシナリオ自動 backup が `projects/<id>/backups/`
    に動く)。
    """
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = _BACKUP_ROOT / f"{label}_{ts}"
    backup_dir.mkdir(parents=True, exist_ok=True)

    if ASSETS_DIR.exists():
        shutil.copytree(ASSETS_DIR, backup_dir / "assets", dirs_exist_ok=False)

    # app_state は self-reference を避けるため backups/ を除外する
    if STATE_DIR.exists():
        def _ignore_self(_src: str, names: list[str]) -> list[str]:
            return [n for n in names if n == "backups"]

        shutil.copytree(STATE_DIR, backup_dir / "app_state", ignore=_ignore_self, dirs_exist_ok=False)

    return backup_dir


def _restore_assets_from(snapshot_dir: Path) -> None:
    """snapshot_dir/assets を ASSETS_DIR に復元する (= 配布アセット領域を不変に保つ)。"""
    src = snapshot_dir / "assets"
    if not src.exists():
        return
    if ASSETS_DIR.exists():
        shutil.rmtree(ASSETS_DIR)
    shutil.move(str(src), str(ASSETS_DIR))


def apply_update(
    *,
    include_assets: bool = False,
    backup: bool = True,
    discard_local_changes: bool = False,
) -> dict[str, Any]:
    """git pull を実行してアップデートを適用する。

    Args:
        include_assets: True なら配布アセット (``assets/`` 配下) も最新版に
            上書きする。False (デフォルト) なら git pull 後に backup から
            ``assets/`` を復元して、配布アセット領域を不変に保つ。
        backup: True (デフォルト) なら git pull 前に
            ``app_state/backups/update_<timestamp>/`` にバックアップを取る。
        discard_local_changes: True なら git pull 前に modified/staged な
            tracked file を ``git checkout -- .`` で破棄する。False で dirty
            だと git pull が失敗するので、GUI 側で事前に確認する想定。

    Returns:
        ``{"ok": bool, "message": str, "backupPath": str | None, "log": str}``
    """
    if not is_git_repo():
        return {
            "ok": False,
            "message": "git リポジトリではないためアップデートできません。",
        }

    if _current_branch() != "main":
        return {
            "ok": False,
            "message": "アップデートは main ブランチでのみ動作します。",
        }

    log_lines: list[str] = []

    def _log_step(label: str, result: tuple[int, str, str]) -> None:
        code, out, err = result
        log_lines.append(f"$ {label}")
        if out.strip():
            log_lines.append(out.strip())
        if err.strip():
            log_lines.append(err.strip())
        log_lines.append(f"(exit {code})")

    # 1. dirty check & discard
    porcelain = _status_porcelain()
    has_dirty_tracked = any(not status.startswith("??") for status, _ in porcelain)
    if has_dirty_tracked and not discard_local_changes:
        return {
            "ok": False,
            "message": (
                "ローカルで変更されているファイルがあります。"
                "アップデート前に確認してください。"
            ),
            "dirtyFiles": [path for status, path in porcelain if not status.startswith("??")],
        }
    if has_dirty_tracked and discard_local_changes:
        _log_step("git checkout -- .", _git("checkout", "--", "."))

    # 2. backup
    backup_dir: Path | None = None
    if backup:
        try:
            backup_dir = _make_backup()
            log_lines.append(f"backup created: {backup_dir}")
        except OSError as exc:
            return {
                "ok": False,
                "message": f"バックアップの作成に失敗しました: {exc}",
                "log": "\n".join(log_lines),
            }

    # 3. assets を退避 (include_assets=False のとき)
    assets_snapshot: Path | None = None
    if not include_assets and ASSETS_DIR.exists():
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        assets_snapshot = _BACKUP_ROOT / f"_tmp_assets_{ts}"
        try:
            assets_snapshot.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(ASSETS_DIR, assets_snapshot)
        except OSError as exc:
            return {
                "ok": False,
                "message": f"アセットの一時退避に失敗しました: {exc}",
                "log": "\n".join(log_lines),
            }

    # 4. git pull
    result = _git("pull", "origin", "main")
    _log_step("git pull origin main", result)
    pull_code = result[0]

    # 5. assets を復元 (include_assets=False のとき)
    if assets_snapshot is not None:
        try:
            if ASSETS_DIR.exists():
                shutil.rmtree(ASSETS_DIR)
            shutil.move(str(assets_snapshot), str(ASSETS_DIR))
            log_lines.append("assets/ を更新前の状態に復元しました (include_assets=False)")
        except OSError as exc:
            log_lines.append(f"WARN: アセット復元に失敗: {exc}")

    if pull_code != 0:
        return {
            "ok": False,
            "message": (
                "git pull に失敗しました。バックアップから手動で復旧するか、"
                "サポートに連絡してください。"
            ),
            "backupPath": str(backup_dir) if backup_dir else None,
            "log": "\n".join(log_lines),
        }

    # 6. 適用後の状態
    info = check_for_updates()
    new_sha = info.get("currentSha") if info.get("ok") else None

    return {
        "ok": True,
        "message": "アップデートが完了しました。アプリを再起動してください。",
        "newSha": new_sha,
        "newTag": info.get("currentTag") if info.get("ok") else None,
        "backupPath": str(backup_dir) if backup_dir else None,
        "includeAssets": include_assets,
        "log": "\n".join(log_lines),
    }

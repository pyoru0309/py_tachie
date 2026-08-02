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
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from .log_setup import app_logger
from .paths import ASSETS_DIR, PROJECT_ROOT, STATE_DIR
from .version import __version__ as APP_VERSION

_REQUIREMENTS_PATH = PROJECT_ROOT / "requirements.txt"

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


def _describe_full(ref: str) -> str | None:
    """`git describe --tags` (abbrev 込み, 例 'v1.0-218-gb4f61d2') を返す。"""
    code, out, _ = _git("describe", "--tags", ref)
    return out.strip() if code == 0 and out.strip() else None


def get_current_version() -> dict[str, Any]:
    """ローカルの現在バージョン情報 (R11)。ネットワーク fetch を伴わない軽量版。

    アップデートタブを開いた時点で常時表示するために使う。
    `version` は app/version.py の semver (= 表示用の唯一の真実、例 '0.3.0-dev')。
    `sha` は HEAD の短い git SHA (バグ報告で「どのビルドか」を突き合わせる用)。
    `tag` / `describe` は git タグ由来 (後方互換のため残置。splite_anime の stray な
    `v1.0` タグを拾うので表示には使わない)。
    """
    if not is_git_repo():
        # git が無くてもアプリ自体のバージョンは出せる。
        return {
            "isGitRepo": False,
            "version": APP_VERSION,
            "tag": None,
            "describe": None,
            "sha": None,
            "branch": None,
        }
    return {
        "isGitRepo": True,
        "version": APP_VERSION,
        "tag": _describe_tag("HEAD"),
        "describe": _describe_full("HEAD"),
        "sha": _short_sha("HEAD"),
        "branch": _current_branch(),
    }


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


def _channel_to_branch(channel: str | None) -> str:
    """受信チャネル名 ("stable" / "dev") から git branch 名へ変換。

    "dev" のみ dev branch、それ以外 (None / "stable" / 未知の値) は main にフォールバック。
    """
    c = (channel or "stable").strip().lower()
    return "dev" if c == "dev" else "main"


def check_for_updates(channel: str | None = None) -> dict[str, Any]:
    """origin/<channel に対応する branch> を fetch して、HEAD との差分を返す。

    channel が None のときは "stable" 扱い (= origin/main)。
    現在の local branch と target branch が違う場合は切替が必要な旨を返す。
    """
    if not is_git_repo():
        return {
            "ok": False,
            "isGitRepo": False,
            "message": (
                "git リポジトリではないため自動アップデートできません。"
                "GitHub から ZIP で再ダウンロードしてください。"
            ),
        }

    target_branch = _channel_to_branch(channel)
    current_branch = _current_branch()

    # main / dev 以外の作業ブランチに居る場合はサポート外 (= 開発者が手動で
    # 検証中など)。安全のため拒否。
    if current_branch not in {"main", "dev"}:
        return {
            "ok": False,
            "isGitRepo": True,
            "branch": current_branch,
            "channel": channel or "stable",
            "message": (
                f"現在のブランチは '{current_branch}' です。"
                "アップデートは main / dev ブランチでのみ動作します。"
            ),
        }

    # origin/<target_branch> を fetch
    code, _out, err = _git("fetch", "origin", target_branch)
    if code != 0:
        # dev branch がリモートに無いケース ("couldn't find remote ref dev") は
        # ユーザーに分かりやすく案内する。
        err_msg = (err or "").strip()
        if "couldn't find remote ref" in err_msg or "couldn't find remote" in err_msg:
            return {
                "ok": False,
                "isGitRepo": True,
                "branch": current_branch,
                "channel": channel or "stable",
                "message": (
                    f"リモートに '{target_branch}' ブランチがまだありません。"
                    "もう少し時間を置いてから再度お試しください。"
                ),
            }
        return {
            "ok": False,
            "isGitRepo": True,
            "message": f"リモートからの取得に失敗しました: {err_msg or 'unknown error'}",
        }

    # target が origin/<target_branch>。current が target_branch と同じなら
    # HEAD..origin/<target> で差分を見る。違う branch に居るなら、切替後 + pull
    # で取り込まれる総差分を見せたいので、HEAD..origin/<target> で測ると
    # 「切替分も含めた N commits 増」になる。実用上はこれで十分。
    code, out, _ = _git("rev-list", "--count", f"HEAD..origin/{target_branch}")
    behind = int(out.strip() or 0) if code == 0 else 0

    code, out, _ = _git("diff", "--name-only", "HEAD", f"origin/{target_branch}")
    changed_files = [f for f in out.splitlines() if f] if code == 0 else []

    # ローカルの変更
    porcelain = _status_porcelain()
    dirty_modified = [path for status, path in porcelain if not status.startswith("??")]
    dirty_untracked = [path for status, path in porcelain if status.startswith("??")]

    needs_switch = current_branch != target_branch

    return {
        "ok": True,
        "isGitRepo": True,
        "branch": current_branch,
        "targetBranch": target_branch,
        "channel": "dev" if target_branch == "dev" else "stable",
        "needsBranchSwitch": needs_switch,
        "behind": behind,
        "currentTag": _describe_tag("HEAD"),
        "currentSha": _short_sha("HEAD"),
        "latestTag": _describe_tag(f"origin/{target_branch}"),
        "latestSha": _short_sha(f"origin/{target_branch}"),
        "changedFiles": changed_files,
        "dirtyModified": dirty_modified,
        "dirtyUntracked": dirty_untracked,
    }


def _reinstall_dependencies() -> tuple[int, str, str]:
    """``pip install -r requirements.txt`` を現在の Python で実行する。

    requirements.txt がアップデートで増減・更新されたときに依存を追従させるための
    任意ステップ。``websockets`` 等の C 拡張付きパッケージで、実行中の Python 用の
    新しい wheel が公開されていれば、これで高速版 (speedups) を取り込める可能性が
    ある。ただし Python のバージョン自体は変えられないので、3.14 で wheel が無い等の
    ケースは解消しない (その場合は Python 3.12/3.13 への切替を案内する)。

    ``sys.executable -m pip`` を使い、アプリを起動しているのと同一の Python /
    venv に対してインストールする。git の subprocess と同じく UTF-8 固定で decode
    する (Windows の cp932 環境で UnicodeDecodeError を避けるため)。
    """
    if not _REQUIREMENTS_PATH.exists():
        return 1, "", f"requirements.txt が見つかりません: {_REQUIREMENTS_PATH}"
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-r", str(_REQUIREMENTS_PATH)],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError:
        return 127, "", "pip not found"
    except subprocess.TimeoutExpired:
        return 124, "", "pip install がタイムアウトしました (600 秒)"


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
    channel: str | None = None,
    include_assets: bool = False,
    backup: bool = True,
    discard_local_changes: bool = False,
    reinstall_deps: bool = False,
) -> dict[str, Any]:
    """git pull を実行してアップデートを適用する。

    Args:
        channel: 受信チャネル ("stable" or "dev")。None なら "stable"。
            target branch がローカルに無ければ origin から checkout して作成、
            現在 branch と違う場合は switch してから pull する。
        include_assets: True なら配布アセット (``assets/`` 配下) も最新版に
            上書きする。False (デフォルト) なら git pull 後に backup から
            ``assets/`` を復元して、配布アセット領域を不変に保つ。
        backup: True (デフォルト) なら git pull 前に
            ``app_state/backups/update_<timestamp>/`` にバックアップを取る。
        discard_local_changes: True なら git pull 前に modified/staged な
            tracked file を ``git checkout -- .`` で破棄する。False で dirty
            だと git pull が失敗するので、GUI 側で事前に確認する想定。
        reinstall_deps: True なら適用後に ``pip install -r requirements.txt`` を
            実行して依存パッケージを追従させる。requirements.txt が更新された
            アップデートで必要になる。失敗してもコード更新自体は成功扱いにし、
            ``depsReinstalled`` / ``depsMessage`` で結果を返す。

    Returns:
        ``{"ok": bool, "message": str, "backupPath": str | None, "log": str}``
    """
    if not is_git_repo():
        return {
            "ok": False,
            "message": "git リポジトリではないためアップデートできません。",
        }

    target_branch = _channel_to_branch(channel)
    current_branch = _current_branch()
    if current_branch not in {"main", "dev"}:
        return {
            "ok": False,
            "message": (
                f"現在のブランチは '{current_branch}' です。"
                "アップデートは main / dev ブランチでのみ動作します。"
            ),
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

    # 4. fetch → branch 切替 (無ければ作成) → reset --hard で origin に完全一致させる。
    #    旧実装は `git checkout <branch>` + `git pull` (merge) だったが、作業ツリーが
    #    dirty / 分岐していると merge が中途半端に終わり、「config.py は新しいのに
    #    font_inspect.py が欠落」のような壊れたツリーを残して起動不能になる事故が出た
    #    (2026-06-02, Windows)。リリース配信は「常にリモートと完全一致」が正しいので、
    #    merge ではなく hard reset を使う。これにより欠損した tracked file も確実に
    #    復元され、中途半端な状態が残らない。gitignore 済みの projects/ app_state/
    #    cache/ outputs/ や未追跡ファイルは reset --hard では消えない。
    _log_step(f"git fetch origin {target_branch}", _git("fetch", "origin", target_branch))
    # ローカル branch が無い場合は origin から作成、ある場合は force checkout で切替。
    local_exists_code, _, _ = _git("show-ref", "--verify", "--quiet", f"refs/heads/{target_branch}")
    if local_exists_code == 0:
        switch_result = _git("checkout", "-f", target_branch)
    else:
        switch_result = _git("checkout", "-b", target_branch, f"origin/{target_branch}")
    _log_step(f"git checkout -f {target_branch}", switch_result)
    if switch_result[0] != 0:
        return {
            "ok": False,
            "message": (
                f"ブランチ '{target_branch}' への切替に失敗しました。"
            ),
            "backupPath": str(backup_dir) if backup_dir else None,
            "log": "\n".join(log_lines),
        }

    # 5. origin/<branch> に working tree + index を完全一致させる (= 適用)
    reset_result = _git("reset", "--hard", f"origin/{target_branch}")
    _log_step(f"git reset --hard origin/{target_branch}", reset_result)
    pull_code = reset_result[0]

    # 6. assets を復元 (include_assets=False のとき)
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
                "アップデートの適用 (git reset --hard) に失敗しました。"
                "バックアップから手動で復旧するか、サポートに連絡してください。"
            ),
            "backupPath": str(backup_dir) if backup_dir else None,
            "log": "\n".join(log_lines),
        }

    # 7. 依存パッケージの再インストール (任意)。コード適用後に requirements.txt が
    #    変わっているケースに追従する。失敗してもコード更新自体は成功扱いにする
    #    (起動はできるため)。
    deps_reinstalled = False
    deps_message = ""
    if reinstall_deps:
        dep_code, dep_out, dep_err = _reinstall_dependencies()
        _log_step("pip install -r requirements.txt", (dep_code, dep_out, dep_err))
        if dep_code == 0:
            deps_reinstalled = True
            deps_message = "依存パッケージを再インストールしました。"
        else:
            deps_message = (
                "依存パッケージの再インストールに失敗しました "
                f"(exit {dep_code})。手動で `pip install -r requirements.txt` を"
                "実行してください。コードの更新自体は完了しています。"
            )

    # 8. 適用後の状態
    info = check_for_updates(channel=channel)
    new_sha = info.get("currentSha") if info.get("ok") else None

    base_message = "アップデートが完了しました。アプリを再起動してください。"
    message = f"{base_message} {deps_message}".strip() if deps_message else base_message

    return {
        "ok": True,
        "message": message,
        "newSha": new_sha,
        "newTag": info.get("currentTag") if info.get("ok") else None,
        "backupPath": str(backup_dir) if backup_dir else None,
        "channel": "dev" if target_branch == "dev" else "stable",
        "branch": target_branch,
        "includeAssets": include_assets,
        "depsReinstalled": deps_reinstalled,
        "depsMessage": deps_message,
        "log": "\n".join(log_lines),
    }

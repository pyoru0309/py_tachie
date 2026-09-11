"""プロジェクトの**保管場所 (storage location)** 解決。

背景
----
従来はプロジェクトの置き場所が 1 つ (``global_config.projectsPath``、未設定なら同梱の
``projects/``) しかなかった。外付けディスクへ「完成品をアーカイブとして寄せつつ、一覧
画面からは今までどおり見えるようにしたい」という要求に応えるため、**複数の保管場所を
登録できる**ようにする。

モデル
------
- 保管場所は ``Location(id, name, path, builtin)``。
- 先頭は必ず組み込み (``id="builtin"``)。パスは従来の ``projectsPath`` (未設定なら同梱
  ``projects/``) なので、**旧設定はそのまま組み込み保管場所として生き続ける**。
- 追加ぶんは ``global_config.projectLocations`` に ``[{id, name, path}]`` で持つ。
- 新規プロジェクト / ZIP 取り込みの保存先は ``defaultProjectLocationId``。

ID (= ディレクトリ名) の一意性
------------------------------
プロジェクト ID はディスク上のディレクトリ名そのもので、URL (``/project-cache/<id>/``)
やシナリオ内のアセットパス (``projects/<id>/assets/...``) に埋まっている。保管場所を
増やしても **ID は全保管場所を通じて一意** という前提を保つ:

- 移動 / 複製 / 取り込みでは、全保管場所を見て衝突しない ID を割り当てる。
- それでも Finder で手動コピーされる等で重複しうるので、走査は「登録順で先勝ち」。
  後続の重複は ``duplicate_project_ids()`` で報告し、UI から気付けるようにする
  (黙って消えるのが一番まずい)。

可用性
------
外付けディスクは外れる。``Location.available`` は「パスが今ディレクトリとして見える
か」だけを表し、見えない保管場所は走査から外れる (エラーにはしない)。設定からは消え
ないので、挿し直せば戻る。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from . import global_config as _global_config
from .global_config import current_projects_dir, load_global_config
from .paths import DEFAULT_PROJECTS_DIR

BUILTIN_LOCATION_ID = "builtin"
# 「既定 (= 新規プロジェクトの保存先)」は付け替えられる属性なので、名前には含めない。
# 名前に入れると、既定を外付けへ移したときに「アプリ内 (既定)」が既定でなくなる、
# 選択肢が「アプリ内 (既定)（既定）」と二重になる、といった食い違いが出る。
BUILTIN_LOCATION_NAME = "アプリ内"


@dataclass(frozen=True)
class Location:
    id: str
    name: str
    path: Path
    builtin: bool = False

    @property
    def available(self) -> bool:
        try:
            return self.path.is_dir()
        except OSError:
            return False

    def to_dict(self, *, default_id: str = "") -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "path": str(self.path),
            "builtin": self.builtin,
            "available": self.available,
            "isDefault": self.id == (default_id or BUILTIN_LOCATION_ID),
        }


def slugify_location_id(value: str) -> str:
    normalized = unicodedata.normalize("NFC", (value or "").strip())
    slug = re.sub(r"[^\w-]+", "_", normalized, flags=re.UNICODE).strip("_").lower()
    return slug[:48] or "location"


def _builtin_location() -> Location:
    path = current_projects_dir()
    # 同梱 projects/ はアプリ自身のディレクトリなので、無ければ作っておく。
    # これが無いと **新規インストール直後 (= まだ 1 件も作っていない状態)** に
    # 組み込み保管場所が available=False になり、一覧に「未接続の保管場所があります」
    # という的外れな警告が出る。projectsPath で外部を指しているときは触らない
    # (外付けが未接続なら「未接続」と出るのが正しい)。
    if path == DEFAULT_PROJECTS_DIR and not path.exists():
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
    # projectsPath で同梱 projects/ 以外へ移していれば、その場所の名前を出したほうが
    # 分かりやすい (「アプリ内」ではないため)。
    # projectsPath で同梱 projects/ 以外へ移していれば、そのフォルダ名を出す
    # (「アプリ内」ではないため)。組み込みかどうかは builtin フラグで分かる。
    name = BUILTIN_LOCATION_NAME if path == DEFAULT_PROJECTS_DIR else path.name
    return Location(id=BUILTIN_LOCATION_ID, name=name, path=path, builtin=True)


# ---------------------------------------------------------------------------
# キャッシュ
# ---------------------------------------------------------------------------
# 保管場所の解決はホットパスに乗る: `utils.resolve_root_rel()` が素材 1 件ごとに
# `projects/<id>/...` を実パスへ引き直すため、素材スキャンや scene-bundle 組み立てでは
# 数百〜数千回呼ばれる。毎回 global_config を読んで各保管場所を glob すると
# 1 件あたり 0.6ms 級のコストになり、スキャンが目に見えて遅くなる。
#
# そこで 2 段でメモ化する。どちらも「変化したら自動で外れる」キーを使う:
#   - 保管場所リスト: global_config.json の (mtime_ns, size)
#   - プロジェクト索引: 上記 + 各保管場所ディレクトリの mtime_ns
#     (ディレクトリ mtime は直下のエントリ増減で必ず変わる)
# mtime の粒度をすり抜けるケースに備えて、変更系 API は
# `invalidate_project_scan_cache()` で明示的に落とす。
_locations_cache: tuple[tuple, list["Location"]] | None = None
_index_cache: tuple[tuple, dict[str, tuple["Location", Path]], list[tuple["Location", Path]]] | None = None


def _config_signature() -> tuple:
    # モジュール属性経由で参照する (テストが global_config.GLOBAL_CONFIG_PATH を
    # 差し替えるため、from-import で束縛すると効かない)。
    try:
        stat = _global_config.GLOBAL_CONFIG_PATH.stat()
    except OSError:
        return (0, 0)
    return (stat.st_mtime_ns, stat.st_size)


def _dir_mtime(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


def invalidate_project_scan_cache() -> None:
    """保管場所・プロジェクト索引のメモ化を落とす。プロジェクトを作る / 移す /
    消す / 保管場所設定を書き換えた直後に呼ぶ。"""
    global _locations_cache, _index_cache
    _locations_cache = None
    _index_cache = None


def _project_index(config: dict | None = None) -> tuple[dict[str, tuple["Location", Path]], list[tuple["Location", Path]]]:
    """(NFC 名 → (保管場所, ディレクトリ), 走査順のリスト) を返す。登録順で先勝ち。"""
    global _index_cache
    locations = load_locations(config)
    cacheable = config is None
    key = tuple((loc.id, str(loc.path), _dir_mtime(loc.path)) for loc in locations)
    if cacheable and _index_cache is not None and _index_cache[0] == key:
        return _index_cache[1], _index_cache[2]
    index: dict[str, tuple[Location, Path]] = {}
    ordered: list[tuple[Location, Path]] = []
    for loc in locations:
        if not loc.available:
            continue
        try:
            project_files = sorted(loc.path.glob("*/project.json"))
        except OSError:
            continue
        for project_file in project_files:
            project_dir = project_file.parent
            nfc = unicodedata.normalize("NFC", project_dir.name)
            if nfc in index:
                continue  # 別の保管場所に同名あり → 登録順で先勝ち
            index[nfc] = (loc, project_dir)
            ordered.append((loc, project_dir))
    if cacheable:
        _index_cache = (key, index, ordered)
    return index, ordered


def load_locations(config: dict | None = None) -> list[Location]:
    """登録済みの保管場所を、組み込みを先頭にした登録順で返す。"""
    global _locations_cache
    if config is None:
        signature = _config_signature()
        if _locations_cache is not None and _locations_cache[0] == signature:
            return _locations_cache[1]
        built = _build_locations(load_global_config())
        _locations_cache = (signature, built)
        return built
    return _build_locations(config)


def _build_locations(config: dict) -> list[Location]:
    locations = [_builtin_location()]
    seen_ids = {BUILTIN_LOCATION_ID}
    seen_paths = {locations[0].path.resolve(strict=False)}
    raw = config.get("projectLocations")
    if not isinstance(raw, list):
        return locations
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        raw_path = str(entry.get("path") or "").strip()
        if not raw_path:
            continue
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            continue
        resolved = path.resolve(strict=False)
        if resolved in seen_paths:
            # 組み込みと同じ場所を二重登録しても意味が無い (同じプロジェクトが
            # 2 度出るだけ)。
            continue
        loc_id = slugify_location_id(str(entry.get("id") or "") or path.name)
        while loc_id in seen_ids:
            loc_id = f"{loc_id}_2"
        name = str(entry.get("name") or "").strip() or path.name
        seen_ids.add(loc_id)
        seen_paths.add(resolved)
        locations.append(Location(id=loc_id, name=name, path=path))
    return locations


def default_location_id(config: dict | None = None) -> str:
    config = config if config is not None else load_global_config()
    wanted = str(config.get("defaultProjectLocationId") or "").strip()
    known = {loc.id for loc in load_locations(config)}
    return wanted if wanted in known else BUILTIN_LOCATION_ID


def location_by_id(location_id: str, config: dict | None = None) -> Location | None:
    target = (location_id or "").strip() or BUILTIN_LOCATION_ID
    for loc in load_locations(config):
        if loc.id == target:
            return loc
    return None


def default_location(config: dict | None = None) -> Location:
    config = config if config is not None else load_global_config()
    return location_by_id(default_location_id(config), config) or _builtin_location()


def default_projects_dir() -> Path:
    """新規プロジェクト / ZIP 取り込みの保存先ディレクトリ。

    既定保管場所が外れている (外付けディスク未接続など) ときは、黙って別の場所へ
    作られるより組み込みへ倒したほうが事故が少ない。
    """
    loc = default_location()
    if loc.available or loc.builtin:
        return loc.path
    return current_projects_dir()


def iter_project_dirs(config: dict | None = None) -> Iterator[tuple[Location, Path]]:
    """全保管場所の ``<location>/<id>/project.json`` を (保管場所, プロジェクト dir) で yield。

    ID (= ディレクトリ名) は登録順で先勝ち。重複ぶんはここでは出さない
    (``duplicate_project_ids`` が別途報告する)。
    """
    _index, ordered = _project_index(config)
    yield from ordered


def iter_project_files(config: dict | None = None) -> Iterator[Path]:
    """``iter_project_dirs`` の project.json 版 (旧 glob 呼び出しの置き換え用)。"""
    for _loc, project_dir in iter_project_dirs(config):
        yield project_dir / "project.json"


def duplicate_project_ids(config: dict | None = None) -> list[dict[str, object]]:
    """同じ ID が複数の保管場所にある場合の一覧を返す (UI 警告用)。"""
    by_key: dict[str, list[tuple[Location, str]]] = {}
    for loc in load_locations(config):
        if not loc.available:
            continue
        try:
            project_files = sorted(loc.path.glob("*/project.json"))
        except OSError:
            continue
        for project_file in project_files:
            name = project_file.parent.name
            by_key.setdefault(unicodedata.normalize("NFC", name), []).append((loc, name))
    out: list[dict[str, object]] = []
    for key, items in sorted(by_key.items()):
        if len(items) < 2:
            continue
        out.append({
            "id": key,
            "usedLocationId": items[0][0].id,
            "locations": [{"id": loc.id, "name": loc.name, "path": str(loc.path)} for loc, _ in items],
        })
    return out


def find_project_location(project_id: str, config: dict | None = None) -> tuple[Location, Path] | None:
    """プロジェクト ID から (保管場所, ディスク上の実ディレクトリ) を引く。

    NFD/NFC のブレを吸収するため、直接 join だけでなく NFC 比較の総当たりも通す
    (macOS は正規化非依存で ``exists()`` が通ってしまい、返る文字列がディスク上の
    名前と一致しない)。
    """
    if not project_id:
        return None
    index, _ordered = _project_index(config)
    return index.get(unicodedata.normalize("NFC", project_id))


def project_id_exists(project_id: str, config: dict | None = None) -> bool:
    return find_project_location(project_id, config) is not None


def unique_project_id_across_locations(base_id: str, config: dict | None = None) -> str:
    """全保管場所を通じて衝突しない ID を返す。"""
    config = config if config is not None else load_global_config()
    candidate = base_id
    suffix = 2
    while project_id_exists(candidate, config):
        candidate = f"{base_id}_{suffix}"
        suffix += 1
    return candidate


__all__ = [
    "BUILTIN_LOCATION_ID",
    "Location",
    "default_location",
    "default_location_id",
    "default_projects_dir",
    "duplicate_project_ids",
    "find_project_location",
    "invalidate_project_scan_cache",
    "iter_project_dirs",
    "iter_project_files",
    "load_locations",
    "location_by_id",
    "project_id_exists",
    "slugify_location_id",
    "unique_project_id_across_locations",
]

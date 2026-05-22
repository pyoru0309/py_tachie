"""タイトル組版 (Title Composition) — /title-editor 専用の組版データ管理。

設計:
    - プロジェクト非依存。PROJECT_ROOT/title_compositions/<id>.json に保存される。
    - 編集中の状態はクライアント側だけが持つ。サーバ側は CRUD だけ。
    - 1 つの composition は { id, name, width, height, background, clips, updatedAt }。
    - clips は scenario の telops と互換のスキーマ (= TextClip)。既存 _normalize_telop を流用。
    - サーバ側で PNG を焼く処理は持たない (= MVP)。クライアントが canvas.toBlob で書き出す。

非対応 (= MVP スコープ外):
    - 動画書き出し / renderCache / プロジェクトへの自動配置
    - シーンへの貼り付け参照 (sceneTextCompositions[])
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .log_setup import app_logger
from .paths import TITLE_COMPOSITIONS_DIR
from .scenario import _normalize_telop

_log = app_logger("title_compositions")

# ファイル名として安全な ID。ascii 英数 + アンダーバー + ハイフンのみ許容。
_SLUG_RE = re.compile(r"[^A-Za-z0-9_\-]")


def _ensure_dir() -> Path:
    TITLE_COMPOSITIONS_DIR.mkdir(parents=True, exist_ok=True)
    return TITLE_COMPOSITIONS_DIR


def _new_id(_name: str) -> str:
    """内部 ID は `comp_<8文字>` 固定で十分。ユーザーには name で見せるので、
    id は URL safe であれば slug 由来である必要はない。日本語名 → 全部 `_` に
    なって判別性のない slug ができる事故も避けられる。"""
    return f"comp_{uuid.uuid4().hex[:8]}"


def _validate_id(comp_id: str) -> str:
    """API から受け取る id を ascii + アンダーバー + ハイフンに制限し、パス traversal を防ぐ。"""
    s = str(comp_id or "").strip()
    if not s or _SLUG_RE.sub("", s) != s:
        raise ValueError(f"invalid composition id: {comp_id!r}")
    return s


def _path_for(comp_id: str) -> Path:
    _ensure_dir()
    return TITLE_COMPOSITIONS_DIR / f"{_validate_id(comp_id)}.json"


def _normalize_background(raw: Any) -> dict[str, Any]:
    """background = { color, transparent }。プレビュー時の下地と PNG 書き出しの背景を兼ねる。
    透明 PNG にしたいときは transparent=True、画面背景を見せたいときは color を使う。"""
    if not isinstance(raw, dict):
        raw = {}
    color = raw.get("color")
    if not isinstance(color, str) or not color:
        color = "#1e1e1e"     # プレビュー時に「タイトルが見えやすい中間グレー」既定
    transparent = bool(raw.get("transparent", False))
    return {"color": color, "transparent": transparent}


def normalize_composition(raw: Any) -> dict[str, Any]:
    """ディスク or リクエストの dict を厳密形に正規化する。clips は _normalize_telop を流用。"""
    if not isinstance(raw, dict):
        raw = {}
    comp_id = raw.get("id")
    name = str(raw.get("name") or "").strip() or "未命名タイトル"
    if not comp_id:
        comp_id = _new_id(name)
    else:
        comp_id = _validate_id(comp_id)
    width = int(raw.get("width") or 1920)
    height = int(raw.get("height") or 1080)
    if width <= 0 or width > 8192:
        width = 1920
    if height <= 0 or height > 8192:
        height = 1080
    background = _normalize_background(raw.get("background"))
    clips_raw = raw.get("clips") if isinstance(raw.get("clips"), list) else []
    clips: list[dict[str, Any]] = []
    for i, clip in enumerate(clips_raw):
        if isinstance(clip, dict):
            clips.append(_normalize_telop(clip, i))
    updated_at = str(raw.get("updatedAt") or "") or datetime.now(timezone.utc).isoformat()
    return {
        "id": comp_id,
        "name": name,
        "width": width,
        "height": height,
        "background": background,
        "clips": clips,
        "updatedAt": updated_at,
    }


def list_compositions() -> list[dict[str, Any]]:
    """一覧 API 用に、各 composition の {id, name, updatedAt, clipCount} だけを返す軽量サマリ。"""
    _ensure_dir()
    out: list[dict[str, Any]] = []
    for path in sorted(TITLE_COMPOSITIONS_DIR.glob("*.json")):
        try:
            with path.open("r", encoding="utf-8") as fp:
                data = json.load(fp)
            comp = normalize_composition(data)
            out.append({
                "id": comp["id"],
                "name": comp["name"],
                "updatedAt": comp["updatedAt"],
                "clipCount": len(comp["clips"]),
            })
        except Exception as exc:
            # 壊れた JSON は一覧から除外。原因はログに残す。
            _log.warning("skip %s: %s", path, exc)
            continue
    # 更新時刻降順
    out.sort(key=lambda c: c.get("updatedAt", ""), reverse=True)
    return out


def get_composition(comp_id: str) -> dict[str, Any] | None:
    path = _path_for(comp_id)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as fp:
        data = json.load(fp)
    return normalize_composition(data)


def create_composition(payload: Any) -> dict[str, Any]:
    """新規 composition を作る。id 衝突時は uuid 接尾辞で回避する。"""
    norm = normalize_composition(payload)
    # 衝突回避: 既存ファイルがある間は接尾辞を再生成。
    while _path_for(norm["id"]).exists():
        norm["id"] = _new_id(norm["name"])
    norm["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _write(norm)
    return norm


def update_composition(comp_id: str, payload: Any) -> dict[str, Any]:
    """既存 composition の上書き更新。id は URL 側を優先する。"""
    norm = normalize_composition(payload)
    norm["id"] = _validate_id(comp_id)
    norm["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _write(norm)
    return norm


def delete_composition(comp_id: str) -> bool:
    path = _path_for(comp_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def _write(norm: dict[str, Any]) -> None:
    path = _path_for(norm["id"])
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fp:
        json.dump(norm, fp, ensure_ascii=False, indent=2)
    tmp.replace(path)

"""three.js / mp4box.js を ``static/vendor/`` 以下にローカルインストールする。

設計指針 (CLAUDE.md / project_v2_vendor_local_assets.md より)::

    static/vendor/
      three/
        0.165.0/build/three.module.js
        0.165.0/examples/jsm/...
      mp4box/
        0.5.2/mp4box.module.js
      active.json   # 現行 version の indirection

importmap は HTML 配信時にサーバが動的注入する (``app.vendor.resolve_importmap``)。
``vendor.useCdn=True`` もしくは active 未設定/物理欠落の時は CDN にフォールバック。

three.js について:
- core (``three``) と addons (``three/addons/``) は ``examples/jsm/`` を含めて
  npm tarball を丸ごと落として展開。少容量より「事故防止」優先。

mp4box.js について:
- npm 公式パッケージは UMD のみで native ESM が無いため、jsdelivr の ``+esm``
  変換版 (依存内蔵の単一 ESM bundle) をそのまま vendor 化する。
"""

from __future__ import annotations

import io
import json
import shutil
import tarfile
from pathlib import Path
from typing import Any

from .paths import STATIC_DIR


VENDOR_ROOT = STATIC_DIR / "vendor"
VENDOR_ACTIVE_PATH = VENDOR_ROOT / "active.json"

NPM_REGISTRY = "https://registry.npmjs.org"
JSDELIVR_NPM = "https://cdn.jsdelivr.net/npm"

SUPPORTED_LIBS: tuple[str, ...] = ("three", "mp4box")

# 推奨 (=動作確認済み) version。UI の「インストール」ボタンの既定値になる。
RECOMMENDED_VERSIONS: dict[str, str] = {
    "three": "0.165.0",
    "mp4box": "0.5.2",
}

# CDN フォールバック URL。useCdn=True もしくは local 不在時に使用。
CDN_FALLBACK: dict[str, dict[str, str]] = {
    "three": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/",
    },
    "mp4box": {
        "mp4box": "https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm",
    },
}


# ---------------------------------------------------------------------------
# active marker
# ---------------------------------------------------------------------------


def _load_active() -> dict[str, str]:
    if not VENDOR_ACTIVE_PATH.exists():
        return {}
    try:
        data = json.loads(VENDOR_ACTIVE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(v, str) and v}


def _save_active(active: dict[str, str]) -> None:
    VENDOR_ROOT.mkdir(parents=True, exist_ok=True)
    VENDOR_ACTIVE_PATH.write_text(
        json.dumps(active, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def installed_versions(lib: str) -> list[str]:
    base = VENDOR_ROOT / lib
    if not base.exists():
        return []
    versions: list[str] = []
    for entry in sorted(base.iterdir()):
        if entry.is_dir() and entry.name not in {"active"}:
            versions.append(entry.name)
    return versions


def vendor_state() -> dict[str, Any]:
    active = _load_active()
    libs: dict[str, dict[str, Any]] = {}
    for lib in SUPPORTED_LIBS:
        active_version = active.get(lib, "")
        installed = installed_versions(lib)
        libs[lib] = {
            "active": active_version,
            "installed": installed,
            "recommended": RECOMMENDED_VERSIONS.get(lib, ""),
            "cdn": CDN_FALLBACK.get(lib, {}),
        }
    return {"libs": libs}


def resolve_importmap(use_cdn: bool) -> dict[str, str]:
    """importmap.imports を組み立てる。

    - ``use_cdn=True``: 全部 CDN URL。
    - ``use_cdn=False``: active marker 上の version が物理的に存在すれば
      ``/static/vendor/{lib}/{version}/...`` を、無ければ CDN を返す。
    """
    imports: dict[str, str] = {}
    active = {} if use_cdn else _load_active()

    for lib in SUPPORTED_LIBS:
        version = active.get(lib, "") if not use_cdn else ""
        local_dir = VENDOR_ROOT / lib / version if version else None
        local_ok = bool(version and local_dir and local_dir.exists())

        if lib == "three":
            main = local_dir / "build" / "three.module.js" if local_dir else None
            if local_ok and main and main.exists():
                imports["three"] = f"/static/vendor/three/{version}/build/three.module.js"
                imports["three/addons/"] = f"/static/vendor/three/{version}/examples/jsm/"
            else:
                imports.update(CDN_FALLBACK["three"])
        elif lib == "mp4box":
            main = local_dir / "mp4box.module.js" if local_dir else None
            if local_ok and main and main.exists():
                imports["mp4box"] = f"/static/vendor/mp4box/{version}/mp4box.module.js"
            else:
                imports.update(CDN_FALLBACK["mp4box"])
    return imports


# ---------------------------------------------------------------------------
# install / remove
# ---------------------------------------------------------------------------


def _httpx_client():
    import httpx

    return httpx.Client(timeout=120.0, follow_redirects=True)


def _validate_version(version: str) -> None:
    if not version or "/" in version or version.startswith(".") or len(version) > 64:
        raise ValueError(f"無効な version です: {version!r}")


def _fetch_npm_tarball(pkg: str, version: str) -> bytes:
    with _httpx_client() as client:
        meta_url = f"{NPM_REGISTRY}/{pkg}/{version}"
        meta_resp = client.get(meta_url)
        if meta_resp.status_code == 404:
            raise RuntimeError(f"npm に {pkg}@{version} が見つかりません")
        meta_resp.raise_for_status()
        meta = meta_resp.json()
        tarball_url = ((meta.get("dist") or {}).get("tarball") or "").strip()
        if not tarball_url:
            raise RuntimeError(f"npm registry に tarball URL がありません: {pkg}@{version}")
        tar_resp = client.get(tarball_url)
        tar_resp.raise_for_status()
        return tar_resp.content


def _extract_three(version: str) -> Path:
    target = VENDOR_ROOT / "three" / version
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)

    tarball = _fetch_npm_tarball("three", version)
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as tar:
        for member in tar.getmembers():
            name = member.name
            if not name.startswith("package/"):
                continue
            relative = name[len("package/") :]
            # build/three.module.js と examples/jsm/ 全部を残す。
            keep = relative == "build/three.module.js" or relative.startswith(
                "examples/jsm/"
            )
            if not keep:
                continue
            out_path = target / relative
            if member.isdir():
                out_path.mkdir(parents=True, exist_ok=True)
                continue
            if member.issym() or member.islnk():
                continue
            out_path.parent.mkdir(parents=True, exist_ok=True)
            extracted = tar.extractfile(member)
            if extracted is None:
                continue
            out_path.write_bytes(extracted.read())

    main = target / "build" / "three.module.js"
    if not main.exists():
        raise RuntimeError(
            f"three@{version}: tarball に build/three.module.js がありません"
        )
    return target


def _extract_mp4box(version: str) -> Path:
    target = VENDOR_ROOT / "mp4box" / version
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)

    with _httpx_client() as client:
        url = f"{JSDELIVR_NPM}/mp4box@{version}/+esm"
        resp = client.get(url)
        resp.raise_for_status()
        body = resp.text
    if "createFile" not in body and "MP4Box" not in body:
        raise RuntimeError(
            f"mp4box@{version}: ESM bundle に MP4Box / createFile シンボルが見当たりません"
        )
    (target / "mp4box.module.js").write_text(body, encoding="utf-8")
    return target


def install_lib(lib: str, version: str) -> dict[str, Any]:
    if lib not in SUPPORTED_LIBS:
        raise ValueError(f"未対応のライブラリです: {lib}")
    _validate_version(version)

    if lib == "three":
        target = _extract_three(version)
    elif lib == "mp4box":
        target = _extract_mp4box(version)
    else:
        raise ValueError(lib)

    active = _load_active()
    active[lib] = version
    _save_active(active)
    smoke = smoke_test(lib, version)
    return {
        "lib": lib,
        "version": version,
        "path": str(target.relative_to(STATIC_DIR.parent)),
        "smoke": smoke,
    }


def remove_lib(lib: str, version: str) -> None:
    if lib not in SUPPORTED_LIBS:
        raise ValueError(lib)
    _validate_version(version)
    target = VENDOR_ROOT / lib / version
    if target.exists():
        shutil.rmtree(target)
    active = _load_active()
    if active.get(lib) == version:
        active.pop(lib, None)
        _save_active(active)


def set_active(lib: str, version: str) -> None:
    if lib not in SUPPORTED_LIBS:
        raise ValueError(lib)
    if version:
        _validate_version(version)
        if not (VENDOR_ROOT / lib / version).exists():
            raise ValueError(f"{lib}@{version} がインストールされていません")
    active = _load_active()
    if version:
        active[lib] = version
    else:
        active.pop(lib, None)
    _save_active(active)


def smoke_test(lib: str, version: str) -> dict[str, Any]:
    """簡易 sanity check (ファイル存在 + 最小マーカー文字列の grep)。

    本格的な runtime smoke test (THREE.REVISION 確認 / addon import / 短い export 1 本)
    はブラウザ側で行う必要がある。ここでは静的チェックのみ。
    """
    target = VENDOR_ROOT / lib / version
    if not target.exists():
        return {"ok": False, "reason": "vendor directory missing"}
    if lib == "three":
        main = target / "build" / "three.module.js"
        if not main.exists():
            return {"ok": False, "reason": "build/three.module.js missing"}
        head = main.read_bytes()[:200_000].decode("utf-8", errors="ignore")
        if "REVISION" not in head:
            return {"ok": False, "reason": "REVISION marker not found"}
        return {"ok": True, "size": main.stat().st_size}
    if lib == "mp4box":
        main = target / "mp4box.module.js"
        if not main.exists():
            return {"ok": False, "reason": "mp4box.module.js missing"}
        head = main.read_bytes()[:200_000].decode("utf-8", errors="ignore")
        if "createFile" not in head and "MP4Box" not in head:
            return {"ok": False, "reason": "MP4Box / createFile symbol not found"}
        return {"ok": True, "size": main.stat().st_size}
    return {"ok": False, "reason": "unknown lib"}

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

from .compositor import (
    CANVAS_SIZE,
    apply_idle_motion_to_payload,
    apply_shake_to_payload,
    bake_preview_layers,
    compute_dialogue_layout,
    is_transparent_background,
    request_from_payload,
)
from . import visualizer as visualizer_plugins


from .paths import (
    ACTIVE_PROJECT_PATH,
    ASSETS_DIR,
    CACHE_DIR,
    DEFAULT_PROJECT_ID,
    DEFAULT_PROJECTS_DIR,
    DOCS_DIR,
    GLOBAL_CONFIG_PATH,
    OUTPUT_DIR,
    PROJECT_ROOT,
    PSD_MANIFEST_PATH,
    STATE_DIR,
    STATIC_DIR,
    UI_STATE_PATH,
)
from .global_config import (
    BUILTIN_VIDEO_PRESETS,
    all_video_presets,
    current_projects_dir,
    decorate_video_presets,
    default_global_config,
    detect_ffmpeg_capabilities,
    ffmpeg_executable,
    ffprobe_executable,
    initialize_ffmpeg_path_default,
    load_global_config,
    preset_with_availability,
    resolve_video_preset,
    save_global_config,
)
from .utils import (
    ProjectContext,
    active_project_id,
    copy_if_missing,
    current_project,
    ensure_project,
    project_context,
    project_thumbnail_path,
    read_project_file,
    relative_to_root,
    set_active_project,
    slugify_project_id,
    unique_project_id,
    write_project_file,
)
from .config import (
    default_config,
    ensure_config,
    font_family_and_weight,
    merge_auto_fonts,
    normalized_font_family_name,
    pretty_font_family_name,
    save_config_payload,
    scan_fonts,
)
from .assets import (
    ASSET_CATEGORY_KINDS,
    asset_items,
    asset_scope_root,
    asset_scope_trash_root,
    asset_url,
    character_roots,
    directory_size_bytes,
    empty_asset_trash,
    ensure_trash_root,
    file_metadata,
    find_missing_asset_references,
    ignored_upload_member,
    image_items,
    import_character_psds,
    is_inside_trash,
    is_valid_image_file,
    load_trash_manifest,
    move_asset_to_trash,
    rename_asset,
    restore_asset_from_trash,
    safe_asset_filename,
    safe_resolve_asset_path,
    save_trash_manifest,
    scan_assets_for_scope,
    scan_character_directory_summary,
    scan_project_assets,
    uploaded_category_path,
    valid_image_asset_path,
    valid_manifest_items,
)
from .export_text import generate_export_text, yaml_quote
from .export_video import (
    audio_duration_seconds,
    audio_volume_by_frame,
    prepare_clean_pcm,
    video_metadata,
)
from .encoders import detect_h264_encoders
from .log_setup import app_logger, configure_app_logging
from .video_fix import reencode_with_gap_fill, write_sidecar
from .video_probe import (
    check_existing_fixed,
    file_sha1_short,
    fixed_paths_for,
    probe_pts_gaps,
)
from .render import (
    animate_character_state,
    animation_asset_items,
    animation_layers,
    eye_for_frame,
    mouth_for_frame,
    pick_layer,
    resolve_character_paths,
    safe_asset_path,
    safe_output_name,
)
from .psd import (
    IMPORT_YAML_FILENAME,
    PSD_IMPORTER_CATEGORY_LABELS,
    PSD_IMPORTER_DIR,
    PSD_IMPORTER_DIR_FOR_CATEGORY,
    PSD_IMPORTER_FLAG_KEYS_BY_CATEGORY,
    PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY,
    PSD_IMPORTER_RECOMMENDED_KEYS,
    build_psd_layer_tree,
    cleanup_old_psd_importer_sessions,
    composite_psd_paths,
    convert_psd_importer_session,
    ensure_psd_importer_dir,
    parse_psd_combination_paths,
    parse_psd_importer_yaml,
    psd_importer_session_dir,
    sanitize_psd_combination_label,
    serialize_psd_importer_yaml,
)
from .backup import (
    create_backup as _create_backup,
    delete_backup as _delete_backup,
    list_backups as _list_backups,
    restore_backup as _restore_backup,
)
from .character import (
    import_character_into_root,
    import_character_uploads,
    keep_imported_image,
    safe_character_root,
    safe_project_character_root,
    update_character_manifest_payload,
    write_character_manifest,
)
from .manifest import (
    CHARACTER_CATEGORIES,
    V4_MANIFEST_KEYS,
    apply_config_defaults,
    attach_character_definitions,
    category_items_from_directory,
    character_definition_from_asset_manifest,
    common_character_manifest,
    default_body_item,
    ensure_manifest,
    generate_manifest,
    merge_project_asset_manifest,
    scan_character_manifest,
)
from .scenario import (
    CHARACTER_STATE_KEYS,
    LEGACY_V3_STATE_KEYS,
    _character_def_for,
    _fill_cut_start_frame,
    _migrate_legacy_character_state,
    _migrate_legacy_preset,
    _normalize_bgm_track,
    _normalize_bpm_bob,
    _normalize_breath,
    _normalize_cut,
    _normalize_drop_shadow_style,
    _normalize_glow_style,
    _normalize_hex_color,
    _normalize_scene,
    _normalize_telop,
    _normalize_video_track,
    _resolve_id_from_path,
    character_manifest_items,
    default_character_state,
    default_scenario,
    ensure_expression_presets,
    ensure_scenario,
    first_character_id,
    normalize_character_state,
    normalize_cut_state,
    normalize_scenario,
    save_expression_presets,
    scenario_cuts,
)


app = FastAPI(title="立ち絵システム")

# WebGL export PoC (測定器): WS で生 RGBA を受けて ffmpeg に流す。詳細は app/v2_export_bench.py。
from .v2_export_bench import router as _v2_export_bench_router  # noqa: E402

app.include_router(_v2_export_bench_router)

# WebGL export 本実装 (Step 0): /api/v2/export/ws。詳細は app/v2_export.py。
from .v2_export import router as _v2_export_router  # noqa: E402

app.include_router(_v2_export_router)

# ビジュアライザ開発支援 (/dev/visualizers/)。本体 UI と独立。詳細は app/dev_tools.py。
from .dev_tools import router as _dev_tools_router  # noqa: E402

app.include_router(_dev_tools_router)

# JS ライブラリ (three / mp4box) の vendor 管理。詳細は app/vendor.py。
from . import vendor as vendor_mod  # noqa: E402

# アプリ内アップデータ (git pull ラッパ)。詳細は app/update.py。
from . import update as update_mod  # noqa: E402

# 実行環境診断 (websockets.speedups 等)。詳細は app/runtime_health.py。
from . import runtime_health  # noqa: E402

# デフォルトフォント (Noto Sans JP) のインストール。詳細は app/fonts.py。
from . import fonts as fonts_mod  # noqa: E402

# プロジェクト ZIP 入出力 (archive / import)。詳細は app/project_archive.py / project_import.py。
from . import project_archive as project_archive_mod  # noqa: E402
from . import project_import as project_import_mod  # noqa: E402
from . import tts as tts_mod  # noqa: E402


# /static/ の Cache-Control no-store は StaticFiles サブクラス側 (NoStoreStaticFiles)
# で実装。HTTP middleware (BaseHTTPMiddleware / pure ASGI どちらの実装でも) は
# 並列 POST + 一部レスポンスのキャンセル/タイムアウトのタイミングで Uvicorn の
# ``RuntimeError: Response content longer than Content-Length`` を踏みやすかった
# ため (Starlette upstream の既知問題)、middleware 経路を撤去した。
# StaticFiles サブクラスは FileResponse の Cache-Control を直接書き換えるだけ
# なので、body の chunked 再 emit や send 二重呼出しは発生しない。


class SwallowResponseRaceMiddleware:
    """``/project-cache/.../preview/*.png`` の配信中に Uvicorn が
    ``RuntimeError: Response content longer than Content-Length`` を出すケースを、
    response.start 済みの場合に限って握り潰すための最終安全網。

    根本対策は preview PNG の atomic write (tmp -> os.replace、main.py の
    ``save_layer``) で、これで FileResponse の stat 値とその後の送信量の不整合は
    起きなくなるはず。本ミドルウェアは「念のため残す保険」であり、絞り込みを
    強くして本物のレスポンス破損を隠さない:

    - 対象 path: ``/project-cache/`` 配下のみ。出力動画 / 静的 / 通常 API は素通し。
    - 対象例外: ``"Content-Length"`` 文字列を含む ``RuntimeError`` のみ。
      ``more_body`` 単独や他の ASGI protocol violation は黙殺しない。
    - 対象タイミング: ``http.response.start`` を既に送り終わった後だけ。
      start 前の例外はクライアントが応答ヘッダ受信前なので普通に 500 を返した方が良い。
    """

    _TARGET_PATH_PREFIX = "/project-cache/"

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "") or ""
        if not path.startswith(self._TARGET_PATH_PREFIX):
            # 対象外パスは何もせず素通し。
            await self.app(scope, receive, send)
            return

        response_started = False

        async def safe_send(message: dict[str, Any]) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            try:
                await send(message)
            except RuntimeError as exc:
                # response.start 後の Content-Length 不整合だけ握り潰す。
                # それ以外は本物の異常なので普通に伝搬させる。
                if response_started and "Content-Length" in str(exc):
                    return
                raise

        await self.app(scope, receive, safe_send)


# SwallowResponseRaceMiddleware の登録はファイル末尾に移動 (= app.mount などすべての
# route 定義が終わったあとに ASGI ラップ)。add_middleware だと FastAPI 標準の
# ServerErrorMiddleware の **内側** に配置されてしまい、そこから先で raise される
# Content-Length 不整合の RuntimeError を catch できないため。


class NoStoreStaticFiles(StaticFiles):
    """``/static/`` のレスポンスに ``Cache-Control: no-store`` を付与する StaticFiles。

    ESM の動的 import 先 (例: /static/js/renderer/scene-builder.js) は app.js の
    ような cache-busting query を持たず、ブラウザの last-modified heuristic で古い
    コードをつかみ続ける。サーバ再起動だけでは無効化されないため、開発の事故を
    減らす目的で /static/ には no-store を毎回付ける。
    """

    async def get_response(self, path: str, scope: dict[str, Any]) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, max-age=0"
        return response


async def upload_asset_files(
    scope: str,
    category: str,
    files: list[UploadFile],
    character_id: str | None,
    display_name: str | None,
    ctx: ProjectContext | None,
) -> dict[str, Any]:
    if category not in ASSET_CATEGORY_KINDS:
        raise ValueError(f"未知のカテゴリです: {category}")
    info = ASSET_CATEGORY_KINDS[category]
    scope_root = asset_scope_root(scope, ctx)
    scope_root.mkdir(parents=True, exist_ok=True)

    if category == "characters":
        if not character_id:
            raise ValueError("キャラIDを指定してください")
        safe_id = slugify_project_id(character_id)
        char_dir = scope_root / "characters" / safe_id
        if char_dir.exists():
            raise ValueError(f"既に同名のキャラクターが存在します: {safe_id}")
        psd_uploads: list[UploadFile] = []
        zip_uploads: list[UploadFile] = []
        png_uploads: list[UploadFile] = []
        for upload in files:
            if not upload.filename:
                continue
            ext = Path(upload.filename).suffix.lower()
            if ext == ".psd":
                psd_uploads.append(upload)
            elif ext == ".zip":
                zip_uploads.append(upload)
            elif ext in (".png", ".webp", ".avif"):
                png_uploads.append(upload)
        if not (psd_uploads or zip_uploads or png_uploads):
            raise ValueError("PSD、ZIP、または PNG/WebP/AVIF を選択してください")
        manifest = await import_character_into_root(
            target_characters_root=scope_root / "characters",
            name=display_name or character_id,
            character_id=character_id,
            psd_files=psd_uploads,
            zip_files=zip_uploads,
            png_files=png_uploads,
            ctx=ctx,
        )
        summary = scan_character_directory_summary(char_dir, scope_root)
        return {"created": safe_id, "summary": summary, "manifest": manifest}

    extensions = info["extensions"]
    target_dir = scope_root / category
    target_dir.mkdir(parents=True, exist_ok=True)
    saved_files: list[dict[str, Any]] = []
    for upload in files:
        if not upload.filename:
            continue
        ext = Path(upload.filename).suffix.lower()
        if ext not in extensions:
            raise ValueError(f"このカテゴリで許可されていない拡張子です: {ext}")
        target = target_dir / safe_asset_filename(upload.filename)
        # 同名ファイルが既に存在する場合は **上書き** する。旧仕様は `_1`, `_2`
        # サフィックスで連番リネームしていたが、ユーザが「画像を差し替え」たい
        # 場合に元ファイルの mtime が変わらず変更が反映されない症状を生んでいた。
        # PSD importer (keep_imported_image) / キャラ一括 import 経路も既に
        # `unlink + replace` で上書きしているので、ここで挙動を揃える。
        # ※ 複数バージョンを残したい場合はアップロード前にリネーム運用とする。
        target.unlink(missing_ok=True)
        target.write_bytes(await upload.read())
        saved_files.append(file_metadata(target, scope_root))
    if not saved_files:
        raise ValueError("有効なファイルがアップロードされませんでした")
    return {"saved": saved_files}



def _log_pil_build_info() -> None:
    """起動時に PIL のバージョンをログ表示する。"""
    # Pillow 10+ で `Image.core.pillow_version` (小文字) は廃止され、`PILLOW_VERSION`
    # のみが残った。古いコードは "?" にフォールバックしていたが起動ログが嘘になるので、
    # 両方の名前を順に見るようにした。
    core_version = (
        getattr(Image.core, "PILLOW_VERSION", None)
        or getattr(Image.core, "pillow_version", None)
        or "?"
    )
    info = {
        "version": Image.__version__,
        "core": core_version,
    }
    try:
        from PIL import features
        info["libjpeg_turbo"] = features.check_feature("libjpeg_turbo")
        info["libimagequant"] = features.check_feature("libimagequant")
    except Exception:
        pass
    app_logger("startup").info("PIL backend: pillow  %s", info)


# ---------------------------------------------------------------------------
# ログ抑制 (uvicorn 系 + splite_anime logger の一括レベル設定)
# ---------------------------------------------------------------------------
# 詳細は app/log_setup.py のコメント参照。
# - quietMode=True  → uvicorn / uvicorn.access / uvicorn.error / splite_anime
#                      を WARNING 化 (起動・per-frame アクセス・自前 INFO すべて抑止)
# - quietMode=False → 同 logger を INFO 化 (= ユーザ操作の重要イベントは出る)
# - 自前 print は logger.debug() に落としているので、いずれの mode でも詳細ログは
#   出ない (= デバッグ時のみ環境変数で DEBUG 化する想定)


@app.on_event("startup")
def startup() -> None:
    _log_pil_build_info()
    initialize_ffmpeg_path_default()
    global_config = load_global_config()
    quiet = bool((global_config.get("logging") or {}).get("quietMode"))
    configure_app_logging(quiet=quiet)
    if quiet:
        # quietMode は WARNING 化なので info は出ない。startup 完了の合図として
        # 1 行だけ stderr に直接出す (永続)。
        print("[startup] quiet mode: app/uvicorn loggers -> WARNING", flush=True)
    # 実行環境診断 (websockets.speedups の有無等)。degraded なら WARNING を出す
    # ので quietMode でも残る。書き出しが遅い環境の早期発見が目的。
    runtime_health.log_startup_diagnostics(app_logger("startup"))
    if active_project_id():
        ctx = current_project()
        ensure_manifest(ctx)
        ensure_config(ctx)
    # キャッシュ自動間引き (mtime 古いものを削除)。長期に触っていない
    # `cache/preview/` / `cache/lipsync/` / `cache/clean_pcm/` を間引く。
    # 既定 6 時間。今 active project の token は最近 touch されているので
    # 削除されない (= 起動直後 hit の速攻性は維持)。
    # 旧キー autoPruneOlderThanDays は global_config 側で Hours に migration 済み。
    cache_cfg = global_config.get("cache") or {}
    if cache_cfg.get("autoPruneOnStartup", True):
        try:
            hours = int(cache_cfg.get("autoPruneOlderThanHours") or 6)
        except (TypeError, ValueError):
            hours = 6
        hours = max(1, min(8760, hours))
        try:
            counts = prune_old_cache_files(hours)
        except Exception as exc:  # noqa: BLE001
            app_logger("startup").warning("cache auto-prune failed: %s", exc)
        else:
            total = sum(counts.values())
            if total > 0:
                app_logger("startup").info(
                    "cache auto-prune (mtime > %d 時間): preview=%d lipsync=%d cleanPcm=%d",
                    hours, counts["preview"], counts["lipsync"], counts["cleanPcm"],
                )


@app.on_event("startup")
async def _install_benign_connection_error_filter() -> None:
    """Windows ProactorEventLoop が peer 切断時に出す ConnectionResetError ノイズを抑止。

    ``_ProactorBasePipeTransport._call_connection_lost`` の ``socket.shutdown`` が
    WinError 10054 を投げるのは asyncio の既知問題 (bpo-39010)。実害は無いが、
    プレビュー中の <video> の range seek / scene-bundle の abort でブラウザが接続を
    切るたびに多発し、その都度 full traceback を stderr へ整形出力する処理が event
    loop を圧迫して /assets の range 配信 (= 動画レイヤーの読み込み) を遅らせる副作用が
    ある。loop の exception handler で peer 切断系 (transport callback で出るもの) だけ
    黙殺し、それ以外は従来のハンドラ / default にそのまま委譲する。
    """
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    prev = loop.get_exception_handler()
    _benign = (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)

    def _handler(loop_: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        exc = context.get("exception")
        if isinstance(exc, _benign):
            # transport の connection_lost で出る peer 切断。application 影響なし。
            return
        if prev is not None:
            prev(loop_, context)
        else:
            loop_.default_exception_handler(context)

    loop.set_exception_handler(_handler)


@app.get("/api/projects")
def list_projects() -> dict[str, Any]:
    projects = []
    for project_file in sorted(current_projects_dir().glob("*/project.json")):
        ctx = project_context(project_file.parent.name)
        project = read_project_file(ctx)
        timestamp = project.get("lastOpenedAt") or project.get("updatedAt") or project.get("createdAt") or ""
        projects.append(
            {
                "id": ctx.id,
                "title": project.get("title", ctx.id),
                "updatedAt": project.get("updatedAt", ""),
                "createdAt": project.get("createdAt", ""),
                "lastOpenedAt": project.get("lastOpenedAt", ""),
                "sortTimestamp": timestamp,
                "currentScenario": project.get("currentScenario", "scenarios/main.json"),
                "thumbnail": project_thumbnail_path(ctx),
                "lastPlayheadFrame": int(project.get("lastPlayheadFrame") or 0),
                "active": ctx.id == active_project_id(),
            }
        )
    return {"activeProjectId": active_project_id(), "projects": projects}


@app.post("/api/projects")
def create_project(payload: dict[str, Any]) -> dict[str, Any]:
    title = str(payload.get("title") or "New Project").strip()
    project_id = unique_project_id(str(payload.get("id") or title))
    ctx = ensure_project(project_id)
    now = datetime.now().isoformat(timespec="seconds")
    write_project_file(ctx, {"title": title or project_id, "lastOpenedAt": now})
    set_active_project(ctx.id)
    manifest = ensure_manifest(ctx)
    ensure_config(ctx)
    ensure_scenario(manifest, ctx)
    return {"project": read_project_file(ctx), "id": ctx.id}


@app.patch("/api/projects/{project_id}")
def update_project(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    ctx = project_context(project_id)
    if not ctx.project_file.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    title = str(payload.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Project title is required")

    # ディスク側ディレクトリ名 (= slug) も新タイトルに追従させる。
    # ユーザがダッシュボードで title を変えたあと、フォルダ名が古いままだと
    # outputs/ や cache/ や backups/ を OS のファインダで探したとき迷子になる。
    # 文字列は slugify_project_id 内で NFC 化済みなので、以降の slug 比較は NFC で安定。
    desired_slug = slugify_project_id(title)
    new_id = ctx.id
    if desired_slug != ctx.id:
        projects_dir = current_projects_dir()
        # 他プロジェクトと slug が衝突するときは連番で回避 (タイトル衝突自体は
        # 許容する仕様なので、フォルダ名だけは数字 suffix で住み分ける)。
        # 「自分自身」との衝突判定は samefile() (= inode 比較) で行う。case-insensitive
        # FS (APFS default / NTFS) では `Foo` → `foo` のリネームで両 path が同じ
        # ディレクトリを指すため、単純な文字列比較 `candidate != ctx.id` だと
        # 「自分自身を別物と誤認 → foo_2 に逃がす」事故になる。
        candidate = desired_slug
        suffix = 2
        while True:
            candidate_root = projects_dir / candidate
            if not (candidate_root / "project.json").exists():
                break
            try:
                if candidate_root.samefile(ctx.root):
                    break  # 同じディレクトリを指している (case-only リネーム等)
            except (OSError, ValueError):
                pass
            candidate = f"{desired_slug}_{suffix}"
            suffix += 1
        new_id = candidate

        if new_id != ctx.id:
            old_root = ctx.root
            new_root = projects_dir / new_id
            # 大文字小文字だけが違うリネーム (例: "Foo" → "foo") は case-insensitive
            # な APFS/HFS+/NTFS では `rename` が no-op になることがあるので、
            # 一旦 tmp 名へ逃がしてから本来の名前に置き直す。
            try:
                if str(new_root).lower() == str(old_root).lower():
                    tmp_root = old_root.with_name(f"{old_root.name}.__renaming_tmp__")
                    old_root.rename(tmp_root)
                    tmp_root.rename(new_root)
                else:
                    old_root.rename(new_root)
            except OSError as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"フォルダ名の変更に失敗しました: {exc}",
                ) from exc
            # active project pointer も追従。これを忘れると次回 active_project_id()
            # が空文字を返し、初期化時に別プロジェクトへ勝手に切り替わる。
            if active_project_id() == ctx.id:
                set_active_project(new_id)
            ctx = project_context(new_id)

    project = write_project_file(ctx, {"title": title, "id": new_id})
    return {"project": project, "id": ctx.id}


@app.post("/api/projects/{project_id}/activate")
def activate_project(project_id: str) -> dict[str, Any]:
    ctx = ensure_project(project_id)
    set_active_project(ctx.id)
    project = write_project_file(ctx, {"lastOpenedAt": datetime.now().isoformat(timespec="seconds")})
    return {"activeProjectId": ctx.id, "project": project}


@app.post("/api/projects/{project_id}/playhead")
def save_project_playhead(project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """再生ヘッドの保存。updatedAt は意図的にバンプしない（一覧の並びを乱さないため）。"""
    ctx = project_context(project_id)
    if not ctx.project_file.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    raw = (payload or {}).get("frame")
    try:
        frame = max(0, int(raw))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="frame must be an integer")
    write_project_file(ctx, {"lastPlayheadFrame": frame}, bump_updated_at=False)
    return {"ok": True, "lastPlayheadFrame": frame}


# サムネイル保存。ブラウザ側で v2 GL canvas から canvas.toBlob('image/png') した
# バイナリを raw body として受け取り、cache/thumbnail.png に書く。トップページの
# 一覧では GL を起こさず静的 PNG として表示する。updatedAt はバンプしない
# (一覧ソートを乱さない)。
#
# 経路は v2 PNG 出力 (/api/projects/{id}/render-png) と同じ captureSceneSnapshot
# パイプライン → toBlob('image/png') を共有しており、これでビジュアライザ /
# videoTrack / dialogue / telop / GL bg・fg / 色フィルタ・blur まで含めた
# 「再生ヘッドの絵そのまま」がサムネに反映される。
_THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024  # 8MB: 1080p PNG (rgba) は通常 1-3MB


@app.post("/api/projects/{project_id}/thumbnail")
async def upload_project_thumbnail(project_id: str, request: Request) -> dict[str, Any]:
    ctx = project_context(project_id)
    if not ctx.project_file.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type != "image/png":
        raise HTTPException(status_code=415, detail="Unsupported content type (use image/png)")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    if len(body) > _THUMBNAIL_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Thumbnail too large")
    ctx.cache_dir.mkdir(parents=True, exist_ok=True)
    target = ctx.cache_dir / "thumbnail.png"
    target.write_bytes(body)
    # 旧 webp サムネが残っていれば一覧で混乱しないよう削除。
    legacy_webp = ctx.cache_dir / "thumbnail.webp"
    if legacy_webp.exists():
        try:
            legacy_webp.unlink()
        except OSError:
            pass
    return {"ok": True, "thumbnail": project_thumbnail_path(ctx)}


# ---- v2 PNG 出力 (再生ヘッド上のプレビュー画面を WebGL canvas からそのまま保存) ----
# サムネ保存 (cache 配下) と違って `outputs/` 配下に永続書き出しするため、
# `/api/projects/{id}/thumbnail` とは別 endpoint。
# 本線 UI の renderPreview({ saveOutput: true }) が v2 経路で
# captureSceneSnapshot('image/png') した blob を raw body として送る。
_RENDER_PNG_MAX_BYTES = 32 * 1024 * 1024  # 32MB: 1080p PNG (rgba) は通常 1-8MB


@app.post("/api/projects/{project_id}/render-png")
async def upload_project_render_png(project_id: str, request: Request) -> dict[str, Any]:
    """v2 GL canvas から toBlob('image/png') した PNG を outputs/ に保存。

    /api/render の v1 経路と同じ拡張子 / 命名規則 (render_<ts>.png) で書く。
    返り値も `{path, filename}` の同じ形にして、フロント側 (playback.js) が
    v1/v2 経路で結果オブジェクトを区別せず使えるようにする。
    """
    ctx = project_context(project_id)
    if not ctx.project_file.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type != "image/png":
        raise HTTPException(status_code=415, detail="Unsupported content type (use image/png)")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    if len(body) > _RENDER_PNG_MAX_BYTES:
        raise HTTPException(status_code=413, detail="PNG too large")
    ctx.output_dir.mkdir(parents=True, exist_ok=True)
    output_name = f"render_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
    output_path = ctx.output_dir / output_name
    output_path.write_bytes(body)
    return {
        "path": f"/project-outputs/{ctx.id}/{output_name}",
        "filename": output_name,
    }


@app.post("/api/projects/{project_id}/duplicate")
def duplicate_project(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """プロジェクト一式をディスクごと複製。新しい title は既存と被ってはならない。"""
    src_ctx = project_context(project_id)
    if not src_ctx.project_file.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    new_title = str((payload or {}).get("title") or "").strip()
    if not new_title:
        raise HTTPException(status_code=400, detail="新しいプロジェクト名を入力してください")
    # 既存タイトル衝突チェック
    for existing in current_projects_dir().glob("*/project.json"):
        try:
            with existing.open("r", encoding="utf-8") as handle:
                title = str(json.load(handle).get("title", "")).strip()
        except (OSError, json.JSONDecodeError):
            continue
        if title == new_title:
            raise HTTPException(status_code=409, detail=f"プロジェクト名「{new_title}」は既に使われています")
    new_project_id = unique_project_id(new_title)
    dst_root = current_projects_dir() / new_project_id
    if dst_root.exists():
        raise HTTPException(status_code=409, detail="複製先のフォルダがすでに存在します")
    # ディスク上をまるごとコピー（cache/output/export 含む。重い場合は将来 ignore_patterns 検討）
    shutil.copytree(src_ctx.root, dst_root, ignore=shutil.ignore_patterns("cache", "outputs"))
    new_ctx = project_context(new_project_id)
    # 複製元 ID を埋め込んだ project-scoped アセットパス (projects/<old_id>/assets/...)
    # を複製先 ID に書き換える。copytree で実体はコピー済みだが、シナリオ等に旧 ID の
    # パスが残ると複製先が旧プロジェクトのアセットを参照し続け、旧プロジェクトを削除
    # すると複製が壊れる (= 報告されたバグ)。共通アセット (assets/...) は不変で正しい。
    # 他プロジェクトを参照する cross-project パス (= 複製元以外の projects/<x>/) は
    # 実体が複製されないため、意図的に書き換えず元の場所を指したままにする。
    old_path_prefix = f"projects/{src_ctx.id}/"
    new_path_prefix = f"projects/{new_ctx.id}/"
    if old_path_prefix != new_path_prefix:
        rewrite_targets = list(dst_root.glob("scenarios/*.json"))
        for name in ("project.json", "config.json", "expression_presets.json"):
            candidate = dst_root / name
            if candidate.exists():
                rewrite_targets.append(candidate)
        for target in rewrite_targets:
            try:
                text = target.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if old_path_prefix in text:
                target.write_text(text.replace(old_path_prefix, new_path_prefix), encoding="utf-8")
    # project.json を新 ID／タイトル／タイムスタンプで上書き
    now = datetime.now().isoformat(timespec="seconds")
    project = read_project_file(new_ctx)
    project.update({
        "id": new_ctx.id,
        "title": new_title,
        "createdAt": now,
        "updatedAt": now,
        "lastOpenedAt": now,
    })
    with new_ctx.project_file.open("w", encoding="utf-8") as handle:
        json.dump(project, handle, ensure_ascii=False, indent=2)
    return {"project": project, "id": new_ctx.id, "sourceId": src_ctx.id}


@app.get("/api/projects/{project_id}/archive")
def archive_project(project_id: str) -> FileResponse:
    """プロジェクトディレクトリを ZIP 化してダウンロードする。

    cache / outputs / exports / generated は除外 (project_archive 側のルール)。
    """
    from fastapi import BackgroundTasks  # local import で main の hot path を増やさない

    ctx = project_context(project_id)
    if not ctx.project_file.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        zip_path = project_archive_mod.build_project_archive(ctx.root, ctx.id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    title = ""
    try:
        with ctx.project_file.open("r", encoding="utf-8") as handle:
            title = str(json.load(handle).get("title") or "").strip()
    except (OSError, json.JSONDecodeError):
        pass

    safe_title = re.sub(r"[^A-Za-z0-9._\-]+", "_", title or ctx.id)[:64] or ctx.id
    download_name = f"{safe_title}.splite.zip"

    background = BackgroundTasks()
    background.add_task(project_archive_mod.cleanup_archive_file, zip_path)
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=download_name,
        background=background,
    )


@app.post("/api/projects/import")
async def import_project_endpoint(file: UploadFile = File(...)) -> dict[str, Any]:
    """ZIP アーカイブからプロジェクトを取り込む。

    取り込み処理本体は app/project_import.py に分離 (将来のスキーマ移行ツール
    としても再利用したいため)。
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="ファイルが指定されていません")
    data = await file.read()
    try:
        result = project_import_mod.import_project_zip(
            zip_bytes=data,
            projects_dir=current_projects_dir(),
            original_filename=file.filename,
        )
    except project_import_mod.ProjectImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, **result}


# ---- scenarios/main.json バックアップ ---------------------------------------
# 周期 / プロジェクト切替 / 復元前の安全網を取る auto と、ユーザが「バックアップ」
# ボタン (旧「エクスポート」) で取る manual がある。auto は global_config の
# autoRetentionCount で世代管理 (古い順に削除)。manual / preRestore は設定 UI
# からのみ削除可。詳細は app/backup.py を参照。
def _ensure_project_ctx(project_id: str):
    ctx = project_context(project_id)
    if not ctx.project_file.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    return ctx


def _auto_retention_count() -> int:
    cfg = load_global_config()
    backup_cfg = cfg.get("backup") if isinstance(cfg.get("backup"), dict) else {}
    try:
        value = int(backup_cfg.get("autoRetentionCount", 50))
    except (TypeError, ValueError):
        value = 50
    return max(1, min(1000, value))


@app.get("/api/projects/{project_id}/backups")
def list_project_backups(project_id: str) -> dict[str, Any]:
    ctx = _ensure_project_ctx(project_id)
    return {"backups": _list_backups(ctx)}


@app.post("/api/projects/{project_id}/backups")
def create_project_backup(project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    ctx = _ensure_project_ctx(project_id)
    raw_kind = str((payload or {}).get("kind") or "manual")
    if raw_kind not in ("auto", "manual"):
        raise HTTPException(status_code=400, detail="kind must be 'auto' or 'manual'")
    retention = _auto_retention_count() if raw_kind == "auto" else None
    info = _create_backup(ctx, raw_kind, retention=retention)
    return {"backup": info, "skipped": info is None}


@app.post("/api/projects/{project_id}/backups/{backup_id}/restore")
def restore_project_backup(project_id: str, backup_id: str) -> dict[str, Any]:
    ctx = _ensure_project_ctx(project_id)
    try:
        result = _restore_backup(ctx, backup_id, snapshot_current=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 上書き直後の scenario / manifest を返してフロントに再描画させる。
    manifest = ensure_manifest(ctx)
    scenario = ensure_scenario(manifest, ctx)
    config = ensure_config(ctx)
    manifest = apply_config_defaults(manifest, config)
    manifest["config"] = config
    manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
    manifest["project"] = read_project_file(ctx)
    manifest["projectId"] = ctx.id
    return {**result, "manifest": manifest, "scenario": scenario}


@app.delete("/api/projects/{project_id}/backups/{backup_id}")
def delete_project_backup(project_id: str, backup_id: str) -> dict[str, Any]:
    ctx = _ensure_project_ctx(project_id)
    try:
        ok = _delete_backup(ctx, backup_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(status_code=404, detail="backup not found")
    return {"ok": True}


@app.post("/api/export/text")
def export_text(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    ctx = current_project()
    # voice / voiceapp / emotion を解決するため、ランタイム manifest の
    # characters[] (= attach_character_definitions の結果) を渡す。
    # ディスクの manifest.json は voice を永続化していないため voice 列が
    # 空になるのを避ける。
    try:
        manifest = ensure_manifest(ctx)
        manifest = attach_character_definitions(merge_project_asset_manifest(manifest, ctx), ctx)
        manifest_characters = manifest.get("characters") or []
    except Exception:  # noqa: BLE001
        manifest_characters = None
    return generate_export_text(payload, ctx, manifest_characters=manifest_characters)


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    ctx = project_context(project_id)
    if not ctx.project_file.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    was_active = active_project_id() == ctx.id
    project = read_project_file(ctx)
    expected_name = str(project.get("title") or ctx.id)
    confirmation = str((payload or {}).get("confirmation") or "")
    if confirmation not in {expected_name, ctx.id}:
        raise HTTPException(status_code=400, detail="Project name confirmation does not match")
    shutil.rmtree(ctx.root)
    if was_active:
        remaining = sorted(current_projects_dir().glob("*/project.json"))
        if remaining:
            set_active_project(remaining[0].parent.name)
        else:
            set_active_project("")
    return {"deleted": ctx.id, "activeProjectId": active_project_id()}


@app.post("/api/projects/rescan")
def rescan_project_assets() -> dict[str, Any]:
    ctx = current_project()
    manifest = generate_manifest(ctx)
    manifest = attach_character_definitions(merge_project_asset_manifest(manifest, ctx), ctx)
    with ctx.manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    config = ensure_config(ctx)
    manifest = apply_config_defaults(manifest, config)
    manifest["config"] = config
    manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
    return manifest


@app.get("/api/manifest")
def get_manifest() -> dict[str, Any]:
    ctx = current_project()
    return _manifest_for_ctx(ctx)


def _manifest_for_ctx(ctx) -> dict[str, Any]:
    config = ensure_config(ctx)
    manifest = apply_config_defaults(ensure_manifest(ctx), config)
    manifest["config"] = _filter_missing_font_candidates(json.loads(json.dumps(config)))
    manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
    manifest["project"] = read_project_file(ctx)
    manifest["projectId"] = ctx.id
    return manifest


@app.get("/api/projects/{project_id}/manifest")
def get_project_manifest(project_id: str) -> dict[str, Any]:
    """指定プロジェクトの manifest を返す。active project に依存しない。"""
    ctx = _ensure_project_ctx(project_id)
    return _manifest_for_ctx(ctx)


def _filter_missing_font_candidates(config: dict[str, Any]) -> dict[str, Any]:
    """既定 config に残っている assets/* の旧名 (LINESeedJP_OTF_Rg.otf 等) は
    実体が無いため、JS 側 FontFace.load() の 404 を撒き散らす。マニフェスト返却時に
    `assets/...` `projects/...` で実在しないものだけ落として返す。
    Python 側の永続 config (ensure_config) には触らない。"""
    fonts = config.get("fonts") or []
    for font in fonts:
        weights = font.get("weights") or {}
        for weight_id, paths in list(weights.items()):
            if not isinstance(paths, list):
                continue
            filtered = []
            for p in paths:
                if not isinstance(p, str):
                    continue
                if p.startswith("assets/") or p.startswith("projects/"):
                    if (PROJECT_ROOT / p).exists():
                        filtered.append(p)
                    else:
                        continue
                else:
                    filtered.append(p)
            weights[weight_id] = filtered
    return config


@app.get("/api/scenario")
def get_scenario() -> dict[str, Any]:
    ctx = current_project()
    return ensure_scenario(ensure_manifest(ctx), ctx)


@app.get("/api/config")
def get_config() -> dict[str, Any]:
    return ensure_config(current_project())


@app.get("/api/visualizer/plugins")
def get_visualizer_plugins() -> dict[str, Any]:
    """plugins/visualizers/*.py を再走査して、UI で選べるプラグイン一覧を返す。"""
    return {
        "plugins": visualizer_plugins.plugin_descriptors(),
    }


@app.post("/api/config")
def save_config(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return save_config_payload(payload, current_project())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/expression-presets")
def update_expression_presets(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        ctx = current_project()
        manifest = ensure_manifest(ctx)
        presets = save_expression_presets(payload, manifest, ctx)
        return {"presets": presets}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/characters/expression-presets")
def get_asset_expression_presets(assetRoot: str) -> dict[str, Any]:
    """assets/<id>/expression_presets.json をアセット管理画面用に返す。"""
    asset_root = str(assetRoot or "").strip().replace("\\", "/")
    if not asset_root:
        raise HTTPException(status_code=400, detail="assetRoot が必要です")
    target_root = (PROJECT_ROOT / asset_root).resolve()
    try:
        target_root.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not target_root.exists() or not target_root.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")
    from .scenario import read_asset_expression_presets as _read_asset_expression_presets
    presets = _read_asset_expression_presets(target_root)
    # アセットダイアログ側で valid id をハイライトしたいので、character_def もまとめて返す
    ctx = current_project() if active_project_id() else None
    if ctx is not None:
        manifest = ensure_manifest(ctx)
        char_def = next(
            (
                c for c in manifest.get("characters") or []
                if (PROJECT_ROOT / c.get("assetRoot", "")).resolve() == target_root
            ),
            None,
        )
    else:
        manifest = common_character_manifest()
        char_def = next(
            (
                c for c in manifest.get("characters") or []
                if (PROJECT_ROOT / c.get("assetRoot", "")).resolve() == target_root
            ),
            None,
        )
    return {"presets": presets, "character": char_def or {}, "assetRoot": asset_root}


@app.get("/api/characters/hairstyle-presets")
def get_asset_hairstyle_presets(assetRoot: str) -> dict[str, Any]:
    """assets/<id>/hairstyle_presets.json をアセット管理画面用に返す。"""
    asset_root = str(assetRoot or "").strip().replace("\\", "/")
    if not asset_root:
        raise HTTPException(status_code=400, detail="assetRoot が必要です")
    target_root = (PROJECT_ROOT / asset_root).resolve()
    try:
        target_root.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not target_root.exists() or not target_root.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")
    from .scenario import read_asset_hairstyle_presets as _read_asset_hairstyle_presets
    presets = _read_asset_hairstyle_presets(target_root)
    if active_project_id():
        manifest = ensure_manifest(current_project())
    else:
        manifest = common_character_manifest()
    char_def = next(
        (
            c for c in manifest.get("characters") or []
            if (PROJECT_ROOT / c.get("assetRoot", "")).resolve() == target_root
        ),
        None,
    )
    return {"presets": presets, "character": char_def or {}, "assetRoot": asset_root}


@app.post("/api/characters/hairstyle-presets")
def post_asset_hairstyle_presets(payload: dict[str, Any]) -> dict[str, Any]:
    """assets/<id>/hairstyle_presets.json を保存する。アセット管理ダイアログ専用。

    髪型プリセットはアセット定義のみで完結するため project 側ファイルは存在しない。
    プロジェクト側 cut state は `hairstylePresetId` でこの id を参照する。
    """
    asset_root = str(payload.get("assetRoot") or "").strip().replace("\\", "/")
    presets_payload = payload.get("presets")
    if not asset_root:
        raise HTTPException(status_code=400, detail="assetRoot が必要です")
    if not isinstance(presets_payload, list):
        raise HTTPException(status_code=400, detail="presets が配列ではありません")
    target_root = (PROJECT_ROOT / asset_root).resolve()
    try:
        target_root.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not target_root.exists() or not target_root.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")
    from .scenario import write_asset_hairstyle_presets as _write_asset_hairstyle_presets
    if active_project_id():
        ctx = current_project()
        manifest = ensure_manifest(ctx)
    else:
        ctx = None
        manifest = common_character_manifest()
    char_def = next(
        (
            c for c in manifest.get("characters") or []
            if (PROJECT_ROOT / c.get("assetRoot", "")).resolve() == target_root
        ),
        None,
    )
    if char_def is None:
        raise HTTPException(status_code=404, detail="キャラクター定義が見つかりません")
    saved = _write_asset_hairstyle_presets(target_root, presets_payload, char_def)
    # 配布用 YAML を再生成 (Phase 5)
    from .scenario import refresh_import_manifest_for_character as _refresh_import_manifest
    try:
        _refresh_import_manifest(target_root, char_def)
    except Exception as exc:  # noqa: BLE001
        # YAML の書き出し失敗で API を落とさない (preset の保存自体は成功している)。
        app_logger("hairstyle-presets").warning("import_manifest.yml の更新に失敗: %s", exc)
    if ctx is not None:
        manifest = ensure_manifest(ctx)
        manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
    return {"presets": saved, "manifest": manifest}


@app.post("/api/characters/expression-presets")
def post_asset_expression_presets(payload: dict[str, Any]) -> dict[str, Any]:
    """assets/<id>/expression_presets.json を保存する。アセット管理ダイアログ専用。

    project 側プリセット (POST /api/expression-presets) との関係は、
    ensure_expression_presets が同 (characterId, presetId) を project 優先で
    マージする (`origin` フィールドで識別)。
    """
    asset_root = str(payload.get("assetRoot") or "").strip().replace("\\", "/")
    presets_payload = payload.get("presets")
    if not asset_root:
        raise HTTPException(status_code=400, detail="assetRoot が必要です")
    if not isinstance(presets_payload, list):
        raise HTTPException(status_code=400, detail="presets が配列ではありません")
    target_root = (PROJECT_ROOT / asset_root).resolve()
    try:
        target_root.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not target_root.exists() or not target_root.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")
    from .scenario import write_asset_expression_presets as _write_asset_expression_presets
    # 妥当性チェックに使う character_def は manifest 経由で取得する。
    # ensure_manifest はプロジェクト未選択だと cwd の DEFAULT_PROJECT_ID を使うので
    # 共通アセット用に common_character_manifest を直接当てる。
    if active_project_id():
        ctx = current_project()
        manifest = ensure_manifest(ctx)
    else:
        ctx = None
        manifest = common_character_manifest()
    char_def = next(
        (
            c for c in manifest.get("characters") or []
            if (PROJECT_ROOT / c.get("assetRoot", "")).resolve() == target_root
        ),
        None,
    )
    if char_def is None:
        raise HTTPException(status_code=404, detail="キャラクター定義が見つかりません")
    saved = _write_asset_expression_presets(target_root, presets_payload, char_def)
    # 配布用 YAML を再生成 (Phase 5)
    from .scenario import refresh_import_manifest_for_character as _refresh_import_manifest
    try:
        _refresh_import_manifest(target_root, char_def)
    except Exception as exc:  # noqa: BLE001
        app_logger("expression-presets").warning("import_manifest.yml の更新に失敗: %s", exc)
    # 現在開いているプロジェクトの manifest expressionPresets も最新化
    if ctx is not None:
        manifest = ensure_manifest(ctx)
        manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
    return {"presets": saved, "manifest": manifest}


@app.post("/api/characters")
def update_character(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        active_id = active_project_id()
        ctx = current_project() if active_id else None
        character_manifest = update_character_manifest_payload(payload, ctx)
        if ctx:
            config = ensure_config(ctx)
            manifest = apply_config_defaults(ensure_manifest(ctx), config)
            manifest["config"] = config
            manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
        else:
            manifest = common_character_manifest()
        return {"character": character_manifest, "manifest": manifest}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/characters")
def delete_character(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        ctx = current_project()
        character_dir = safe_project_character_root(str(payload.get("assetRoot") or ""), ctx)
        character_id = slugify_project_id(str(payload.get("characterId") or character_dir.name))
        shutil.rmtree(character_dir)

        # シナリオ・expression_presets は触らない。cut.state.characters[] の該当
        # エントリを残しておくと、同じ characterId で再インポートしたとき
        # baseId / eyeId / 座標 / speakerCharacterId / 表情プリセット が自動復活する。
        # 孤児になっている間は normalize_character_state がフィールドを保持し、
        # 描画側 (compositor / scene-builder) は characterId が manifest に
        # 一致しないインスタンスを「空レイヤー」として無視する。
        config = ensure_config(ctx)
        manifest = apply_config_defaults(ensure_manifest(ctx), config)
        manifest["config"] = config
        manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
        manifest["project"] = read_project_file(ctx)
        manifest["projectId"] = ctx.id
        return {"deleted": character_id, "manifest": manifest, "scenario": ensure_scenario(manifest, ctx)}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/characters/manifest")
def get_character_manifest_for_management() -> dict[str, Any]:
    active_id = active_project_id()
    if not active_id:
        return common_character_manifest()
    return get_manifest()


@app.post("/api/characters/import")
async def import_character(
    name: str = Form(""),
    characterId: str = Form(""),
    psdFile: UploadFile | None = File(None),
    zipFile: UploadFile | None = File(None),
    pngFiles: list[UploadFile] | None = File(None),
) -> dict[str, Any]:
    try:
        ctx = current_project()
        character_manifest = await import_character_uploads(
            name=name,
            character_id=characterId,
            psd_file=psdFile,
            zip_file=zipFile,
            png_files=pngFiles,
            ctx=ctx,
        )
        manifest = generate_manifest(ctx)
        manifest = attach_character_definitions(merge_project_asset_manifest(manifest, ctx), ctx)
        with ctx.manifest_path.open("w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
        config = ensure_config(ctx)
        manifest = apply_config_defaults(manifest, config)
        manifest["config"] = config
        manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
        manifest["project"] = read_project_file(ctx)
        manifest["projectId"] = ctx.id
        return {"character": character_manifest, "manifest": manifest}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/psd-importer/upload")
async def post_psd_importer_upload(psdFile: UploadFile = File(...)) -> dict[str, Any]:
    if not psdFile or not psdFile.filename:
        raise HTTPException(status_code=400, detail="PSDファイルを選択してください")
    if Path(psdFile.filename).suffix.lower() != ".psd":
        raise HTTPException(status_code=400, detail="PSDファイルを選択してください")
    try:
        from psd_tools import PSDImage
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="psd-toolsがインストールされていません") from exc

    cleanup_old_psd_importer_sessions()
    token = uuid.uuid4().hex
    session_dir = psd_importer_session_dir(token)
    session_dir.mkdir(parents=True, exist_ok=True)
    psd_path = session_dir / "source.psd"
    psd_path.write_bytes(await psdFile.read())

    try:
        psd = PSDImage.open(psd_path)
    except Exception as exc:
        shutil.rmtree(session_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"PSDの読み込みに失敗しました: {exc}") from exc

    tree = build_psd_layer_tree(psd)
    # PSD ルート直下に `import_manifest.yml` テキストレイヤーがあれば、その本文と
    # parsed の id / name を返してダイアログのマッピング欄に自動反映する。
    embedded_yaml = ""
    embedded_id = ""
    embedded_name = ""
    try:
        from .psd import _extract_psd_embedded_yaml as _extract_embedded_yaml
        extracted = _extract_embedded_yaml(psd)
        if isinstance(extracted, str) and extracted.strip():
            embedded_yaml = extracted
            try:
                parsed_embed = parse_psd_importer_yaml(extracted)
                embedded_id = str(parsed_embed.get("id") or "")
                embedded_name = str(parsed_embed.get("name") or "")
            except Exception:
                pass
    except Exception as exc:  # noqa: BLE001
        app_logger("psd-importer").warning("upload 時の埋め込み YAML 抽出に失敗: %s", exc)

    from .black_line_aa import BLACK_LINE_AA_PRESETS, DEFAULT_BLACK_LINE_AA_PRESET

    return {
        "token": token,
        "fileName": psdFile.filename,
        "size": [psd.size[0], psd.size[1]],
        "tree": tree,
        "embeddedYaml": embedded_yaml,
        "embeddedId": embedded_id,
        "embeddedName": embedded_name,
        # PSD インポータ UI が select を組み立てるためのプリセット一覧。
        "blackLineAaPresets": BLACK_LINE_AA_PRESETS,
        "defaultBlackLineAaPreset": DEFAULT_BLACK_LINE_AA_PRESET,
    }


@app.post("/api/psd-importer/preview")
def post_psd_importer_preview(payload: dict[str, Any]) -> dict[str, Any]:
    token = str(payload.get("token") or "")
    raw_paths = payload.get("paths") or []
    if not token:
        raise HTTPException(status_code=400, detail="tokenが必要です")
    try:
        from psd_tools import PSDImage
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="psd-toolsがインストールされていません") from exc
    try:
        session_dir = psd_importer_session_dir(token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    psd_path = session_dir / "source.psd"
    if not psd_path.exists():
        raise HTTPException(status_code=404, detail="PSDセッションが見つかりません。再度アップロードしてください")

    paths: list[list[str]] = []
    if isinstance(raw_paths, list):
        for entry in raw_paths:
            if isinstance(entry, list) and entry:
                paths.append([str(component) for component in entry if str(component)])

    psd = PSDImage.open(psd_path)
    image = composite_psd_paths(psd, paths) if paths else Image.new("RGBA", psd.size, (0, 0, 0, 0))
    preview_path = session_dir / "preview.png"
    image.save(preview_path)
    cache_busting = uuid.uuid4().hex[:8]
    return {
        "url": f"/cache/psd-importer/{token}/preview.png?v={cache_busting}",
        "size": [psd.size[0], psd.size[1]],
    }


@app.post("/api/psd-importer/convert")
def post_psd_importer_convert(payload: dict[str, Any]) -> dict[str, Any]:
    token = str(payload.get("token") or "")
    raw_id = str(payload.get("id") or "").strip()
    raw_name = str(payload.get("name") or "").strip()
    yaml_text = str(payload.get("yaml") or "")
    mode = str(payload.get("mode") or "create").strip().lower()
    asset_root = str(payload.get("assetRoot") or "").strip().replace("\\", "/")
    # 登録先 (create モードのみ意味を持つ)。append は assetRoot が既存パスを指す。
    scope = str(payload.get("scope") or "common").strip().lower()
    if scope not in {"common", "project"}:
        raise HTTPException(status_code=400, detail=f"未対応のscopeです: {scope}")
    image_format = str(payload.get("imageFormat") or "png").strip().lower()
    try:
        max_width = max(0, int(payload.get("maxWidth") or 0))
        max_height = max(0, int(payload.get("maxHeight") or 0))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="maxWidth/maxHeightは整数で指定してください") from exc
    resampling = str(payload.get("resampling") or "lanczos").strip().lower()
    if resampling not in {"lanczos", "bicubic", "hamming", "bilinear", "box", "nearest"}:
        raise HTTPException(status_code=400, detail=f"未対応のresamplingです: {resampling}")
    bake_white_transparent = bool(payload.get("bakeWhiteTransparent", False))
    bake_black_line_aa = bool(payload.get("bakeBlackLineAa", False))
    black_line_aa_preset = str(payload.get("blackLineAaPreset") or "").strip().lower()
    if not token:
        raise HTTPException(status_code=400, detail="tokenが必要です")
    if mode not in {"create", "append"}:
        raise HTTPException(status_code=400, detail=f"未対応のmodeです: {mode}")
    if image_format not in {"png", "avif"}:
        raise HTTPException(status_code=400, detail=f"未対応のimageFormatです: {image_format}")

    parsed = parse_psd_importer_yaml(yaml_text)

    try:
        session_dir = psd_importer_session_dir(token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    psd_path = session_dir / "source.psd"
    if not psd_path.exists():
        raise HTTPException(status_code=404, detail="PSDセッションが見つかりません。再度アップロードしてください")

    if mode == "append":
        if not asset_root:
            raise HTTPException(status_code=400, detail="追加インポートには assetRoot が必要です")
        target_root = (PROJECT_ROOT / asset_root).resolve()
        try:
            target_root.relative_to(PROJECT_ROOT.resolve())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
        if not target_root.exists() or not target_root.is_dir():
            raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")
        manifest_path = target_root / "character_manifest.json"
        if not manifest_path.exists():
            raise HTTPException(status_code=400, detail="character_manifest.json が存在しません")
        with manifest_path.open("r", encoding="utf-8") as handle:
            existing_manifest = json.load(handle)
        character_id = str(existing_manifest.get("id") or target_root.name)
        display_name = str(existing_manifest.get("name") or character_id)
    else:
        character_id = slugify_project_id(
            raw_id or parsed.get("id") or raw_name or parsed.get("name") or "character"
        )
        display_name = raw_name or parsed.get("name") or character_id
        # scope=project は現在アクティブなプロジェクトの assets/characters/ 配下に作る。
        # scope=common は従来通り共通の ASSETS_DIR/characters/ 配下。
        if scope == "project":
            ctx = current_project()
            if ctx is None:
                raise HTTPException(status_code=400, detail="プロジェクトが選択されていません")
            target_root = ctx.root / "assets" / "characters" / character_id
        else:
            target_root = ASSETS_DIR / "characters" / character_id
        if target_root.exists():
            raise HTTPException(
                status_code=409,
                detail=f"既に同じID（{character_id}）のキャラクターが存在します。別のIDを指定してください",
            )

    try:
        manifest = convert_psd_importer_session(
            psd_path=psd_path,
            target_dir=target_root,
            character_id=character_id,
            name=display_name,
            parsed=parsed,
            append=(mode == "append"),
            yaml_text=yaml_text,
            image_format=image_format,
            max_width=max_width,
            max_height=max_height,
            resampling=resampling,
            bake_white_transparent=bake_white_transparent,
            bake_black_line_aa=bake_black_line_aa,
            black_line_aa_preset=black_line_aa_preset,
        )
    except Exception as exc:
        if mode != "append" and target_root.exists():
            shutil.rmtree(target_root, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    shutil.rmtree(session_dir, ignore_errors=True)
    return {
        "ok": True,
        "id": character_id,
        "name": display_name,
        "manifest": manifest,
        "assetRoot": relative_to_root(target_root).replace("\\", "/"),
        "mode": mode,
    }


@app.get("/api/characters/import-yaml")
def get_character_import_yaml(assetRoot: str) -> dict[str, Any]:
    rel_path = (assetRoot or "").strip().replace("\\", "/")
    if not rel_path:
        raise HTTPException(status_code=400, detail="assetRoot が必要です")
    candidate = (PROJECT_ROOT / rel_path).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not candidate.exists() or not candidate.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")
    from .psd import (
        read_import_manifest_yaml_text as _read_import_manifest_yaml_text,
        serialize_psd_importer_yaml as _serialize_psd_importer_yaml,
    )
    raw_yaml_text = _read_import_manifest_yaml_text(candidate) or ""
    parsed = (
        parse_psd_importer_yaml(raw_yaml_text)
        if raw_yaml_text
        else {"id": "", "name": "", "categories": {}, "thumb": [], "map": {}}
    )
    # 既存ファイルが旧形式 (voice.emotion: '' などの冗長キー入り) でも、ダイアログ
    # 上は最新シリアライザで再フォーマットして見せる。ファイル自体には触れない
    # (次の「インポート」操作 / 紐付け保存で書き戻されるタイミングで自然に正規化
    # される)。
    yaml_text = (
        _serialize_psd_importer_yaml(parsed) if raw_yaml_text else ""
    )
    return {
        "ok": True,
        "yaml": yaml_text,
        "id": parsed.get("id", ""),
        "name": parsed.get("name", ""),
    }


@app.get("/api/characters/layers")
def get_character_layers(assetRoot: str) -> dict[str, Any]:
    rel_path = (assetRoot or "").strip().replace("\\", "/")
    if not rel_path:
        raise HTTPException(status_code=400, detail="assetRoot が必要です")
    candidate = (PROJECT_ROOT / rel_path).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not candidate.exists() or not candidate.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")
    manifest_path = candidate / "character_manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="character_manifest.json が存在しません")
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    from .psd import LEGACY_IMPORT_YAML_FILENAME as _LEGACY_IMPORT_YAML_FILENAME
    has_import_yaml = (
        (candidate / IMPORT_YAML_FILENAME).exists()
        or (candidate / _LEGACY_IMPORT_YAML_FILENAME).exists()
    )
    return {
        "ok": True,
        "manifest": manifest,
        "assetRoot": relative_to_root(candidate).replace("\\", "/"),
        "hasImportYaml": has_import_yaml,
        "recommendedKeys": PSD_IMPORTER_RECOMMENDED_KEYS,
        "flagKeys": {
            category: sorted(flags)
            for category, flags in PSD_IMPORTER_FLAG_KEYS_BY_CATEGORY.items()
        },
    }


def _drop_layer_entry_with_file(
    manifest: dict[str, Any], manifest_key: str, victim: dict[str, Any]
) -> None:
    path_str = victim.get("path") or ""
    if path_str:
        abs_path = (PROJECT_ROOT / path_str).resolve()
        if abs_path.exists() and abs_path.is_file():
            try:
                abs_path.unlink()
            except OSError:
                pass
    manifest[manifest_key] = [e for e in manifest.get(manifest_key, []) if e is not victim]


def _rename_layer_entry_in_place(
    target_entry: dict[str, Any], new_id: str
) -> None:
    old_path_str = target_entry.get("path") or ""
    new_path_str = old_path_str
    if old_path_str:
        old_abs = (PROJECT_ROOT / old_path_str).resolve()
        if old_abs.exists() and old_abs.is_file():
            new_filename = f"{new_id}.png"
            new_abs = old_abs.with_name(new_filename)
            counter = 2
            while new_abs.exists() and new_abs != old_abs:
                new_filename = f"{new_id}_{counter}.png"
                new_abs = old_abs.with_name(new_filename)
                counter += 1
            try:
                old_abs.rename(new_abs)
            except OSError as exc:
                raise HTTPException(
                    status_code=500, detail=f"ファイルのリネームに失敗しました: {exc}"
                ) from exc
            new_path_str = relative_to_root(new_abs).replace("\\", "/")
    target_entry["id"] = new_id
    target_entry["name"] = new_id
    if new_path_str:
        target_entry["path"] = new_path_str


@app.post("/api/characters/layers/save")
def post_character_layers_save(payload: dict[str, Any]) -> dict[str, Any]:
    """レイヤー編集ダイアログの一括保存。

    body: {
      "assetRoot": "...",
      "updates": [
        { "category": "mouth", "oldId": "mouth_xxx", "newId": "mouth_closed" },  # rename
        { "category": "mouth", "oldId": "mouth_yyy", "deleted": true },         # delete
        { "category": "mouth", "oldId": "mouth_zzz", "name": "とんがり口" },     # 表示名変更
      ]
    }

    rename 同士は2フェーズ（一時ID経由）で衝突回避。同カテゴリで final_id 衝突は新規側を尊重。
    name は rename 後に当てる (rename はデフォルト name=new_id を立てるので、明示指定が
    あれば後勝ちで上書き)。
    """
    asset_root = str(payload.get("assetRoot") or "").strip().replace("\\", "/")
    raw_updates = payload.get("updates") or []
    if not asset_root:
        raise HTTPException(status_code=400, detail="assetRoot が必要です")
    if not isinstance(raw_updates, list):
        raise HTTPException(status_code=400, detail="updates が配列ではありません")

    target_root = (PROJECT_ROOT / asset_root).resolve()
    try:
        target_root.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not target_root.exists() or not target_root.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")

    manifest_path = target_root / "character_manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="character_manifest.json が存在しません")
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    deletes: list[tuple[str, str]] = []
    renames: list[tuple[str, str, str]] = []  # (category, old_id, new_id)
    flag_updates: list[tuple[str, str, dict[str, bool]]] = []  # (category, id, flags)
    name_updates: list[tuple[str, str, str]] = []  # (category, old_id, display_name)
    for raw in raw_updates:
        if not isinstance(raw, dict):
            continue
        category = str(raw.get("category") or "").strip().lower()
        old_id = str(raw.get("oldId") or "").strip()
        if not category or not old_id or category not in PSD_IMPORTER_DIR_FOR_CATEGORY:
            continue
        if raw.get("deleted"):
            deletes.append((category, old_id))
            continue
        if "flags" in raw and isinstance(raw.get("flags"), dict):
            valid_flags = PSD_IMPORTER_FLAG_KEYS_BY_CATEGORY.get(category, set())
            cleaned: dict[str, bool] = {}
            for flag_name, flag_value in raw["flags"].items():
                if isinstance(flag_name, str) and flag_name in valid_flags:
                    cleaned[flag_name] = bool(flag_value)
            flag_updates.append((category, old_id, cleaned))
            # フラグ更新と rename は同 entry に同時指定もありうるので continue しない。
        if "name" in raw:
            display_name = str(raw.get("name") or "").strip()
            if display_name:
                name_updates.append((category, old_id, display_name))
        new_id_raw = str(raw.get("newId") or "").strip()
        if not new_id_raw:
            continue
        new_id = slugify_project_id(new_id_raw) or new_id_raw
        if not new_id or new_id == old_id:
            continue
        renames.append((category, old_id, new_id))

    deleted_combinations: list[tuple[str, str, str]] = []  # (category, old_id, sourceCombination)
    for category, old_id in deletes:
        manifest_key = PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY[category]
        entries = manifest.get(manifest_key, []) or []
        victim = next((e for e in entries if e.get("id") == old_id), None)
        if victim is None:
            continue
        deleted_combinations.append((category, old_id, victim.get("sourceCombination") or ""))
        _drop_layer_entry_with_file(manifest, manifest_key, victim)
        defaults = manifest.setdefault("defaults", {})
        if category == "base" and defaults.get("baseId") == old_id:
            remaining = manifest.get("bases", []) or []
            defaults["baseId"] = remaining[0].get("id", "") if remaining else ""

    # 2フェーズリネーム（A→B、B→A の交換も衝突なし）
    tmp_renames: list[tuple[str, str, str, str]] = []  # (category, original_old_id, tmp_id, final_id)
    for idx, (category, old_id, new_id) in enumerate(renames):
        manifest_key = PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY[category]
        entries = manifest.get(manifest_key, []) or []
        target = next((e for e in entries if e.get("id") == old_id), None)
        if target is None:
            continue
        tmp_id = f"__phase_c_tmp_{idx}__"
        _rename_layer_entry_in_place(target, tmp_id)
        tmp_renames.append((category, old_id, tmp_id, new_id))

    rename_combinations: list[tuple[str, str, str, str]] = []  # (category, old_id, final_id, combo)
    for category, old_id, tmp_id, final_id in tmp_renames:
        manifest_key = PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY[category]
        entries = manifest.get(manifest_key, []) or []
        target = next((e for e in entries if e.get("id") == tmp_id), None)
        if target is None:
            continue
        # 衝突する別 entry がいたら新規側を尊重して破棄
        conflict = next(
            (e for e in entries if e is not target and e.get("id") == final_id),
            None,
        )
        if conflict is not None:
            _drop_layer_entry_with_file(manifest, manifest_key, conflict)
        _rename_layer_entry_in_place(target, final_id)
        defaults = manifest.setdefault("defaults", {})
        if category == "base" and defaults.get("baseId") == old_id:
            defaults["baseId"] = final_id
        rename_combinations.append(
            (category, old_id, final_id, target.get("sourceCombination") or "")
        )

    # フラグ更新: rename 完了後の id を引き当てて manifest entry を更新する。
    # blinkHalf / blinkClosed / lipClosed / lipMid は manifest 全体で 1 枚だけ
    # 立てられる排他フラグ。新たに True を立てた entry 以外の同フラグは下げる。
    flag_updates_applied: list[tuple[str, str, dict[str, bool], str]] = []  # (category, id, flags, combo)
    rename_old_to_final = {(c, o): f for (c, o, f, _) in rename_combinations}
    for category, original_id, flags in flag_updates:
        manifest_key = PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY[category]
        # rename が同時指定されていれば new id で entry を引く。
        actual_id = rename_old_to_final.get((category, original_id), original_id)
        entries = manifest.get(manifest_key, []) or []
        target = next((e for e in entries if e.get("id") == actual_id), None)
        if target is None:
            continue
        EXCLUSIVE_FLAGS = {
            "eye": {"blinkHalf", "blinkClosed"},
            "mouth": {"lipClosed", "lipMid", "lipOpen"},
        }
        existing_flags: dict[str, Any] = (
            dict(target.get("flags") or {}) if isinstance(target.get("flags"), dict) else {}
        )
        for flag_name, flag_value in flags.items():
            if flag_value:
                if flag_name in EXCLUSIVE_FLAGS.get(category, set()):
                    for other in entries:
                        if other is target:
                            continue
                        other_flags = other.get("flags") or {}
                        if isinstance(other_flags, dict) and other_flags.get(flag_name):
                            other_flags = dict(other_flags)
                            other_flags.pop(flag_name, None)
                            if other_flags:
                                other["flags"] = other_flags
                            else:
                                other.pop("flags", None)
                existing_flags[flag_name] = True
            else:
                existing_flags.pop(flag_name, None)
        if existing_flags:
            target["flags"] = existing_flags
        else:
            target.pop("flags", None)
        flag_updates_applied.append(
            (category, actual_id, dict(flags), target.get("sourceCombination") or "")
        )

    # 表示名 (name) の更新: rename 後の id で entry を引いて name を上書き。
    # _rename_layer_entry_in_place は name=new_id でデフォルト初期化するので、
    # 明示 name 指定があるときだけここで後勝ちで適用する (UTF-8 日本語可)。
    name_updates_applied: list[tuple[str, str, str]] = []  # (category, id, name)
    for category, original_id, display_name in name_updates:
        manifest_key = PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY[category]
        actual_id = rename_old_to_final.get((category, original_id), original_id)
        entries = manifest.get(manifest_key, []) or []
        target = next((e for e in entries if e.get("id") == actual_id), None)
        if target is None:
            continue
        target["name"] = display_name
        name_updates_applied.append((category, actual_id, display_name))

    yaml_path = target_root / IMPORT_YAML_FILENAME
    yaml_data: dict[str, Any] | None = None
    from .psd import read_import_manifest_yaml_text as _read_import_manifest_yaml_text
    existing_yaml_text = _read_import_manifest_yaml_text(target_root)
    if existing_yaml_text is not None:
        try:
            yaml_data = parse_psd_importer_yaml(existing_yaml_text)
        except Exception:
            yaml_data = None
    if yaml_data is None:
        yaml_data = {
            "id": manifest.get("id", ""),
            "name": manifest.get("name", ""),
            "categories": {key: [] for key in PSD_IMPORTER_DIR_FOR_CATEGORY},
            "thumb": [],
            "map": {},
            "flags": {},
        }
    map_entries = yaml_data.setdefault("map", {})
    yaml_flags = yaml_data.setdefault("flags", {})

    # 削除: categories から該当 combination を除外、map / flags からも除外
    for category, old_id, combo in deleted_combinations:
        if combo:
            yaml_data["categories"].setdefault(category, [])
            yaml_data["categories"][category] = [
                c for c in yaml_data["categories"][category] if c != combo
            ]
            yaml_flags.pop(combo, None)
        map_entries.pop(old_id, None)
    # rename: 先に全 old_id を一括 pop してから final_id を設定（交換 rename 時の自損を回避）。
    for _, old_id, _, _ in rename_combinations:
        map_entries.pop(old_id, None)
    for _, _, final_id, combo in rename_combinations:
        if combo:
            map_entries[final_id] = combo

    # フラグ更新: combination をキーに flags ブロックを upsert。manifest 側で
    # 排他制約が反映済なので、yaml もそれに合わせて他 combination のフラグを削る。
    EXCLUSIVE_YAML_FLAGS_BY_CATEGORY = {
        "eye": {"blinkHalf", "blinkClosed"},
        "mouth": {"lipClosed", "lipMid", "lipOpen"},
    }
    for category, _, flags, combo in flag_updates_applied:
        if not combo:
            continue
        existing_flag_list = list(yaml_flags.get(combo) or [])
        for flag_name, flag_value in flags.items():
            if flag_value:
                if flag_name not in existing_flag_list:
                    existing_flag_list.append(flag_name)
                # 排他: 他 combination から同 flag を除去
                if flag_name in EXCLUSIVE_YAML_FLAGS_BY_CATEGORY.get(category, set()):
                    for other_combo, other_flags in list(yaml_flags.items()):
                        if other_combo == combo or not isinstance(other_flags, list):
                            continue
                        if flag_name in other_flags:
                            yaml_flags[other_combo] = [f for f in other_flags if f != flag_name]
            else:
                existing_flag_list = [f for f in existing_flag_list if f != flag_name]
        if existing_flag_list:
            yaml_flags[combo] = existing_flag_list
        else:
            yaml_flags.pop(combo, None)

    # まず categories/map/flags を反映した中間 YAML を書き出してから、
    # refresh_import_manifest_for_character で expressionPresets / hairstylePresets /
    # メタを最新の asset 状態 (上で更新した manifest 自身) で再注入する。
    yaml_path.write_text(serialize_psd_importer_yaml(yaml_data), encoding="utf-8")
    manifest["importYaml"] = IMPORT_YAML_FILENAME
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    from .scenario import refresh_import_manifest_for_character as _refresh_import_manifest
    try:
        _refresh_import_manifest(target_root, manifest)
    except Exception as exc:  # noqa: BLE001
        app_logger("layers/save").warning("import_manifest.yml の preset 反映に失敗: %s", exc)

    return {
        "ok": True,
        "manifest": manifest,
        "applied": {
            "deletes": len(deleted_combinations),
            "renames": len(rename_combinations),
            "flags": len(flag_updates_applied),
            "names": len(name_updates_applied),
        },
    }


@app.post("/api/characters/layers/update")
def post_character_layer_update(payload: dict[str, Any]) -> dict[str, Any]:
    asset_root = str(payload.get("assetRoot") or "").strip().replace("\\", "/")
    category = str(payload.get("category") or "").strip().lower()
    old_id = str(payload.get("oldId") or "").strip()
    new_id_raw = str(payload.get("newId") or "").strip()
    if not asset_root or not category or not old_id or not new_id_raw:
        raise HTTPException(status_code=400, detail="assetRoot/category/oldId/newId が必要です")
    if category not in PSD_IMPORTER_DIR_FOR_CATEGORY:
        raise HTTPException(status_code=400, detail=f"未対応のカテゴリです: {category}")
    new_id = slugify_project_id(new_id_raw) or new_id_raw
    if not new_id:
        raise HTTPException(status_code=400, detail="newIdが空です")

    target_root = (PROJECT_ROOT / asset_root).resolve()
    try:
        target_root.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not target_root.exists() or not target_root.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")

    manifest_path = target_root / "character_manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="character_manifest.json が存在しません")
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    manifest_key = PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY[category]
    entries = manifest.get(manifest_key, []) or []
    target_entry = next((e for e in entries if e.get("id") == old_id), None)
    if target_entry is None:
        raise HTTPException(status_code=404, detail=f"id={old_id} のレイヤーが見つかりません")

    if old_id == new_id:
        return {"ok": True, "noop": True, "id": new_id, "manifest": manifest}

    if any(e is not target_entry and e.get("id") == new_id for e in entries):
        raise HTTPException(
            status_code=409, detail=f"同じカテゴリに既に id={new_id} のレイヤーがあります"
        )

    new_path_str = target_entry.get("path") or ""
    old_path_str = new_path_str
    if old_path_str:
        old_abs = (PROJECT_ROOT / old_path_str).resolve()
        if old_abs.exists() and old_abs.is_file():
            new_filename = f"{new_id}.png"
            new_abs = old_abs.with_name(new_filename)
            counter = 2
            while new_abs.exists() and new_abs != old_abs:
                new_filename = f"{new_id}_{counter}.png"
                new_abs = old_abs.with_name(new_filename)
                counter += 1
            try:
                old_abs.rename(new_abs)
            except OSError as exc:
                raise HTTPException(
                    status_code=500, detail=f"ファイルのリネームに失敗しました: {exc}"
                ) from exc
            new_path_str = relative_to_root(new_abs).replace("\\", "/")

    target_entry["id"] = new_id
    target_entry["name"] = new_id
    if new_path_str:
        target_entry["path"] = new_path_str

    defaults = manifest.setdefault("defaults", {})
    if defaults.get("baseId") == old_id and category == "base":
        defaults["baseId"] = new_id

    yaml_path = target_root / IMPORT_YAML_FILENAME
    if yaml_path.exists():
        try:
            yaml_data = parse_psd_importer_yaml(yaml_path.read_text(encoding="utf-8"))
        except Exception:
            yaml_data = None
        if yaml_data is not None:
            map_entries = yaml_data.setdefault("map", {})
            map_entries.pop(old_id, None)
            combination = target_entry.get("sourceCombination") or ""
            if combination:
                map_entries[new_id] = combination
            yaml_path.write_text(serialize_psd_importer_yaml(yaml_data), encoding="utf-8")

    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    return {"ok": True, "id": new_id, "path": new_path_str, "manifest": manifest}


@app.post("/api/assets/character-thumbnail")
async def post_character_thumbnail(
    scope: str = Form("common"),
    asset_root: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="サムネイル画像を選択してください")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".avif"}:
        raise HTTPException(status_code=400, detail="PNG/JPG/WebP/AVIFを選択してください")

    rel_path = (asset_root or "").strip().replace("\\", "/")
    if not rel_path:
        raise HTTPException(status_code=400, detail="asset_root が必要です")
    candidate = (PROJECT_ROOT / rel_path).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    if not candidate.exists() or not candidate.is_dir():
        raise HTTPException(status_code=404, detail="キャラクターディレクトリが見つかりません")

    raw = await file.read()
    target_path = candidate / "thumb.png"
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            image.convert("RGBA").save(target_path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"画像の保存に失敗しました: {exc}") from exc
    return {"ok": True, "thumb": relative_to_root(target_path).replace("\\", "/")}


@app.delete("/api/assets/character-thumbnail")
def delete_character_thumbnail(payload: dict[str, Any]) -> dict[str, Any]:
    rel_path = str(payload.get("assetRoot") or "").strip().replace("\\", "/")
    if not rel_path:
        raise HTTPException(status_code=400, detail="assetRoot が必要です")
    candidate = (PROJECT_ROOT / rel_path).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="許可されていないパスです") from exc
    target_path = candidate / "thumb.png"
    if target_path.exists():
        target_path.unlink()
    return {"ok": True}


@app.get("/cache/psd-importer/{token}/{filename}")
def get_psd_importer_cache(token: str, filename: str) -> FileResponse:
    try:
        session_dir = psd_importer_session_dir(token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    safe_name = Path(filename).name
    path = (session_dir / safe_name).resolve()
    try:
        path.relative_to(session_dir.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="無効なパスです") from exc
    if not path.exists():
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")
    return FileResponse(path)


def _save_scenario_to_ctx(ctx, payload: dict[str, Any]) -> dict[str, Any]:
    """scenario の永続化共通処理。`/api/scenario` (active project 依存) と
    `/api/projects/{id}/scenario` (project-scoped) の両方から呼ばれる。"""
    has_scenes = isinstance(payload.get("scenes"), list)
    has_cuts = isinstance(payload.get("cuts"), list)
    if not has_scenes and not has_cuts:
        raise HTTPException(status_code=400, detail="Scenario must include scenes or cuts")
    payload_project_id = payload.get("projectId")
    if payload_project_id:
        payload_project_id = slugify_project_id(str(payload_project_id))
        if payload_project_id != ctx.id:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Scenario project mismatch: "
                    f"payload={payload_project_id}, target={ctx.id}"
                ),
            )
    raw_input: dict[str, Any] = {
        "version": int(payload.get("version", 4)),
        "title": str(payload.get("title", "scenario")),
    }
    if has_scenes:
        raw_input["scenes"] = payload["scenes"]
    else:
        raw_input["cuts"] = payload["cuts"]
    scenario = normalize_scenario(raw_input, ensure_manifest(ctx))
    ctx.scenario_path.parent.mkdir(parents=True, exist_ok=True)
    with ctx.scenario_path.open("w", encoding="utf-8") as handle:
        json.dump(scenario, handle, ensure_ascii=False, indent=2)
    write_project_file(ctx)
    return scenario


@app.post("/api/scenario")
def save_scenario(payload: dict[str, Any]) -> dict[str, Any]:
    """⚠ project-scoped save (`/api/projects/{id}/scenario`) への移行推奨。
    本エンドポイントは active project 依存のため、プロジェクト切替直後の
    debounce save が新しい active project に書き込まれる race の温床になる。
    互換のため残してあるが、新規呼び出しは project-scoped 版を使うこと。"""
    if not payload.get("projectId"):
        raise HTTPException(
            status_code=409,
            detail="Unscoped scenario save requires payload.projectId; use /api/projects/{id}/scenario",
        )
    return _save_scenario_to_ctx(current_project(), payload)


@app.get("/api/projects/{project_id}/scenario")
def get_project_scenario(project_id: str) -> dict[str, Any]:
    """指定プロジェクトの scenario を返す。active project に依存しない。"""
    ctx = _ensure_project_ctx(project_id)
    return ensure_scenario(ensure_manifest(ctx), ctx)


@app.post("/api/projects/{project_id}/scenario")
def save_project_scenario(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """指定プロジェクトに scenario を保存する。active project に依存しない。
    `scheduleScenarioSave` がスケジュール時点の projectId を URL に焼き込むことで、
    プロジェクト切替直後に残弾が新 active に飛ぶ race を物理的に塞ぐ。"""
    if not payload.get("projectId"):
        raise HTTPException(
            status_code=409,
            detail="Project-scoped scenario save requires payload.projectId",
        )
    ctx = _ensure_project_ctx(project_id)
    return _save_scenario_to_ctx(ctx, payload)


def resolve_payload_paths(payload: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    """v4 ID-based payload に compositor 互換のパスフィールドを補う。"""
    out = dict(payload)
    chars_in = payload.get("characters")
    if isinstance(chars_in, list):
        out["characters"] = [
            resolve_character_paths(item, manifest) if isinstance(item, dict) else item
            for item in chars_in
        ]
    return out


def _preview_layer_safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or ""))


def _clamp_animation_fps(value: Any, fallback: int = 12) -> int:
    """ライブプレビューのアニメ fps。manifest の characterAnimationFps と揃える。"""
    try:
        fps = int(value)
    except (TypeError, ValueError):
        return fallback
    if fps not in (8, 12, 24):
        return fallback
    return fps


def _scene_duration_sec(scene: dict[str, Any]) -> float:
    cuts = scene.get("cuts") or []
    if not cuts:
        return 0.0
    last = cuts[-1]
    try:
        from .timecode import frames_to_sec  # 局所 import (循環回避)
    except Exception:
        return 0.0
    end_frame = int(last.get("startFrame") or 0) + max(1, int(last.get("durationFrame") or 0))
    return frames_to_sec(end_frame)


def _build_preview_visualizer(
    *,
    ctx: ProjectContext,
    manifest: dict[str, Any],
    config: dict[str, Any],
    cut_id: str,
    cut_duration: float,
    preview_root: Path,
    cache_url: Callable[[str], str],
    override_scene: dict[str, Any] | None = None,
    override_cut: dict[str, Any] | None = None,
    allow_source_build: bool = True,
) -> dict[str, Any] | None:
    """scene-bundle レスポンス用 visualizer payload を返す (GL 経路のみ)。

    無効 / プラグイン未指定 / プロジェクト読み込み失敗 / 該当 plugin が GL_MODULE を
    持たないとき (= discover_plugins で除外されている) は None。

    override_scene / override_cut が指定された場合は disk 読み込みを skip し、
    指定された値で visualizer payload を組む (sceneOverride 経路用)。

    解析ストリームは scene token ではなく viz 専用トークン (音源 + 解析パラメータ +
    time grid) でキャッシュされる。キャッシュヒット時は FFT どころか ffmpeg decode
    すら走らない。テロップ・キャラ配置などシーン内の無関係な編集でも無効化されない。
    """
    if not cut_id or cut_duration <= 0:
        return None
    target_scene: dict[str, Any] | None = override_scene if isinstance(override_scene, dict) else None
    target_cut: dict[str, Any] | None = override_cut if isinstance(override_cut, dict) else None
    if target_scene is None or target_cut is None:
        try:
            scenario = ensure_scenario(manifest, ctx)
        except Exception:
            return None
        for scene in scenario.get("scenes") or []:
            for cut in scene.get("cuts") or []:
                if str(cut.get("id") or "") == cut_id:
                    target_scene = scene
                    target_cut = cut
                    break
            if target_scene is not None:
                break
    if target_scene is None or target_cut is None:
        return None
    viz_spec = target_scene.get("visualizer") or {}
    if not viz_spec.get("enabled"):
        return None
    plugin_key = str(viz_spec.get("pluginKey") or "").strip()
    if not plugin_key:
        return None
    plugin_info = visualizer_plugins.discover_plugins().get(plugin_key)
    if plugin_info is None:
        return None

    audio_track = visualizer_plugins.find_visualizer_audio_track(
        target_scene, str(viz_spec.get("audioTrackId") or "")
    )
    # AudioContext (ffmpeg decode) はここでは作らない。ensure_visualizer_streams が
    # キャッシュミス時にだけ lazy に decode する。

    cfg = manifest.get("config") or {}
    animation_fps = _clamp_animation_fps(cfg.get("characterAnimationFps"))
    plugin_frame_rate = plugin_info.gl_frame_rate
    if plugin_frame_rate and plugin_frame_rate > 0:
        animation_fps = max(1, int(plugin_frame_rate))
    n_frames = max(1, int(round(cut_duration * animation_fps)))

    try:
        from .timecode import frames_to_sec
    except Exception:
        frames_to_sec = lambda f: float(f) / 24.0  # fallback
    cut_start_sec = frames_to_sec(int(target_cut.get("startFrame") or 0))
    scene_total_sec = _scene_duration_sec(target_scene)
    if scene_total_sec <= 0:
        scene_total_sec = cut_start_sec + cut_duration

    user_params = viz_spec.get("params") or {}
    layer = str(viz_spec.get("layer") or "above_bg")

    time_grid = [cut_start_sec + i / float(animation_fps) for i in range(n_frames)]
    streams = visualizer_plugins.ensure_visualizer_streams(
        plugin_key=plugin_key,
        user_params=user_params,
        audio_track=audio_track,
        project_root=PROJECT_ROOT,
        time_grid_sec=time_grid,
        fps=animation_fps,
        cache_dir=ctx.cache_dir,
        allow_source_build=allow_source_build,
    )
    streams_url: dict[str, Any] = {}
    for name, meta in streams.items():
        entry: dict[str, Any] = {
            "url": cache_url(meta["path"]),
            "dtype": meta["dtype"],
            "shape": meta["shape"],
        }
        if "scale" in meta:
            entry["scale"] = meta["scale"]
        if "offset" in meta:
            entry["offset"] = meta["offset"]
        streams_url[name] = entry
    return {
        "pluginKey": plugin_key,
        "layer": layer,
        "frames": [],  # 互換用 (browser PNG 経路は使わない)
        "frameDurationSec": round(1.0 / animation_fps, 6),
        "frameCount": n_frames,
        "cutStartSec": cut_start_sec,
        "sceneTotalSec": scene_total_sec,
        "gl": {
            "module": plugin_info.gl_module,
            "version": plugin_info.gl_version,
            "params": user_params,
            "streams": streams_url,
        },
    }


def _stable_payload_token(
    payload: dict[str, Any],
    *,
    visualizer_spec: dict[str, Any] | None = None,
    telops_spec: list[dict[str, Any]] | None = None,
    character_layers: list[dict[str, Any]] | None = None,
) -> str:
    """payload + visualizer 設定 + telops + character layers の canonical JSON を SHA1 で 16 桁ハッシュ。

    v2 scene-bundle はこの token を ``under_<token>.png`` 等のキャラレイヤー PNG
    ファイル名に使う。同じ state 入力なら同じファイル名 → サーバ側で既存焼き込みを
    再利用、ブラウザ HTTP cache hit。

    visualizer_spec / telops_spec / character_layers は cut payload に直接乗らないが
    結果に影響するため、token に取り込んで「scene 内の設定変更で token が変わる」
    挙動を確保する。
    """
    canonical = json.dumps(
        {
            "payload": payload,
            "visualizer": visualizer_spec or {},
            "telops": telops_spec or [],
            "character_layers": character_layers or [],
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]


def _build_scene_payload(payload: dict[str, Any], ctx=None) -> dict[str, Any]:
    """``/api/v2/scene-bundle`` レスポンスの payload を生成 (v2 GL 経路専用)。

    - キャラの色フィルタ / 背景 blur / dialogue / telops は焼き込まず raw 値を返し、
      ブラウザ側 (three.js / canvas2d) で適用する。
    - 背景・前景は元素材の asset URL を ``background.assetUrl`` / ``foreground.assetUrl``
      で渡す。
    - token は payload + manifest mtime の SHA1 16 桁ハッシュなので、state が同じなら
      同じファイル名を使い回す (= ブラウザ HTTP cache / preview/*.png 再利用)。
    - キャラレイヤー PNG (`under_`, `over_`, `eye_*`, `mouth_*`) は v2 が GL texture
      として使うため ``bake_preview_layers`` で焼き続ける (色フィルタは適用しない)。
    - visualizer は GL plugin (gl_data_streams + GL_MODULE) のみ対応。
    """
    ctx = ctx or current_project()
    config = {**ensure_config(ctx), "projectRoot": str(PROJECT_ROOT)}
    manifest = ensure_manifest(ctx)
    # preview 経路は AudioContext + AnalyserNode で口パクを real-time 駆動するため、
    # サーバ側で ffmpeg astats を回す compute_cut_lipsync_levels は不要。クライアント
    # から `purpose: "preview"` が来ているときは skip して bake 時間を縮める。
    # token には乗せない (= preview/export で同じ token / 同じ焼き込み PNG を共有)。
    purpose = str(payload.get("purpose") or "").strip()
    if "purpose" in payload:
        payload = {k: v for k, v in payload.items() if k != "purpose"}
    # vizSourceBuild は「音源単位 viz キャッシュを同期生成してよいか」のヒントで、
    # 描画結果には影響しない (= 同じ cut.state なら同じ焼き込み PNG)。token に乗せると
    # CURRENT(false) と先読み(true) で別 PNG になりキャッシュが二重化するため除外する。
    allow_viz_source_build = bool(payload.get("vizSourceBuild", True))
    # サーバ側の bundle 生成コスト内訳 (律速診断)。export の書き出しサマリに集計される。
    from time import perf_counter as _perf
    _t_total0 = _perf()
    _timing_ms: dict[str, float] = {}
    _bake_ms_acc = 0.0  # bake_preview_layers (キャラ PNG 焼き) の累積 (char ループ内で加算)
    _layout_ms_acc = 0.0  # compute_dialogue_layout の累積
    if "vizSourceBuild" in payload:
        payload = {k: v for k, v in payload.items() if k != "vizSourceBuild"}
    if isinstance(payload.get("motionType"), str) and "motionSettings" not in payload:
        payload = {**payload, "motionSettings": config.get("motion", {})}
    # token は resolve_payload_paths 通過前の入力を基準にハッシュ。
    # 内部正規化結果が microsecond で揺れても影響を受けないため。
    token_input_payload = payload
    payload = resolve_payload_paths(payload, manifest)
    request = request_from_payload(payload, config)

    preview_root = ctx.cache_dir / "preview"
    preview_root.mkdir(parents=True, exist_ok=True)
    # ビジュアライザ / テロップは scene 単位 (cut 横断) なので payload には載らない。
    # token に取り込まないと「scene 内 setting を変えても同じ token = 古いキャッシュが
    # 使われ続ける」汚染になる。scenario から該当シーンの spec をまとめて引き当てる。
    cut_id_for_lookup = str(payload.get("cutId") or "")
    target_scene_for_lookup: dict[str, Any] | None = None
    target_cut_for_lookup: dict[str, Any] | None = None
    if cut_id_for_lookup:
        try:
            _t_scn0 = _perf()
            scenario_for_lookup = ensure_scenario(manifest, ctx)
            _timing_ms["scenario"] = _timing_ms.get("scenario", 0.0) + (_perf() - _t_scn0) * 1000.0
            for scene_iter in scenario_for_lookup.get("scenes") or []:
                cuts_iter = scene_iter.get("cuts") or []
                for cut_iter in cuts_iter:
                    if str(cut_iter.get("id") or "") == cut_id_for_lookup:
                        target_scene_for_lookup = scene_iter
                        target_cut_for_lookup = cut_iter
                        break
                if target_scene_for_lookup is not None:
                    break
        except Exception:
            target_scene_for_lookup = None
            target_cut_for_lookup = None
    # クライアントから sceneOverride が乗っているときは disk 状態より優先する。
    # 自動保存は 700ms debounce のため、編集直後の renderPreview がディスクから
    # 古い scenario を読んで「1 操作前の状態」を返す問題があった。テロップ・BGM・
    # videoTrack・visualizer 等の scene 単位設定はディスク経由ではなく live state を
    # そのまま使うことで即時反映する。
    scene_override_raw = payload.get("sceneOverride")
    scene_override = scene_override_raw if isinstance(scene_override_raw, dict) else None
    if scene_override is not None:
        if target_scene_for_lookup is None:
            target_scene_for_lookup = {}
        for key in ("telops", "videoTrack", "bgmTracks", "soundEffects", "videoLayers", "visualizer", "bpm", "breath", "bpmBob"):
            if key in scene_override:
                target_scene_for_lookup[key] = scene_override[key]
        # cuts も override に乗っていれば差し替える (cut の startFrame / durationFrame
        # 編集が即時反映されるように)。該当 cut も live cut で上書き。
        override_cuts = scene_override.get("cuts")
        if isinstance(override_cuts, list):
            target_scene_for_lookup["cuts"] = override_cuts
            for cut_iter in override_cuts:
                if isinstance(cut_iter, dict) and str(cut_iter.get("id") or "") == cut_id_for_lookup:
                    target_cut_for_lookup = cut_iter
                    break
    visualizer_spec_for_token: dict[str, Any] | None = (
        (target_scene_for_lookup.get("visualizer") or {})
        if target_scene_for_lookup else None
    )
    scene_telops_raw: list[dict[str, Any]] = []
    if target_scene_for_lookup is not None:
        for telop in target_scene_for_lookup.get("telops") or []:
            if isinstance(telop, dict):
                scene_telops_raw.append(telop)
    cut_start_sec_for_scene = 0.0
    if target_cut_for_lookup is not None:
        try:
            from .timecode import frames_to_sec as _frames_to_sec
        except Exception:
            _frames_to_sec = lambda f: float(f) / 24.0  # noqa: E731
        cut_start_sec_for_scene = _frames_to_sec(int(target_cut_for_lookup.get("startFrame") or 0))
    # 各キャラの blink/lip フラグ解決後の variant パスを token に取り込む。
    # レイヤー編集ダイアログで「mouth_A の lipClosed フラグを mouth_B に付け替えた」
    # ような操作で cut state が同一でも variant パスが変わる。token に反映しないと
    # 古い PNG キャッシュ (`<token>_<char>_mouth_closed.png`) が再利用されてしまう。
    #
    # 加えて各レイヤーパスの mtime_ns も token に混ぜる。アセット管理で PNG を
    # 上書き (同一パス・同一 cut state) しても、ファイル mtime が変われば token が
    # 変わって `<token>_*.png` が再焼成され、ブラウザ texture-cache (URL キー) も
    # miss する。これが無いと「画像を差し替えたのに反映されない」状態になる。
    def _mtime_ns_for(rel: Any) -> int | None:
        if not rel:
            return None
        try:
            return (PROJECT_ROOT / str(rel)).stat().st_mtime_ns
        except OSError:
            return None
    char_layers_for_token: list[dict[str, Any]] = []
    for character_request in request.characters:
        if not character_request.show_character:
            continue
        char_state_for_token = next(
            (
                item for item in (payload.get("characters") or [])
                if isinstance(item, dict) and str(item.get("id") or "") == character_request.id
            ),
            None,
        ) or {"characterId": ""}
        layers_for_token = animation_layers(manifest, char_state_for_token)
        # bake_preview_layers が読む全パスの mtime を入れる。eye/mouth variant に
        # 加えて base/cheek/bangs/back_hair/fronts も含めないと、たとえば base を
        # 差し替えただけのケースで token が変わらず under_<token>.png が古いまま。
        layer_mtimes: dict[str, int | None] = {}
        for path in (
            character_request.base,
            character_request.cheek,
            character_request.bangs,
            character_request.back_hair,
            *(character_request.fronts or []),
            layers_for_token.get("eye_open"),
            layers_for_token.get("eye_half"),
            layers_for_token.get("eye_closed"),
            layers_for_token.get("mouth_default"),
            layers_for_token.get("mouth_closed"),
            layers_for_token.get("mouth_mid"),
            layers_for_token.get("mouth_open"),
        ):
            if path:
                layer_mtimes[str(path)] = _mtime_ns_for(path)
        char_layers_for_token.append({
            "id": character_request.id,
            "blink_eligible": bool(layers_for_token.get("blink_eligible")),
            "eye_open": layers_for_token.get("eye_open"),
            "eye_half": layers_for_token.get("eye_half"),
            "eye_closed": layers_for_token.get("eye_closed"),
            "mouth_default": layers_for_token.get("mouth_default"),
            "mouth_closed": layers_for_token.get("mouth_closed"),
            "mouth_mid": layers_for_token.get("mouth_mid"),
            "mouth_open": layers_for_token.get("mouth_open"),
            "mtimes": layer_mtimes,
        })
    token = _stable_payload_token(
        token_input_payload,
        visualizer_spec=visualizer_spec_for_token,
        telops_spec=scene_telops_raw,
        character_layers=char_layers_for_token,
    )

    def cache_url(rel: str) -> str:
        return f"/project-cache/{ctx.id}/{rel}"

    transparent_bg = is_transparent_background(request.background)
    bg_blur_px_raw = float(getattr(request, "background_blur_px", 0.0) or 0.0)
    bg_asset_url: str | None = None
    if not transparent_bg:
        # 元素材を直接 texture 化する経路。Pillow 焼き込みは行わず、cover UV と
        # blur 量はクライアント側 (scene-builder + blur shader) で扱う。
        bg_asset_url = asset_url(str(request.background))

    fg_asset_url: str | None = None
    if request.foreground:
        # 元素材を直接 texture 化。contain plane への中央配置は scene-builder 側。
        fg_asset_url = asset_url(str(request.foreground))

    dialogue_layout: dict[str, Any] | None = None
    if request.text or request.show_speech_box:
        # three.js 側は canvas2D でオフスクリーン描画 → CanvasTexture 化する。
        # compute_dialogue_layout で Pillow 経路と同じ wrap_text / dialogue_box_rect /
        # baseline 計算を共有する。
        _t_lay0 = _perf()
        dialogue_layout = compute_dialogue_layout(request, config)
        _layout_ms_acc += (_perf() - _t_lay0) * 1000.0

    speaker_id = request.speaker_character_id
    characters_payload = []
    for character_request in request.characters:
        if not character_request.show_character:
            continue
        char_state = next(
            (
                item for item in (payload.get("characters") or [])
                if isinstance(item, dict) and str(item.get("id") or "") == character_request.id
            ),
            None,
        ) or {"characterId": ""}
        layers_meta = animation_layers(manifest, char_state)
        # blink_eligible=False (= カット選択 eye が blinkOpen フラグなし) のときは
        # half/closed を焼かず None にする (skip baking)。eye_open は常に「カット
        # 選択の目」(= state["eye"]) をそのまま texture 化する。
        blink_eligible = bool(layers_meta.get("blink_eligible"))
        eye_variants = {
            "open": layers_meta.get("eye_open"),
            "half": layers_meta.get("eye_half") if blink_eligible else None,
            "closed": layers_meta.get("eye_closed") if blink_eligible else None,
        }
        # mouth_default = カット選択の口。喋っていない / 口パク OFF / 非話者 で使う。
        # closed/mid/open は manifest 上の `lipClosed/lipMid/lipOpen` フラグ付きレイヤー。
        mouth_variants = {
            "default": layers_meta.get("mouth_default"),
            "closed": layers_meta.get("mouth_closed"),
            "mid": layers_meta.get("mouth_mid"),
            "open": layers_meta.get("mouth_open"),
        }
        # speaker_id が空 (= 話者未指定) の場合、誰も「非話者」扱いにせず dim を
        # かけない。話者キャラ削除直後など speakerCharacterId が一時的に空になる
        # 状況で、残りキャラが一斉にグレーアウトするのを防ぐ。
        is_speaker = (not speaker_id) or character_request.id == speaker_id
        char_safe = _preview_layer_safe_id(character_request.id) or "char"
        base_prefix = f"{token}_{char_safe}"

        # 「全レイヤーが既存ファイル」なら bake 自体を skip (token は state hash なので
        # 既存ファイルは内容も同一)。Pillow による焼き込みは ~20-50ms × キャラ数 ×
        # カット切替の度にかかるので、cached re-use の効果は大きい。
        # サイズは under.png のヘッダから取り直す。
        expected_suffixes = [
            "under", "over",
            "eye_open", "eye_half", "eye_closed",
            "mouth_default", "mouth_closed", "mouth_mid", "mouth_open",
        ]
        # cache hit 判定:
        #   1) under は常に必須。
        #   2) mouth_default も常に必須 (= カット選択の口)。
        #   3) flag 付きで variant path が存在するキー (例: blinkHalf を立てた eye)
        #      は対応 PNG が無いとフラグ編集後に表示できないので追加 check。
        #   これにより層エディタで flag を増やした直後の cut でも、不足ファイルが
        #   検出されて bake が走る。
        cache_check_suffixes = ["under", "mouth_default"]
        for variant_key, suffix in (
            ("eye_half", "eye_half"),
            ("eye_closed", "eye_closed"),
            ("mouth_closed", "mouth_closed"),
            ("mouth_mid", "mouth_mid"),
            ("mouth_open", "mouth_open"),
        ):
            if layers_meta.get(variant_key):
                cache_check_suffixes.append(suffix)
        all_exist = all(
            (preview_root / f"{base_prefix}_{s}.png").exists()
            for s in cache_check_suffixes
        )

        if all_exist:
            # 焼き込みスキップ。URL だけ返却 (一部 layer が存在しないケースは個別チェックで)。
            def url_or_none(suffix: str) -> str | None:
                p = preview_root / f"{base_prefix}_{suffix}.png"
                return cache_url(f"preview/{p.name}") if p.exists() else None
            under_url = url_or_none("under")
            over_url = url_or_none("over")
            # フラグから外された variant (= layers_meta が None) の旧キャッシュ PNG は
            # 残っていても URL を返さない。これでフラグ編集の取り消しが即時反映される。
            eye_urls = {
                "open": url_or_none("eye_open") if layers_meta.get("eye_open") else None,
                "half": url_or_none("eye_half") if layers_meta.get("eye_half") else None,
                "closed": url_or_none("eye_closed") if layers_meta.get("eye_closed") else None,
            }
            mouth_urls = {
                "default": url_or_none("mouth_default") if layers_meta.get("mouth_default") else None,
                "closed": url_or_none("mouth_closed") if layers_meta.get("mouth_closed") else None,
                "mid": url_or_none("mouth_mid") if layers_meta.get("mouth_mid") else None,
                "open": url_or_none("mouth_open") if layers_meta.get("mouth_open") else None,
            }
            _t_bake0 = _perf()
            with Image.open(preview_root / f"{base_prefix}_under.png") as img:
                layer_w, layer_h = img.size
            _bake_ms_acc += (_perf() - _t_bake0) * 1000.0
        else:
            # color filter は v2 では shader 側で適用するため、ここでは焼き込まない。
            _t_bake0 = _perf()
            baked = bake_preview_layers(
                PROJECT_ROOT,
                character_request,
                eye_variants,
                mouth_variants,
                is_speaker,
                request.inactive_character_opacity,
            )
            _bake_ms_acc += (_perf() - _t_bake0) * 1000.0

            def save_layer(image, suffix: str) -> str | None:
                if image is None:
                    return None
                file_name = f"{base_prefix}_{suffix}.png"
                path = preview_root / file_name
                # stable token なので、既存ファイルへの上書きは内容も同一: skip。
                # ★ 並列 race 対策: final path に直接 image.save すると、別の scene-bundle
                # リクエストが「既に exists」と判定して URL を返し、FileResponse が
                # 「保存途中で stat 時より長くなったファイル」を配信し、Uvicorn が
                # Content-Length 不整合で RuntimeError を投げる、というローカル競合が
                # 起きる。tmp file に書いてから os.replace で atomic rename することで、
                # 「exists() == True なファイルは必ず完成版」を保証する。
                if not path.exists():
                    # tmp 名は pid + thread + uuid で衝突回避。並列 worker が同じ
                    # 最終 path を狙っても、それぞれ別 tmp に書いて最後の replace が勝つ。
                    # ★ Pillow の Image.save() は拡張子から format を推測するため
                    # ``.tmp`` 拡張子のままだと未知 format でエラーになる。format="PNG"
                    # を明示して、Pillow が拡張子を見ないようにする。
                    tmp_name = f".{path.name}.{os.getpid()}-{threading.get_ident()}-{uuid.uuid4().hex[:8]}.tmp"
                    tmp_path = path.with_name(tmp_name)
                    try:
                        image.save(tmp_path, format="PNG")
                        # os.replace は POSIX で atomic。同名 file がもう存在していても
                        # 上書きする。先に同名 final が出来ていれば、自分の tmp は捨てて
                        # 既存を使う (先勝ち)。
                        if path.exists():
                            try:
                                tmp_path.unlink()
                            except OSError:
                                pass
                        else:
                            os.replace(tmp_path, path)
                    except Exception:
                        # 書き込み中断時は tmp を掃除して例外を再 raise。
                        try:
                            tmp_path.unlink()
                        except OSError:
                            pass
                        raise
                return cache_url(f"preview/{file_name}")

            under_url = save_layer(baked["under"], "under")
            over_url = save_layer(baked["over"], "over")
            eye_urls = {
                key: save_layer(image, f"eye_{key}")
                for key, image in baked["eyes"].items()
            }
            mouth_urls = {
                key: save_layer(image, f"mouth_{key}")
                for key, image in baked["mouths"].items()
            }
            # mouth_default が closed/mid/open のいずれかと同じパスのときは、
            # bake_preview_layers が同じ Image を返すケースもあるが、save_layer は
            # 個別ファイルとして保存する (token + suffix で URL が一意)。
            layer_w, layer_h = baked["layerSize"]

        zoom_offset_x = 0
        zoom_offset_y = 0
        effective_scale = float(character_request.character_scale)
        if (
            is_speaker
            and request.motion_zoom_scale
            and request.motion_zoom_scale != 1.0
        ):
            zoom_factor = max(0.01, float(request.motion_zoom_scale))
            base_scale = float(character_request.character_scale or 1.0)
            new_scale = base_scale * zoom_factor
            base_w = layer_w * base_scale
            base_h = layer_h * base_scale
            new_w = layer_w * new_scale
            new_h = layer_h * new_scale
            zoom_offset_x = int(round((base_w - new_w) / 2))
            origin = (request.motion_zoom_origin or "center").lower()
            if origin == "top":
                zoom_offset_y = 0
            elif origin == "bottom":
                zoom_offset_y = int(round(base_h - new_h))
            else:
                zoom_offset_y = int(round((base_h - new_h) / 2))
            effective_scale = new_scale

        # 色フィルタ raw を per-character payload に乗せる (v2 shader 側で適用)。
        color_filter_raw = None
        if isinstance(character_request.color_filter, dict):
            color_filter_raw = dict(character_request.color_filter)

        characters_payload.append(
            {
                "id": character_request.id,
                "name": character_request.name,
                "isSpeaker": is_speaker,
                "x": character_request.character_x + zoom_offset_x,
                "y": character_request.character_y + zoom_offset_y,
                "scale": effective_scale,
                "rawX": character_request.character_x,
                "rawY": character_request.character_y,
                "rawScale": float(character_request.character_scale),
                "layerWidth": layer_w,
                "layerHeight": layer_h,
                "underUrl": under_url,
                "overUrl": over_url,
                "eyeUrls": eye_urls,
                "mouthUrls": mouth_urls,
                # blinkEligible: カット選択 eye が blinkOpen フラグ付き、かつ
                # manifest に blinkClosed フラグの eye が存在する。
                # blinkHalf は任意 (無ければ blinkClosed をそのまま中間にも使う = 2 段目パチ)。
                # False のキャラは目パチが skip される (state["eye"] 固定)。
                "blinkEligible": (
                    blink_eligible
                    and bool(layers_meta.get("eye_closed"))
                ),
                "colorFilter": color_filter_raw,
                # 左右反転 (v2): scene-builder で キャラ本体 + silhouette のみ中心軸反転。
                # glow/dropShadow plane は反転しない (影の向きは固定したいため)。
                "flipX": bool(getattr(character_request, "flip_x", False)),
                # B-2: マルチキャラレイアウト用。crop が None なら scene-builder は
                # clippingPlanes 適用を skip。
                "crop": getattr(character_request, "crop", None),
                "layoutSlot": getattr(character_request, "layout_slot", None),
                # M-1: per-character motion ({type, settings})。playback.js が
                # computePerCharacterMotionOffsets で seek/再生ごとに dx/dy/scale 計算。
                "motion": getattr(character_request, "motion", None),
                # BPM 上下ゆれ (bob) ({bpm, amplitudePx})。motion とは独立。
                # scene-builder の update() が sceneSec から sin で dy を計算する。
                "bob": getattr(character_request, "bob", None),
            }
        )

    cut_id = str(payload.get("cutId") or "")
    cut_duration = float(payload.get("duration") or 3.0)
    cut_audio = str(payload.get("audio") or "")
    animation_defaults = config.get("animationDefaults") or {}
    motion_type = str(payload.get("motionType") or "none")
    # cut.state.motionSettings (= 演出タブで上書きされた値) があれば優先、
    # 無ければ global config の motion 既定を使う。これがないと cut 単位で
    # シェイク量や移動座標を変えても scene-bundle に乗らず描画に反映されない。
    raw_motion_settings = payload.get("motionSettings")
    motion_settings = raw_motion_settings if isinstance(raw_motion_settings, dict) else (config.get("motion") or {})

    # シーンの visualizer 設定 (GL 経路のみ)。失敗時は None で静的再生。
    # sceneOverride が来ているときは target_scene_for_lookup が override 反映済みの
    # dict になっている。visualizer も同じ live state を見るために渡す。
    # allow_viz_source_build は token 計算前 (vizSourceBuild の strip 時) に確定済み。
    # false (対話プレビューの現カット fetch) のときは音源単位キャッシュが未生成でも
    # 全長解析を同期実行せず per-cut で即返す (初動レイテンシ優先)。未指定 = True で、
    # 書き出し (export-session の独自 fetch) や先読み warm は従来どおり音源キャッシュを生成。
    _t_viz0 = _perf()
    visualizer_payload = _build_preview_visualizer(
        ctx=ctx,
        manifest=manifest,
        config=config,
        cut_id=cut_id,
        cut_duration=cut_duration,
        preview_root=preview_root,
        cache_url=cache_url,
        override_scene=target_scene_for_lookup if scene_override is not None else None,
        override_cut=target_cut_for_lookup if scene_override is not None else None,
        allow_source_build=allow_viz_source_build,
    )
    _timing_ms["viz"] = (_perf() - _t_viz0) * 1000.0

    background_payload: dict[str, Any] = {
        "transparent": transparent_bg,
        "blurPx": bg_blur_px_raw,
        # 背景画像が未指定 (透過扱い) のときに塗る単色。opacity=0 で「色 plane を作らない」。
        # 画像 / videoTrack が指定されているときも payload には乗せるが、scene-builder 側で
        # 画像があれば色 plane をスキップする (= cover-fit 画像で隠れるため無駄)。
        "color": str(getattr(request, "background_color", "#000000") or "#000000"),
        "colorOpacity": float(getattr(request, "background_color_opacity", 0.0) or 0.0),
    }
    if bg_asset_url:
        background_payload["assetUrl"] = bg_asset_url

    foreground_payload: dict[str, Any] | None = None
    if fg_asset_url:
        foreground_payload = {"assetUrl": fg_asset_url}
        # 前景の表示位置 (plane 左上の絶対座標, 0,0 = 画面左上)。None = 中央配置。
        fg_x = getattr(request, "foreground_x", None)
        fg_y = getattr(request, "foreground_y", None)
        if fg_x is not None:
            foreground_payload["x"] = float(fg_x)
        if fg_y is not None:
            foreground_payload["y"] = float(fg_y)

    dialogue_payload: dict[str, Any] | None = (
        {"raw": dialogue_layout} if dialogue_layout is not None else None
    )

    # scene の telops 配列をそのまま乗せる (canvas2d 側 drawTelopsOnCanvas で描画)。
    telops_payload: list[dict[str, Any]] = list(scene_telops_raw)

    # Animation timeline (export 経路の deterministic 化用):
    # - blinkFrames: cut-local frame indices (PROJECT_FPS=24 単位)。v1 と同じ
    #   random.Random("<id>:<duration>") seed なので同 cut なら同列。
    # - lipSyncLevels: cut.audio (話者) または useForLipSync BGM (cut 範囲) の
    #   per-frame Float32 levels。Float32Array binary を /project-cache から配信。
    # - idleMotion: scene-level の breath/bpm/bpmBob。連続関数 (sin) で
    #   client が `cutStartSec + cutFrameIdx/fps` から deterministic に計算する
    #   ため、ここでは設定値だけを乗せる (per-frame 配列は不要)。
    # preview (real-time AnalyserNode) はこれらを無視できるので、v1 経路にも
    # 含めて問題ない (フィールドが増えるだけ)。
    animation_timeline_payload: dict[str, Any] = {
        # blinkFrames: v1 互換 (cut 全体で 1 本)。新しい client は blinkFramesByChar を読む。
        "blinkFrames": [],
        # blinkFramesByChar: { [charId]: [frame indices] }。char_id を seed に含めるので
        # 同カット内でキャラ間のタイミングがズレる (一斉まばたき防止)。
        "blinkFramesByChar": {},
        "lipSyncLevels": None,
        "idleMotion": None,
    }
    if target_scene_for_lookup is not None:
        animation_timeline_payload["idleMotion"] = {
            "breath": target_scene_for_lookup.get("breath") or None,
            "bpm": target_scene_for_lookup.get("bpm") or None,
            "bpmBob": target_scene_for_lookup.get("bpmBob") or None,
        }
    if target_cut_for_lookup is not None:
        try:
            from .v2_export import (
                compute_cut_blink_frames,
                compute_cut_blink_frames_by_char,
                compute_cut_lipsync_levels,
            )
            from .timecode import PROJECT_FPS as _PROJECT_FPS
            animation_timeline_payload["blinkFrames"] = compute_cut_blink_frames(
                target_cut_for_lookup, fps=int(_PROJECT_FPS),
            )
            animation_timeline_payload["blinkFramesByChar"] = compute_cut_blink_frames_by_char(
                target_cut_for_lookup,
                fps=int(_PROJECT_FPS),
                char_ids=[str(c.get("id") or "") for c in characters_payload if c.get("id")],
            )
            if animation_defaults.get("lipSync", True) and purpose != "preview":
                _t_lip0 = _perf()
                animation_timeline_payload["lipSyncLevels"] = compute_cut_lipsync_levels(
                    cut=target_cut_for_lookup,
                    scene=target_scene_for_lookup or {},
                    cache_dir=ctx.cache_dir,
                    project_id=ctx.id,
                    token=token,
                    fps=int(_PROJECT_FPS),
                    lip_sync_config=config.get("lipSync") or {},
                )
                _timing_ms["lipsync"] = (_perf() - _t_lip0) * 1000.0
        except Exception:
            # 失敗は致命的でない (preview は real-time AnalyserNode で動く)
            pass

    _timing_ms["bake"] = _bake_ms_acc
    _timing_ms["layout"] = _layout_ms_acc
    _timing_ms["total"] = (_perf() - _t_total0) * 1000.0
    return {
        "projectId": ctx.id,
        "token": token,
        # サーバ bundle 生成コストの内訳 (ms)。export サマリの「cut境界」分解に使う。
        "_timing": _timing_ms,
        "canvasSize": [1920, 1080],
        "duration": cut_duration,
        "audio": cut_audio,
        "audioUrl": asset_url(cut_audio) if cut_audio else None,
        "background": background_payload,
        "foreground": foreground_payload,
        "dialogue": dialogue_payload,
        "characters": characters_payload,
        "speakerId": speaker_id,
        "motion": {"type": motion_type, "settings": motion_settings},
        "lipSync": config.get("lipSync") or {},
        "lipSyncEnabled": bool(animation_defaults.get("lipSync", True)),
        "blinkEnabled": bool(animation_defaults.get("blink", True)),
        # 目パチアルゴリズム ("anime" = 開き→閉じ→中→開き / "uniform" = 各 fps で均等)。
        "blinkAlgorithm": (
            str(animation_defaults.get("blinkAlgorithm") or "anime")
            if animation_defaults.get("blinkAlgorithm") in ("anime", "uniform")
            else "anime"
        ),
        # アニメ fps (8 / 12 / 24)。preview / export 双方の eye-blink 量子化基準。
        "characterAnimationFps": _clamp_animation_fps(config.get("characterAnimationFps")),
        "inactiveOpacity": float(request.inactive_character_opacity),
        "visualizer": visualizer_payload,
        "telops": telops_payload,
        "cutStartSec": float(cut_start_sec_for_scene),
        "blinkFrames": animation_timeline_payload["blinkFrames"],
        "blinkFramesByChar": animation_timeline_payload["blinkFramesByChar"],
        "lipSyncLevels": animation_timeline_payload["lipSyncLevels"],
        "idleMotion": animation_timeline_payload["idleMotion"],
        # scene-level の videoTrack 設定 (src/trim/speed/loop/fit/muted)。
        # export では WebCodecsVideoProvider がこれを読んで demux + decode する。
        # preview は別経路 (state.scenario からの直接参照) なのでここに依存しない。
        "videoTrack": (
            target_scene_for_lookup.get("videoTrack")
            if target_scene_for_lookup is not None else None
        ),
        # scene-level の videoLayers 設定。videoTrack と同様、preview は state.scenario
        # から直接参照する経路で読み、ここは主に export (WebCodecsVideoProvider per-layer)
        # 用に scene-bundle 経由で渡す。
        "videoLayers": (
            list(target_scene_for_lookup.get("videoLayers") or [])
            if target_scene_for_lookup is not None else []
        ),
        # B-2: マルチキャラレイアウトの分割パターン + ボーダー設定。preview / export
        # 経路の scene-builder で `buildCharacterLayoutBorder` が読み、分割線を描く。
        # cut.state.characterLayout は normalize_cut_state でフィールド化済み。
        "characterLayout": (
            (target_cut_for_lookup or {}).get("state", {}).get("characterLayout")
            if target_cut_for_lookup is not None else None
        ),
    }


@app.post("/api/v2/scene-bundle")
def post_scene_bundle_v2(payload: dict[str, Any]) -> dict[str, Any]:
    """v2 (WebGL) 用シーンバンドル: 色フィルタ / 背景 blur / dialogue / telops は焼かず raw を返す。

    同じ state 入力に対して同じファイル名 (= 既存焼き込みの再利用 + ブラウザ HTTP cache hit)
    を成立させる。これにより 2 回目以降の再生がディスク・帯域・初動レイテンシすべて劇的に軽くなる。
    """
    try:
        return _build_scene_payload(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/projects/{project_id}/v2/scene-bundle")
def post_project_scene_bundle_v2(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """指定プロジェクトの v2 scene-bundle を返す。active project に依存しない。"""
    ctx = _ensure_project_ctx(project_id)
    try:
        return _build_scene_payload(payload, ctx)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/outputs/{filename}")
def get_output(filename: str) -> FileResponse:
    path = OUTPUT_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output not found")
    return FileResponse(path)


@app.get("/project-outputs/{project_id}/{filename}")
def get_project_output(project_id: str, filename: str) -> FileResponse:
    ctx = project_context(project_id)
    path = ctx.output_dir / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output not found")
    return FileResponse(path)


@app.get("/cache/{filename:path}")
def get_cache(filename: str) -> FileResponse:
    base = CACHE_DIR.resolve()
    path = (CACHE_DIR / filename).resolve()
    try:
        path.relative_to(base)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid cache path") from exc
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Cache not found")
    return FileResponse(path)


@app.get("/project-cache/{project_id}/{filename:path}")
def get_project_cache(project_id: str, filename: str) -> FileResponse:
    ctx = project_context(project_id)
    base = ctx.cache_dir.resolve()
    path = (ctx.cache_dir / filename).resolve()
    try:
        path.relative_to(base)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid cache path") from exc
    if not path.exists():
        raise HTTPException(status_code=404, detail="Cache not found")
    # preview/ 配下は v2 (SHA1 token) / v1 (datetime token) ともにファイル名が
    # 「state hash + suffix」で content-addressable。永久キャッシュに置いて安全
    # (token が変われば URL も別)。これにより 2 度目以降の再生でブラウザが
    # 304 すら投げず memory cache から即返す = scene-bundle 後の viz_*.png /
    # fg_*.png / under_*.png 大量再フェッチが消える。
    # 一方 preview.png のような top-level ファイルは内容が更新され得るので no-cache。
    rel = filename.replace("\\", "/")
    if rel.startswith("preview/"):
        cache_control = "public, max-age=31536000, immutable"
    else:
        cache_control = "no-cache"
    response = FileResponse(path)
    response.headers["Cache-Control"] = cache_control
    return response


@app.get("/api/audio-duration")
def get_audio_duration(path: str) -> dict[str, Any]:
    try:
        audio_path = safe_asset_path(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not audio_path or not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio not found")
    duration = audio_duration_seconds(audio_path)
    if duration is None:
        raise HTTPException(status_code=400, detail="Audio duration could not be read")
    return {"path": path, "duration": duration, "roundedDuration": max(1, math.ceil(duration))}


@app.get("/api/clean-pcm-info")
def get_clean_pcm_info(path: str) -> dict[str, Any]:
    """動画素材の clean PCM (= AAC decoder の連続出力と等価な WAV) を生成 or cache 取得し、
    `{url, mapInfo}` を返す。preview の VL audio 経路で `<video>` の内蔵 audio を
    捨てて `<audio src=url>` + `mapInfo` で stream-time seek するために使う。

    `mapInfo` は `{"sample_rate": int, "frames": [[pts_time, stream_time, nb_samples], ...]}`
    で、frontend の `source_to_stream_time` (JS 移植) に渡して編集 UI 上の
    source-time を stream-time に変換する。
    詳細: [[project-vl-audio-source-time-preserving-2026-05-21]]
    """
    try:
        video_path = safe_asset_path(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not video_path or not video_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")
    result = prepare_clean_pcm(video_path)
    if result is None:
        raise HTTPException(
            status_code=400,
            detail="clean PCM の生成に失敗しました (音声ストリーム無し / ffmpeg エラー)",
        )
    wav_path, map_info = result
    # /cache/clean_pcm/<hash>.wav 形式の URL に変換
    rel = wav_path.resolve().relative_to(CACHE_DIR.resolve())
    return {
        "path": path,
        "url": f"/cache/{rel.as_posix()}",
        "mapInfo": map_info,
    }


@app.post("/api/video/probe-gaps")
async def video_probe_gaps_endpoint(request: Request) -> dict[str, Any]:
    """動画素材の PTS gap を検査する (VL attach 直前のチェック用)。

    入力: `{"path": "<asset_rel_path>"}`
    出力: `{path, probe, needsFix, existingFixed}`
      - probe: video_probe.probe_pts_gaps の戻り値
      - needsFix: gap > 50ms が 1 箇所でもあれば True
      - existingFixed: 既に <basename>.fixed.mp4 + sidecar があり元 SHA が一致するなら
        `{fixedPath, sidecar}`、無ければ None

    詳細: [[feedback-vl-pts-gap-source-must-be-normalized]]
    """
    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
    raw_path = str(payload.get("path") or "").strip()
    if not raw_path:
        raise HTTPException(status_code=400, detail="`path` is required")
    try:
        src = safe_asset_path(raw_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not src or not src.exists():
        raise HTTPException(status_code=404, detail="Video not found")
    probe = probe_pts_gaps(src)
    if probe is None:
        raise HTTPException(
            status_code=400,
            detail="probe failed (no audio stream / ffprobe error)",
        )
    needs_fix = bool(probe.get("gaps")) and float(probe.get("totalGapSec") or 0.0) > 0.0
    return {
        "path": raw_path,
        "probe": probe,
        "needsFix": needs_fix,
        "existingFixed": check_existing_fixed(src),
        "availableEncoders": detect_h264_encoders().to_dict(),
    }


@app.post("/api/video/reencode-fix")
async def video_reencode_fix_endpoint(request: Request) -> StreamingResponse:
    """PTS gap を含む動画を CFR + silence 埋めで再エンコード (Server-Sent Events)。

    入力: `{"path": "<rel>", "crf": 18, "preset": "medium", "targetFps": 60}`
    出力 (SSE, 各イベント `data: <json>\n\n`):
      - `{"progress": 0.0..0.999}` 進捗 (out_time_us / total)
      - `{"done": true, "ok": true, "fixedPath": "<rel>"}` 完了
      - `{"done": true, "ok": false, "error": "<msg>"}` 失敗

    成功時は同 assets/videos/ に `<basename>.fixed.mp4` と `<basename>.fixed.mp4.json`
    (sidecar) を生成する。
    """
    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
    raw_path = str(payload.get("path") or "").strip()
    if not raw_path:
        raise HTTPException(status_code=400, detail="`path` is required")
    encoder_kind = str(payload.get("encoderKind") or "hw").strip().lower()
    if encoder_kind not in ("hw", "balanced", "quality"):
        encoder_kind = "hw"
    target_fps = int(payload.get("targetFps") or 60)
    try:
        src = safe_asset_path(raw_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not src or not src.exists():
        raise HTTPException(status_code=404, detail="Video not found")

    probe = probe_pts_gaps(src)
    if probe is None:
        raise HTTPException(status_code=400, detail="probe failed (no audio stream)")
    fixed_path, sidecar_path = fixed_paths_for(src)
    original_sha = file_sha1_short(src) or ""
    total_duration = float(probe.get("sourceDurationSec") or 0.0) or None

    import asyncio

    async def event_stream():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict] = asyncio.Queue()

        def on_progress(p: float) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, {"progress": float(p)})

        def on_stderr(msg: str) -> None:
            # 末尾だけ。長い stderr を SSE に乗せ続けないようサイズ抑制。
            loop.call_soon_threadsafe(queue.put_nowait, {"error": msg[-500:]})

        def run_blocking() -> dict:
            ok, resolved_kind = reencode_with_gap_fill(
                src,
                fixed_path,
                encoder_kind=encoder_kind,
                target_fps=target_fps,
                total_duration_sec=total_duration,
                progress_cb=on_progress,
                stderr_cb=on_stderr,
            )
            if not ok:
                return {"done": True, "ok": False, "resolvedKind": resolved_kind}
            write_sidecar(
                sidecar_path,
                original_rel=raw_path,
                original_sha1=original_sha,
                probe=probe,
                encoder_kind_request=encoder_kind,
                resolved_kind=resolved_kind,
                target_fps=target_fps,
            )
            try:
                rel = fixed_path.resolve().relative_to(PROJECT_ROOT.resolve())
                fixed_rel = str(rel).replace("\\", "/")
            except ValueError:
                fixed_rel = ""
            return {
                "done": True, "ok": True,
                "fixedPath": fixed_rel,
                "resolvedKind": resolved_kind,
            }

        # `run_in_executor` は asyncio.Future を返す。`asyncio.create_task` で
        # ラップしようとすると uvloop で「a coroutine was expected, got <Future>」
        # TypeError になるため、戻り値の Future をそのまま `asyncio.wait` に渡す。
        fut = loop.run_in_executor(None, run_blocking)

        try:
            while True:
                # ffmpeg 完了 (fut) と queue 投入 (getter) のいずれか早い方を待つ。
                getter = asyncio.create_task(queue.get())
                done, _pending = await asyncio.wait(
                    {getter, fut}, return_when=asyncio.FIRST_COMPLETED,
                )
                if getter in done:
                    msg = getter.result()
                    yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                    if msg.get("done"):
                        break
                else:
                    # fut が先に完了した → 残りの queue を吐き出してから終了メッセージ
                    getter.cancel()
                    drained_done = False
                    while not queue.empty():
                        msg = queue.get_nowait()
                        yield f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
                        if msg.get("done"):
                            drained_done = True
                            break
                    if not drained_done:
                        # queue に done メッセージが無ければ fut の戻り値で締める
                        final = fut.result()
                        yield f"data: {json.dumps(final, ensure_ascii=False)}\n\n"
                    break
        finally:
            if not fut.done():
                fut.cancel()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/video-duration")
def get_video_duration(path: str) -> dict[str, Any]:
    """動画レイヤー / 背景動画のメタデータ取得。

    duration (秒) / width / height / hasAudio を返す。
    タイムライン上の幅計算、`trimEndSec: null` 時のフォールバック、
    `computeVideoFit` への入力、ffmpeg amix の音声無し判定 (hasAudio=False) で
    クライアントが利用する。
    """
    try:
        video_path = safe_asset_path(path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not video_path or not video_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")
    meta = video_metadata(video_path)
    if meta is None:
        raise HTTPException(status_code=400, detail="Video metadata could not be read")
    return {
        "path": path,
        "duration": meta["duration"],
        "width": meta["width"],
        "height": meta["height"],
        "hasAudio": meta["hasAudio"],
        "roundedDuration": max(1, math.ceil(meta["duration"])),
    }


# ---------- アセット管理 API ------------------------------------------------

def _ctx_for_scope(scope: str) -> ProjectContext | None:
    if scope == "common":
        return None
    if scope == "project":
        return current_project()
    raise HTTPException(status_code=400, detail=f"未知のスコープです: {scope}")


@app.get("/api/assets/inventory")
def get_assets_inventory(scope: str = "common") -> dict[str, Any]:
    try:
        ctx = _ctx_for_scope(scope)
        return scan_assets_for_scope(scope, ctx)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/assets/upload")
async def post_assets_upload(
    scope: str = Form(...),
    category: str = Form(...),
    character_id: str | None = Form(None),
    display_name: str | None = Form(None),
    files: list[UploadFile] = File(...),
) -> dict[str, Any]:
    try:
        ctx = _ctx_for_scope(scope)
        result = await upload_asset_files(scope, category, files, character_id, display_name, ctx)
        return {"ok": True, **result}
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/assets/delete")
def post_assets_delete(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope", "common"))
    category = payload.get("category")
    rel_path = payload.get("path")
    if not (isinstance(category, str) and isinstance(rel_path, str) and category and rel_path):
        raise HTTPException(status_code=400, detail="category と path は必須です")
    try:
        ctx = _ctx_for_scope(scope)
        entry = move_asset_to_trash(scope, category, rel_path, ctx)
        return {"ok": True, "trashEntry": entry}
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/assets/restore")
def post_assets_restore(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope", "common"))
    trash_id = payload.get("id")
    if not isinstance(trash_id, str) or not trash_id:
        raise HTTPException(status_code=400, detail="id は必須です")
    try:
        ctx = _ctx_for_scope(scope)
        entry = restore_asset_from_trash(scope, trash_id, ctx)
        return {"ok": True, "restored": entry}
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/assets/empty-trash")
def post_assets_empty_trash(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope", "common"))
    try:
        ctx = _ctx_for_scope(scope)
        removed = empty_asset_trash(scope, ctx)
        return {"ok": True, "removed": removed}
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/assets/rename")
def post_assets_rename(payload: dict[str, Any]) -> dict[str, Any]:
    scope = str(payload.get("scope", "common"))
    category = payload.get("category")
    rel_path = payload.get("path")
    new_name = payload.get("name")
    if not (
        isinstance(category, str) and category
        and isinstance(rel_path, str) and rel_path
        and isinstance(new_name, str) and new_name
    ):
        raise HTTPException(status_code=400, detail="category, path, name は必須です")
    try:
        ctx = _ctx_for_scope(scope)
        return {"ok": True, "asset": rename_asset(scope, category, rel_path, new_name, ctx)}
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/assets/missing")
def get_assets_missing() -> dict[str, Any]:
    try:
        ctx = current_project()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"missing": find_missing_asset_references(ctx)}


# ---------- 出力済データ管理 API --------------------------------------------

OUTPUT_PREVIEW_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".avif"}
OUTPUT_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm"}


def output_kind_label(entry: Path) -> str:
    if entry.is_dir():
        return "directory"
    suffix = entry.suffix.lower()
    if suffix in OUTPUT_VIDEO_EXTS:
        return "video"
    if suffix in OUTPUT_PREVIEW_EXTS:
        return "image"
    return "file"


def list_project_outputs(ctx: ProjectContext) -> list[dict[str, Any]]:
    output_dir = ctx.output_dir
    items: list[dict[str, Any]] = []
    if not output_dir.exists():
        return items
    for entry in sorted(output_dir.iterdir()):
        if entry.name.startswith("."):
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        kind = output_kind_label(entry)
        size = directory_size_bytes(entry) if entry.is_dir() else stat.st_size
        items.append(
            {
                "name": entry.name,
                "kind": kind,
                "ext": entry.suffix.lower(),
                "size": size,
                "modifiedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "url": (
                    f"/project-outputs/{ctx.id}/{entry.name}"
                    if not entry.is_dir()
                    else None
                ),
                "relativePath": str(entry.relative_to(PROJECT_ROOT)).replace("\\", "/"),
            }
        )
    return items


def delete_project_output(ctx: ProjectContext, name: str) -> Path:
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise ValueError("出力ファイル名が不正です")
    target = (ctx.output_dir / name).resolve()
    base = ctx.output_dir.resolve()
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise ValueError("許可されていないパスです") from exc
    if not target.exists():
        raise FileNotFoundError(name)
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return target


def empty_project_outputs(ctx: ProjectContext) -> int:
    output_dir = ctx.output_dir
    removed = 0
    if not output_dir.exists():
        return 0
    for entry in list(output_dir.iterdir()):
        if entry.name.startswith("."):
            continue
        try:
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
            removed += 1
        except OSError:
            continue
    return removed


@app.get("/api/outputs/list")
def get_outputs_list(scope: str = "project") -> dict[str, Any]:
    if scope != "project":
        raise HTTPException(status_code=400, detail="出力管理はプロジェクト単位のみ対応しています")
    try:
        ctx = current_project()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "scope": "project",
        "projectId": ctx.id,
        "outputDir": str(ctx.output_dir.relative_to(PROJECT_ROOT)).replace("\\", "/"),
        "outputs": list_project_outputs(ctx),
    }


@app.post("/api/outputs/delete")
def post_outputs_delete(payload: dict[str, Any]) -> dict[str, Any]:
    name = payload.get("name") if isinstance(payload, dict) else None
    if not isinstance(name, str) or not name:
        raise HTTPException(status_code=400, detail="name は必須です")
    try:
        ctx = current_project()
        delete_project_output(ctx, name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "removed": name}


@app.post("/api/outputs/empty")
def post_outputs_empty(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        ctx = current_project()
        removed = empty_project_outputs(ctx)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "removed": removed}


def _dir_size_bytes(path: Path) -> tuple[int, int]:
    """ディレクトリ配下のファイル合計サイズと件数を返す (再帰、symlink は辿らない)。

    存在しないディレクトリは ``(0, 0)``。`/cache` 系の統計表示に使う。
    """
    total = 0
    count = 0
    if not path.exists():
        return 0, 0
    try:
        for entry in path.rglob("*"):
            if entry.is_symlink() or not entry.is_file():
                continue
            try:
                total += entry.stat().st_size
                count += 1
            except OSError:
                continue
    except OSError:
        return 0, 0
    return total, count


def _empty_dir_contents(path: Path) -> int:
    """ディレクトリ配下のファイル/サブディレクトリを全削除 (ディレクトリ自体は残す)。

    返り値は削除に成功したエントリ数。`cache/preview/` 等の「中身だけ消す」用途。
    """
    if not path.exists():
        return 0
    removed = 0
    for entry in list(path.iterdir()):
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def collect_cache_stats() -> dict[str, Any]:
    """全プロジェクト + 共有キャッシュのサイズ統計をまとめて返す。

    レスポンス形:
        {
          "projects": [{"id": ..., "title": ..., "preview": {bytes, count}, ...}, ...],
          "shared":   {"cleanPcm": {bytes, count}, "psdImporter": {bytes, count}, ...},
          "totalBytes": int,
        }
    UI 側でこのまま「キャッシュ」ビューに表示する。
    """
    total = 0
    projects: list[dict[str, Any]] = []
    for project_file in sorted(current_projects_dir().glob("*/project.json")):
        try:
            ctx = project_context(project_file.parent.name)
        except Exception:
            continue
        project = read_project_file(ctx)
        preview_b, preview_n = _dir_size_bytes(ctx.cache_dir / "preview")
        lipsync_b, lipsync_n = _dir_size_bytes(ctx.cache_dir / "lipsync")
        thumb_b = 0
        thumb_path = ctx.cache_dir / "thumbnail.png"
        if thumb_path.exists():
            try:
                thumb_b = thumb_path.stat().st_size
            except OSError:
                thumb_b = 0
        sub_total = preview_b + lipsync_b + thumb_b
        total += sub_total
        projects.append({
            "id": ctx.id,
            "title": project.get("title") or ctx.id,
            "isActive": ctx.id == active_project_id(),
            "preview": {"bytes": preview_b, "count": preview_n},
            "lipsync": {"bytes": lipsync_b, "count": lipsync_n},
            "thumbnail": {"bytes": thumb_b, "count": 1 if thumb_b > 0 else 0},
            "totalBytes": sub_total,
        })

    clean_pcm_b, clean_pcm_n = _dir_size_bytes(CACHE_DIR / "clean_pcm")
    psd_b, psd_n = _dir_size_bytes(CACHE_DIR / "psd-importer")
    shared = {
        "cleanPcm": {"bytes": clean_pcm_b, "count": clean_pcm_n},
        "psdImporter": {"bytes": psd_b, "count": psd_n},
    }
    total += clean_pcm_b + psd_b
    return {"projects": projects, "shared": shared, "totalBytes": total}


def empty_project_cache(ctx: ProjectContext, *, include_lipsync: bool = True) -> dict[str, int]:
    """プロジェクトのキャッシュを空にする (preview + 任意で lipsync)。

    thumbnail.png は残す (= プロジェクト一覧での表示に使うため)。
    `cache/preview/` 配下の bake 済み PNG は次回 scene-bundle 要求で必要分だけ
    再生成されるので削除は安全。
    """
    preview_removed = _empty_dir_contents(ctx.cache_dir / "preview")
    lipsync_removed = _empty_dir_contents(ctx.cache_dir / "lipsync") if include_lipsync else 0
    return {"preview": preview_removed, "lipsync": lipsync_removed}


def empty_shared_cache(*, include_clean_pcm: bool = True) -> dict[str, int]:
    """共有キャッシュ (clean_pcm) を空にする。

    psd-importer はインポート途中セッションの可能性があるので触らない
    (= 既存の `cleanup_old_psd_importer_sessions` に任せる)。
    """
    clean_pcm_removed = (
        _empty_dir_contents(CACHE_DIR / "clean_pcm") if include_clean_pcm else 0
    )
    return {"cleanPcm": clean_pcm_removed}


def prune_old_cache_files(older_than_hours: int) -> dict[str, int]:
    """mtime が ``older_than_hours`` より古いキャッシュファイルを削除。

    対象:
      - `projects/<id>/cache/preview/` 配下のファイル
      - `projects/<id>/cache/lipsync/` 配下のファイル
      - `cache/clean_pcm/` 配下のファイル

    `thumbnail.png` / `psd-importer/` は対象外 (= 別仕組みで管理されているため)。
    返り値は削除件数 (項目別)。
    """
    if older_than_hours <= 0:
        return {"preview": 0, "lipsync": 0, "cleanPcm": 0}
    import time as _time
    cutoff = _time.time() - older_than_hours * 3600

    def _prune(path: Path) -> int:
        if not path.exists():
            return 0
        removed = 0
        try:
            for entry in path.rglob("*"):
                if entry.is_symlink() or not entry.is_file():
                    continue
                try:
                    if entry.stat().st_mtime < cutoff:
                        entry.unlink()
                        removed += 1
                except OSError:
                    continue
        except OSError:
            return removed
        return removed

    counts = {"preview": 0, "lipsync": 0, "cleanPcm": 0}
    for project_file in sorted(current_projects_dir().glob("*/project.json")):
        try:
            ctx = project_context(project_file.parent.name)
        except Exception:
            continue
        counts["preview"] += _prune(ctx.cache_dir / "preview")
        counts["lipsync"] += _prune(ctx.cache_dir / "lipsync")
    counts["cleanPcm"] += _prune(CACHE_DIR / "clean_pcm")
    return counts


@app.get("/api/cache/stats")
def get_cache_stats() -> dict[str, Any]:
    return collect_cache_stats()


@app.post("/api/cache/empty")
def post_cache_empty(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """キャッシュを空にする。

    payload:
      - ``scope="project"`` (既定): active project の preview + lipsync を空に。
        ``projectId`` 指定で別プロジェクトも指定可。
      - ``scope="shared"``: 共有キャッシュ (clean_pcm) を空に。
      - ``scope="all"``: 全プロジェクトの preview + lipsync + 共有 (clean_pcm) を空に。
    """
    payload = payload or {}
    scope = str(payload.get("scope") or "project").strip()
    result: dict[str, Any] = {"ok": True, "scope": scope}

    if scope in ("project", "all"):
        targets: list[ProjectContext] = []
        if scope == "all":
            for project_file in sorted(current_projects_dir().glob("*/project.json")):
                try:
                    targets.append(project_context(project_file.parent.name))
                except Exception:
                    continue
        else:
            project_id = payload.get("projectId")
            try:
                if isinstance(project_id, str) and project_id.strip():
                    targets.append(project_context(project_id.strip()))
                else:
                    targets.append(current_project())
            except Exception as exc:
                raise HTTPException(status_code=400, detail=str(exc))
        per_project = []
        total_preview = 0
        total_lipsync = 0
        for ctx in targets:
            counts = empty_project_cache(ctx)
            per_project.append({"id": ctx.id, **counts})
            total_preview += counts["preview"]
            total_lipsync += counts["lipsync"]
        result["perProject"] = per_project
        result["preview"] = total_preview
        result["lipsync"] = total_lipsync

    if scope in ("shared", "all"):
        shared_counts = empty_shared_cache()
        result["shared"] = shared_counts
        result["cleanPcm"] = shared_counts["cleanPcm"]

    if scope not in ("project", "shared", "all"):
        raise HTTPException(status_code=400, detail=f"未知の scope: {scope!r}")

    return result


# ---------- グローバル設定 API ------------------------------------------------

def _ffmpeg_status_payload() -> dict[str, Any]:
    capabilities = detect_ffmpeg_capabilities()
    return {
        "available": bool(capabilities.get("available")),
        "error": capabilities.get("error") or "",
        "encoderCount": len(capabilities.get("encoders") or set()),
    }


# ---------- UI 状態 (リロード / 再起動で画面位置を維持) ----------------------
# 「ダッシュボードを見ていた」「編集画面を見ていた」のどちらをユーザーが
# 最後に表示していたかを `app_state/ui_state.json` に記録する。
# - editor → 編集画面 (アクティブプロジェクトが復元されているのが前提)
# - dashboard → プロジェクト一覧
# 実装は素朴な「文字列 1 つを持つ JSON」。互換性が破れたら editor にフォール
# バックして無視する。

def _load_ui_state() -> dict[str, str]:
    if not UI_STATE_PATH.exists():
        return {"view": "editor"}
    try:
        data = json.loads(UI_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"view": "editor"}
    if not isinstance(data, dict):
        return {"view": "editor"}
    view = data.get("view")
    if view not in ("editor", "dashboard"):
        return {"view": "editor"}
    return {"view": view}


def _save_ui_state(view: str) -> dict[str, str]:
    if view not in ("editor", "dashboard"):
        raise ValueError("view は 'editor' または 'dashboard' を指定してください")
    UI_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "view": view,
        "updatedAt": datetime.now(tz=timezone.utc).isoformat(),
    }
    UI_STATE_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"view": view}


@app.get("/api/ui-state")
def get_ui_state() -> dict[str, str]:
    return _load_ui_state()


@app.post("/api/ui-state")
def post_ui_state(payload: dict[str, Any]) -> dict[str, str]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="リクエストボディが不正です")
    view = str(payload.get("view") or "").strip()
    try:
        return _save_ui_state(view)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/global-config")
def get_global_config_endpoint() -> dict[str, Any]:
    config = load_global_config()
    return {
        "config": config,
        "builtInVideoPresets": decorate_video_presets(BUILTIN_VIDEO_PRESETS),
        "customVideoPresets": decorate_video_presets(
            [p for p in (config.get("videoExport", {}).get("customPresets") or []) if isinstance(p, dict)]
        ),
        "ffmpeg": _ffmpeg_status_payload(),
    }


@app.post("/api/global-config")
def post_global_config_endpoint(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        config = save_global_config(payload or {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    configure_app_logging(quiet=bool((config.get("logging") or {}).get("quietMode")))
    return {
        "ok": True,
        "config": config,
        "builtInVideoPresets": decorate_video_presets(BUILTIN_VIDEO_PRESETS),
        "customVideoPresets": decorate_video_presets(
            [p for p in (config.get("videoExport", {}).get("customPresets") or []) if isinstance(p, dict)]
        ),
        "ffmpeg": _ffmpeg_status_payload(),
    }


# ---------- 音声合成 (VOICEVOX / Voicepeak) ---------------------------------


def _tts_resolve_paths_for_state() -> dict[str, str | None]:
    cfg = load_global_config().get("tts") or {}
    return {
        "voicevox_app_path": (cfg.get("voicevoxAppPath") or "").strip() or None,
        "voicevox_base_url": (cfg.get("voicevoxBaseUrl") or "").strip() or None,
        "voicepeak_bin_path": (cfg.get("voicepeakBinPath") or "").strip() or None,
    }


def _tts_state_payload() -> dict[str, Any]:
    paths = _tts_resolve_paths_for_state()
    state = tts_mod.detect_state(
        voicevox_app_path=paths["voicevox_app_path"],
        voicevox_base_url=paths["voicevox_base_url"],
        voicepeak_bin_path=paths["voicepeak_bin_path"],
    )
    return state.to_dict()


@app.get("/api/tts/state")
def get_tts_state() -> dict[str, Any]:
    return _tts_state_payload()


@app.post("/api/tts/refresh")
def refresh_tts_catalog() -> dict[str, Any]:
    paths = _tts_resolve_paths_for_state()
    state = tts_mod.refresh_catalog(
        voicevox_app_path=paths["voicevox_app_path"],
        voicevox_base_url=paths["voicevox_base_url"],
        voicepeak_bin_path=paths["voicepeak_bin_path"],
    )
    return {"ok": True, **state.to_dict()}


def _tts_audio_dir(ctx: ProjectContext) -> Path:
    target = ctx.root / "assets" / "audio" / "tts"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _tts_compose_filename(
    cut_index: int | str | None,
    text: str,
    narrator: str,
    emotion: str,
) -> str:
    from datetime import datetime

    head = "".join(ch for ch in (text or "").strip().splitlines()[0] if ch != "/")[:16]
    head = safe_asset_filename(head or "serif").rsplit(".", 1)[0]
    narrator_part = safe_asset_filename(str(narrator or "voice")).rsplit(".", 1)[0]
    emotion_part = safe_asset_filename(str(emotion or "normal")).rsplit(".", 1)[0]
    cut_part = ""
    if cut_index is not None:
        try:
            cut_part = f"{int(cut_index):03d}"
        except (TypeError, ValueError):
            cut_part = safe_asset_filename(str(cut_index)).rsplit(".", 1)[0]
    timestamp = datetime.now().strftime("%y%m%d-%H%M%S")
    parts = [p for p in [cut_part, head, narrator_part, emotion_part, timestamp] if p]
    return "-".join(parts) + ".wav"


def _normalize_bulk_voice(raw_voice: Any) -> str:
    """item の voice 指定を文字列化する (空白 trim のみ)。

    voice は ``voicevox:四国めたん/ノーマル`` / ``voicepeak:Miyamai Moca`` のように
    アプリ名 prefix を含む完全形を必須とする。
    数値 / null は ``""`` を返し、後段で warnings に拾わせる。
    """
    if raw_voice is None:
        return ""
    if isinstance(raw_voice, str):
        return raw_voice.strip()
    # 数値や bool が来た場合は str 化して返し、parse 側で「prefix が無い」判定に流す
    return str(raw_voice).strip()


@app.post("/api/tts/parse-yaml")
def parse_tts_bulk_yaml(payload: dict[str, Any]) -> dict[str, Any]:
    """カット一括追加 YAML のパース。フロントが per-item 合成するためのデータを返す。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="リクエストボディが不正です")
    yaml_text = str(payload.get("yaml") or "")
    if not yaml_text.strip():
        raise HTTPException(status_code=400, detail="YAML が空です")
    try:
        import yaml  # type: ignore
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="YAML パーサ (PyYAML) が見つかりません",
        ) from exc
    try:
        data = yaml.safe_load(yaml_text)
    except yaml.YAMLError as exc:
        raise HTTPException(status_code=400, detail=f"YAML の構文エラー: {exc}") from exc
    if data is None:
        return {"items": [], "warnings": []}
    if isinstance(data, dict) and "segments" in data:
        raw_list = data.get("segments") or []
    elif isinstance(data, list):
        raw_list = data
    else:
        raise HTTPException(status_code=400, detail="YAML はセリフのリストとして書いてください")

    items: list[dict[str, Any]] = []
    warnings: list[str] = []
    for n, raw in enumerate(raw_list, start=1):
        if not isinstance(raw, dict):
            warnings.append(f"#{n} は dict 形式ではありません（スキップ）")
            continue
        text = raw.get("text")
        if isinstance(text, list):
            text = "\n".join(str(line) for line in text)
        text = str(text or "").rstrip()
        if not text:
            warnings.append(f"#{n} に text がありません（スキップ）")
            continue
        speaker_raw = raw.get("speaker")
        speaker = str(speaker_raw or "").strip() if speaker_raw is not None else ""
        index = raw.get("index")
        try:
            index_int = int(index) if index is not None else n
        except (TypeError, ValueError):
            index_int = n
        voice_id = _normalize_bulk_voice(raw.get("voice"))
        if voice_id and not (
            voice_id.startswith("voicevox:") or voice_id.startswith("voicepeak:")
        ):
            warnings.append(
                f"#{n} の voice ({voice_id!r}) は 'voicevox:四国めたん/ノーマル' のような "
                "アプリ名 prefix 付き形式で書いてください（スキップ）"
            )
            voice_id = ""
        # voicepeak は voice ID に感情を含める表記 'voicepeak:{narrator}/{emotion}'
        # を許容する。ここで切り出して emotion フィールドへ振り分ける。
        # voicevox は 'voicevox:{narrator}/{styleName}' なので "/" は emotion ではない。
        emotion = ""
        if voice_id.startswith("voicepeak:"):
            sub = voice_id[len("voicepeak:") :]
            if "/" in sub:
                narrator_part, _, emotion_part = sub.partition("/")
                voice_id = f"voicepeak:{narrator_part}"
                emotion = emotion_part.strip()
        # 後方の参考用: emotion フィールドが手書きで指定されていれば、
        # voice 側の prefix が無いケースの fallback として採用。
        if not emotion:
            emotion_raw = raw.get("emotion")
            if emotion_raw is not None:
                emotion = str(emotion_raw).strip()
        try:
            pause_sec = float(raw.get("pause_sec") or 0.0)
        except (TypeError, ValueError):
            pause_sec = 0.0
        items.append(
            {
                "index": index_int,
                "speakerCharacterId": speaker,
                "voiceId": voice_id,
                "emotion": emotion,
                "pauseSec": max(0.0, pause_sec),
                "text": text,
            }
        )
    return {"items": items, "warnings": warnings}


@app.post("/api/telop/parse-yaml")
def parse_telop_bulk_yaml(payload: dict[str, Any]) -> dict[str, Any]:
    """テロップ一括追加 YAML のパース。「テロップ書き出し」と互換のフォーマットを取り込む。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="リクエストボディが不正です")
    yaml_text = str(payload.get("yaml") or "")
    if not yaml_text.strip():
        raise HTTPException(status_code=400, detail="YAML が空です")
    try:
        import yaml  # type: ignore
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="YAML パーサ (PyYAML) が見つかりません",
        ) from exc
    try:
        data = yaml.safe_load(yaml_text)
    except yaml.YAMLError as exc:
        raise HTTPException(status_code=400, detail=f"YAML の構文エラー: {exc}") from exc
    if data is None:
        return {"items": [], "warnings": []}
    if isinstance(data, list):
        raw_list = data
    elif isinstance(data, dict) and "telops" in data:
        raw_list = data.get("telops") or []
    else:
        raise HTTPException(
            status_code=400,
            detail="YAML はテロップのリストとして書いてください (- index / start_sec / duration_sec / text)",
        )

    items: list[dict[str, Any]] = []
    warnings: list[str] = []
    for n, raw in enumerate(raw_list, start=1):
        if not isinstance(raw, dict):
            warnings.append(f"#{n} は dict 形式ではありません（スキップ）")
            continue
        text = raw.get("text")
        if isinstance(text, list):
            text = "\n".join(str(line) for line in text)
        text = str(text or "").rstrip()
        if not text:
            warnings.append(f"#{n} に text がありません（スキップ）")
            continue
        try:
            start_sec = float(raw.get("start_sec") or 0.0)
        except (TypeError, ValueError):
            start_sec = 0.0
        try:
            duration_sec = float(raw.get("duration_sec") or 0.0)
        except (TypeError, ValueError):
            duration_sec = 0.0
        if duration_sec <= 0:
            warnings.append(f"#{n} の duration_sec が 0 以下です（1.0 として扱います）")
            duration_sec = 1.0
        style = raw.get("style") if isinstance(raw.get("style"), dict) else None
        items.append(
            {
                "index": n,
                "startSec": max(0.0, start_sec),
                "durationSec": duration_sec,
                "text": text,
                "style": style,
            }
        )
    return {"items": items, "warnings": warnings}


@app.post("/api/tts/synthesize")
def synthesize_tts(payload: dict[str, Any]) -> dict[str, Any]:
    """単発合成。``projects/<id>/assets/audio/tts/`` に wav を書き出して
    プロジェクト manifest を再スキャンしたうえで返す。"""
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="リクエストボディが不正です")

    voice_id = str(payload.get("voiceId") or "").strip()
    text = str(payload.get("text") or "").strip()
    if not voice_id:
        raise HTTPException(status_code=400, detail="voiceId は必須です")
    if not text:
        raise HTTPException(status_code=400, detail="text は必須です")

    emotion = (payload.get("emotion") or "").strip() or None
    cut_index = payload.get("cutIndex")
    skip_manifest = bool(payload.get("skipManifest"))

    try:
        ctx = current_project()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"プロジェクトが選択されていません: {exc}") from exc

    paths = _tts_resolve_paths_for_state()
    state = tts_mod.detect_state(
        voicevox_app_path=paths["voicevox_app_path"],
        voicevox_base_url=paths["voicevox_base_url"],
        voicepeak_bin_path=paths["voicepeak_bin_path"],
    )

    # voicevox を要求していて Engine が落ちていたら、ここで起動を試みる。
    # ボイスを再生成 / 一括合成のときに「全体設定 → ボイスを登録」を押し直す
    # ことなく自動復帰できるようにする狙い。
    if voice_id.startswith("voicevox:") and state.voicevox_app_path and not state.voicevox_engine_alive:
        try:
            tts_mod.launch_voicevox_app(Path(state.voicevox_app_path))
            state.voicevox_engine_alive = tts_mod.wait_for_voicevox_engine(
                state.voicevox_base_url, timeout_sec=15.0
            )
        except (FileNotFoundError, OSError):
            state.voicevox_engine_alive = False
    state_dict = state.to_dict()

    catalog = state_dict["voices"]
    catalog_entry = next((v for v in catalog if v.get("id") == voice_id), None)
    narrator = (catalog_entry or {}).get("narrator") or voice_id.split(":", 1)[-1]
    filename = _tts_compose_filename(cut_index, text, str(narrator), emotion or "")
    out_path = _tts_audio_dir(ctx) / filename

    try:
        result = tts_mod.synthesize(
            voice_id=voice_id,
            text=text,
            output_path=out_path,
            emotion=emotion,
            voicevox_base_url_value=state.voicevox_base_url,
            voicepeak_bin=Path(state.voicepeak_bin_path) if state.voicepeak_bin_path else None,
            voice_catalog=catalog,
        )
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    rel_path = result.audio_path.relative_to(PROJECT_ROOT).as_posix()
    duration = audio_duration_seconds(result.audio_path)

    response: dict[str, Any] = {
        "ok": True,
        "audioPath": rel_path,
        "filename": filename,
        "durationSec": duration,
        "narrator": result.narrator,
        "emotion": result.emotion,
        "voiceId": result.voice_id,
        "app": result.app,
    }
    if not skip_manifest:
        manifest = generate_manifest(ctx)
        manifest = attach_character_definitions(merge_project_asset_manifest(manifest, ctx), ctx)
        with ctx.manifest_path.open("w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
        config = ensure_config(ctx)
        manifest = apply_config_defaults(manifest, config)
        manifest["config"] = config
        manifest["expressionPresets"] = ensure_expression_presets(manifest, ctx)
        response["manifest"] = manifest
    return response


@app.post("/api/ffmpeg/refresh")
def refresh_ffmpeg_capabilities() -> dict[str, Any]:
    detect_ffmpeg_capabilities(force=True)
    return {
        "ok": True,
        "ffmpeg": _ffmpeg_status_payload(),
        "builtInVideoPresets": decorate_video_presets(BUILTIN_VIDEO_PRESETS),
    }


_IMPORTMAP_RE = re.compile(
    r'<script\s+type="importmap">\s*\{[\s\S]*?\}\s*</script>',
    re.IGNORECASE,
)


def _render_html_with_importmap(path: Path) -> HTMLResponse:
    """index.html / v2-export*.html を読み込み、<script type="importmap"> を
    現在の vendor 設定 (CDN or local) に置き換えて返す。
    """
    html = path.read_text(encoding="utf-8")
    use_cdn = bool(
        (load_global_config().get("vendor") or {}).get("useCdn", False)
    )
    imports = vendor_mod.resolve_importmap(use_cdn=use_cdn)
    importmap_block = (
        '<script type="importmap">'
        + json.dumps({"imports": imports}, ensure_ascii=False)
        + "</script>"
    )
    if _IMPORTMAP_RE.search(html):
        html = _IMPORTMAP_RE.sub(importmap_block, html, count=1)
    else:
        # importmap が無い HTML には何もしない (以前の実装を維持)。
        pass
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/")
def index() -> HTMLResponse:
    return _render_html_with_importmap(STATIC_DIR / "index.html")


@app.get("/v2-export-bench")
def v2_export_bench_page() -> HTMLResponse:
    """WebGL export PoC ページ。本体 UI とは独立。"""
    return _render_html_with_importmap(STATIC_DIR / "v2-export-bench.html")


@app.get("/v2-export")
def v2_export_page() -> HTMLResponse:
    """WebGL export 本実装ページ (Step 0)。本体 UI とは独立。"""
    return _render_html_with_importmap(STATIC_DIR / "v2-export.html")


@app.get("/title-editor")
def title_editor_page() -> HTMLResponse:
    """タイトル組版エディタ (Phase 7)。プロジェクト非依存の独立ユーティリティ。
    16:9 キャンバスに複数の TextClip を配置して静的 PNG として書き出す。"""
    return _render_html_with_importmap(STATIC_DIR / "title-editor.html")


# ---------------------------------------------------------------------------
# Title Composition CRUD (Phase 7)
# ---------------------------------------------------------------------------


@app.get("/api/title-compositions")
def title_compositions_list() -> dict[str, Any]:
    from .title_compositions import list_compositions
    return {"compositions": list_compositions()}


@app.get("/api/title-compositions/{comp_id}")
def title_composition_get(comp_id: str) -> dict[str, Any]:
    from .title_compositions import get_composition
    try:
        comp = get_composition(comp_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if comp is None:
        raise HTTPException(status_code=404, detail="composition not found")
    return comp


@app.post("/api/title-compositions")
async def title_composition_create(request: Request) -> dict[str, Any]:
    from .title_compositions import create_composition
    payload = await request.json()
    try:
        return create_composition(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.put("/api/title-compositions/{comp_id}")
async def title_composition_update(comp_id: str, request: Request) -> dict[str, Any]:
    from .title_compositions import update_composition
    payload = await request.json()
    try:
        return update_composition(comp_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/api/title-compositions/{comp_id}")
def title_composition_delete(comp_id: str) -> dict[str, Any]:
    from .title_compositions import delete_composition
    try:
        ok = delete_composition(comp_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not ok:
        raise HTTPException(status_code=404, detail="composition not found")
    return {"ok": True}


@app.post("/api/title-editor/export-png")
async def title_editor_export_png(request: Request) -> dict[str, Any]:
    """タイトル組版エディタ から PNG を「アセット共通」または「現行プロジェクト」の
    foregrounds/ サブディレクトリに保存する。

    body = {
        target: "shared" | "project",
        filename: str,           # 拡張子 .png は無くても付ける
        pngBase64: str,          # data:image/png;base64,... or 純 base64
    }
    """
    import base64

    payload = await request.json()
    target = str(payload.get("target") or "").strip().lower()
    if target not in ("shared", "project"):
        raise HTTPException(status_code=400, detail="target must be 'shared' or 'project'")
    raw_filename = str(payload.get("filename") or "").strip() or "title"
    # 安全なファイル名 (Windows / Unix 共通の禁則文字を除去) + 拡張子強制
    safe = re.sub(r"[\\/:*?\"<>|]+", "_", raw_filename)
    safe = safe.strip(" .") or "title"
    if not safe.lower().endswith(".png"):
        safe = f"{safe}.png"
    if len(safe) > 120:
        safe = safe[:116] + ".png"

    png_raw = str(payload.get("pngBase64") or "")
    if png_raw.startswith("data:"):
        _, _, png_raw = png_raw.partition(",")
    try:
        data = base64.b64decode(png_raw, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid pngBase64: {exc}")
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(status_code=400, detail="data is not a PNG")

    if target == "shared":
        base_dir = ASSETS_DIR / "foregrounds"
        rel_root = "assets/foregrounds"
    else:
        try:
            active_id = ACTIVE_PROJECT_PATH.read_text(encoding="utf-8").strip()
        except Exception:
            active_id = ""
        if not active_id:
            raise HTTPException(status_code=400, detail="現行プロジェクトが未指定です (本体側で 1 つ開いてから書き出してください)")
        project_root = current_projects_dir() / active_id
        if not project_root.exists():
            raise HTTPException(status_code=400, detail=f"プロジェクト '{active_id}' が見つかりません")
        base_dir = project_root / "assets" / "foregrounds"
        rel_root = f"projects/{active_id}/assets/foregrounds"

    base_dir.mkdir(parents=True, exist_ok=True)
    out_path = base_dir / safe
    # 既存ファイルがあれば連番で衝突回避 (= 「.png」を「_2.png」「_3.png」...)
    if out_path.exists():
        stem = out_path.stem
        i = 2
        while True:
            cand = base_dir / f"{stem}_{i}.png"
            if not cand.exists():
                out_path = cand
                safe = cand.name
                break
            i += 1
    out_path.write_bytes(data)
    return {
        "ok": True,
        "savedPath": f"{rel_root}/{safe}",
        "filename": safe,
        "target": target,
        "bytes": len(data),
    }


@app.get("/api/title-editor/manifest")
def title_editor_manifest() -> dict[str, Any]:
    """タイトル組版エディタ用の軽量 manifest (= フォント一覧 + 既定書体)。
    プロジェクト非依存にしたいが、フォント定義はプロジェクトの config.json に
    入っているため、active project か最初に見つけた project の config を流用する。"""
    target_path: Path | None = None
    # まず active project
    try:
        active_id = ACTIVE_PROJECT_PATH.read_text(encoding="utf-8").strip()
    except Exception:
        active_id = ""
    if active_id:
        candidate = current_projects_dir() / active_id / "config.json"
        if candidate.exists():
            target_path = candidate
    if target_path is None:
        for p in sorted(current_projects_dir().glob("*/config.json")):
            target_path = p
            break
    cfg: dict[str, Any] = {}
    if target_path is not None:
        try:
            with target_path.open("r", encoding="utf-8") as fp:
                cfg = json.load(fp)
        except Exception:
            cfg = {}
    return {
        "fonts": cfg.get("fonts", []),
        "fontWeights": cfg.get("fontWeights", []),
        "defaultFont": cfg.get("defaultFont", ""),
        "defaultFontWeight": cfg.get("defaultFontWeight", "regular"),
    }


# ---------------------------------------------------------------------------
# JS vendor (three / mp4box) 管理
# ---------------------------------------------------------------------------


@app.get("/api/vendor/state")
def vendor_state_endpoint() -> dict[str, Any]:
    cfg = load_global_config()
    return {
        "useCdn": bool((cfg.get("vendor") or {}).get("useCdn", False)),
        **vendor_mod.vendor_state(),
    }


@app.post("/api/vendor/install")
def vendor_install_endpoint(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    lib = str(payload.get("lib") or "").strip()
    version = str(payload.get("version") or "").strip()
    if not version:
        version = vendor_mod.RECOMMENDED_VERSIONS.get(lib, "")
    try:
        result = vendor_mod.install_lib(lib, version)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"インストールに失敗しました: {exc}") from exc
    return {"ok": True, "result": result, **vendor_mod.vendor_state()}


@app.post("/api/vendor/remove")
def vendor_remove_endpoint(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    lib = str(payload.get("lib") or "").strip()
    version = str(payload.get("version") or "").strip()
    try:
        vendor_mod.remove_lib(lib, version)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, **vendor_mod.vendor_state()}


@app.post("/api/vendor/active")
def vendor_active_endpoint(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    lib = str(payload.get("lib") or "").strip()
    version = str(payload.get("version") or "").strip()
    try:
        vendor_mod.set_active(lib, version)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, **vendor_mod.vendor_state()}


# ---------------------------------------------------------------------------
# デフォルトフォント (Noto Sans JP 等) の取得
# ---------------------------------------------------------------------------


@app.get("/api/fonts/installed")
def fonts_installed_endpoint() -> dict[str, Any]:
    return {
        "installed": fonts_mod.installed_font_packages(),
        "available": [
            {"name": k, "family": v["family"]}
            for k, v in fonts_mod.INSTALLABLE_FONTS.items()
        ],
    }


@app.post("/api/fonts/install")
def fonts_install_endpoint(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    name = str(payload.get("name") or "").strip()
    try:
        result = fonts_mod.install_font_package(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"インストール失敗: {exc}") from exc
    return {"ok": True, "result": result, "installed": fonts_mod.installed_font_packages()}


@app.get("/api/fonts/scan-detail")
def fonts_scan_detail_endpoint() -> dict[str, Any]:
    """``assets/fonts/`` を 1 ファイル単位でスキャンし、検出 weight と override を返す。

    UI (全体設定 → 環境タブのフォント認識表) からも、診断目的の curl からも使う。
    """
    from .font_inspect import inspect_font
    from .config import font_family_and_weight, display_name_for_font

    cfg = load_global_config()
    overrides = (cfg.get("fontWeightOverrides") or {}) if isinstance(cfg.get("fontWeightOverrides"), dict) else {}
    weight_choices = (
        cfg.get("fontWeights")
        or [
            {"id": "thin", "name": "Thin"},
            {"id": "extra_light", "name": "Extra Light"},
            {"id": "light", "name": "Light"},
            {"id": "demi_light", "name": "Demi Light"},
            {"id": "regular", "name": "Regular"},
            {"id": "medium", "name": "Medium"},
            {"id": "semi_bold", "name": "Semi Bold"},
            {"id": "bold", "name": "Bold"},
            {"id": "extra_bold", "name": "Extra Bold"},
            {"id": "black", "name": "Black"},
        ]
    )

    fonts_dir = ASSETS_DIR / "fonts"
    files: list[dict[str, Any]] = []
    if fonts_dir.exists():
        for path in sorted([*fonts_dir.rglob("*.otf"), *fonts_dir.rglob("*.ttf")]):
            rel = relative_to_root(path)
            meta = inspect_font(path)
            stem_family, stem_weight = font_family_and_weight(path.stem)
            display_family = display_name_for_font(meta, stem_family)
            os2_weight = meta.get("weight_id") or ""
            detected = os2_weight or stem_weight or "regular"
            override = overrides.get(rel, "")
            files.append({
                "path": rel,
                "filename": path.name,
                "displayFamily": display_family,
                "metaFamily": meta.get("family", ""),
                "metaSubfamily": meta.get("subfamily", ""),
                "weightClass": int(meta.get("weight_class") or 0),
                "isVariable": bool(meta.get("is_variable")),
                "detectedWeight": detected,
                "stemWeight": stem_weight,
                "os2Weight": os2_weight,
                "override": override,
                "effectiveWeight": override or detected,
                "source": "override" if override else ("os2" if os2_weight else "filename"),
            })
    return {
        "files": files,
        "weightChoices": weight_choices,
        "overrides": overrides,
    }


# ============================================================================
# アプリ内アップデータ (git pull ラッパ)
# ============================================================================

def _resolve_update_channel(override: str | None = None) -> str:
    """payload/query で渡された channel を、無ければ global_config から取得する。"""
    if override:
        return override
    try:
        return str(load_global_config().get("update", {}).get("channel") or "stable")
    except Exception:  # noqa: BLE001
        return "stable"


@app.get("/api/system/health")
def system_health_endpoint() -> dict[str, Any]:
    """実行環境の書き出し性能に関わる診断結果を返す。

    websockets.speedups (C 拡張) の有無 / Python バージョン / プラットフォームを
    返し、degraded (= 書き出しが遅くなる構成) なら warnings に対処案内を載せる。
    環境タブの診断パネルで表示する。
    """
    return runtime_health.diagnose()


@app.get("/api/update/check")
def update_check_endpoint(channel: str | None = None) -> dict[str, Any]:
    """origin/<channel に対応する branch> を fetch して HEAD との差分を返す。

    channel: "stable" (= origin/main) or "dev" (= origin/dev)。
    省略時は global_config の update.channel に従う。
    """
    resolved = _resolve_update_channel(channel)
    return update_mod.check_for_updates(channel=resolved)


@app.post("/api/update/apply")
def update_apply_endpoint(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """git pull を実行してアップデートを適用する。

    Payload (全て optional):
      - channel:       "stable" | "dev" — 省略時は global_config に従う
      - includeAssets: bool (default False) — assets/ も最新版に上書きするか
      - backup:        bool (default True)  — 適用前にバックアップを取るか
      - discardLocalChanges: bool (default False) — modified file を破棄して進めるか
      - reinstallDeps: bool (default False) — 適用後に pip install -r requirements.txt するか
    """
    payload = payload or {}
    channel = _resolve_update_channel(payload.get("channel"))
    include_assets = bool(payload.get("includeAssets", False))
    backup = bool(payload.get("backup", True))
    discard = bool(payload.get("discardLocalChanges", False))
    reinstall_deps = bool(payload.get("reinstallDeps", False))
    try:
        return update_mod.apply_update(
            channel=channel,
            include_assets=include_assets,
            backup=backup,
            discard_local_changes=discard,
            reinstall_deps=reinstall_deps,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"アップデートの実行に失敗しました: {exc}") from exc


app.mount("/static", NoStoreStaticFiles(directory=STATIC_DIR), name="static")


# 旧実装は `app.mount("/assets", StaticFiles(directory=PROJECT_ROOT))` で
# PROJECT_ROOT 全体を `/assets/<rel>` から読めるようにしていた。これは
# - app_state/active_project.txt
# - projects/<id>/scenarios/*.json
# - projects/<id>/project.json / config.json / expression_presets.json
# - app/*.py 等の実装ファイル
# まで LAN 公開時に取得できてしまう。実 URL は `assets/<...>` と
# `projects/<id>/assets/<...>` の 2 パターンしか必要ないので、明示的に
# allowlist してそれ以外を 404 にする。
_ASSET_ROUTE_BASE = PROJECT_ROOT.resolve()


def _is_allowed_asset_rel(rel: str) -> bool:
    if not rel:
        return False
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return False
    if parts[0] == "assets":
        return len(parts) >= 2
    if parts[0] == "projects":
        # projects/<id>/assets/...
        return len(parts) >= 4 and parts[2] == "assets"
    return False


@app.get("/assets/{rel:path}")
def get_asset_file(rel: str) -> FileResponse:
    rel_norm = rel.replace("\\", "/").lstrip("/")
    if not _is_allowed_asset_rel(rel_norm):
        raise HTTPException(status_code=404, detail="Not found")
    candidate = (PROJECT_ROOT / rel_norm).resolve()
    try:
        candidate.relative_to(_ASSET_ROUTE_BASE)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Not found") from exc
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(candidate)


# zensical で生成された docs/ をヘルプとして配信。FastAPI は /docs を Swagger UI に
# 予約しているため、`/help` にマウントして衝突を回避する。
if DOCS_DIR.exists():
    app.mount("/help", StaticFiles(directory=DOCS_DIR, html=True), name="help")


# ★★★ 最後に SwallowResponseRaceMiddleware で ASGI ラップする ★★★
# Starlette / FastAPI のデフォルト middleware (ServerErrorMiddleware /
# ExceptionMiddleware) は app の最外層に位置するため、それらが raise する
# Content-Length 不整合の RuntimeError を catch するにはさらにその外側に
# middleware を置く必要がある。app.add_middleware だと内側にしか入らないので、
# ファイル末尾で ASGI 呼び出し可能オブジェクトとして wrap する。
# これ以降、`app` は FastAPI インスタンスではなくミドルウェアラッパだが、
# uvicorn は ASGI callable として呼ぶだけなので問題ない。route 追加など
# FastAPI の API は使えなくなる点に注意。
app = SwallowResponseRaceMiddleware(app)

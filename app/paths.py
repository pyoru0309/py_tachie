"""パス定数（プロジェクトルート / 各ストレージディレクトリ / アクティブプロジェクト記録）。

このモジュールは他の app/ モジュールに依存しない。逆に他のモジュールからは
`from .paths import PROJECT_ROOT, ...` の形で参照される。
"""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = PROJECT_ROOT / "app_state"
DEFAULT_PROJECTS_DIR = PROJECT_ROOT / "projects"
ASSETS_DIR = PROJECT_ROOT / "assets"
OUTPUT_DIR = PROJECT_ROOT / "outputs"
CACHE_DIR = PROJECT_ROOT / "cache"
STATIC_DIR = PROJECT_ROOT / "static"
DOCS_DIR = PROJECT_ROOT / "docs"
# ★ Phase 7: プロジェクト非依存の「タイトル組版」(= /title-editor で作る静的 PNG 用の
#   組版データ) を置くディレクトリ。projects/<id>/ と独立して横断的に管理する。
TITLE_COMPOSITIONS_DIR = PROJECT_ROOT / "title_compositions"
ACTIVE_PROJECT_PATH = STATE_DIR / "current_project.txt"
PSD_MANIFEST_PATH = ASSETS_DIR / "character_manifest.json"
GLOBAL_CONFIG_PATH = STATE_DIR / "global_config.json"
UI_STATE_PATH = STATE_DIR / "ui_state.json"
DEFAULT_PROJECT_ID = "default"

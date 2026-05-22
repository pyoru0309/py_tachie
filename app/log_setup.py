"""アプリ全体のログ統一ヘルパ。

このプロジェクトはこれまで `print(..., file=sys.stderr, flush=True)` で自前ログを
書いていたが、`logging` 経路を通っていないため `quietMode` 等のレベル制御が効か
ない問題があった。本 module で以下を一括管理する:

- `app_logger("foo")` で `splite_anime.foo` logger を取得 (各 module から呼ぶ)
- `configure_app_logging(quiet=...)` で:
  - quiet=True  → `uvicorn / uvicorn.access / uvicorn.error / splite_anime` を
    すべて WARNING 化 (起動メッセージや per-frame アクセスログを抑止)
  - quiet=False → 上記をすべて INFO 化 (= 重要イベントは出るが per-input 詳細は
    DEBUG なので出ない)

`splite_anime` logger 単独で StreamHandler を 1 個だけ attach し、root の伝播を
止める (= 多重ログを防止)。format は短く `[<name>] message`。
"""

from __future__ import annotations

import logging
import sys

_ROOT_LOGGER_NAME = "splite_anime"

_AFFECTED_LOGGERS = (
    _ROOT_LOGGER_NAME,
    "uvicorn",
    "uvicorn.access",
    "uvicorn.error",
)


def app_logger(name: str | None = None) -> logging.Logger:
    """`splite_anime[.<name>]` logger を返す。

    module 側からは `log = app_logger(__name__.split('.')[-1])` のように
    呼び出すと、`splite_anime.<module>` の階層 logger が手に入る。
    """
    if not name:
        return logging.getLogger(_ROOT_LOGGER_NAME)
    return logging.getLogger(f"{_ROOT_LOGGER_NAME}.{name}")


_HANDLER_ATTACHED = False


def _ensure_root_handler() -> None:
    """`splite_anime` logger に StreamHandler(stderr) を 1 個だけ付与する。

    一度だけ実行。`propagate=False` で root logger には流さない (= uvicorn の
    handler と二重出力にならないように)。
    """
    global _HANDLER_ATTACHED
    if _HANDLER_ATTACHED:
        return
    root = logging.getLogger(_ROOT_LOGGER_NAME)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("[%(name)s] %(message)s"))
    root.addHandler(handler)
    root.propagate = False
    _HANDLER_ATTACHED = True


def configure_app_logging(*, quiet: bool) -> None:
    """全 app/uvicorn logger のレベルを quiet に応じて設定する。

    起動時 + `/api/config` 更新時に呼ぶ。
    - quiet=True : WARNING (= ノイズ抑制、起動メッセージや per-frame アクセスログ無し)
    - quiet=False: INFO    (= ユーザ操作の重要イベントは出る。per-input 詳細は DEBUG)
    """
    _ensure_root_handler()
    level = logging.WARNING if quiet else logging.INFO
    for name in _AFFECTED_LOGGERS:
        logging.getLogger(name).setLevel(level)

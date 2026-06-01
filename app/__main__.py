"""``python -m app`` で uvicorn を起動するための薄いラッパ。

PoC で必要だった ``--ws-per-message-deflate false`` をはじめとする起動オプションを
ここで一元化しておき、ユーザは ``python -m app`` だけで開発サーバを立てられる。

例::

    python -m app                       # デフォルト (127.0.0.1:8000, reload あり)
    python -m app --port 8080           # ポート上書き
    python -m app --host 0.0.0.0        # LAN 公開
    python -m app --no-reload           # reload 無効化 (本番想定)

PoC 期間に得た知見:
- ``ws_per_message_deflate=False`` を必ず明示する。圧縮ありだと PoC bench で 6.7fps、
  なしだと 110fps 出る (project_v2_export_poc_simple_baseline_2026_05_05.md)。
- websockets 拡張は ``websockets`` パッケージが必要。requirements.txt で明示済み。
- Windows では reload を有効にすると uvicorn が subprocess 非対応の
  SelectorEventLoop を強制し、動画書き出し (asyncio サブプロセスで ffmpeg を起動)
  が FFMPEG_SPAWN_FAILED になる。このため Windows では reload を自動無効化する。
"""

from __future__ import annotations

import argparse
import sys


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app",
        description="立ち絵システム (FastAPI) の開発サーバ起動ラッパ",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="バインドするホスト (既定: 127.0.0.1)。LAN 公開時は 0.0.0.0",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="バインドするポート (既定: 8000)",
    )
    parser.add_argument(
        "--no-reload",
        dest="reload",
        action="store_false",
        help="uvicorn の autoreload を無効化する (本番想定)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="ワーカー数。指定すると reload は強制 OFF",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        help="uvicorn のログレベル (debug / info / warning / error)",
    )
    parser.set_defaults(reload=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    try:
        import uvicorn
    except ImportError:
        sys.stderr.write(
            "uvicorn が見つかりません。`python3 -m pip install -r requirements.txt` を実行してください。\n"
        )
        return 1

    reload = args.reload and args.workers is None
    workers = args.workers if args.workers and args.workers > 0 else None

    # Windows では uvicorn の reload / workers>1 (= use_subprocess=True) が
    # SelectorEventLoop を強制する。Windows の SelectorEventLoop は
    # asyncio.create_subprocess_exec を非サポートで NotImplementedError になり、
    # 動画書き出し (app/v2_export.py の WS 経路) が FFMPEG_SPAWN_FAILED で即死する。
    # ProactorEventLoop (subprocess 対応) を選ばせるため Windows では reload を無効化。
    if reload and sys.platform == "win32":
        reload = False
        sys.stderr.write(
            "[起動] Windows では動画書き出しとの互換性のため autoreload を無効化します"
            " (uvicorn の reload が subprocess 非対応の SelectorEventLoop を強制するため)。\n"
        )

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=reload,
        workers=workers,
        log_level=args.log_level,
        ws_per_message_deflate=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

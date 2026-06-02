"""実行環境の健全性診断 (書き出し速度に効く要素のチェック).

背景 (2026-06-02 の Windows 書き出し低速調査):
- v2 export は GL → RGBA → WebSocket → ffmpeg stdin の経路でフレームを流す。
- ブラウザ → サーバの WebSocket フレームは RFC 6455 によりマスクされており、
  サーバは受信フレームを 1 バイトずつアンマスク (XOR) する必要がある。
- ``websockets`` パッケージはこのアンマスク等を C 拡張 ``websockets.speedups``
  で高速化する。wheel に同梱されてくる。
- ところが **Python 3.14 では (調査時点で) speedups の wheel が無く**、pure-Python
  実装にフォールバックする。これが Windows の検証機で WS 受信を 70-100MB/s に頭打ち
  させ (Mac は speedups ありで 480-580MB/s)、書き出し fps が 1/4〜1/6 に落ちる主因
  だった。

この差は **git pull (アップデータ) では直せない**。speedups は Python ランタイム
バージョンと pip でビルドされる C 拡張の状態に依存し、git 管理対象ではないため。
そこで「自分の環境が degraded かどうか」を実行時に検出して、起動ログと環境タブの
診断パネルで明示し、ユーザに対処 (Python 3.12/3.13 への切替、依存再インストール) を
案内する。
"""

from __future__ import annotations

import platform
import sys
from functools import lru_cache
from typing import Any


def _websockets_version() -> str | None:
    try:
        import websockets  # noqa: PLC0415

        return getattr(websockets, "__version__", None)
    except Exception:  # noqa: BLE001
        return None


def _speedups_present() -> bool:
    """``websockets.speedups`` の C 拡張 (apply_mask) が利用可能かを返す。

    speedups が無い (= pure-Python フォールバック) と、ブラウザ → サーバの
    マスク済みバイナリフレームのアンマスクが遅くなり、書き出しが遅くなる。
    """
    try:
        from websockets.speedups import apply_mask  # noqa: PLC0415, F401

        return True
    except Exception:  # noqa: BLE001
        return False


@lru_cache(maxsize=1)
def diagnose() -> dict[str, Any]:
    """実行環境の書き出し性能に関わる診断結果を返す。

    Returns:
        ``{
            "ok": bool,                  # 致命的な欠落が無いか (= speedups 等が揃うか)
            "degraded": bool,            # 書き出しが遅くなる構成か
            "python": "3.14.0",
            "pythonVersionTuple": [3, 14, 0],
            "platform": "Windows-...",   # platform.platform()
            "isWindows": bool,
            "websocketsVersion": "16.0" | None,
            "websocketsSpeedups": bool,  # C 拡張 apply_mask が使えるか
            "warnings": [ {"code": str, "level": "warning"|"info",
                           "title": str, "detail": str, "action": str} ],
        }``
    """
    vt = sys.version_info
    speedups = _speedups_present()
    is_windows = sys.platform == "win32"

    warnings: list[dict[str, str]] = []

    if not speedups:
        # speedups 欠落は Windows で特に致命的 (WS 受信が頭打ち)。Mac/Linux でも
        # 遅くはなるが影響は相対的に小さい。
        if is_windows:
            warnings.append(
                {
                    "code": "ws_speedups_missing_windows",
                    "level": "warning",
                    "title": "動画書き出しが遅くなる構成です",
                    "detail": (
                        "WebSocket 高速化用の C 拡張 (websockets.speedups) が読み込まれて"
                        "いません。動画書き出しでブラウザからサーバへ送るフレームの処理が"
                        "頭打ちになり、書き出しが本来の 1/4〜1/6 程度まで遅くなります。"
                        f" 現在の Python は {vt.major}.{vt.minor}.{vt.micro} です。"
                    ),
                    "action": (
                        "Python 3.12 または 3.13 で動かすと speedups の wheel が入り高速化"
                        "されます。同じ Python のままなら "
                        "「依存パッケージを再インストール」を試すと、対応 wheel が公開済みの"
                        "場合に解消することがあります。"
                    ),
                }
            )
        else:
            warnings.append(
                {
                    "code": "ws_speedups_missing",
                    "level": "info",
                    "title": "WebSocket 高速化拡張が無効です",
                    "detail": (
                        "websockets.speedups (C 拡張) が読み込まれていません。"
                        "動画書き出しが多少遅くなる可能性があります。"
                    ),
                    "action": (
                        "気になる場合は依存パッケージの再インストール、または "
                        "Python 3.12/3.13 をお試しください。"
                    ),
                }
            )

    degraded = not speedups
    ok = speedups

    return {
        "ok": ok,
        "degraded": degraded,
        "python": f"{vt.major}.{vt.minor}.{vt.micro}",
        "pythonVersionTuple": [vt.major, vt.minor, vt.micro],
        "platform": platform.platform(),
        "isWindows": is_windows,
        "websocketsVersion": _websockets_version(),
        "websocketsSpeedups": speedups,
        "warnings": warnings,
    }


def log_startup_diagnostics(logger: Any) -> None:
    """起動時に診断結果をログへ出す。degraded なら WARNING、正常なら INFO/debug。

    ``logger`` は ``app.log_setup.app_logger(...)`` で得たロガーを想定。
    """
    info = diagnose()
    py = info["python"]
    ws_ver = info["websocketsVersion"] or "?"
    speedups = "有効" if info["websocketsSpeedups"] else "無効"
    if info["degraded"]:
        for w in info["warnings"]:
            logger.warning(
                "[環境診断] %s — %s %s",
                w["title"],
                w["detail"],
                w["action"],
            )
        logger.warning(
            "[環境診断] Python %s / websockets %s / speedups %s",
            py, ws_ver, speedups,
        )
    else:
        logger.info(
            "[環境診断] Python %s / websockets %s / speedups %s",
            py, ws_ver, speedups,
        )

"""WebGL export PoC: WebSocket で生 RGBA を受けて ffmpeg stdin に流す測定器。

前提:
- ブラウザ側 (static/js/v2-export-bench.js) が WebGL で 1 frame 描画 → readPixels →
  WS binary で送る、というループを回す。
- このサーバ側は ffmpeg を立ち上げて stdin に流すだけ。エンコーダや vflip 経路を
  選んで「render→readback→pipe→encode」の純粋 throughput を見る。

PoC のため、`/api/v2-export-bench/ws` に独自フォーマットを定義する:
  最初: JSON `{width, height, fps, encoder, vflip, totalFrames}`
  以降: binary RGBA (W*H*4 bytes) を 1 frame ごとに送信
  終端: client から JSON `{"type": "finish"}` を送る

サーバはエンコード完了後、final stats JSON を返して close する:
  `{type: "done", frames, elapsedSec, stdinWriteMs: {p50, p95, mean, max}, ffmpegRc}`
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from statistics import mean
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .global_config import ffmpeg_executable

router = APIRouter()

# 出力ファイルの一時置き場 (null 出力時は使わない)。
_OUTPUT_DIR = Path("/tmp/splite_v2_export_bench")
_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_v = sorted(values)
    k = max(0, min(len(sorted_v) - 1, int(round((p / 100.0) * (len(sorted_v) - 1)))))
    return sorted_v[k]


def _build_ffmpeg_cmd(
    width: int,
    height: int,
    fps: int,
    encoder: str,
    vflip: bool,
) -> tuple[list[str], str | None]:
    """encoder 識別子から ffmpeg コマンドを組み立てる。返り値: (cmd, output_path or None)

    encoder == "discard" の場合は ffmpeg を起動しない (caller 側で ffmpeg を
    spawn しない)。WS/ASGI 経路だけの throughput を見るための診断モード。
    """
    if encoder == "discard":
        return [], None  # caller が ffmpeg を起動しない
    ffmpeg = ffmpeg_executable()
    cmd: list[str] = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "rawvideo",
        "-pix_fmt", "rgba",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "pipe:0",
    ]
    if vflip:
        cmd.extend(["-vf", "vflip"])

    if encoder == "null":
        cmd.extend(["-f", "null", "-"])
        return cmd, None
    if encoder == "libx264_ultrafast":
        out = _OUTPUT_DIR / f"poc_x264_{width}x{height}.mp4"
        cmd.extend([
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-pix_fmt", "yuv420p",
            str(out),
        ])
        return cmd, str(out)
    if encoder == "h264_videotoolbox":
        out = _OUTPUT_DIR / f"poc_vt_{width}x{height}.mp4"
        cmd.extend([
            "-c:v", "h264_videotoolbox",
            "-q:v", "50",
            "-pix_fmt", "yuv420p",
            str(out),
        ])
        return cmd, str(out)
    if encoder == "h264_nvenc":
        out = _OUTPUT_DIR / f"poc_nvenc_{width}x{height}.mp4"
        cmd.extend([
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-rc", "vbr",
            "-cq", "22",
            "-b:v", "0",
            "-pix_fmt", "yuv420p",
            str(out),
        ])
        return cmd, str(out)
    raise ValueError(f"unknown encoder: {encoder}")


@router.websocket("/api/v2-export-bench/ws")
async def export_bench_ws(ws: WebSocket) -> None:
    await ws.accept()
    proc: asyncio.subprocess.Process | None = None
    output_path: str | None = None
    write_times_ms: list[float] = []
    drain_times_ms: list[float] = []
    receive_idle_ms: list[float] = []  # ws.receive() 自体の待ち時間 (Python 側に
    # frame が到着するまでに使った時間)。発行側 (browser) が backpressure で
    # 遅らせていれば大きく、ASGI/WebSocket 自体が詰まっていれば小さい (前 frame
    # 読み終わった瞬間に次がもう来ている)。
    frame_count = 0
    started = time.perf_counter()
    received_bytes = 0

    # 計測診断のため、handshake 時の WebSocket 拡張ネゴ結果を記録する。
    # `permessage-deflate` が含まれていると、raw RGBA を圧縮しようとして
    # CPU が暴れる可能性があるため、ベンチでは uvicorn を
    # `--ws-per-message-deflate=false` で起動するのが望ましい。
    ws_extensions = ws.headers.get("sec-websocket-extensions") or ""

    try:
        # 1) 始端ハンドシェイク
        handshake_text = await ws.receive_text()
        cfg = json.loads(handshake_text)
        width = int(cfg["width"])
        height = int(cfg["height"])
        fps = int(cfg.get("fps", 24))
        encoder = str(cfg.get("encoder", "null"))
        vflip = bool(cfg.get("vflip", False))
        total_frames = int(cfg.get("totalFrames", 240))
        expected_frame_bytes = width * height * 4

        try:
            cmd, output_path = _build_ffmpeg_cmd(width, height, fps, encoder, vflip)
        except ValueError as exc:
            await ws.send_text(json.dumps({"type": "error", "message": str(exc)}))
            await ws.close()
            return

        # 2) ffmpeg 起動 (encoder=="discard" のときは ffmpeg を起動せず、bytes を
        #    数えるだけ。WS/ASGI 経路の throughput を切り分けるための診断モード)
        if encoder != "discard":
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
            )

        await ws.send_text(json.dumps({
            "type": "ready",
            "ffmpegCmd": cmd,
            "outputPath": output_path,
            "expectedFrameBytes": expected_frame_bytes,
            "totalFrames": total_frames,
            "wsExtensions": ws_extensions,  # client 側に表示してユーザーが圧縮の有無を判定できる
        }))

        started = time.perf_counter()
        last_receive_end = started

        # 3) フレームループ
        while True:
            t_recv0 = time.perf_counter()
            msg = await ws.receive()
            t_recv1 = time.perf_counter()

            if msg.get("type") == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is None:
                # text フレーム (handshake / finish 等の制御) は idle 計測から除外。
                # raw RGBA frame の inter-arrival だけを純粋に測るため。
                text = msg.get("text") or ""
                try:
                    obj = json.loads(text)
                except json.JSONDecodeError:
                    last_receive_end = time.perf_counter()
                    continue
                if obj.get("type") == "finish":
                    break
                last_receive_end = time.perf_counter()
                continue

            # 「前回 binary frame 処理完了 → 今回 binary frame 到着」までの idle。
            # 発行側 backpressure を反映した真の binary inter-arrival 時間。
            receive_idle_ms.append((t_recv1 - last_receive_end) * 1000.0)
            received_bytes += len(data)

            if encoder == "discard":
                # ffmpeg を経由せずに即捨てる。WS/ASGI の生 throughput だけ見る。
                write_times_ms.append(0.0)
                drain_times_ms.append(0.0)
            else:
                if proc is None or proc.stdin is None:
                    break
                t0 = time.perf_counter()
                proc.stdin.write(data)
                t1 = time.perf_counter()
                # drain() は内部 buffer が high water mark を越えていれば await する。
                # 「ffmpeg が消化しきれていない = pipe back-pressure」をここで観測できる。
                await proc.stdin.drain()
                t2 = time.perf_counter()
                write_times_ms.append((t1 - t0) * 1000.0)
                drain_times_ms.append((t2 - t1) * 1000.0)
            frame_count += 1
            last_receive_end = time.perf_counter()

            # 30 frame ごとに progress を返す (UI 進捗表示用)。
            if frame_count % 30 == 0:
                await ws.send_text(json.dumps({
                    "type": "progress",
                    "frames": frame_count,
                    "elapsedSec": time.perf_counter() - started,
                    "receivedBytes": received_bytes,
                }))

        # 4) ffmpeg stdin close → wait (encoder == "discard" 以外)
        rc = 0
        stderr_data = b""
        if proc is not None:
            if proc.stdin is not None:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
            try:
                stderr_data = await asyncio.wait_for(proc.stderr.read(), timeout=2.0) if proc.stderr else b""
            except asyncio.TimeoutError:
                stderr_data = b""
            try:
                rc = await asyncio.wait_for(proc.wait(), timeout=30.0)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except Exception:
                    pass
                rc = -1

        elapsed = time.perf_counter() - started
        avg_fps = frame_count / elapsed if elapsed > 0 else 0.0
        throughput_mbps = (received_bytes / 1e6) / elapsed if elapsed > 0 else 0.0

        await ws.send_text(json.dumps({
            "type": "done",
            "frames": frame_count,
            "elapsedSec": elapsed,
            "fps": avg_fps,
            "throughputMBps": throughput_mbps,
            "ffmpegRc": rc,
            "ffmpegStderrTail": stderr_data.decode("utf-8", errors="replace")[-500:],
            "outputPath": output_path,
            "wsExtensions": ws_extensions,
            "receiveIdleMs": {
                "p50": _percentile(receive_idle_ms, 50),
                "p95": _percentile(receive_idle_ms, 95),
                "mean": (mean(receive_idle_ms) if receive_idle_ms else 0.0),
                "max": (max(receive_idle_ms) if receive_idle_ms else 0.0),
            },
            "stdinWriteMs": {
                "p50": _percentile(write_times_ms, 50),
                "p95": _percentile(write_times_ms, 95),
                "mean": (mean(write_times_ms) if write_times_ms else 0.0),
                "max": (max(write_times_ms) if write_times_ms else 0.0),
            },
            "drainMs": {
                "p50": _percentile(drain_times_ms, 50),
                "p95": _percentile(drain_times_ms, 95),
                "mean": (mean(drain_times_ms) if drain_times_ms else 0.0),
                "max": (max(drain_times_ms) if drain_times_ms else 0.0),
            },
        }))
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(exc)}))
        except Exception:
            pass
    finally:
        if proc is not None and proc.returncode is None:
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
            except Exception:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            await ws.close()
        except Exception:
            pass

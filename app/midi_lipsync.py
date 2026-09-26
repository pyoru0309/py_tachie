"""歌唱判定用 MIDI から口パクの口形タイムラインを作る。

背景
----
音量 (RMS) で口パクを駆動すると、伸ばす音・子音・ブレスの区別が付かず「歌っている
のに口が閉じる / 休符なのに口が動く」が避けられない。歌唱判定用 MIDI (ボーカル
トラックのノート + 歌詞イベント) があれば、

- ノートの長さ = 口を開けている区間 (休符 = 閉じる)
- 歌詞 (かな) = 口形 (あ/い/う/え/お/ん)

がそのまま取れる。ここでは SMF を自前でパースし (依存追加なし)、テンポ変更を反映
した秒単位のセグメント列 → フレームごとの口形文字列に落とす。

口形の表現
----------
1 フレーム 1 文字の文字列で持つ (JSON にそのまま載り、4 分の曲でも 6KB 弱):

- ``a`` ``i`` ``u`` ``e`` ``o`` : 母音
- ``n`` : 口を閉じる (「ん」/ ま行・ば行・ぱ行の子音の閉じ)
- ``-`` : ノートなし (休符)。クライアントはカットで選んだ口 (default) を出す

キャラの絵が 6 形を持たない場合の寄せ先 (あ/え→口開け 等) はクライアント側
(scene-builder の MOUTH_FALLBACKS) が面倒を見るので、ここでは常に 6 形で出す。
"""

from __future__ import annotations

import struct
import threading
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

REST = "-"
SHAPES = "aiueon"

# 休符がこれより短ければ前のノートを伸ばしてつなぐ (レガートで 1 コマだけ口が
# 閉じる / カット既定の口に戻る「ちらつき」を防ぐ)。
GAP_BRIDGE_SEC = 0.07
# ま行・ば行・ぱ行は唇を閉じてから開くので、ノート頭を短く「n」にする。
BILABIAL_CLOSE_SEC = 0.06
BILABIAL_CLOSE_RATIO = 0.35
# 「かん」のように末尾が「ん」の歌詞は、ノートの終わりを閉じる。
TRAILING_N_RATIO = 0.3
TRAILING_N_MAX_SEC = 0.25
# 1 フレーム中でノートが占める割合がこれ未満なら休符扱い。
MIN_FRAME_COVERAGE = 0.3

_VOWEL_ROWS = {
    "a": "あかさたなはまやらわがざだばぱぁゃゎゕ",
    "i": "いきしちにひみりぎじぢびぴぃゐ",
    "u": "うくすつぬふむゆるぐずづぶぷぅゅゔっ",
    "e": "えけせてねへめれげぜでべぺぇゑゖ",
    "o": "おこそとのほもよろをごぞどぼぽぉょ",
    "n": "ん",
}
_KANA_VOWEL: dict[str, str] = {ch: v for v, row in _VOWEL_ROWS.items() for ch in row}
_BILABIAL_KANA = set("まみむめもばびぶべぼぱぴぷぺぽ")
# 直前の母音を伸ばす記号 (長音・メリスマ継続)。
_CONTINUATION = set("ー〜~-+－＋")
# 母音を持たず、その後ろに続く「ん」「っ」は主母音の決定に使わない。
_WEAK_KANA = set("んっ")


def _to_hiragana(text: str) -> str:
    out = []
    for ch in unicodedata.normalize("NFKC", text):
        code = ord(ch)
        # カタカナ (ァ..ヶ) → ひらがな。ヴ は ゔ に落ちる。
        if 0x30A1 <= code <= 0x30F6:
            ch = chr(code - 0x60)
        out.append(ch)
    return "".join(out)


@dataclass(frozen=True)
class LyricShape:
    """1 ノートの歌詞から決まる口形。"""

    vowel: str  # "aiueon" のいずれか / "" = 直前の母音を伸ばす (継続)
    bilabial: bool = False  # 頭で唇を閉じる (ま行・ば行・ぱ行 / m b p)
    trailing_n: bool = False  # 末尾で口を閉じる (「かん」)


def lyric_shape(text: str | None) -> LyricShape | None:
    """歌詞 1 つ分 (通常は 1 モーラ) を口形に変換する。

    - 主母音 = 「ん」「っ」「ー」以外で最後に現れるかなの母音。「じゃ」→ あ、
      「きょ」→ お、「かっ」→ あ。
    - 「ん」だけ → n (閉じ)。「っ」だけ → u (利用者指定: っ は う と同じ)。
    - 「ー」「~」「+」「-」だけ → 継続 (直前の母音を伸ばす)。
    - ローマ字 (ka / n / sha 等) も最後の母音字で解釈する。
    - 解釈できない (空・記号のみ) → None。呼び出し側で「あ」扱いなどを決める。
    """
    if text is None:
        return None
    raw = _to_hiragana(str(text)).strip()
    # カラオケ (.kar) の改行・改段マーカーを落とす。
    raw = raw.replace("/", "").replace("\\", "").replace("\r", "").replace("\n", "").strip()
    if not raw:
        return None
    if all(ch in _CONTINUATION for ch in raw):
        return LyricShape(vowel="")

    kana = [ch for ch in raw if ch in _KANA_VOWEL]
    if kana:
        strong = [ch for ch in kana if ch not in _WEAK_KANA]
        if strong:
            vowel = _KANA_VOWEL[strong[-1]]
        else:
            vowel = _KANA_VOWEL[kana[-1]]  # 「ん」→ n /「っ」→ u
        bilabial = kana[0] in _BILABIAL_KANA
        trailing_n = bool(strong) and kana[-1] == "ん"
        return LyricShape(vowel=vowel, bilabial=bilabial, trailing_n=trailing_n)

    letters = [ch for ch in raw.lower() if "a" <= ch <= "z"]
    if letters:
        vowels = [ch for ch in letters if ch in "aiueo"]
        if not vowels:
            # "n" / "m" / "nn" → 閉じ。子音だけ (例 "s") は継続扱い。
            return LyricShape(vowel="n") if letters[-1] in "nm" else LyricShape(vowel="")
        return LyricShape(
            vowel=vowels[-1],
            bilabial=letters[0] in "mbp",
            trailing_n=letters[-1] == "n",
        )
    return None


# =============================================================================
# SMF パーサ
# =============================================================================


@dataclass
class MidiNote:
    start_tick: int
    end_tick: int
    pitch: int
    channel: int
    lyric: str | None = None


@dataclass
class MidiTrack:
    index: int
    name: str = ""
    notes: list[MidiNote] = field(default_factory=list)
    lyric_count: int = 0


@dataclass
class MidiSong:
    division: int
    smpte_ticks_per_sec: float | None
    # (tick, 秒, 1 tick あたり秒) を tick 昇順で。先頭は必ず tick=0。
    tempo_segments: list[tuple[int, float, float]]
    tempo_change_count: int
    tracks: list[MidiTrack]

    def tick_to_sec(self, tick: int) -> float:
        if self.smpte_ticks_per_sec:
            return tick / self.smpte_ticks_per_sec
        segs = self.tempo_segments
        lo, hi = 0, len(segs) - 1
        while lo < hi:  # tick 以下で最後のセグメントを二分探索
            mid = (lo + hi + 1) // 2
            if segs[mid][0] <= tick:
                lo = mid
            else:
                hi = mid - 1
        seg_tick, seg_sec, sec_per_tick = segs[lo]
        return seg_sec + (tick - seg_tick) * sec_per_tick


def _read_vlq(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    for _ in range(4):
        if pos >= len(data):
            raise ValueError("MIDI: 可変長数値の途中でデータが終わっています")
        byte = data[pos]
        pos += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, pos
    raise ValueError("MIDI: 不正な可変長数値です")


def _decode_text(payload: bytes) -> str:
    for encoding in ("utf-8", "cp932"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    return payload.decode("latin-1")


def parse_midi(data: bytes) -> MidiSong:
    """Standard MIDI File (format 0/1/2) をパースする。

    ノートは (channel, pitch) ごとに on/off を FIFO で対応付ける。歌詞は Lyric
    メタ (0x05) を優先し、1 つも無いトラックだけ Text メタ (0x01, .kar 形式) を
    歌詞として使う。
    """
    if len(data) < 14 or data[:4] != b"MThd":
        raise ValueError("MIDI ファイルではありません (MThd がありません)")
    header_len = struct.unpack(">I", data[4:8])[0]
    # format 0/1/2 とも「全トラックの tempo を共有」で扱うので format 値は見ない。
    _fmt, ntracks, division = struct.unpack(">HHH", data[8:14])
    pos = 8 + header_len
    smpte_ticks_per_sec: float | None = None
    if division & 0x8000:
        frames = 256 - (division >> 8)
        smpte_ticks_per_sec = float(frames * (division & 0xFF)) or None
        division = 480
    if division <= 0:
        raise ValueError("MIDI: 分解能 (division) が不正です")

    tempos: list[tuple[int, int]] = []  # (tick, usec per quarter)
    tracks: list[MidiTrack] = []
    for index in range(ntracks):
        if pos + 8 > len(data):
            break
        chunk_type = data[pos : pos + 4]
        length = struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + length]
        pos += 8 + length
        if chunk_type != b"MTrk":
            continue
        track = MidiTrack(index=len(tracks))
        lyrics: list[tuple[int, str]] = []
        texts: list[tuple[int, str]] = []
        open_notes: dict[tuple[int, int], list[MidiNote]] = {}
        tick = 0
        i = 0
        running: int | None = None
        while i < len(body):
            delta, i = _read_vlq(body, i)
            tick += delta
            if i >= len(body):
                break
            status = body[i]
            if status == 0xFF:
                if i + 1 >= len(body):
                    break
                meta_type = body[i + 1]
                meta_len, j = _read_vlq(body, i + 2)
                payload = body[j : j + meta_len]
                i = j + meta_len
                if meta_type == 0x51 and meta_len == 3:
                    tempos.append((tick, (payload[0] << 16) | (payload[1] << 8) | payload[2]))
                elif meta_type == 0x03 and not track.name:
                    track.name = _decode_text(payload).strip()
                elif meta_type == 0x05:
                    lyrics.append((tick, _decode_text(payload)))
                elif meta_type == 0x01:
                    texts.append((tick, _decode_text(payload)))
                elif meta_type == 0x2F:
                    break
                continue
            if status in (0xF0, 0xF7):
                sysex_len, j = _read_vlq(body, i + 1)
                i = j + sysex_len
                continue
            if status & 0x80:
                running = status
                i += 1
            elif running is None:
                raise ValueError("MIDI: ランニングステータスの前にステータスがありません")
            kind = running >> 4
            channel = running & 0x0F
            if kind in (0xC, 0xD):
                i += 1
                continue
            if i + 1 >= len(body):
                break
            data1, data2 = body[i], body[i + 1]
            i += 2
            key = (channel, data1)
            if kind == 0x9 and data2 > 0:
                note = MidiNote(start_tick=tick, end_tick=tick, pitch=data1, channel=channel)
                open_notes.setdefault(key, []).append(note)
                track.notes.append(note)
            elif kind == 0x8 or (kind == 0x9 and data2 == 0):
                stack = open_notes.get(key)
                if stack:
                    stack.pop(0).end_tick = tick
        for stack in open_notes.values():  # note-off 欠落はトラック末尾で閉じる
            for note in stack:
                note.end_tick = max(note.start_tick, tick)
        if not lyrics:
            lyrics = [(t, s) for t, s in texts if s.strip() and not s.lstrip().startswith("@")]
        track.lyric_count = len(lyrics)
        _attach_lyrics(track.notes, lyrics, division)
        track.notes.sort(key=lambda n: (n.start_tick, n.pitch))
        tracks.append(track)

    tempos.sort(key=lambda item: item[0])
    segments: list[tuple[int, float, float]] = []
    current_tick, current_sec, current_spt = 0, 0.0, 0.5 / division  # 既定 120BPM
    for t_tick, usec in tempos:
        if usec <= 0:
            continue
        current_sec += (t_tick - current_tick) * current_spt
        current_tick = t_tick
        current_spt = usec / 1_000_000.0 / division
        if segments and segments[-1][0] == t_tick:
            segments[-1] = (t_tick, current_sec, current_spt)
        else:
            segments.append((t_tick, current_sec, current_spt))
    if not segments or segments[0][0] != 0:
        segments.insert(0, (0, 0.0, 0.5 / division))
    return MidiSong(
        division=division,
        smpte_ticks_per_sec=smpte_ticks_per_sec,
        tempo_segments=segments,
        tempo_change_count=len(tempos),
        tracks=tracks,
    )


def _attach_lyrics(notes: list[MidiNote], lyrics: list[tuple[int, str]], division: int) -> None:
    """歌詞イベントをノートに割り付ける。

    通常は note-on と同 tick に置かれるが、ソフトによっては数 tick 前後にずれるので
    32 分音符ぶんの許容を持たせる。同じノートに複数来たら連結する。
    """
    if not notes or not lyrics:
        return
    tolerance = max(1, division // 8)
    ordered = sorted(notes, key=lambda n: n.start_tick)
    starts = [n.start_tick for n in ordered]
    import bisect

    for tick, text in lyrics:
        k = bisect.bisect_left(starts, tick)
        best: MidiNote | None = None
        best_dist = tolerance + 1
        for cand in (k - 1, k):
            if 0 <= cand < len(ordered):
                dist = abs(ordered[cand].start_tick - tick)
                if dist < best_dist:
                    best, best_dist = ordered[cand], dist
        if best is None:
            continue
        best.lyric = (best.lyric or "") + text


# =============================================================================
# ノート → 口形セグメント → フレーム
# =============================================================================


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    shape: str


def track_segments(song: MidiSong, track_index: int) -> list[Segment]:
    """1 トラックぶんの (秒, 秒, 口形) 列。モノフォニック化・短い休符の橋渡し込み。"""
    track = next((t for t in song.tracks if t.index == track_index), None)
    if track is None or not track.notes:
        return []
    has_lyrics = track.lyric_count > 0
    timed = []
    for note in track.notes:
        start = song.tick_to_sec(note.start_tick)
        end = song.tick_to_sec(note.end_tick)
        if end > start:
            timed.append([start, end, note])
    timed.sort(key=lambda item: item[0])
    # 重なり (和音 / 次ノートが前ノートの off より先に来る) は後着優先で切る。
    for cur, nxt in zip(timed, timed[1:]):
        if nxt[0] < cur[1]:
            cur[1] = nxt[0]
    timed = [item for item in timed if item[1] > item[0]]
    for cur, nxt in zip(timed, timed[1:]):
        if 0 < nxt[0] - cur[1] < GAP_BRIDGE_SEC:
            cur[1] = nxt[0]

    segments: list[Segment] = []
    prev_vowel = "a"
    for start, end, note in timed:
        shape = lyric_shape(note.lyric)
        if shape is None:
            # 歌詞付きトラックで歌詞の無いノート = メリスマ (前の母音を伸ばす)。
            # 歌詞が 1 つも無いトラックは口形が分からないので「あ」(= 口開け)。
            shape = LyricShape(vowel="" if has_lyrics else "a")
        vowel = shape.vowel or prev_vowel
        dur = end - start
        head = start
        if shape.bilabial and vowel != "n":
            close = min(BILABIAL_CLOSE_SEC, dur * BILABIAL_CLOSE_RATIO)
            segments.append(Segment(start, start + close, "n"))
            head = start + close
        tail = end
        if shape.trailing_n and vowel != "n":
            tail = max(head, end - min(TRAILING_N_MAX_SEC, dur * TRAILING_N_RATIO))
        if tail > head:
            segments.append(Segment(head, tail, vowel))
        if end > tail:
            segments.append(Segment(tail, end, "n"))
        if vowel != "n":
            prev_vowel = vowel
    return segments


def merge_segments(groups: Iterable[list[Segment]]) -> list[Segment]:
    """複数トラック (= 1 キャラに複数割り当て) のセグメントを 1 本にまとめる。"""
    merged = [seg for group in groups for seg in group]
    merged.sort(key=lambda s: (s.start, s.end))
    return merged


def shapes_for_frames(
    segments: list[Segment],
    *,
    start_sec: float,
    frame_count: int,
    fps: float,
    time_map=None,
) -> str:
    """フレーム i の区間 ``[start + i/fps, start + (i+1)/fps)`` を最も多く占める口形。

    ``time_map`` は「タイムライン秒 → MIDI 秒」の写像 (オフセット・ループ込み)。
    未指定なら恒等。区間が短い (1 フレーム) ので、写像は区間の両端で取る。
    ノートの占有が ``MIN_FRAME_COVERAGE`` 未満なら休符 (``-``)。
    """
    if frame_count <= 0:
        return ""
    if not segments:
        return REST * frame_count
    import bisect

    starts = [s.start for s in segments]
    # prefix_max_end[j] = segments[0..j] の end の最大値。後ろから遡るとき、これが
    # 区間頭 m0 以下になったらそれより前に重なるセグメントは無い (複数トラックを
    # 合成して長いノートの裏に短いノートが並んでいても取りこぼさない)。
    prefix_max_end = []
    running = float("-inf")
    for seg in segments:
        running = max(running, seg.end)
        prefix_max_end.append(running)

    frame_dur = 1.0 / fps
    out = []
    for i in range(frame_count):
        t0 = start_sec + i * frame_dur
        m0 = time_map(t0) if time_map else t0
        m1 = m0 + frame_dur
        best_shape = REST
        best_cover = 0.0
        j = bisect.bisect_left(starts, m1) - 1
        while j >= 0 and prefix_max_end[j] > m0:
            seg = segments[j]
            cover = min(seg.end, m1) - max(seg.start, m0)
            if cover > best_cover + 1e-9:
                best_cover, best_shape = cover, seg.shape
            j -= 1
        out.append(best_shape if best_cover >= frame_dur * MIN_FRAME_COVERAGE else REST)
    return "".join(out)


# =============================================================================
# ファイル読み込み (mtime キャッシュ) / UI 向けサマリ
# =============================================================================

_CACHE: dict[str, tuple[int, MidiSong]] = {}
_CACHE_LOCK = threading.Lock()


def load_midi(path: Path) -> MidiSong:
    key = str(path)
    mtime = path.stat().st_mtime_ns
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
    song = parse_midi(path.read_bytes())
    with _CACHE_LOCK:
        if len(_CACHE) > 32:
            _CACHE.clear()
        _CACHE[key] = (mtime, song)
    return song


def midi_summary(song: MidiSong) -> dict:
    """シーン設定の「MIDI で口パク」欄に出すトラック一覧。"""
    tracks = []
    for track in song.tracks:
        if not track.notes:
            continue
        lyric_preview = "".join(n.lyric or "" for n in track.notes[:40]).strip()
        tracks.append(
            {
                "index": track.index,
                "name": track.name,
                "noteCount": len(track.notes),
                "lyricCount": track.lyric_count,
                "lyricPreview": lyric_preview[:40],
                "firstNoteSec": round(song.tick_to_sec(track.notes[0].start_tick), 3),
                "lastNoteSec": round(max(song.tick_to_sec(n.end_tick) for n in track.notes), 3),
            }
        )
    return {
        "tracks": tracks,
        "tempoChangeCount": song.tempo_change_count,
    }


# =============================================================================
# 割り当ての一致チェック (MIDI トラック ↔ キャラのボーカル音源)
# =============================================================================
#
# デュエットで MIDI のトラック番号とキャラを取り違えると、相手のパートで口が動く
# (2026-09-26 に実際に起きた)。キャラ専用の口パク入力 (ボーカル音源) があれば、
# 「ノートが鳴っているのにその音源が無音」のフレーム割合で取り違えを検出できる。
# 正しい割り当てでは数 % (歌い出しの子音・フェード程度)、取り違えでは 20〜30% 以上。

CHECK_FPS = 100
# 無音の判定: 絶対 -50dBFS 未満、または音源の 95 パーセンタイルから 35dB 以上低い。
_SILENCE_ABS_DB = -50.0
_SILENCE_REL_DB = 35.0
# これを超えたら UI で警告する。
MISMATCH_WARN_RATIO = 0.15

_RMS_CACHE: dict[tuple[str, int], "object"] = {}


def _audio_rms_db(path: Path):
    """音源を mono 48kHz で読み、CHECK_FPS ごとの RMS (dBFS) を numpy 配列で返す。"""
    import subprocess

    import numpy as np

    from .global_config import ffmpeg_executable

    key = (str(path), path.stat().st_mtime_ns)
    with _CACHE_LOCK:
        hit = _RMS_CACHE.get(key)
    if hit is not None:
        return hit
    raw = subprocess.run(
        [ffmpeg_executable(), "-v", "error", "-i", str(path), "-ac", "1", "-ar", "48000",
         "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    samples = np.frombuffer(raw, dtype=np.float32)
    hop = 48000 // CHECK_FPS
    n = len(samples) // hop
    frames = samples[: n * hop].reshape(n, hop) if n else samples[:0].reshape(0, hop)
    db = 20.0 * np.log10(np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1)) + 1e-9)
    with _CACHE_LOCK:
        if len(_RMS_CACHE) > 16:
            _RMS_CACHE.clear()
        _RMS_CACHE[key] = db
    return db


def silent_while_note_ratio(
    segments: list[Segment],
    reference_db,
    *,
    midi_minus_ref_sec: float,
) -> tuple[float, int]:
    """ノート区間のうち、参照音源が無音のフレーム割合と、ノートのフレーム数。

    ``midi_minus_ref_sec`` = (MIDI 時刻) − (参照音源の時刻)。同じタイムライン位置で
    MIDI が何秒先を指しているか (BGM のトリム差・MIDI オフセット込み)。
    """
    import numpy as np

    if reference_db is None or len(reference_db) == 0:
        return 0.0, 0
    threshold = max(_SILENCE_ABS_DB, float(np.percentile(reference_db, 95)) - _SILENCE_REL_DB)
    shapes = shapes_for_frames(
        segments,
        start_sec=0.0,
        frame_count=len(reference_db),
        fps=float(CHECK_FPS),
        time_map=lambda t: t + midi_minus_ref_sec,
    )
    on = np.frombuffer(shapes.encode("ascii"), dtype=np.uint8) != ord(REST)
    note_frames = int(on.sum())
    if not note_frames:
        return 0.0, 0
    silent = reference_db < threshold
    return float((on & silent).sum()) / note_frames, note_frames

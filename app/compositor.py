"""v2 scene-bundle 用の Pillow 補助ヘルパ。

v1 (Pillow フル描画) パイプラインは撤去済み。本 module は以下に絞る:

- ``CharacterRequest`` / ``RenderRequest`` (scene-bundle / preview の入力 dataclass)
- ``request_from_payload`` / ``character_request_from_payload`` (payload パース)
- ``apply_idle_motion_to_payload`` / ``apply_shake_to_payload`` (motion 補正)
- ``bake_preview_layers`` (v2 scene-bundle が GL texture として使うキャラレイヤー PNG)
- ``compute_dialogue_layout`` (canvas2D 側 ``drawDialogueOnCanvas`` のレイアウト計算ソース)
- ``existing_font_path`` / ``paths_for_weight`` / ``get_font`` (フォント解決)
"""
from __future__ import annotations

import os
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont

from .assets import asset_url



CANVAS_SIZE = (1920, 1080)


@dataclass
class CharacterRequest:
    id: str
    name: str
    base: str | None
    cheek: str | None
    eye: str | None
    mouth: str | None
    bangs: str | None
    back_hair: str | None
    fronts: list[str]
    eye_above_bangs: bool
    character_x: int
    character_y: int
    character_scale: float
    remove_white: bool
    show_character: bool
    # 左右反転 (v2): キャラ本体レイヤーのみ中心軸で反転して描画する。
    # scale を負数化すると幅/中央寄せ計算が崩れるので別フィールドとして保持する。
    flip_x: bool = False
    # cut 単位の乗算カラーフィルター。v2 では shader 側で適用する (scene-bundle が
    # raw 値を per-character payload に乗せる)。None または enabled=False で未適用。
    color_filter: dict[str, Any] | None = None
    # cut 単位の glow / drop shadow。フロント側 cut.state.characterEffects を直接読む
    # 形に揃えてあるので、ここでは raw 値だけ保持して scene-bundle には乗せない。
    glow: dict[str, Any] | None = None
    drop_shadow: dict[str, Any] | None = None


@dataclass
class RenderRequest:
    background: str
    foreground: str
    characters: list[CharacterRequest]
    text: str
    font_size: int
    font_family: str
    font_weight: str
    text_align: str
    text_lines: int
    box_opacity: int
    speech_placement: str
    show_speech_box: bool
    speaker_character_id: str
    speaker_name: str
    speaker_name_font_size: int
    show_speaker_name: bool
    inactive_character_opacity: float
    box_border_width: int
    box_border_color: str
    box_background_color: str
    # セリフ枠の四隅角丸 (px)。プロジェクト設定の textDefaults から流入し、
    # cut 単位の textStyle には保存されない。
    box_border_radius_tl: int
    box_border_radius_tr: int
    box_border_radius_bl: int
    box_border_radius_br: int
    text_color: str
    text_outline_width: int
    text_outline_color: str
    box_overlay_image: str | None
    speech_offset_x: int
    speech_offset_y: int
    speech_padding_x: int
    speech_padding_y: int
    line_gap: int
    letter_spacing: float = 0.0
    # オプティカルカーニング (左右 ink ベアリング + 日本語 punctuation 係数 → letter_spacing 一律加算)。
    # Pillow 経路 (v1) では現状未実装、Canvas2D (v2) 経路で layoutTextRun が読む。
    # textDefaults から流入し、cut 単位の textStyle には保存されない。
    enable_optical_kerning: bool = False
    # 高品位モード: 各 glyph の輪郭を見て「衝突しない最大詰め」を直接計算する。
    # enable_optical_kerning と AND で作用。重い処理だが字形ベースで詰まり方が均等になる。
    optical_kerning_high_quality: bool = False
    output_name: str | None = None
    motion_zoom_scale: float = 1.0
    motion_zoom_origin: str = "center"
    # F4.5: 背景画像のぼかし量 (px)。0 で無効。シーンの videoTrack には適用しない
    # (このフィールドは bg 画像描画パスでのみ参照される)。
    background_blur_px: float = 0.0
    # 背景画像が未指定 (透過扱い) のときに塗る単色。opacity=0 で完全透明 (= 何も塗らない)。
    # 背景画像 / videoTrack が指定されているときは無視する (= cover で覆われるため)。
    background_color: str = "#000000"
    background_color_opacity: float = 0.0
    # セリフ本文 (枠ではなく文字) の光彩 / ドロップシャドウ。canvas2D (v2) のみ実装。
    # cut.state.textStyle.dialogueGlow / dialogueDropShadow から流入する。
    dialogue_glow: dict[str, Any] | None = None
    dialogue_drop_shadow: dict[str, Any] | None = None


def remove_exact_white(rgba: Image.Image) -> Image.Image:
    arr = np.asarray(rgba.convert("RGBA"), dtype=np.uint8).copy()
    exact_white = (arr[:, :, 0] == 255) & (arr[:, :, 1] == 255) & (arr[:, :, 2] == 255)
    arr[exact_white, 3] = 0
    return Image.fromarray(arr, "RGBA")


def to_layer(image: Image.Image, remove_white: bool) -> Image.Image:
    rgba = image.convert("RGBA")
    if not remove_white:
        return rgba
    if image.mode in ("RGBA", "LA") and rgba.getchannel("A").getextrema()[0] < 255:
        return rgba

    return remove_exact_white(rgba)


def dim_character(character: Image.Image, opacity: float) -> Image.Image:
    opacity = max(0.0, min(1.0, opacity))
    if opacity <= 0:
        return character
    overlay = Image.new("RGBA", character.size, (0, 0, 0, 0))
    alpha = character.getchannel("A").point(lambda value: round(value * opacity))
    overlay.putalpha(alpha)
    character.alpha_composite(overlay)
    return character


def existing_font_path(candidate: str) -> Path | None:
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    return path if path.exists() else None


def paths_for_weight(font_item: dict[str, Any], weight: str) -> list[str]:
    weights = font_item.get("weights", {})
    if weights:
        return (
            weights.get(weight)
            or weights.get("regular")
            or weights.get("medium")
            or weights.get("bold")
            or next(iter(weights.values()), [])
        )
    return font_item.get("paths", [])


def get_font(
    size: int,
    family: str,
    weight: str,
    config: dict[str, Any] | None = None,
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates: list[str] = []
    if config:
        for item in config.get("fonts", []):
            if item.get("id") == family:
                candidates.extend(paths_for_weight(item, weight))
                break
        if not candidates:
            for item in config.get("fonts", []):
                if item.get("id") == config.get("defaultFont"):
                    candidates.extend(paths_for_weight(item, config.get("defaultFontWeight", "regular")))
                    break

    candidates.extend(
        [
            "/Library/Fonts/NotoSansJP-Regular.otf",
            "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
            "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
            "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc",
            "/Library/Fonts/Arial Unicode.ttf",
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        ]
    )
    for candidate in candidates:
        path = existing_font_path(candidate)
        if path:
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


# 日本語の禁則処理。
# - LINE_START_FORBIDDEN: 行頭に置きたくない文字 (句読点 / 終わり括弧 / 小書き文字 等)。
#   折り返し直後にこれらが来る場合は、前の行の末尾に「追い込み」(=ぶら下げ) する。
# - LINE_END_FORBIDDEN: 行末に置きたくない文字 (始まり括弧 等)。
#   折り返し直前にこれらが来る場合は、次の行の頭に「押し出し」する。
LINE_START_FORBIDDEN = set(
    # 句読点 + ASCII の停止記号
    "、。，．・：；！？!?,.;:"
    # 終わり括弧 (和文 / 全角 / ASCII)
    "”’）)」』】〕〉》］]｝}〙〗｠"
    # 小書き / 長音 / 繰返し / 中黒
    "ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶーゝゞヽヾ々"
)
LINE_END_FORBIDDEN = set(
    "“‘（(「『【〔〈《［[｛{〘〖｟"
)


def wrap_text(text: str, font: ImageFont.ImageFont, max_width: int, max_lines: int) -> list[str]:
    if not text:
        return [""]

    draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))

    def fits(s: str) -> bool:
        bbox = draw.textbbox((0, 0), s, font=font)
        return (bbox[2] - bbox[0]) <= max_width

    lines: list[str] = []
    for paragraph in text.splitlines() or [text]:
        current = ""
        for char in paragraph:
            candidate = current + char
            # 余白に収まる、または current が空 (= 1 文字でも max_width を超える書体)
            # の場合はそのまま積む。current 空のときに break すると空行を量産するので
            # 必ず 1 文字は載せる。
            if fits(candidate) or not current:
                current = candidate
                continue
            # 折り返し直前 (char で current が溢れる) で禁則チェック。
            if char in LINE_START_FORBIDDEN:
                # 行頭禁止文字: 例外的に max_width を 1 文字ぶら下げてもよい。
                # 句読点・小書き等は box 内で多少はみ出してもセリフ感が損なわれない。
                current = candidate
                continue
            if current[-1] in LINE_END_FORBIDDEN:
                # 行末禁止文字 (始まり括弧): 末尾の 1 文字を次の行へ送る。
                last = current[-1]
                current = current[:-1]
                if current:
                    lines.append(current)
                    if len(lines) >= max_lines:
                        return lines[:max_lines]
                current = last + char
                continue
            # 通常の改行。
            lines.append(current)
            if len(lines) >= max_lines:
                return lines[:max_lines]
            current = char
        lines.append(current)
        if len(lines) >= max_lines:
            return lines[:max_lines]
    return lines[:max_lines]


def draw_text_with_spacing(
    draw: ImageDraw.ImageDraw,
    xy: tuple[float, float],
    text: str,
    *,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    fill,
    anchor: str = "lt",
    stroke_width: int = 0,
    stroke_fill=None,
    letter_spacing: float = 0.0,
) -> float:
    """letter_spacing 分だけ文字間を詰める／開ける形で描画。返り値は描画後の x。

    letter_spacing が 0 の場合は ImageDraw.text へ素通し。
    PIL は文字間を直接サポートしないので 1 文字ずつ描く必要がある。
    anchor は左上 (lt) ベース前提。
    """
    if not text:
        return float(xy[0])
    if letter_spacing == 0:
        kwargs = {}
        if stroke_width > 0 and stroke_fill is not None:
            kwargs = {"stroke_width": stroke_width, "stroke_fill": stroke_fill}
        draw.text(xy, text, fill=fill, font=font, anchor=anchor, **kwargs)
        bbox = draw.textbbox(xy, text, font=font, anchor=anchor)
        return float(bbox[2])
    x, y = float(xy[0]), float(xy[1])
    kwargs = {}
    if stroke_width > 0 and stroke_fill is not None:
        kwargs = {"stroke_width": stroke_width, "stroke_fill": stroke_fill}
    for ch in text:
        draw.text((x, y), ch, fill=fill, font=font, anchor=anchor, **kwargs)
        bbox = draw.textbbox((0, 0), ch, font=font, anchor="lt")
        x += (bbox[2] - bbox[0]) + letter_spacing
    return x


def measure_text_width(font, text: str, letter_spacing: float = 0.0) -> int:
    if not text:
        return 0
    measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    if letter_spacing == 0:
        bbox = measure.textbbox((0, 0), text, font=font, anchor="lt")
        return int(bbox[2] - bbox[0])
    width = 0
    for ch in text:
        bbox = measure.textbbox((0, 0), ch, font=font, anchor="lt")
        width += (bbox[2] - bbox[0])
    width += int(round(letter_spacing * max(0, len(text) - 1)))
    return int(width)


def parse_hex_color(value: str | None, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    if not value:
        return fallback
    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(char * 2 for char in text)
    if len(text) != 6:
        return fallback
    try:
        return tuple(int(text[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return fallback


def clamp_rect(left: int, top: int, right: int, bottom: int) -> tuple[int, int, int, int]:
    width = max(1, right - left)
    height = max(1, bottom - top)
    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > CANVAS_SIZE[0]:
        left -= right - CANVAS_SIZE[0]
        right = CANVAS_SIZE[0]
    if bottom > CANVAS_SIZE[1]:
        top -= bottom - CANVAS_SIZE[1]
        bottom = CANVAS_SIZE[1]
    left = max(0, left)
    top = max(0, top)
    right = min(CANVAS_SIZE[0], max(left + width, right))
    bottom = min(CANVAS_SIZE[1], max(top + height, bottom))
    return (left, top, right, bottom)


def dialogue_box_rect(request: RenderRequest, box_height: int | None = None) -> tuple[int, int, int, int]:
    box_height = box_height or (250 if request.text_lines == 1 else 310)
    offset_x = max(0, request.speech_offset_x)
    offset_y = max(0, request.speech_offset_y)
    side_width = 720
    placement = request.speech_placement or "bottom"
    if placement == "top":
        return clamp_rect(offset_x, offset_y, CANVAS_SIZE[0] - offset_x, offset_y + box_height)
    if placement == "left":
        return clamp_rect(offset_x, offset_y, offset_x + side_width, offset_y + box_height)
    if placement == "right":
        return clamp_rect(CANVAS_SIZE[0] - offset_x - side_width, offset_y, CANVAS_SIZE[0] - offset_x, offset_y + box_height)
    if placement == "center":
        width = max(1, CANVAS_SIZE[0] - offset_x * 2)
        top = (CANVAS_SIZE[1] - box_height) // 2 + offset_y
        left = (CANVAS_SIZE[0] - width) // 2
        return clamp_rect(left, top, left + width, top + box_height)
    bottom = CANVAS_SIZE[1] - offset_y
    return clamp_rect(offset_x, bottom - box_height, CANVAS_SIZE[0] - offset_x, bottom)


def text_body_anchor(
    request: RenderRequest,
    text_width: int,
    text_height: int,
) -> tuple[int, int]:
    """セリフ枠を表示しないとき (show_speech_box=False) のテキスト本体の左上座標。

    placement に加えて ``text_align`` も加味する: 横方向に幅を持つ placement
    (top/bottom/left/right) では、配置エリアの中で left/center/right に応じて
    body 全体を寄せる。これを怠ると align=center を選んでも左寄せのままに見える。
    """
    offset_x = max(0, request.speech_offset_x)
    offset_y = max(0, request.speech_offset_y)
    placement = request.speech_placement or "bottom"
    align = (request.text_align or "left").lower()
    canvas_w, canvas_h = CANVAS_SIZE
    side_width = 720

    def horizontal_in(area_left: int, area_width: int) -> int:
        # 配置エリア (area_left, area_left+area_width) 内で text_align に従って寄せる。
        if align == "center":
            return area_left + max(0, (area_width - text_width) // 2)
        if align == "right":
            return area_left + max(0, area_width - text_width)
        return area_left

    if placement == "top":
        return (horizontal_in(offset_x, canvas_w - 2 * offset_x), offset_y)
    if placement == "left":
        return (horizontal_in(offset_x, side_width), offset_y)
    if placement == "right":
        return (horizontal_in(canvas_w - offset_x - side_width, side_width), offset_y)
    if placement == "center":
        return ((canvas_w - text_width) // 2 + offset_x, (canvas_h - text_height) // 2 + offset_y)
    # bottom (default)
    return (horizontal_in(offset_x, canvas_w - 2 * offset_x), canvas_h - offset_y - text_height)


def _render_rounded_rect_mask(
    width: int,
    height: int,
    tl: int,
    tr: int,
    br: int,
    bl: int,
) -> Image.Image:
    """8bit alpha (``L``) の角丸矩形マスクを生成する。

    CSS 互換のスケーリング (隣接 2 角の合計が辺長を超えるときの比率縮小) は
    呼び出し側で済んでいる前提。"""
    mask = Image.new("L", (max(0, width), max(0, height)), 0)
    if width <= 0 or height <= 0:
        return mask
    mdraw = ImageDraw.Draw(mask)
    # 中央の十字状の領域を塗りつぶし、各角だけ pieslice で別途描画する。
    mdraw.rectangle((max(tl, bl), 0, width - 1 - max(tr, br), height - 1), fill=255)
    mdraw.rectangle((0, max(tl, tr), width - 1, height - 1 - max(bl, br)), fill=255)
    if tl > 0:
        mdraw.pieslice((0, 0, 2 * tl - 1, 2 * tl - 1), 180, 270, fill=255)
    if tr > 0:
        mdraw.pieslice((width - 2 * tr, 0, width - 1, 2 * tr - 1), 270, 360, fill=255)
    if br > 0:
        mdraw.pieslice((width - 2 * br, height - 2 * br, width - 1, height - 1), 0, 90, fill=255)
    if bl > 0:
        mdraw.pieslice((0, height - 2 * bl, 2 * bl - 1, height - 1), 90, 180, fill=255)
    return mask


def _draw_speech_box_with_corner_radii(
    canvas: Image.Image,
    bbox: tuple[int, int, int, int],
    radii_css: tuple[int, int, int, int],
    fill: tuple[int, int, int, int],
    border: tuple[int, int, int, int],
    border_width: int,
) -> None:
    """セリフ枠を四隅別の角丸 + ボーダーで描画する (Pillow 経路)。

    ボーダーは CSS の ``outline`` のように ``bbox`` の **外側** に描く。中心線
    ストロークだと半透明 fill と border 色が混ざってしまうため、外側マスクから
    内側マスクを差し引いた領域だけにボーダー色を塗る方式に揃える。"""
    left, top, right, bottom = bbox
    width = max(0, right - left)
    height = max(0, bottom - top)
    if width <= 0 or height <= 0:
        return
    tl, tr, br, bl = (max(0, int(r)) for r in radii_css)
    # 入力 radii は compute_dialogue_layout 側で CSS 互換スケーリング済みだが、
    # 単独経路から呼ばれる可能性も想定して safety net として再度比率縮小する。
    factor = 1.0
    if width > 0:
        if tl + tr > width:
            factor = min(factor, width / (tl + tr))
        if bl + br > width:
            factor = min(factor, width / (bl + br))
    if height > 0:
        if tl + bl > height:
            factor = min(factor, height / (tl + bl))
        if tr + br > height:
            factor = min(factor, height / (tr + br))
    if factor < 1.0:
        tl = int(tl * factor)
        tr = int(tr * factor)
        br = int(br * factor)
        bl = int(bl * factor)

    inner_mask = _render_rounded_rect_mask(width, height, tl, tr, br, bl)
    bw = max(0, int(border_width))

    # ボーダーを bbox の外側に描く: 外側マスク (= 元 box + bw 周り拡張) から
    # 内側マスクを引いて差分の輪に border 色を流し込み、その後で内側 fill を
    # 上書きする。先に外側を塗っておくことで、半透明 fill とボーダー色が
    # 重ならず境目がきれいに分離する。
    if bw > 0 and border[3] > 0:
        outer_w = width + 2 * bw
        outer_h = height + 2 * bw
        # 角がシャープ (radius 0) の場合は外側もシャープに保つ。
        outer_tl = tl + bw if tl > 0 else 0
        outer_tr = tr + bw if tr > 0 else 0
        outer_br = br + bw if br > 0 else 0
        outer_bl = bl + bw if bl > 0 else 0
        outer_mask = _render_rounded_rect_mask(outer_w, outer_h, outer_tl, outer_tr, outer_br, outer_bl)
        inner_on_outer = Image.new("L", (outer_w, outer_h), 0)
        inner_on_outer.paste(inner_mask, (bw, bw))
        border_mask = ImageChops.subtract(outer_mask, inner_on_outer)
        border_layer = Image.new("RGBA", (outer_w, outer_h), border)
        canvas.paste(border_layer, (left - bw, top - bw), border_mask)

    # 内側 fill を最後に paste するので、ボーダーとの境目は内側 mask 形状で
    # きっちり区切られる。
    fill_img = Image.new("RGBA", (width, height), fill)
    canvas.paste(fill_img, (left, top), inner_mask)


def compute_dialogue_layout(
    request: RenderRequest,
    config: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """``draw_dialogue`` の幾何計算 (folding / box rect / baselines) を抽出し、
    Pillow と Canvas2D の両経路で使える dict として返す。

    返値:
      ``None`` の場合は描画対象なし (text 空 + box 非表示)。
      それ以外は ``box`` (オプション) / ``overlayImage`` / ``speaker`` (オプション) /
      ``textLines`` (各行の baseline 座標) / フォント・色情報を含む。
    """
    if not request.text and not request.show_speech_box:
        return None
    font = get_font(request.font_size, request.font_family, request.font_weight, config)
    speaker_font = get_font(request.speaker_name_font_size, request.font_family, request.font_weight, config)
    measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    text_padding_x = max(0, request.speech_padding_x)
    text_padding_y = max(0, request.speech_padding_y)
    initial_left, _it, initial_right, _ib = dialogue_box_rect(request)
    initial_width = initial_right - initial_left
    max_text_width = max(120, initial_width - text_padding_x * 2)
    lines = wrap_text(request.text, font, max_text_width, request.text_lines)
    speaker_name = request.speaker_name.strip() if request.show_speaker_name else ""
    line_gap = max(0, request.line_gap)
    ascent, descent = font.getmetrics() if hasattr(font, "getmetrics") else (request.font_size, request.font_size // 4)
    speaker_ascent, speaker_descent = (
        speaker_font.getmetrics() if hasattr(speaker_font, "getmetrics") else (request.speaker_name_font_size, request.speaker_name_font_size // 4)
    )
    line_height = ascent + descent
    total_text_height = line_height * len(lines) + line_gap * max(0, len(lines) - 1)
    speaker_height = speaker_ascent + speaker_descent if speaker_name else 0
    speaker_gap = 10 if speaker_name else 0
    dynamic_box_height = max(1, total_text_height + speaker_height + speaker_gap + text_padding_y * 2)
    left, top, right, bottom = dialogue_box_rect(request, dynamic_box_height)
    box_height = bottom - top
    opacity = max(0, min(255, request.box_opacity))

    if request.show_speech_box:
        text_left = left
        text_right = right
        content_height = total_text_height + speaker_height + speaker_gap
        content_top = top + max(0, (box_height - content_height) / 2)
        speaker_pos = (
            {"x": left + text_padding_x, "baselineY": content_top + speaker_ascent}
            if speaker_name else None
        )
        baseline = content_top + speaker_height + speaker_gap + ascent
    else:
        widest_text = 1
        for line in lines:
            bbox = measure.textbbox((0, 0), line or " ", font=font)
            widest_text = max(widest_text, bbox[2] - bbox[0])
        total_body_height = total_text_height + speaker_height + speaker_gap
        body_left, body_top = text_body_anchor(request, widest_text, total_body_height)
        body_left = max(0, min(CANVAS_SIZE[0] - widest_text, body_left))
        body_top = max(0, min(CANVAS_SIZE[1] - total_body_height, body_top))
        text_left = body_left
        text_right = body_left + widest_text
        speaker_pos = (
            {"x": text_left, "baselineY": body_top + speaker_ascent}
            if speaker_name else None
        )
        baseline = body_top + speaker_height + speaker_gap + ascent

    letter_spacing = float(request.letter_spacing or 0.0)
    text_lines_layout: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        text_width = measure_text_width(font, line or " ", letter_spacing)
        if request.text_align == "center":
            x = text_left + ((text_right - text_left) - text_width) / 2
        else:
            x = text_left + text_padding_x if request.show_speech_box else text_left
        y = baseline + index * (line_height + line_gap)
        text_lines_layout.append({
            "text": line,
            "x": float(x),
            "baselineY": float(y),
            "width": int(text_width),
        })

    overlay_url = asset_url(str(request.box_overlay_image)) if request.box_overlay_image else None

    box_w = max(0, right - left)
    box_h = max(0, bottom - top)
    # CSS 仕様 (border-radius) と同じく、隣接 2 角の合計が辺長を超えるときだけ
    # 全体を比率縮小する。各角は単独では box_w / box_h の上限まで使える。
    # 例: 左下 / 右下を box_h まで伸ばして上辺だけ角丸無しにする等。
    rtl = max(0, int(request.box_border_radius_tl))
    rtr = max(0, int(request.box_border_radius_tr))
    rbr = max(0, int(request.box_border_radius_br))
    rbl = max(0, int(request.box_border_radius_bl))
    factor = 1.0
    if box_w > 0:
        if rtl + rtr > box_w:
            factor = min(factor, box_w / (rtl + rtr))
        if rbl + rbr > box_w:
            factor = min(factor, box_w / (rbl + rbr))
    if box_h > 0:
        if rtl + rbl > box_h:
            factor = min(factor, box_h / (rtl + rbl))
        if rtr + rbr > box_h:
            factor = min(factor, box_h / (rtr + rbr))
    radius_tl = int(rtl * factor)
    radius_tr = int(rtr * factor)
    radius_br = int(rbr * factor)
    radius_bl = int(rbl * factor)

    return {
        "showSpeechBox": bool(request.show_speech_box),
        "box": {
            "left": int(left),
            "top": int(top),
            "right": int(right),
            "bottom": int(bottom),
            "fillColor": request.box_background_color,
            "fillOpacity": int(opacity),
            "borderColor": request.box_border_color,
            # 「濃さ 0」でボーダーも透明になるよう、boxOpacity 連動。
            # v2 では shader 側で blend mode (screen / multiply) を選択するため、
            # ここでは opacity を 0..255 でそのまま透過させる。
            "borderOpacity": int(opacity),
            "borderWidth": max(0, int(request.box_border_width)),
            "radius": 0,
            "borderRadius": {
                "tl": int(radius_tl),
                "tr": int(radius_tr),
                "bl": int(radius_bl),
                "br": int(radius_br),
            },
        } if request.show_speech_box else None,
        "overlayImageUrl": overlay_url,
        "speaker": {
            **speaker_pos,
            "text": speaker_name,
            "fontSize": int(request.speaker_name_font_size),
        } if speaker_pos else None,
        "textLines": text_lines_layout,
        # 行内 align 再計算用 (JS 側 layoutTextRun が optical kerning ON のとき
        # 各行幅を再計測して center/right 揃えを引き直すために使う)。
        # textBoxInner.left/right は「行頭/行末として許容される x 範囲」、
        # padX は showSpeechBox=True のときの内側パディング。
        "textBoxInner": {
            "left": float(text_left),
            "right": float(text_right),
            "padX": int(text_padding_x) if request.show_speech_box else 0,
        },
        "textAlign": str(request.text_align or "left"),
        "enableOpticalKerning": bool(request.enable_optical_kerning),
        "opticalKerningHighQuality": bool(request.optical_kerning_high_quality),
        "fontSize": int(request.font_size),
        "fontFamily": str(request.font_family or ""),
        "fontWeight": str(request.font_weight or "regular"),
        "lineHeight": int(line_height),
        "lineGap": int(line_gap),
        "ascent": int(ascent),
        "descent": int(descent),
        "letterSpacing": letter_spacing,
        "textColor": request.text_color,
        "textOpacity": 255,
        "speakerOpacity": 230,
        "outlineWidth": max(0, int(request.text_outline_width)),
        "outlineColor": request.text_outline_color,
        # セリフ本文の光彩 / ドロップシャドウ (canvas2D で適用)。
        # 未指定や enabled=False のときは renderer 側で no-op。
        "dialogueGlow": request.dialogue_glow,
        "dialogueDropShadow": request.dialogue_drop_shadow,
    }


def asset_path(project_root: Path, rel_path: str | None) -> Path | None:
    if not rel_path:
        return None
    path = (project_root / rel_path).resolve()
    root = project_root.resolve()
    if root not in path.parents and path != root:
        raise ValueError("Asset path is outside of project root")
    return path


def is_transparent_background(background_rel: str | None) -> bool:
    return not (background_rel and str(background_rel).strip())



def _load_preview_layer(project_root: Path, rel_path: str | None, remove_white: bool, layer_size: tuple[int, int]) -> Image.Image | None:
    if not rel_path:
        return None
    full = asset_path(project_root, rel_path)
    if not full or not full.exists():
        return None
    with Image.open(full) as source:
        layer = to_layer(source, remove_white)
    if layer.size != layer_size:
        canvas = Image.new("RGBA", layer_size, (0, 0, 0, 0))
        canvas.alpha_composite(layer, (0, 0))
        layer = canvas
    return layer


def bake_preview_layers(
    project_root: Path,
    character_request: CharacterRequest,
    eye_variant_paths: dict[str, str | None],
    mouth_variant_paths: dict[str, str | None],
    is_speaker: bool,
    inactive_opacity: float,
) -> dict[str, Any]:
    """話者・非話者ごとに必要なレイヤー素材を焼く。アンチエイリアスはプレビューでは省略。

    v4 では ベース → 頬 → (eyeAboveBangs=true なら 前髪) → 目 → 口 → (eyeAboveBangs=false なら 前髪) → 前面 の順で焼く。
    口パク／目パチで差し替えが必要なのは目と口だけ。それ以外は under/over に固める。

    色フィルタは v2 では shader 側で適用するため、ここでは焼き込まない。
    """
    candidate_rels: list[str | None] = [
        character_request.back_hair,
        character_request.base,
        character_request.cheek,
        character_request.bangs,
        *(character_request.fronts or []),
        *eye_variant_paths.values(),
        *mouth_variant_paths.values(),
    ]
    layer_size = (1024, 1536)
    for rel in candidate_rels:
        if not rel:
            continue
        full = asset_path(project_root, rel)
        if full and full.exists():
            with Image.open(full) as source:
                if source.width * source.height > layer_size[0] * layer_size[1]:
                    layer_size = source.size

    rw = character_request.remove_white
    back_hair = _load_preview_layer(project_root, character_request.back_hair, rw, layer_size)
    base = _load_preview_layer(project_root, character_request.base, rw, layer_size)
    cheek = _load_preview_layer(project_root, character_request.cheek, rw, layer_size)
    bangs = _load_preview_layer(project_root, character_request.bangs, rw, layer_size)
    front_layers = [
        layer
        for rel in (character_request.fronts or [])
        if (layer := _load_preview_layer(project_root, rel, rw, layer_size)) is not None
    ]

    under = Image.new("RGBA", layer_size, (0, 0, 0, 0))
    # 後ろ髪は最下層 (base よりも下)。Phase 1 で back_hair カテゴリを追加。
    if back_hair is not None:
        under.alpha_composite(back_hair, (0, 0))
    if base is not None:
        under.alpha_composite(base, (0, 0))
    if cheek is not None:
        under.alpha_composite(cheek, (0, 0))
    if character_request.eye_above_bangs and bangs is not None:
        under.alpha_composite(bangs, (0, 0))

    over = Image.new("RGBA", layer_size, (0, 0, 0, 0))
    if not character_request.eye_above_bangs and bangs is not None:
        over.alpha_composite(bangs, (0, 0))
    for layer in front_layers:
        over.alpha_composite(layer, (0, 0))

    eye_layers: dict[str, Image.Image | None] = {
        key: _load_preview_layer(project_root, rel, rw, layer_size)
        for key, rel in eye_variant_paths.items()
    }
    mouth_layers: dict[str, Image.Image | None] = {
        key: _load_preview_layer(project_root, rel, rw, layer_size)
        for key, rel in mouth_variant_paths.items()
    }

    if not is_speaker:
        opacity = max(0.0, min(1.0, float(inactive_opacity)))
        if opacity < 1.0:
            under = dim_character(under, opacity)
            over = dim_character(over, opacity)
            for key, layer in eye_layers.items():
                if layer is not None:
                    eye_layers[key] = dim_character(layer, opacity)
            for key, layer in mouth_layers.items():
                if layer is not None:
                    mouth_layers[key] = dim_character(layer, opacity)

    return {
        "layerSize": layer_size,
        "under": under,
        "over": over,
        "eyes": eye_layers,
        "mouths": mouth_layers,
    }



def character_request_from_payload(payload: dict[str, Any], fallback: dict[str, Any] | None = None) -> CharacterRequest:
    fallback = fallback or {}
    character = payload.get("character", fallback.get("character", {}))
    fronts_raw = payload.get("fronts")
    if not isinstance(fronts_raw, list):
        fronts_raw = fallback.get("fronts") if isinstance(fallback.get("fronts"), list) else []
    fronts = [str(item) for item in fronts_raw if isinstance(item, str) and item]
    # cut state の characterEffects を CharacterRequest に伝搬。cut 単位の値なので
    # payload (= 個別キャラ) より fallback を優先する。
    color_filter_cfg: dict[str, Any] | None = None
    glow_cfg: dict[str, Any] | None = None
    drop_shadow_cfg: dict[str, Any] | None = None
    effects_raw = fallback.get("characterEffects")
    if isinstance(effects_raw, dict):
        cf = effects_raw.get("colorFilter")
        if isinstance(cf, dict):
            color_filter_cfg = cf
        gl = effects_raw.get("glow")
        if isinstance(gl, dict):
            glow_cfg = gl
        ds = effects_raw.get("dropShadow")
        if isinstance(ds, dict):
            drop_shadow_cfg = ds
    return CharacterRequest(
        id=str(payload.get("id") or fallback.get("id") or ""),
        name=str(payload.get("name") or fallback.get("name") or ""),
        base=payload.get("base") or fallback.get("base") or None,
        cheek=payload.get("cheek") or fallback.get("cheek") or None,
        eye=payload.get("eye") or fallback.get("eye") or None,
        mouth=payload.get("mouth") or fallback.get("mouth") or None,
        bangs=payload.get("bangs") or fallback.get("bangs") or None,
        back_hair=payload.get("back_hair") or fallback.get("back_hair") or None,
        fronts=fronts,
        eye_above_bangs=bool(payload.get("eyeAboveBangs", fallback.get("eyeAboveBangs", False))),
        character_x=int(character.get("x", 830)),
        character_y=int(character.get("y", -18)),
        character_scale=float(character.get("scale", 0.72)),
        remove_white=bool(payload.get("removeWhite", fallback.get("removeWhite", True))),
        show_character=bool(payload.get("showCharacter", fallback.get("showCharacter", True))),
        flip_x=bool(payload.get("flipX", fallback.get("flipX", False))),
        color_filter=color_filter_cfg,
        glow=glow_cfg,
        drop_shadow=drop_shadow_cfg,
    )


def request_from_payload(
    payload: dict[str, Any],
    config: dict[str, Any] | None = None,
) -> RenderRequest:
    text_style = payload.get("textStyle", {})
    text_defaults = (config or {}).get("textDefaults") or {}

    # UI に cut 単位の入力を持たないキー (オフセット / 枠余白 / ボーダー / 装飾 PNG /
    # 話者名サイズ / 非話者の暗さ / 角丸) は textDefaults を一次ソースに採用する。
    # cut.state.textStyle には saveScenario の都合で古い値が残るため、ここで上書き
    # しないと「設定保存→即時反映」が壊れる。
    def _project_default_int(
        key: str,
        default: int,
        *,
        min_value: int = 0,
        max_value: int | None = None,
    ) -> int:
        raw = text_defaults.get(key, text_style.get(key, default))
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = int(default)
        value = max(min_value, value)
        if max_value is not None:
            value = min(max_value, value)
        return value

    def _project_default_float(
        key: str,
        default: float,
        *,
        min_value: float = 0.0,
        max_value: float | None = None,
    ) -> float:
        raw = text_defaults.get(key, text_style.get(key, default))
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = float(default)
        value = max(min_value, value)
        if max_value is not None:
            value = min(max_value, value)
        return value

    def _project_default_str(key: str, default: str) -> str:
        raw = text_defaults.get(key, text_style.get(key, default))
        return str(default if raw is None else raw)

    def _radius(key: str) -> int:
        # 上限は 500px (枠半幅相当) — 余白との組合せで 1/4 楕円表現も許容する。
        return _project_default_int(key, 0, min_value=0, max_value=500)
    character_payloads = payload.get("characters")
    if isinstance(character_payloads, list):
        characters = [
            character_request_from_payload(item, payload)
            for item in character_payloads
            if isinstance(item, dict)
        ]
    else:
        characters = [character_request_from_payload(payload)]
    # F3 / F4: cut 単位のキャラ効果 (色フィルター / 光彩 / 影) を全 CharacterRequest に伝搬。
    character_effects = payload.get("characterEffects")
    if isinstance(character_effects, dict):
        color_filter = character_effects.get("colorFilter") if isinstance(character_effects.get("colorFilter"), dict) else None
        glow = character_effects.get("glow") if isinstance(character_effects.get("glow"), dict) else None
        drop_shadow = character_effects.get("dropShadow") if isinstance(character_effects.get("dropShadow"), dict) else None
        for character in characters:
            character.color_filter = color_filter
            character.glow = glow
            character.drop_shadow = drop_shadow
    speaker_character_id = str(payload.get("speakerCharacterId") or "")
    speaker_name = str(payload.get("speakerName") or "")
    if speaker_character_id and not any(character.id == speaker_character_id for character in characters):
        speaker_character_id = ""
    if not speaker_character_id and payload.get("text") and characters:
        speaker_character_id = characters[0].id
    if speaker_character_id and not speaker_name:
        speaker = next((character for character in characters if character.id == speaker_character_id), None)
        speaker_name = speaker.name if speaker else ""

    motion_type = str(payload.get("motionType") or "none")
    motion_settings = payload.get("motionSettings") if isinstance(payload.get("motionSettings"), dict) else {}
    motion_zoom_scale = 1.0
    motion_zoom_origin = "center"
    if motion_type == "zoom":
        zoom_cfg = motion_settings.get("zoom") if isinstance(motion_settings, dict) else None
        if isinstance(zoom_cfg, dict):
            try:
                motion_zoom_scale = max(1.0, min(2.0, float(zoom_cfg.get("scale", 1.0))))
            except (TypeError, ValueError):
                motion_zoom_scale = 1.0
            origin_value = str(zoom_cfg.get("origin") or "center")
            if origin_value not in ("center", "top", "bottom"):
                origin_value = "center"
            motion_zoom_origin = origin_value

    return RenderRequest(
        background=payload.get("background", "BG_classroom.jpg"),
        foreground=str(payload.get("foreground") or ""),
        characters=characters,
        text=payload.get("text", ""),
        font_size=int(text_style.get("fontSize", 54)),
        font_family=text_style.get("fontFamily", "noto_sans_jp"),
        font_weight=text_style.get("fontWeight", "regular"),
        text_align=text_style.get("align", "left"),
        text_lines=int(text_style.get("lines", 2)),
        box_opacity=int(text_style.get("boxOpacity", 215)),
        speech_placement=text_style.get("speechPlacement") or payload.get("speechPlacement") or "bottom",
        show_speech_box=bool(payload.get("showSpeechBox", True)),
        speaker_character_id=speaker_character_id,
        speaker_name=speaker_name,
        speaker_name_font_size=_project_default_int("speakerNameFontSize", 28, min_value=12, max_value=80),
        show_speaker_name=bool(
            payload.get("showSpeakerName", text_style.get("showSpeakerName", True))
        ),
        inactive_character_opacity=_project_default_float(
            "inactiveCharacterOpacity", 0.5, min_value=0.0, max_value=1.0
        ),
        box_border_width=_project_default_int("boxBorderWidth", 3, min_value=0, max_value=100),
        box_border_color=_project_default_str("boxBorderColor", "#ffffff"),
        box_background_color=_project_default_str("boxBackgroundColor", "#14181c"),
        box_border_radius_tl=_radius("boxBorderRadiusTL"),
        box_border_radius_tr=_radius("boxBorderRadiusTR"),
        box_border_radius_bl=_radius("boxBorderRadiusBL"),
        box_border_radius_br=_radius("boxBorderRadiusBR"),
        text_color=str(text_style.get("textColor", "#ffffff")),
        text_outline_width=max(0, min(12, int(text_style.get("textOutlineWidth", 0)))),
        text_outline_color=str(text_style.get("textOutlineColor", "#666666")),
        box_overlay_image=(_project_default_str("boxOverlayImage", "") or None),
        speech_offset_x=_project_default_int("speechOffsetX", 120),
        speech_offset_y=_project_default_int("speechOffsetY", 70),
        speech_padding_x=_project_default_int("speechPaddingX", 60),
        speech_padding_y=_project_default_int("speechPaddingY", 0),
        line_gap=max(0, int(text_style.get("lineGap", 16))),
        # letterSpacing は scenario / config では 1/1000 em で保持されるので、
        # ここで描画用 px に変換する (RenderRequest.letter_spacing は px)。
        letter_spacing=(
            (float(text_style.get("letterSpacing", 0) or 0) / 1000.0)
            * float(text_style.get("fontSize", 54) or 54)
        ),
        enable_optical_kerning=bool(
            text_defaults.get("enableOpticalKerning", text_style.get("enableOpticalKerning", False))
        ),
        optical_kerning_high_quality=bool(
            text_defaults.get(
                "opticalKerningHighQuality",
                text_style.get("opticalKerningHighQuality", False),
            )
        ),
        output_name=payload.get("outputName") or None,
        motion_zoom_scale=motion_zoom_scale,
        motion_zoom_origin=motion_zoom_origin,
        background_blur_px=max(0.0, float(payload.get("backgroundBlurPx") or 0.0)),
        background_color=str(payload.get("backgroundColor") or "#000000"),
        background_color_opacity=max(0.0, min(1.0, float(payload.get("backgroundColorOpacity") or 0.0))),
        dialogue_glow=(
            dict(text_style.get("dialogueGlow"))
            if isinstance(text_style.get("dialogueGlow"), dict)
            else (
                dict(text_defaults.get("dialogueGlow"))
                if isinstance(text_defaults.get("dialogueGlow"), dict)
                else None
            )
        ),
        dialogue_drop_shadow=(
            dict(text_style.get("dialogueDropShadow"))
            if isinstance(text_style.get("dialogueDropShadow"), dict)
            else (
                dict(text_defaults.get("dialogueDropShadow"))
                if isinstance(text_defaults.get("dialogueDropShadow"), dict)
                else None
            )
        ),
    )


def shake_offset(
    motion_settings: dict[str, Any] | None,
    motion_type: str,
    elapsed_seconds: float,
) -> tuple[float, float]:
    """話者キャラに加える x/y のシェイクオフセットを返す（プレビューでは 0 を渡すこと）"""
    import math

    if motion_type not in ("shake_x", "shake_y") or elapsed_seconds is None:
        return (0.0, 0.0)
    motion_settings = motion_settings or {}
    key = "shakeX" if motion_type == "shake_x" else "shakeY"
    cfg = motion_settings.get(key) or {}
    try:
        amplitude = float(cfg.get("amplitude", 0))
        count = float(cfg.get("count", 0))
        duration = float(cfg.get("duration", 0))
    except (TypeError, ValueError):
        return (0.0, 0.0)
    if amplitude <= 0 or count <= 0 or duration <= 0:
        return (0.0, 0.0)
    if elapsed_seconds < 0 or elapsed_seconds >= duration:
        return (0.0, 0.0)
    offset = amplitude * math.sin(2.0 * math.pi * count * (elapsed_seconds / duration))
    if motion_type == "shake_x":
        return (offset, 0.0)
    return (0.0, offset)


def idle_motion_offset(
    idle_motion: dict[str, Any] | None,
    timeline_seconds: float | None,
) -> tuple[float, float]:
    """シーン全体に流れる呼吸 (breath) と BPM ボブ (bpmBob) の Y オフセットを返す。

    両方の正弦波を加算する。x は常に 0。`timeline_seconds` はシーン先頭からの絶対秒。
    """
    import math

    if not isinstance(idle_motion, dict) or timeline_seconds is None:
        return (0.0, 0.0)
    try:
        t = float(timeline_seconds)
    except (TypeError, ValueError):
        return (0.0, 0.0)
    dy = 0.0
    breath = idle_motion.get("breath") if isinstance(idle_motion.get("breath"), dict) else None
    if breath:
        try:
            amp = max(0.0, float(breath.get("amplitudePx") or 0))
            period = max(0.05, float(breath.get("periodSec") or 4.0))
        except (TypeError, ValueError):
            amp = 0.0
            period = 4.0
        if amp > 0 and period > 0:
            dy += amp * math.sin(2.0 * math.pi * (t / period))
    bpm = idle_motion.get("bpm")
    bpm_bob = idle_motion.get("bpmBob") if isinstance(idle_motion.get("bpmBob"), dict) else None
    if bpm and bpm_bob:
        try:
            bpm_value = float(bpm)
            amp = max(0.0, float(bpm_bob.get("amplitudePx") or 0))
        except (TypeError, ValueError):
            bpm_value = 0.0
            amp = 0.0
        if bpm_value > 0 and amp > 0:
            period = 60.0 / bpm_value
            dy += amp * math.sin(2.0 * math.pi * (t / period))
    return (0.0, dy)


def apply_idle_motion_to_payload(
    payload: dict[str, Any],
    idle_motion: dict[str, Any] | None,
    timeline_seconds: float | None,
) -> dict[str, Any]:
    """全キャラの character.y にシーン idle motion (呼吸+BPMボブ) を加算した payload を返す。"""
    if not isinstance(idle_motion, dict) or timeline_seconds is None:
        return payload
    dx, dy = idle_motion_offset(idle_motion, timeline_seconds)
    if dx == 0 and dy == 0:
        return payload
    new_payload = dict(payload)
    chars = payload.get("characters") or []
    new_chars = []
    for char in chars:
        if not isinstance(char, dict):
            new_chars.append(char)
            continue
        new_char = dict(char)
        new_char["character"] = dict(char.get("character") or {})
        new_char["character"]["x"] = float(new_char["character"].get("x", 0)) + dx
        new_char["character"]["y"] = float(new_char["character"].get("y", 0)) + dy
        new_chars.append(new_char)
    new_payload["characters"] = new_chars
    return new_payload


def apply_shake_to_payload(
    payload: dict[str, Any],
    motion_settings: dict[str, Any] | None,
    elapsed_seconds: float | None,
) -> dict[str, Any]:
    """話者キャラの character.x/y にシェイクオフセットを加算して新しい payload を返す"""
    motion_type = str(payload.get("motionType") or "none")
    if motion_type not in ("shake_x", "shake_y") or elapsed_seconds is None:
        return payload
    speaker_id = str(payload.get("speakerCharacterId") or "")
    if not speaker_id:
        return payload
    dx, dy = shake_offset(motion_settings, motion_type, elapsed_seconds)
    if dx == 0 and dy == 0:
        return payload
    new_payload = dict(payload)
    chars = payload.get("characters") or []
    new_chars = []
    for char in chars:
        if not isinstance(char, dict):
            new_chars.append(char)
            continue
        if char.get("id") != speaker_id:
            new_chars.append(char)
            continue
        new_char = dict(char)
        new_char["character"] = dict(char.get("character") or {})
        new_char["character"]["x"] = float(new_char["character"].get("x", 0)) + dx
        new_char["character"]["y"] = float(new_char["character"].get("y", 0)) + dy
        new_chars.append(new_char)
    new_payload["characters"] = new_chars
    return new_payload

"""プロジェクト config (config.json) のデフォルト値・正規化・フォントスキャン。

依存先は paths / utils のみ。FastAPI ルート (POST /api/config) は main.py 側に残し、
こちらは値そのものを扱う関数群を提供する。
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .paths import ASSETS_DIR
from .timecode import (
    CHARACTER_ANIMATION_FPS_CHOICES,
    CHARACTER_ANIMATION_FPS_DEFAULT,
    PROJECT_FPS,
    normalize_character_animation_fps,
)
from .utils import ProjectContext, current_project, relative_to_root, write_project_file


def default_config() -> dict[str, Any]:
    return {
        "defaultFont": "noto_sans_jp",
        "defaultFontWeight": "regular",
        "fps": PROJECT_FPS,
        "characterAnimationFps": CHARACTER_ANIMATION_FPS_DEFAULT,
        "textDefaults": {
            "fontFamily": "noto_sans_jp",
            "fontWeight": "regular",
            "fontSize": 54,
            "boxOpacity": 0.8,
            "speechPlacement": "bottom",
            "boxBorderWidth": 3,
            "boxBorderColor": "#ffffff",
            "boxBackgroundColor": "#14181c",
            "textColor": "#ffffff",
            "textOutlineWidth": 0,
            "textOutlineColor": "#666666",
            "boxOverlayImage": "",
            "speechOffsetX": 120,
            "speechOffsetY": 70,
            "speechPaddingX": 60,
            "speechPaddingY": 70,
            "lineGap": 16,
            # 文字間は 1/1000 em で保存 (フォントサイズに応じて px へスケール)。
            # 値域は -500..+1000、UI は step=100 で 100/1000em (= 0.1em) 単位で操作。
            "letterSpacing": 0,
            "speakerNameFontSize": 28,
            "showSpeakerName": True,
            "inactiveCharacterOpacity": 0.5,
            "boxBorderRadiusTL": 0,
            "boxBorderRadiusTR": 0,
            "boxBorderRadiusBL": 0,
            "boxBorderRadiusBR": 0,
            "enableOpticalKerning": False,
            "opticalKerningHighQuality": False,
            # セリフ本文の光彩 / ドロップシャドウ (canvas2D で適用)。
            "dialogueGlow": {"enabled": False, "color": "#ffffff", "blurPx": 12, "opacity": 0.8},
            "dialogueDropShadow": {
                "enabled": False,
                "color": "#000000",
                "blurPx": 6,
                "offsetX": 4,
                "offsetY": 4,
                "opacity": 0.7,
            },
        },
        "renderDefaults": {
            "removeWhite": True,
        },
        "animationDefaults": {
            "blink": True,
            "lipSync": True,
            "blinkAlgorithm": "anime",
        },
        "lipSync": {
            "silenceThreshold": 0.08,
            "openThreshold": 0.42,
            "dbFloor": -55,
            "dbCeil": -18,
            "smoothing": 0.2,
        },
        "motion": {
            "shakeX": {"amplitude": 30, "count": 3, "duration": 0.6},
            "shakeY": {"amplitude": 30, "count": 3, "duration": 0.6},
            "zoom": {"scale": 1.3, "origin": "center"},
        },
        "telopDefaults": {
            "fontFamily": "noto_sans_jp",
            "fontWeight": "regular",
            "fontSize": 48,
            "color": "#ffffff",
            "outlineWidth": 4,
            "outlineColor": "#000000",
            "letterSpacing": 0,
            "lineSpacing": 0,
            "enableOpticalKerning": False,
            "opticalKerningHighQuality": False,
            "glow": {"enabled": False, "color": "#ffffff", "blurPx": 12, "opacity": 0.8},
            "dropShadow": {
                "enabled": False,
                "color": "#000000",
                "blurPx": 6,
                "offsetX": 4,
                "offsetY": 4,
                "opacity": 0.7,
            },
        },
        "fontWeights": [
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
        ],
        "fonts": [
            {
                "id": "noto_sans_jp",
                "name": "Noto Sans Japanese",
                "weights": {
                    "light": ["/Library/Fonts/NotoSansJP-Light.otf"],
                    "regular": ["/Library/Fonts/NotoSansJP-Regular.otf"],
                    "medium": ["/Library/Fonts/NotoSansJP-Medium.otf"],
                    "bold": ["/Library/Fonts/NotoSansJP-Bold.otf"],
                    "black": ["/Library/Fonts/NotoSansJP-Black.otf"],
                },
            },
            {
                "id": "m_plus_rounded_1c",
                "name": "M PLUS Rounded 1c",
                "weights": {
                    "regular": ["assets/fonts/MPLUSRounded1c-Regular.ttf", "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"],
                    "medium": ["assets/fonts/MPLUSRounded1c-Medium.ttf", "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"],
                    "bold": ["assets/fonts/MPLUSRounded1c-Bold.ttf", "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"],
                },
            },
            {
                "id": "zen_maru_gothic",
                "name": "Zen Maru Gothic",
                "weights": {
                    "regular": ["assets/fonts/ZenMaruGothic-Regular.ttf", "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"],
                    "medium": ["assets/fonts/ZenMaruGothic-Medium.ttf", "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"],
                    "bold": ["assets/fonts/ZenMaruGothic-Bold.ttf", "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"],
                },
            },
            {
                "id": "line_seed_jp",
                "name": "LINE Seed JP",
                "weights": {
                    "regular": [
                        "assets/fonts/LINESeedJP_OTF_Rg.otf",
                        "assets/fonts/LINESeedJP_TTF_Rg.ttf",
                        "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
                    ],
                    "bold": [
                        "assets/fonts/LINESeedJP_OTF_Bd.otf",
                        "assets/fonts/LINESeedJP_TTF_Bd.ttf",
                        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
                    ],
                },
            },
        ],
    }


def family_id_from_stem(stem_family: str) -> str:
    """filename stem から family_id を生成する (永続 ID)。

    pretty mapping を介さないので、ハードコード一覧を増やさなくても安定 ID が出る。
    永続スキーマ上の参照 (``fontFamily: "auto_..."``) は本関数の出力に固定される
    ため、本関数の出力ロジックは原則変更しない (= 既存シナリオを壊さない)。

    純非 ASCII の stem (例: ``花とちょうちょ`` / ``ちはや純``) は ASCII 化が
    空文字になるため、SHA1 先頭 8 文字を ID に流用する。これがないと複数の
    日本語ファイル名フォントが ``auto_unnamed`` に collapse して 1 エントリに
    マージされてしまい、UI から個別選択できなくなる。
    """
    base = re.sub(r"[^A-Za-z0-9_]+", "_", stem_family).strip("_").lower()
    if base:
        return f"auto_{base}"
    digest = hashlib.sha1(stem_family.encode("utf-8")).hexdigest()[:8]
    return f"auto_{digest}"


def display_name_for_font(meta: dict[str, Any] | None, stem_family: str) -> str:
    """UI 表示用の family 名を **日本語 name 優先** で決定する。

    優先順:

    1. name table の ja-JP / Mac-ja family (= ``meta.family_localized``)。
       FontBook が「ねこスプーン」「あんずもじ」「アームドレモン」を出すのと
       同じ仕組み。NekoSpoon/APJapanesefont/ArmedLemon 等は en-US の name より
       こちらの方が日常的に通っている。
    2. name table の en-US family (= ``meta.family``)。Hina Mincho 等、日本語
       名を持たない欧文向けフォントはこちらで「Hina Mincho」と出る。
    3. ファイル名 stem。フォントが name table を持たない / fontTools が落ちた
       場合の最終フォールバック。

    NameID 1 (legacy Family) は subfamily が連結されているケース
    (例: ``cousagi-font-kyokan Regular`` + subfamily=``Regular``) があり、
    末尾の suffix を除去して「素の family 名」に正規化する。
    NameID 16 (Typographic Family) は元々 subfamily を含まないので影響なし。
    """
    meta = meta or {}

    def _strip_subfamily(family_value: str, subfamily_value: str) -> str:
        family_value = (family_value or "").strip()
        subfamily_value = (subfamily_value or "").strip()
        if subfamily_value and family_value.endswith(" " + subfamily_value):
            return family_value[: -(len(subfamily_value) + 1)].strip()
        return family_value

    localized = _strip_subfamily(meta.get("family_localized", ""), meta.get("subfamily_localized", ""))
    if localized:
        return localized
    english = _strip_subfamily(meta.get("family", ""), meta.get("subfamily", ""))
    if english:
        return english
    return stem_family


def scan_fonts(
    ctx: ProjectContext | None = None,
    weight_overrides: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """``assets/fonts/`` とプロジェクト assets/fonts/ をスキャンして family→weights を返す。

    weight 判定の優先順 (上ほど強い):

    1. ``weight_overrides[rel_path]`` (ユーザーが全体設定で明示指定)
    2. OS/2.usWeightClass (フォント自身の権威メタ、``font_inspect.inspect_font``)
    3. filename suffix (``font_family_and_weight``)、フォールバック

    display 名 (UI 表示) は **name テーブル優先** (= フォント自身の申告)。
    NekoSpoon → 「ねこスプーン」のように、ローカライズ名もそのまま採用する。
    FontFace API 側はどんな文字列も family 名として登録できるため、canvas /
    Pillow 経路ともに技術的問題は無い。

    family_id (永続 ID) は **filename stem 由来** で固定 (``family_id_from_stem``)。
    既存シナリオの ``fontFamily: "auto_..."`` 参照を壊さないための後方互換。
    """
    ctx = ctx or current_project()
    if weight_overrides is None:
        # 循環 import 回避のため遅延 import (config ↔ global_config)
        try:
            from .global_config import load_global_config

            weight_overrides = load_global_config().get("fontWeightOverrides") or {}
        except Exception:  # noqa: BLE001
            weight_overrides = {}
    if not isinstance(weight_overrides, dict):
        weight_overrides = {}

    from .font_inspect import inspect_font  # 遅延 import (fonttools 未インストール環境への耐性)

    font_dirs = [ASSETS_DIR / "fonts", ctx.root / "assets" / "fonts"]
    seen: set[Path] = set()
    grouped: dict[str, dict[str, Any]] = {}
    for font_dir in font_dirs:
        if not font_dir.exists():
            continue
        for path in sorted([*font_dir.rglob("*.otf"), *font_dir.rglob("*.ttf")]):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            rel_path = relative_to_root(path)

            meta = inspect_font(path)
            stem_family, stem_weight = font_family_and_weight(path.stem)

            family_id = family_id_from_stem(stem_family)
            display_name = display_name_for_font(meta, stem_family)

            override_weight = (weight_overrides or {}).get(rel_path)
            weight_id = (
                override_weight
                or meta.get("weight_id")
                or stem_weight
                or "regular"
            )

            item = grouped.setdefault(
                family_id,
                {
                    "id": family_id,
                    "name": display_name,
                    "weights": {},
                    "auto": True,
                },
            )
            # 同 family_id に複数 display 名候補がある場合は短いほうを採用
            # (subfamily 付きより素の family 名のほうが一般に短い)
            if len(display_name) < len(item["name"]):
                item["name"] = display_name
            item["weights"].setdefault(weight_id, []).append(rel_path)
    return sorted(grouped.values(), key=lambda item: item["name"].lower())


def font_family_and_weight(stem: str) -> tuple[str, str]:
    normalized = stem.replace("_", "-").strip()
    weight_aliases = {
        "thin": "thin",
        "extralight": "extra_light",
        "ultralight": "extra_light",
        "light": "light",
        "demilight": "demi_light",  # Source Han Sans 系固有 (OS/2 weight class 350)
        "regular": "regular",
        "normal": "regular",
        "medium": "medium",
        "semibold": "semi_bold",
        "demibold": "semi_bold",
        "bold": "bold",
        "extrabold": "extra_bold",
        "ultrabold": "extra_bold",
        "black": "black",
        "heavy": "black",
    }
    parts = [part for part in re.split(r"[-\s]+", normalized) if part]
    if len(parts) >= 2:
        suffix = re.sub(r"[^A-Za-z]+", "", parts[-1]).lower()
        if suffix in weight_aliases:
            return "-".join(parts[:-1]), weight_aliases[suffix]
    return normalized, "regular"


def pretty_font_family_name(name: str) -> str:
    """[非推奨] 旧 hardcoded 表示名マッピング。

    `display_name_for_font(meta, stem)` (name table 由来) に置き換え済み。
    本関数は外部 import 互換のためにシグネチャだけ残しているが、内部的には
    no-op (入力をそのまま返す)。新規コードでは使わないこと。
    """
    return name


def normalized_font_family_name(name: str) -> str:
    """name 比較用のキー。`merge_auto_fonts` で既存 entry との重複検出に使う。

    純非 ASCII の name (例: ``ちはや純``) は ASCII strip で空文字になり、
    複数の日本語名フォントが「同じキー」で重複扱いされて 1 entry にマージ
    されてしまうため、ASCII 部分が無い場合は **原文を lowercase 化した
    ものを返す** (空文字衝突回避)。
    """
    ascii_key = re.sub(r"[^a-z0-9]+", "", name.lower())
    return ascii_key or name.lower()


def merge_auto_fonts(config: dict[str, Any], ctx: ProjectContext | None = None) -> dict[str, Any]:
    fonts = [item for item in config.get("fonts", []) if not item.get("auto")]
    existing_ids = {item.get("id") for item in fonts}
    fonts_by_name = {normalized_font_family_name(str(item.get("name", ""))): item for item in fonts}
    existing_paths = {
        path
        for item in fonts
        for paths in item.get("weights", {}).values()
        for path in (paths if isinstance(paths, list) else [])
    }
    for item in scan_fonts(ctx):
        paths = item.get("weights", {}).get("regular", [])
        name_key = normalized_font_family_name(item["name"])
        target = fonts_by_name.get(name_key)
        if target:
            target_weights = target.setdefault("weights", {})
            for weight_id, weight_paths in item.get("weights", {}).items():
                current_paths = target_weights.setdefault(weight_id, [])
                for path in weight_paths:
                    if path not in current_paths:
                        current_paths.append(path)
                        existing_paths.add(path)
            continue
        item_paths = [
            path
            for weight_paths in item.get("weights", {}).values()
            for path in (weight_paths if isinstance(weight_paths, list) else [])
        ]
        if item["id"] not in existing_ids and not any(path in existing_paths for path in item_paths):
            fonts.append(item)
            existing_ids.add(item["id"])
            existing_paths.update(item_paths)
            fonts_by_name[name_key] = item
    config["fonts"] = fonts
    return config


def ensure_config(ctx: ProjectContext | None = None) -> dict[str, Any]:
    ctx = ctx or current_project()
    ctx.config_path.parent.mkdir(parents=True, exist_ok=True)
    defaults = default_config()
    if ctx.config_path.exists():
        with ctx.config_path.open("r", encoding="utf-8") as handle:
            config = json.load(handle)
        changed = False
        for key in ["defaultFontWeight", "fontWeights", "textDefaults", "renderDefaults", "animationDefaults", "lipSync", "motion", "telopDefaults"]:
            if key not in config:
                config[key] = defaults[key]
                changed = True
        # fps はプロジェクト基準として固定。characterAnimationFps は 8/12/24 に揃える。
        if config.get("fps") != PROJECT_FPS:
            config["fps"] = PROJECT_FPS
            changed = True
        char_fps = normalize_character_animation_fps(config.get("characterAnimationFps"))
        if config.get("characterAnimationFps") != char_fps:
            config["characterAnimationFps"] = char_fps
            changed = True
        for key, value in defaults["motion"].items():
            if key not in config["motion"]:
                config["motion"][key] = value
                changed = True
            elif isinstance(value, dict):
                for sub_key, sub_value in value.items():
                    if sub_key not in config["motion"][key]:
                        config["motion"][key][sub_key] = sub_value
                        changed = True
        for key, value in defaults["textDefaults"].items():
            if key not in config["textDefaults"]:
                config["textDefaults"][key] = value
                changed = True
        if float(config["textDefaults"].get("boxOpacity", 0.8)) > 1:
            config["textDefaults"]["boxOpacity"] = round(float(config["textDefaults"]["boxOpacity"]) / 255, 2)
            changed = True
        for key, value in defaults["renderDefaults"].items():
            if key not in config["renderDefaults"]:
                config["renderDefaults"][key] = value
                changed = True
        for key, value in defaults["animationDefaults"].items():
            if key not in config["animationDefaults"]:
                config["animationDefaults"][key] = value
                changed = True
        for key, value in defaults["lipSync"].items():
            if key not in config["lipSync"]:
                config["lipSync"][key] = value
                changed = True
        for key, value in defaults["telopDefaults"].items():
            if key not in config["telopDefaults"]:
                config["telopDefaults"][key] = value
                changed = True
            elif isinstance(value, dict):
                for sub_key, sub_value in value.items():
                    if sub_key not in config["telopDefaults"][key]:
                        config["telopDefaults"][key][sub_key] = sub_value
                        changed = True
        weight_ids = {item.get("id") for item in config.get("fontWeights", [])}
        for item in defaults["fontWeights"]:
            if item["id"] not in weight_ids:
                config.setdefault("fontWeights", []).append(item)
                changed = True
        default_fonts = {item["id"]: item for item in defaults["fonts"]}
        fonts = []
        for item in config.get("fonts", []):
            default_item = default_fonts.get(item.get("id"))
            if default_item and "weights" not in item:
                item["weights"] = default_item["weights"]
                changed = True
            elif default_item and "weights" in item:
                for weight_id, default_paths in default_item["weights"].items():
                    current_paths = item["weights"].setdefault(weight_id, [])
                    for path in default_paths:
                        if path not in current_paths:
                            current_paths.append(path)
                            changed = True
            fonts.append(item)
        existing_ids = {item.get("id") for item in fonts}
        for item in defaults["fonts"]:
            if item["id"] not in existing_ids:
                fonts.append(item)
                changed = True
        config["fonts"] = fonts
        before_fonts = json.dumps(config.get("fonts", []), ensure_ascii=False, sort_keys=True)
        config = merge_auto_fonts(config, ctx)
        if json.dumps(config.get("fonts", []), ensure_ascii=False, sort_keys=True) != before_fonts:
            changed = True
        if changed:
            with ctx.config_path.open("w", encoding="utf-8") as handle:
                json.dump(config, handle, ensure_ascii=False, indent=2)
        return config
    config = merge_auto_fonts(defaults, ctx)
    with ctx.config_path.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
    return config


def _normalize_dialogue_glow(value: Any) -> dict[str, Any]:
    """セリフ本文の光彩設定を妥当な範囲にクランプして返す。"""
    src = value if isinstance(value, dict) else {}
    return {
        "enabled": bool(src.get("enabled", False)),
        "color": str(src.get("color") or "#ffffff"),
        "blurPx": max(0, min(200, int(float(src.get("blurPx", 12) or 0)))),
        "opacity": max(0.0, min(1.0, float(src.get("opacity", 0.8) or 0))),
    }


def _normalize_dialogue_drop_shadow(value: Any) -> dict[str, Any]:
    """セリフ本文のドロップシャドウ設定を妥当な範囲にクランプして返す。"""
    src = value if isinstance(value, dict) else {}
    return {
        "enabled": bool(src.get("enabled", False)),
        "color": str(src.get("color") or "#000000"),
        "blurPx": max(0, min(200, int(float(src.get("blurPx", 6) or 0)))),
        "offsetX": max(-200, min(200, int(float(src.get("offsetX", 4) or 0)))),
        "offsetY": max(-200, min(200, int(float(src.get("offsetY", 4) or 0)))),
        "opacity": max(0.0, min(1.0, float(src.get("opacity", 0.7) or 0))),
    }


def save_config_payload(payload: dict[str, Any], ctx: ProjectContext | None = None) -> dict[str, Any]:
    ctx = ctx or current_project()
    defaults = default_config()
    current = ensure_config(ctx)
    config = {
        "defaultFont": str(payload.get("defaultFont") or current.get("defaultFont") or defaults["defaultFont"]),
        "defaultFontWeight": str(
            payload.get("defaultFontWeight") or current.get("defaultFontWeight") or defaults["defaultFontWeight"]
        ),
        "fps": PROJECT_FPS,
        "characterAnimationFps": normalize_character_animation_fps(
            payload.get("characterAnimationFps") if payload.get("characterAnimationFps") is not None else current.get("characterAnimationFps")
        ),
        "fontWeights": current.get("fontWeights", defaults["fontWeights"]),
        "fonts": current.get("fonts", defaults["fonts"]),
        "textDefaults": current.get("textDefaults", defaults["textDefaults"]),
        "renderDefaults": current.get("renderDefaults", defaults["renderDefaults"]),
        "animationDefaults": current.get("animationDefaults", defaults["animationDefaults"]),
        "lipSync": current.get("lipSync", defaults["lipSync"]),
        "motion": current.get("motion", defaults["motion"]),
        "telopDefaults": current.get("telopDefaults", defaults["telopDefaults"]),
    }

    text_defaults = payload.get("textDefaults")
    if isinstance(text_defaults, dict):
        config["textDefaults"] = {
            "fontFamily": str(text_defaults.get("fontFamily") or config["defaultFont"]),
            "fontWeight": str(text_defaults.get("fontWeight") or config["defaultFontWeight"]),
            "fontSize": max(20, min(120, int(text_defaults.get("fontSize", 54)))),
            "boxOpacity": max(0.0, min(1.0, float(text_defaults.get("boxOpacity", 0.8)))),
            "speechPlacement": str(text_defaults.get("speechPlacement") or "bottom"),
            "boxBorderWidth": max(0, min(100, int(text_defaults.get("boxBorderWidth", 3)))),
            "boxBorderColor": str(text_defaults.get("boxBorderColor") or "#ffffff"),
            "boxBackgroundColor": str(text_defaults.get("boxBackgroundColor") or "#14181c"),
            "textColor": str(text_defaults.get("textColor") or "#ffffff"),
            "textOutlineWidth": max(0, min(12, int(text_defaults.get("textOutlineWidth", 0)))),
            "textOutlineColor": str(text_defaults.get("textOutlineColor") or "#666666"),
            "boxOverlayImage": str(text_defaults.get("boxOverlayImage") or ""),
            "speechOffsetX": max(0, min(1920, int(text_defaults.get("speechOffsetX", 120)))),
            "speechOffsetY": max(0, min(1080, int(text_defaults.get("speechOffsetY", 70)))),
            "speechPaddingX": max(0, min(400, int(text_defaults.get("speechPaddingX", 60)))),
            "speechPaddingY": max(0, min(200, int(text_defaults.get("speechPaddingY", 70)))),
            "lineGap": max(0, min(120, int(text_defaults.get("lineGap", 16)))),
            # 1/1000 em (-500..+1000)、UI は step=100。
            "letterSpacing": max(-500, min(1000, int(text_defaults.get("letterSpacing", 0) or 0))),
            "speakerNameFontSize": max(12, min(80, int(text_defaults.get("speakerNameFontSize", 28)))),
            "showSpeakerName": bool(text_defaults.get("showSpeakerName", True)),
            "inactiveCharacterOpacity": max(0.1, min(1.0, float(text_defaults.get("inactiveCharacterOpacity", 0.5)))),
            "boxBorderRadiusTL": max(0, min(500, int(text_defaults.get("boxBorderRadiusTL", 0) or 0))),
            "boxBorderRadiusTR": max(0, min(500, int(text_defaults.get("boxBorderRadiusTR", 0) or 0))),
            "boxBorderRadiusBL": max(0, min(500, int(text_defaults.get("boxBorderRadiusBL", 0) or 0))),
            "boxBorderRadiusBR": max(0, min(500, int(text_defaults.get("boxBorderRadiusBR", 0) or 0))),
            "enableOpticalKerning": bool(text_defaults.get("enableOpticalKerning", False)),
            "opticalKerningHighQuality": bool(text_defaults.get("opticalKerningHighQuality", False)),
            # セリフ本文の光彩 / ドロップシャドウ (canvas2D v2 で適用)。
            # 既存値が無い場合はクライアントから {"enabled": false, ...} が来る想定。
            "dialogueGlow": _normalize_dialogue_glow(text_defaults.get("dialogueGlow")),
            "dialogueDropShadow": _normalize_dialogue_drop_shadow(text_defaults.get("dialogueDropShadow")),
        }
        config["defaultFont"] = config["textDefaults"]["fontFamily"]
        config["defaultFontWeight"] = config["textDefaults"]["fontWeight"]

    render_defaults = payload.get("renderDefaults")
    if isinstance(render_defaults, dict):
        config["renderDefaults"] = {
            "removeWhite": bool(render_defaults.get("removeWhite", True)),
        }

    animation_defaults = payload.get("animationDefaults")
    if isinstance(animation_defaults, dict):
        algorithm = str(animation_defaults.get("blinkAlgorithm") or "anime")
        if algorithm not in ("anime", "uniform"):
            algorithm = "anime"
        config["animationDefaults"] = {
            "blink": bool(animation_defaults.get("blink", True)),
            "lipSync": bool(animation_defaults.get("lipSync", True)),
            "blinkAlgorithm": algorithm,
        }

    lip_sync = payload.get("lipSync")
    if isinstance(lip_sync, dict):
        config["lipSync"] = {
            "silenceThreshold": max(0.0, min(1.0, float(lip_sync.get("silenceThreshold", 0.08)))),
            "openThreshold": max(0.0, min(1.0, float(lip_sync.get("openThreshold", 0.42)))),
            "dbFloor": float(lip_sync.get("dbFloor", -55)),
            "dbCeil": float(lip_sync.get("dbCeil", -18)),
            "smoothing": max(0.0, min(0.45, float(lip_sync.get("smoothing", 0.2)))),
        }
        if config["lipSync"]["openThreshold"] < config["lipSync"]["silenceThreshold"]:
            config["lipSync"]["openThreshold"] = config["lipSync"]["silenceThreshold"]

    motion = payload.get("motion")
    if isinstance(motion, dict):
        motion_defaults = defaults["motion"]
        merged_motion = {
            "shakeX": dict(config.get("motion", {}).get("shakeX") or motion_defaults["shakeX"]),
            "shakeY": dict(config.get("motion", {}).get("shakeY") or motion_defaults["shakeY"]),
            "zoom": dict(config.get("motion", {}).get("zoom") or motion_defaults["zoom"]),
        }
        for axis_key in ("shakeX", "shakeY"):
            payload_axis = motion.get(axis_key)
            if isinstance(payload_axis, dict):
                amp_raw = payload_axis.get("amplitude", merged_motion[axis_key]["amplitude"])
                amp = int(round(float(amp_raw) / 10.0)) * 10
                merged_motion[axis_key]["amplitude"] = max(10, min(100, amp))
                merged_motion[axis_key]["count"] = max(1, min(20, int(payload_axis.get("count", merged_motion[axis_key]["count"]))))
                dur_raw = float(payload_axis.get("duration", merged_motion[axis_key]["duration"]))
                merged_motion[axis_key]["duration"] = max(0.5, min(2.0, round(dur_raw, 1)))
        zoom_payload = motion.get("zoom")
        if isinstance(zoom_payload, dict):
            scale_raw = float(zoom_payload.get("scale", merged_motion["zoom"]["scale"]))
            merged_motion["zoom"]["scale"] = max(1.1, min(2.0, round(scale_raw, 1)))
            origin = str(zoom_payload.get("origin") or merged_motion["zoom"]["origin"])
            if origin not in ("center", "top", "bottom"):
                origin = "center"
            merged_motion["zoom"]["origin"] = origin
        config["motion"] = merged_motion

    telop_defaults = payload.get("telopDefaults")
    if isinstance(telop_defaults, dict):
        base = defaults["telopDefaults"]
        glow_payload = telop_defaults.get("glow") if isinstance(telop_defaults.get("glow"), dict) else {}
        ds_payload = telop_defaults.get("dropShadow") if isinstance(telop_defaults.get("dropShadow"), dict) else {}
        config["telopDefaults"] = {
            "fontFamily": str(telop_defaults.get("fontFamily") or config["defaultFont"]),
            "fontWeight": str(telop_defaults.get("fontWeight") or config["defaultFontWeight"]),
            "fontSize": max(20, min(160, int(telop_defaults.get("fontSize", base["fontSize"])))),
            "color": str(telop_defaults.get("color") or base["color"]),
            "outlineWidth": max(0, min(20, int(telop_defaults.get("outlineWidth", base["outlineWidth"])))),
            "outlineColor": str(telop_defaults.get("outlineColor") or base["outlineColor"]),
            "glow": {
                "enabled": bool(glow_payload.get("enabled", base["glow"]["enabled"])),
                "color": str(glow_payload.get("color") or base["glow"]["color"]),
                "blurPx": max(0, min(60, int(glow_payload.get("blurPx", base["glow"]["blurPx"])))),
                "opacity": max(0.0, min(1.0, float(glow_payload.get("opacity", base["glow"]["opacity"])))),
            },
            "dropShadow": {
                "enabled": bool(ds_payload.get("enabled", base["dropShadow"]["enabled"])),
                "color": str(ds_payload.get("color") or base["dropShadow"]["color"]),
                "blurPx": max(0, min(40, int(ds_payload.get("blurPx", base["dropShadow"]["blurPx"])))),
                "offsetX": max(-40, min(40, int(ds_payload.get("offsetX", base["dropShadow"]["offsetX"])))),
                "offsetY": max(-40, min(40, int(ds_payload.get("offsetY", base["dropShadow"]["offsetY"])))),
                "opacity": max(0.0, min(1.0, float(ds_payload.get("opacity", base["dropShadow"]["opacity"])))),
            },
            "letterSpacing": max(-500, min(1000, int(telop_defaults.get("letterSpacing", 0) or 0))),
            "lineSpacing": max(-20, min(80, int(telop_defaults.get("lineSpacing", 0) or 0))),
            "enableOpticalKerning": bool(telop_defaults.get("enableOpticalKerning", False)),
            "opticalKerningHighQuality": bool(telop_defaults.get("opticalKerningHighQuality", False)),
        }

    config = merge_auto_fonts(config, ctx)
    ctx.config_path.parent.mkdir(parents=True, exist_ok=True)
    with ctx.config_path.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
    write_project_file(ctx)
    return config

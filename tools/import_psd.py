from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image


CATEGORY_PREFIX = {
    "back_hair": "back_hair",
    "base": "base",
    "cheek": "cheek",
    "eye": "eye",
    "mouth": "mouth",
    "bangs": "bangs",
    "front": "front",
}

# v4 では 7 カテゴリ固定。旧 v3 命名（body/pose/costume/foreground）は base/front に集約する。
CATEGORY_ALIASES = {
    "base": "base",
    "ベース": "base",
    "基本": "base",
    "素体": "base",
    # v3 互換: body/pose/costume はすべて base に流す
    "body": "base",
    "体": "base",
    "身体": "base",
    "衣装ポーズ": "base",
    "pose": "base",
    "ポーズ": "base",
    "costume": "base",
    "衣装": "base",
    "服装": "base",
    "cheek": "cheek",
    "頬": "cheek",
    "ほほ": "cheek",
    "チーク": "cheek",
    "eye": "eye",
    "目": "eye",
    "眼": "eye",
    "mouth": "mouth",
    "口": "mouth",
    "bangs": "bangs",
    "前髪": "bangs",
    "back_hair": "back_hair",
    "backhair": "back_hair",
    "後ろ髪": "back_hair",
    "うしろ髪": "back_hair",
    "後髪": "back_hair",
    "うしろがみ": "back_hair",
    "front": "front",
    "前面": "front",
    # v3 互換: foreground は front に
    "foreground": "front",
    "前景": "front",
    "手前": "front",
}


def safe_id(value: str) -> str:
    item_id = re.sub(r"[^\w-]+", "_", value.strip(), flags=re.UNICODE).strip("_")
    if item_id:
        return item_id
    codepoints = "_".join(f"{ord(char):x}" for char in value.strip())
    return f"item_{codepoints or 'unnamed'}"


THUMBNAIL_LAYER_NAMES = {"thumb", "thumbnail", "サムネイル", "サムネ"}


def parse_layer_name(name: str) -> tuple[str, str] | None:
    normalized = name.strip()
    if not normalized or normalized.startswith("_"):
        return None
    category_pattern = "|".join(re.escape(key) for key in sorted(CATEGORY_ALIASES, key=len, reverse=True))
    match = re.match(rf"^({category_pattern})[/:：](.+)$", normalized, re.I)
    if not match:
        return None
    category = CATEGORY_ALIASES.get(match.group(1), CATEGORY_ALIASES.get(match.group(1).lower()))
    label = match.group(2).strip()
    if not category or not label:
        return None
    return category, label


def is_thumbnail_layer_name(name: str) -> bool:
    return name.strip().lower() in {value.lower() for value in THUMBNAIL_LAYER_NAMES}


def find_thumbnail_layer(psd: Any) -> Any | None:
    def walk(layer: Any) -> Any | None:
        for child in layer:
            if is_thumbnail_layer_name(child.name):
                return child
            if child.is_group():
                found = walk(child)
                if found is not None:
                    return found
        return None
    return walk(psd)


def parse_from_parent(parent_name: str, layer_name: str) -> tuple[str, str] | None:
    parent = parent_name.strip()
    layer = layer_name.strip()
    if not parent or not layer or parent.startswith("_") or layer.startswith("_"):
        return None
    category = CATEGORY_ALIASES.get(parent, CATEGORY_ALIASES.get(parent.lower()))
    if not category:
        return None
    return category, layer


def walk_layers(layer: Any, parent_category_name: str | None = None):
    if hasattr(layer, "name") and is_thumbnail_layer_name(layer.name):
        return
    if layer.is_group():
        parsed = parse_layer_name(layer.name)
        if parsed:
            yield layer
            return
        next_parent = layer.name if layer.name in CATEGORY_ALIASES or layer.name.lower() in CATEGORY_ALIASES else parent_category_name
        for child in layer:
            yield from walk_layers(child, next_parent)
    else:
        parsed = parse_layer_name(layer.name)
        if parsed:
            yield layer, parsed
        elif parent_category_name:
            parsed = parse_from_parent(parent_category_name, layer.name)
            if parsed:
                yield layer, parsed


def item_name(category: str, label: str) -> str:
    return f"{CATEGORY_PREFIX[category]}_{safe_id(label)}"


def export_layer_image(psd: Any, layer: Any) -> Image.Image | None:
    canvas = Image.new("RGBA", psd.size, (255, 255, 255, 0))
    if layer.is_group():
        image = layer.composite(viewport=(0, 0, *psd.size), force=True)
        if image is None:
            return None
        return image.convert("RGBA")

    image = layer.topil()
    if image is None:
        return None
    image = image.convert("RGBA")
    left, top, right, bottom = layer.bbox
    if image.size != (right - left, bottom - top):
        image = image.resize((right - left, bottom - top))
    canvas.alpha_composite(image, (left, top))
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description="PSD layer exporter for the standing-picture system.")
    parser.add_argument("psd", type=Path)
    parser.add_argument("--out", type=Path, default=Path("assets/characters/default"))
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--name", type=str, default="")
    parser.add_argument(
        "--format",
        choices=("png", "avif"),
        default="png",
        help="書き出し画像フォーマット (既定: png / avif は容量 1/30〜1/40)",
    )
    args = parser.parse_args()
    image_ext = f".{args.format}"
    manifest_path = args.manifest or args.out / "character_manifest.json"

    try:
        from psd_tools import PSDImage
    except ImportError as exc:
        raise SystemExit("psd-tools is required. Install it with: python3 -m pip install -r requirements.txt") from exc

    psd = PSDImage.open(args.psd)
    args.out.mkdir(parents=True, exist_ok=True)

    character_id = safe_id(args.out.name)
    manifest: dict[str, Any] = {
        "version": 4,
        "id": character_id,
        "name": args.name or args.out.name,
        "backHairs": [],
        "bases": [],
        "cheeks": [],
        "eyes": [],
        "mouths": [],
        "bangs": [],
        "fronts": [],
        "defaults": {
            "character": {"x": 448, "y": 0, "scale": 1},
            # PSD インポートでは画像が既に α 抜きされていることが多いので、
            # 明示指定が無ければ false を初期値とする (app/psd.py 同期)。
            "removeWhite": False,
            "antialiasBlackLine": False,
        },
    }
    category_to_manifest = {
        "back_hair": "backHairs",
        "base": "bases",
        "cheek": "cheeks",
        "eye": "eyes",
        "mouth": "mouths",
        "bangs": "bangs",
        "front": "fronts",
    }

    for layer, parsed in walk_layers(psd):
        category, label = parsed
        image = export_layer_image(psd, layer)
        if image is None:
            continue

        directory = args.out / category
        directory.mkdir(parents=True, exist_ok=True)
        filename = f"{safe_id(label)}{image_ext}"
        output_path = directory / filename
        image.save(output_path)

        manifest[category_to_manifest[category]].append(
            {
                "id": item_name(category, label),
                "name": label,
                "path": str(output_path),
                "sourceLayer": layer.name,
            }
        )

    thumbnail_layer = find_thumbnail_layer(psd)
    if thumbnail_layer is not None:
        thumb_image = export_layer_image(psd, thumbnail_layer)
        if thumb_image is not None:
            thumb_image.save(args.out / "thumb.png")

    if manifest["bases"]:
        preferred_base = next(
            (
                item
                for item in manifest["bases"]
                if "default" in item["name"].lower() or "デフォルト" in item["name"]
            ),
            manifest["bases"][0],
        )
        manifest["defaults"]["baseId"] = preferred_base["id"]

    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    print(f"exported PSD layers to {args.out}")
    print(f"wrote character manifest to {manifest_path}")


if __name__ == "__main__":
    main()

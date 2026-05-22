from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from import_psd import safe_id


CATEGORY_MAP = {
    "base": "base",
    "pose": "poses",
    "costume": "costumes",
    "body": "bodies",
    "cheek": "cheeks",
    "face": "faces",
    "eye": "eyes",
    "mouth": "mouths",
    "foreground": "foregrounds",
}


def image_items(character_dir: Path, category: str) -> list[dict[str, str]]:
    category_dir = character_dir / category
    if not category_dir.exists():
        return []
    items = []
    for path in sorted([*category_dir.glob("*.png"), *category_dir.glob("*.webp")]):
        label = path.stem
        items.append(
            {
                "id": f"{category}_{safe_id(label)}",
                "name": label,
                "path": str(path),
            }
        )
    return items


def build_manifest(character_dir: Path, character_id: str, name: str) -> dict[str, object]:
    manifest: dict[str, object] = {
        "version": 3,
        "id": character_id,
        "name": name,
        "defaults": {
            "character": {"x": 448, "y": 0, "scale": 1},
            "removeWhite": True,
            "antialiasBlackLine": False,
        },
    }
    for category, key in CATEGORY_MAP.items():
        manifest[key] = image_items(character_dir, category)

    defaults = manifest["defaults"]
    assert isinstance(defaults, dict)
    base_items = manifest.get("base")
    if isinstance(base_items, list) and base_items:
        defaults["base"] = base_items[0]["path"]
    body_items = []
    for key in ("bodies", "costumes", "poses"):
        items = manifest.get(key)
        if isinstance(items, list):
            body_items.extend(items)
    if body_items:
        body = next(
            (
                item
                for item in body_items
                if "default" in item["name"].lower() or "デフォルト" in item["name"]
            ),
            body_items[0],
        )
        defaults["body"] = body["path"]
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Copy legacy character PNG assets into the v3 character layout.")
    parser.add_argument("--source", type=Path, default=Path("assets/character"))
    parser.add_argument("--dest", type=Path, default=Path("assets/characters/default"))
    parser.add_argument("--id", default="default")
    parser.add_argument("--name", default="Default Character")
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(f"source does not exist: {args.source}")
    args.dest.mkdir(parents=True, exist_ok=True)
    for category in CATEGORY_MAP:
        source_dir = args.source / category
        if not source_dir.exists():
            continue
        dest_dir = args.dest / category
        dest_dir.mkdir(parents=True, exist_ok=True)
        for path in sorted([*source_dir.glob("*.png"), *source_dir.glob("*.webp")]):
            shutil.copy2(path, dest_dir / path.name)

    manifest = build_manifest(args.dest, args.id, args.name)
    manifest_path = args.dest / "character_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print(f"wrote {manifest_path}")


if __name__ == "__main__":
    main()

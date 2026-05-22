from __future__ import annotations

import json
import re
import shutil
import time
import unicodedata
from pathlib import Path
from typing import Any

import yaml
from PIL import Image

from .log_setup import app_logger
from .paths import CACHE_DIR, PROJECT_ROOT
from .utils import relative_to_root, slugify_project_id

_log = app_logger("psd-importer")


def _normalize_layer_name(name: Any) -> str:
    """PSD レイヤー名の照合用正規化。

    1. None / 非文字列は空文字に
    2. unicodedata NFC (macOS HFS+/APFS は NFD でレイヤー名を返すことがある)
    3. 前後空白を strip (parsePsdImporterYaml が YAML 行末空白を落とすため、
       PSD 内のレイヤー名末尾空白が combination から消えるケースに対応)

    内部の空白 (連続スペース) は意味のあるユーザ命名のことがあるので維持する。
    """
    if not isinstance(name, str):
        return ""
    return unicodedata.normalize("NFC", name).strip()


PSD_IMPORTER_DIR = CACHE_DIR / "psd-importer"

PSD_IMPORTER_CATEGORY_LABELS: dict[str, str] = {
    "ベース": "base",
    "base": "base",
    "Base": "base",
    "BASE": "base",
    # 旧 v3 命名は v4 では base に集約
    "体": "base",
    "身体": "base",
    "body": "base",
    "Body": "base",
    "ポーズ": "base",
    "pose": "base",
    "衣装": "base",
    "costume": "base",
    "頬": "cheek",
    "ほほ": "cheek",
    "チーク": "cheek",
    "cheek": "cheek",
    "Cheek": "cheek",
    "目": "eye",
    "眼": "eye",
    "eye": "eye",
    "Eye": "eye",
    "口": "mouth",
    "mouth": "mouth",
    "Mouth": "mouth",
    "前髪": "bangs",
    "bangs": "bangs",
    "Bangs": "bangs",
    "後ろ髪": "back_hair",
    "うしろ髪": "back_hair",
    "後髪": "back_hair",
    "うしろがみ": "back_hair",
    "back_hair": "back_hair",
    "BackHair": "back_hair",
    "Back_hair": "back_hair",
    "backhair": "back_hair",
    "Backhair": "back_hair",
    "前面": "front",
    "前景": "front",
    "手前": "front",
    "foreground": "front",
    "front": "front",
    "Front": "front",
    "Foreground": "front",
    "サムネイル": "thumb",
    "サムネ": "thumb",
    "thumb": "thumb",
    "thumbnail": "thumb",
}

PSD_IMPORTER_DIR_FOR_CATEGORY: dict[str, str] = {
    "back_hair": "back_hair",
    "base": "base",
    "cheek": "cheek",
    "eye": "eye",
    "mouth": "mouth",
    "bangs": "bangs",
    "front": "front",
}

PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY: dict[str, str] = {
    "back_hair": "backHairs",
    "base": "bases",
    "cheek": "cheeks",
    "eye": "eyes",
    "mouth": "mouths",
    "bangs": "bangs",
    "front": "fronts",
}

# 推奨カテゴリ (user_guide/technical/psd-layer-rules.md / dev_docs/v4_extension_plan.md)。
# 互換のため YAML の map: ブロックを読み続けるが、現行ではフラグ宣言として
# 解釈する (id / ファイル名の rename は行わない)。
#   map: mouth_closed: "口/閉" → 口/閉 のレイヤーに flags.lipClosed=true を立てる
PSD_IMPORTER_RECOMMENDED_KEYS: dict[str, str] = {
    "mouth_closed": "mouth",
    "mouth_mid": "mouth",
    "mouth_open": "mouth",
    "eye_open": "eye",
    "eye_half": "eye",
    "eye_closed": "eye",
}

# 旧 map キー → flag 名 への変換テーブル。`map: mouth_closed: "口/閉"` を
# `flags: "口/閉": [lipClosed]` と同義に扱う。
PSD_IMPORTER_RECOMMENDED_KEY_TO_FLAG: dict[str, str] = {
    "mouth_closed": "lipClosed",
    "mouth_mid": "lipMid",
    "mouth_open": "lipOpen",
    "eye_open": "blinkOpen",
    "eye_half": "blinkHalf",
    "eye_closed": "blinkClosed",
}

# 各カテゴリで認識するフラグ名。manifest entry の `flags` に保存。
# blinkOpen / lipOpen は per-character 複数立てて OK。
# blinkHalf / blinkClosed / lipClosed / lipMid は manifest 全体で 1 枚ずつ。
PSD_IMPORTER_FLAG_KEYS_BY_CATEGORY: dict[str, set[str]] = {
    "eye": {"blinkOpen", "blinkHalf", "blinkClosed"},
    "mouth": {"lipClosed", "lipMid", "lipOpen"},
}


def ensure_psd_importer_dir() -> Path:
    PSD_IMPORTER_DIR.mkdir(parents=True, exist_ok=True)
    return PSD_IMPORTER_DIR


def psd_importer_session_dir(token: str) -> Path:
    safe_token = re.sub(r"[^A-Za-z0-9_-]+", "", token)
    if not safe_token or safe_token != token:
        raise ValueError("不正なPSDインポータトークンです")
    base = ensure_psd_importer_dir().resolve()
    candidate = (base / safe_token).resolve()
    candidate.relative_to(base)
    return candidate


def cleanup_old_psd_importer_sessions(max_age_seconds: int = 24 * 3600) -> None:
    base = ensure_psd_importer_dir()
    now = time.time()
    for entry in base.iterdir():
        try:
            if entry.is_dir() and now - entry.stat().st_mtime > max_age_seconds:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def _is_excluded_psd_layer_name(name: str) -> bool:
    """`_` プレフィックスのレイヤーはインポート対象外
    (user_guide/technical/psd-layer-rules.md「除外したいレイヤー」)。
    下書き / メモ / 参考線 / 調整レイヤー用。末尾名のみで判定し、
    トップレベル / ネスト内のどちらでも有効。
    """
    return bool(name) and name.lstrip().startswith("_")


def build_psd_layer_tree(psd: Any) -> list[dict[str, Any]]:
    """Build a JSON-friendly layer tree in Photoshop layer-panel order (top-most first).

    psd-tools iterates children in PSD record order (bottom-most first), so we
    reverse it to match the order users see in Photoshop / CSP.

    `_` プレフィックスのレイヤー / グループは除外対象 (グループならサブツリー
    ごとスキップ)。インポータダイアログの一覧にも表示されない。
    """

    def walk(layer: Any, parent_path: list[str]) -> dict[str, Any] | None:
        if _is_excluded_psd_layer_name(getattr(layer, "name", "")):
            return None
        path = parent_path + [layer.name]
        node: dict[str, Any] = {
            "name": layer.name,
            "path": path,
            "isGroup": bool(layer.is_group()),
            "visible": bool(getattr(layer, "visible", True)),
        }
        try:
            bbox = layer.bbox
            if bbox is not None:
                node["bbox"] = list(bbox)
        except Exception:
            pass
        if layer.is_group():
            children = [walk(child, path) for child in reversed(list(layer))]
            node["children"] = [c for c in children if c is not None]
        return node

    out: list[dict[str, Any]] = []
    for child in reversed(list(psd)):
        node = walk(child, [])
        if node is not None:
            out.append(node)
    return out


def _layer_image_is_empty(image: Image.Image | None) -> bool:
    """alpha が全 0、または bbox 取得不能で empty とみなす場合 True。"""
    if image is None:
        return True
    if image.mode != "RGBA":
        # RGB / L 等は alpha が無いので「描画あり」扱い (透明判定不能)。
        return False
    bbox = image.getbbox()
    if bbox is None:
        return True
    return False


def render_layer_onto_canvas(canvas: Image.Image, psd: Any, layer: Any) -> None:
    """Paint a leaf layer onto the canvas using its raw pixel data and bbox.

    Using ``topil`` + bbox bypasses the layer's visibility flag (PSD の非表示
    レイヤーでも、命名規則に合うものはインポート対象にする
    — user_guide/technical/psd-layer-rules.md より)。

    ``topil()`` がスマートオブジェクト・調整レイヤー・効果付きレイヤー等で
    None / 透明 を返すケースがあるため、その場合は ``layer.composite()``
    (PSD 全体サイズで合成済み画像を返す) にフォールバックする。両方失敗時は
    レイヤー名を含む WARN ログを残す (空の transparent PNG が無言で生成され、
    原因切り分けに時間がかかる症状を防ぐ)。
    """
    layer_name = getattr(layer, "name", "?")
    layer_kind = getattr(layer, "kind", "?")
    image = None
    try:
        image = layer.topil()
    except Exception as exc:  # noqa: BLE001
        print(
            f"[psd-import] WARN: topil() で例外: layer={layer_name!r} kind={layer_kind} err={exc}",
            flush=True,
        )

    bbox = getattr(layer, "bbox", None)

    if _layer_image_is_empty(image):
        # フォールバック: psd-tools の composite() を試す。SmartObject / 効果付き /
        # 一部の text/shape レイヤーで topil() が透明を返すケースを救う。
        # composite() は PSD canvas 全体サイズで合成結果を返すので、bbox 補正は不要。
        try:
            composite_image = layer.composite() if hasattr(layer, "composite") else None
        except Exception as exc:  # noqa: BLE001
            print(
                f"[psd-import] WARN: composite() で例外: layer={layer_name!r} kind={layer_kind} err={exc}",
                flush=True,
            )
            composite_image = None
        if composite_image is not None:
            composite_image = composite_image.convert("RGBA")
        if not _layer_image_is_empty(composite_image):
            # composite() の結果は PSD canvas 全体サイズなので bbox 補正なしで重ねる。
            assert composite_image is not None
            if composite_image.size == canvas.size:
                canvas.alpha_composite(composite_image)
                return
            # サイズが PSD と異なる場合は不慮の状況なので、左上に貼る。
            canvas.alpha_composite(composite_image, (0, 0))
            return
        # フォールバックも空。WARN ログを残してから silent return する。
        print(
            f"[psd-import] WARN: 透明レイヤーをスキップ: name={layer_name!r} kind={layer_kind} "
            f"bbox={bbox} visible={getattr(layer, 'visible', '?')} "
            f"has_pixels={getattr(layer, 'has_pixels', lambda: '?')() if callable(getattr(layer, 'has_pixels', None)) else '?'}",
            flush=True,
        )
        return

    image = image.convert("RGBA")
    if bbox is None:
        if image.size != psd.size:
            print(
                f"[psd-import] WARN: bbox 不在で PSD と寸法不一致のためスキップ: "
                f"name={layer_name!r} image_size={image.size} psd_size={psd.size}",
                flush=True,
            )
            return
        canvas.alpha_composite(image)
        return
    left, top, right, bottom = bbox
    width = max(1, right - left)
    height = max(1, bottom - top)
    if image.size != (width, height):
        image = image.resize((width, height))
    canvas.alpha_composite(image, (max(0, left), max(0, top)))


def composite_psd_paths(psd: Any, paths: list[list[str]]) -> Image.Image:
    """`paths` で指定されたレイヤーを PSD から合成する。

    各 path はレイヤー階層のリスト:
      - 複数要素 (例: `["ベース", "健康肌"]`): PSD ツリーのルートからの完全パス
        として扱い、prefix 一致で配下のリーフレイヤーを採用 (旧仕様)。
      - 単一要素 (例: `["健康肌"]`): リーフ名のみの指定として扱い、PSD ツリーの
        どこに居るリーフでも末尾名が一致すれば採用する。`import_manifest.yml`
        で `ベース:\n  - 健康肌` のようにグループ階層を省略する場面で使う。

    レイヤー名照合は `_normalize_layer_name` で NFC 正規化 + 前後空白 strip して
    から行う。これで:
      - macOS HFS+/APFS で PSD が NFD のレイヤー名を返す場合
      - YAML 行末空白を parsePsdImporterYaml が落として末尾スペースが消える場合
    のいずれでも当たる。
    """
    if not paths:
        return Image.new("RGBA", psd.size, (0, 0, 0, 0))

    selected_full: set[tuple[str, ...]] = {
        tuple(_normalize_layer_name(p) for p in path)
        for path in paths
        if len(path) > 1
    }
    selected_leaf: set[str] = {
        _normalize_layer_name(path[0]) for path in paths if len(path) == 1
    }

    def matches(layer_path: tuple[str, ...]) -> bool:
        for length in range(1, len(layer_path) + 1):
            if layer_path[:length] in selected_full:
                return True
        return bool(layer_path) and layer_path[-1] in selected_leaf

    canvas = Image.new("RGBA", psd.size, (0, 0, 0, 0))

    # psd-tools yields children bottom-most first, which is exactly the
    # painting order for alpha-compositing (back to front).
    def render(layer: Any, layer_path: tuple[str, ...]) -> None:
        # `_` プレフィックスは命名規則で除外対象 (下書き / メモ / 調整レイヤー)。
        # YAML が参照していてもサブツリーごとスキップ。レイヤー名は raw (非正規化)
        # で除外判定する (`_` だけは UI でも `_` のまま見えているため)。
        if any(_is_excluded_psd_layer_name(part) for part in layer_path):
            return
        if layer.is_group():
            for child in layer:
                render(child, layer_path + (_normalize_layer_name(child.name),))
            return
        if not matches(layer_path):
            return
        render_layer_onto_canvas(canvas, psd, layer)

    for child in psd:
        render(child, (_normalize_layer_name(child.name),))
    return canvas


def reverse_sanitized_label_to_combination(psd: Any, sanitized_label: str) -> str | None:
    """サニタイズ済みラベル (例: ``眉_普通眉-目_目セット_黒目_普通目``) から、PSD ツリー内で
    ``sanitize_psd_combination_label(combination) == sanitized_label`` となる元の combination
    文字列 (例: ``!眉/*普通眉,!目/*目セット/!黒目/*普通目``) を逆引きする。

    歴史的経緯で sourceCombination がサニタイズ済みラベルで保存されてしまった
    (= 原文の `!*` 情報を失った) エントリを再インポートで更新できるようにするため
    のフォールバック。

    アルゴリズム:
      - PSD ツリーを walk して、各リーフレイヤーのフルパスを `/` 連結 (raw)
      - そのパスの `sanitize_psd_combination_label` 結果を key に raw を index 化
      - 与えられた sanitized_label を `-` で split (= 元 combination の `,` 連結部位)
      - 各 part を index で逆引きして raw に戻し、`,` で再結合
      - どれか 1 つでも逆引き不能なら None
      - 同 sanitized に複数の raw レイヤーがある (ambiguous) ときも None
        (適当な 1 件を選ぶと別レイヤーの絵柄で上書きしてしまうため、安全側で
        スキップさせる。呼び出し側は WARN ログを残す。)
    """
    parts = [p for p in (sanitized_label or "").split("-") if p]
    if not parts:
        return None

    raw_by_sanitized: dict[str, list[str]] = {}

    def walk(layer: Any, layer_path: tuple[str, ...]) -> None:
        if any(_is_excluded_psd_layer_name(p) for p in layer_path):
            return
        if layer.is_group():
            for child in layer:
                walk(child, layer_path + (_normalize_layer_name(child.name),))
            return
        full_raw = "/".join(layer_path)
        sanitized = sanitize_psd_combination_label(full_raw)
        raw_by_sanitized.setdefault(sanitized, []).append(full_raw)

    for child in psd:
        walk(child, (_normalize_layer_name(child.name),))

    matched: list[str] = []
    for part in parts:
        candidates = raw_by_sanitized.get(part) or []
        if not candidates:
            return None
        if len(candidates) > 1:
            # `!顔色/*ほっぺ` と `顔色/ほっぺ` のように `!*` 有無で別レイヤーが同一の
            # sanitized 結果を持つケース。曖昧なので逆引きを諦めて呼び出し側でスキップ
            # させる (= 既存ファイルは温存)。
            print(
                f"[psd-importer] WARN: サニタイズ済みラベル '{part}' に一致する PSD レイヤー "
                f"が {len(candidates)} 枚あり、安全のため逆引きをスキップします: "
                f"{candidates}"
            )
            return None
        matched.append(candidates[0])
    return ",".join(matched)


def psd_has_layers_for_combination(psd: Any, combination: str) -> bool:
    """与えた `combination` 文字列に一致するレイヤーが PSD ツリーに 1 枚以上
    あるかを軽量に判定する。

    `composite_psd_paths` と同じ照合規則 (full path / leaf 名 + 大小無視 + NFC 正規化 +
    `_` プレフィックス除外) を使う。`composite_psd_paths` を呼んでから空キャンバスかを
    判定する案もあるが、append インポート時は「該当レイヤー無し」を理由にスキップする
    (= 既存ファイルを温存する) 用途に使うので、画像生成前に O(N) で答える。
    """
    paths = parse_psd_combination_paths(combination)
    if not paths:
        return False

    selected_full: set[tuple[str, ...]] = {
        tuple(_normalize_layer_name(p) for p in path)
        for path in paths
        if len(path) > 1
    }
    selected_leaf: set[str] = {
        _normalize_layer_name(path[0]) for path in paths if len(path) == 1
    }

    def matches(layer_path: tuple[str, ...]) -> bool:
        for length in range(1, len(layer_path) + 1):
            if layer_path[:length] in selected_full:
                return True
        return bool(layer_path) and layer_path[-1] in selected_leaf

    found = False

    def walk(layer: Any, layer_path: tuple[str, ...]) -> None:
        nonlocal found
        if found:
            return
        if any(_is_excluded_psd_layer_name(part) for part in layer_path):
            return
        if layer.is_group():
            for child in layer:
                walk(child, layer_path + (_normalize_layer_name(child.name),))
            return
        if matches(layer_path):
            found = True

    for child in psd:
        walk(child, (_normalize_layer_name(child.name),))
    return found


_PSD_IMPORTER_STRIP_PATTERN = re.compile(r"[!*?<>:\"\\|]")


def sanitize_psd_combination_label(combination: str) -> str:
    parts = [item.strip() for item in combination.split(",") if item.strip()]
    cleaned_parts: list[str] = []
    for part in parts:
        cleaned = _PSD_IMPORTER_STRIP_PATTERN.sub("", part)
        cleaned = cleaned.replace("/", "_")
        cleaned = re.sub(r"\s+", "_", cleaned).strip("_")
        if cleaned:
            cleaned_parts.append(cleaned)
    return "-".join(cleaned_parts) or "unnamed"


def parse_psd_combination_paths(combination: str) -> list[list[str]]:
    paths: list[list[str]] = []
    for part in combination.split(","):
        part = part.strip()
        if not part:
            continue
        components = [component for component in part.split("/") if component]
        if components:
            paths.append(components)
    return paths


def _parse_flag_value(value: str) -> list[str]:
    """`[blinkOpen, lipOpen]` 風の inline list、もしくは単一フラグを list で返す。"""
    text = (value or "").strip()
    if not text:
        return []
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    parts = [part.strip().strip('"').strip("'") for part in text.split(",")]
    return [part for part in parts if part]


# PSD インポータ UI が吐く YAML は ``- !枝豆/*枝豆通常,...`` のように `!` /
# `*` で始まる非 ASCII 値を unquoted のまま書くケースがある (CJK レイヤー名)。
# PyYAML は `!` をタグハンドル、`*` を anchor alias として予約しており、直後が
# ASCII 識別子文字でないと ``expected '!', but found '枝'`` で死ぬ。
# parse の直前に「sigil 直後が ASCII 識別子文字でない」ものだけを quoted scalar
# に書き換える shim を挟む。valid なタグ/alias (`!myTag` / `*anchor1`) はそのまま。
_PSD_YAML_SIGIL_SHIM = re.compile(
    r'(?m)^(?P<prefix>(?:\s*-\s+|\s*\S+?:\s+))(?P<sigil>[!*])(?P<body>(?![A-Za-z_]).*?)(?P<trail>\s*)$'
)


def _shim_psd_importer_yaml(text: str) -> str:
    def _replace(match: re.Match[str]) -> str:
        body = match.group("body")
        if not body:
            return match.group(0)
        escaped = body.replace("\\", "\\\\").replace('"', '\\"')
        return f'{match.group("prefix")}"{match.group("sigil")}{escaped}"{match.group("trail")}'

    return _PSD_YAML_SIGIL_SHIM.sub(_replace, text or "")


def parse_psd_importer_yaml(text: str) -> dict[str, Any]:
    """配布用 YAML (`import_manifest.yml`) を内部構造へ変換する。

    Phase 5 で PyYAML 経由 (`yaml.safe_load`) に移行。受理するスキーマ:

        schemaVersion: 1
        id: yukari
        name: 結月ゆかり
        ベース:    [...]
        頬:       [...]
        目:       [...]
        口:       [...]
        前髪:     [...]
        後ろ髪:   [...]
        前面:     [...]
        サムネイル: 立ち絵   # 単一スカラー or リスト
        map:
            mouth_closed: 閉じ
        flags:
            "目/開き": [blinkOpen]
        expressionPresets:
            - { name: 通常, isDefault: true, cheek: 通常, eye: 開き, mouth: 閉じ }
        hairstylePresets:
            - { name: ロング, isDefault: true, base: 制服, bangs: 通常, backHair: ロング }
        removeWhite: true
        voice:
            id: voicevox-...
            emotion: ""
        color: "#ffaa55"

    返値の `categories` ブロックの key は内部 slug
    (`base`/`cheek`/`eye`/`mouth`/`bangs`/`back_hair`/`front`)。
    """
    raw = yaml.safe_load(_shim_psd_importer_yaml(text)) or {}
    if not isinstance(raw, dict):
        raw = {}

    result: dict[str, Any] = {
        "schemaVersion": int(raw.get("schemaVersion") or 1),
        "id": str(raw.get("id") or ""),
        "name": str(raw.get("name") or ""),
        "categories": {key: [] for key in PSD_IMPORTER_DIR_FOR_CATEGORY},
        "thumb": [],
        "map": {},
        "flags": {},
        "expressionPresets": [],
        "hairstylePresets": [],
        "removeWhite": raw.get("removeWhite") if isinstance(raw.get("removeWhite"), bool) else None,
        "voice": dict(raw.get("voice") or {}) if isinstance(raw.get("voice"), dict) else {},
        "color": str(raw.get("color") or ""),
    }

    for key, value in raw.items():
        if not isinstance(value, list):
            continue
        normalized = PSD_IMPORTER_CATEGORY_LABELS.get(str(key))
        if normalized in result["categories"]:
            result["categories"][normalized] = [str(v) for v in value if v is not None]
        elif normalized == "thumb":
            result["thumb"].extend(str(v) for v in value if v is not None)

    for key in ("サムネイル", "サムネ", "thumb", "thumbnail"):
        scalar = raw.get(key)
        if isinstance(scalar, str) and scalar:
            result["thumb"].append(scalar)

    map_raw = raw.get("map")
    if isinstance(map_raw, dict):
        result["map"] = {str(k): str(v) for k, v in map_raw.items() if v is not None}

    flags_raw = raw.get("flags")
    if isinstance(flags_raw, dict):
        for key, value in flags_raw.items():
            if isinstance(value, list):
                result["flags"][str(key)] = [str(item) for item in value if item is not None]
            elif isinstance(value, str):
                if value.strip().startswith("["):
                    result["flags"][str(key)] = _parse_flag_value(value)
                else:
                    result["flags"][str(key)] = [value]

    presets_raw = raw.get("expressionPresets")
    if isinstance(presets_raw, list):
        result["expressionPresets"] = [item for item in presets_raw if isinstance(item, dict)]

    hair_raw = raw.get("hairstylePresets")
    if isinstance(hair_raw, list):
        result["hairstylePresets"] = [item for item in hair_raw if isinstance(item, dict)]

    return result


def serialize_psd_importer_yaml(data: dict[str, Any]) -> str:
    """内部構造から配布用 YAML を生成する (PyYAML 経由)。

    出力順を確定させるため (`sort_keys=False`)、明示的に dict を組み立ててから
    `yaml.safe_dump` する。日本語キー (`ベース` / `頬` 等) は `allow_unicode=True`
    でそのまま埋め込む。
    """
    out: dict[str, Any] = {"schemaVersion": int(data.get("schemaVersion") or 1)}
    if data.get("id"):
        out["id"] = data["id"]
    if data.get("name"):
        out["name"] = data["name"]
    if data.get("removeWhite") is not None:
        out["removeWhite"] = bool(data["removeWhite"])
    # voice は id があるときだけ書き出す。emotion は voicepeak の感情指定が
    # 入っているときだけ出力する (voicevox には emotion 概念が無く、空文字を
    # 残すと UI 由来でない冗長キーが import_manifest.yml に並んで読みづらくなる)。
    if "voice" in data and isinstance(data.get("voice"), dict):
        voice = data["voice"]
        voice_id = str(voice.get("id") or "").strip()
        emotion = str(voice.get("emotion") or "").strip()
        if voice_id or emotion:
            voice_out: dict[str, Any] = {}
            if voice_id:
                voice_out["id"] = voice_id
            if emotion:
                voice_out["emotion"] = emotion
            out["voice"] = voice_out
    if "color" in data:
        out["color"] = str(data.get("color") or "")

    label_for_category = {
        "back_hair": "後ろ髪",
        "base": "ベース",
        "cheek": "頬",
        "eye": "目",
        "mouth": "口",
        "bangs": "前髪",
        "front": "前面",
    }
    for category, label in label_for_category.items():
        entries = (data.get("categories") or {}).get(category) or []
        if entries:
            out[label] = list(entries)

    thumb = data.get("thumb") or []
    if thumb:
        out["サムネイル"] = list(thumb) if len(thumb) > 1 else str(thumb[0])

    map_entries = data.get("map") or {}
    if map_entries:
        recommended_order = list(PSD_IMPORTER_RECOMMENDED_KEYS.keys())
        ordered: dict[str, Any] = {}
        for key in recommended_order:
            if key in map_entries:
                ordered[key] = str(map_entries[key])
        for key in map_entries:
            if key not in ordered:
                ordered[key] = str(map_entries[key])
        out["map"] = ordered

    flags_entries = data.get("flags") or {}
    if flags_entries:
        out["flags"] = {str(k): list(v or []) for k, v in flags_entries.items()}

    if data.get("expressionPresets"):
        out["expressionPresets"] = [dict(item) for item in data["expressionPresets"] if isinstance(item, dict)]

    if data.get("hairstylePresets"):
        out["hairstylePresets"] = [dict(item) for item in data["hairstylePresets"] if isinstance(item, dict)]

    return yaml.safe_dump(out, allow_unicode=True, sort_keys=False, default_flow_style=False)


# Phase 5: 配布用 YAML のファイル名を `import_manifest.yml` に統一。
# 旧 `.import.yaml` は read 経路で fallback として参照する (write は新名のみ)。
IMPORT_YAML_FILENAME = "import_manifest.yml"
LEGACY_IMPORT_YAML_FILENAME = ".import.yaml"


def read_import_manifest_yaml_text(character_dir: Path) -> str | None:
    """character_dir 直下の YAML を読む。新名優先、無ければ旧 `.import.yaml`。"""
    new_path = character_dir / IMPORT_YAML_FILENAME
    if new_path.exists():
        try:
            return new_path.read_text(encoding="utf-8")
        except OSError:
            return None
    legacy_path = character_dir / LEGACY_IMPORT_YAML_FILENAME
    if legacy_path.exists():
        try:
            return legacy_path.read_text(encoding="utf-8")
        except OSError:
            return None
    return None


def _resolve_layer_label_and_id(
    category: str, combination: str, map_key: str | None
) -> tuple[str, str]:
    """combination から (file label, manifest id) を決める。

    旧仕様 (map で推奨キー指定時に id を上書き) は廃止。
    どのレイヤーも常に「組合せ名から生成した label」と「`<category>_<safe_label>`」
    を返す。再インポート時にレイヤー名 / id が安定するため、
    cut.state.eyeId などの参照が壊れない。
    フラグは別途 convert_psd_importer_session で manifest entry に書き込む。
    """
    label = sanitize_psd_combination_label(combination)
    safe_id = f"{category}_{slugify_project_id(label)}"
    return label, safe_id


_PSD_IMPORTER_RESAMPLING_MAP: dict[str, int] = {
    "lanczos": Image.Resampling.LANCZOS,
    "bicubic": Image.Resampling.BICUBIC,
    "hamming": Image.Resampling.HAMMING,
    "bilinear": Image.Resampling.BILINEAR,
    "box": Image.Resampling.BOX,
    "nearest": Image.Resampling.NEAREST,
}


_PSD_EMBEDDED_YAML_NAMES = {
    "import_manifest.yml",
    "import_manifest",
    ".import.yaml",  # 旧名 (PSD 内に置かれたものは互換のため拾う)
}


def _extract_psd_embedded_yaml(psd: Any) -> str | None:
    """PSD のルート直下に置かれた `import_manifest.yml` テキストレイヤーを探して
    本文を返す。psd-tools の TypeTool レイヤーは `layer.text` (または
    `layer.engine_dict["Text"]`) でテキストを取り出せる。

    深い階層 (フォルダ内) は探索しない。配布用は PSD 1 枚の最上位に置くのが規約。
    """
    try:
        for layer in psd:
            name = str(getattr(layer, "name", "") or "").strip()
            if name not in _PSD_EMBEDDED_YAML_NAMES:
                continue
            # psd-tools 1.10+ では type レイヤーは `kind == "type"` で判別できる。
            kind = str(getattr(layer, "kind", "") or "")
            if kind and kind != "type":
                # フォルダ等で同名があってもテキストとして扱えないので skip
                continue
            text = getattr(layer, "text", None)
            if isinstance(text, str) and text:
                return text
            # fallback: engine_dict から取り出す試み
            engine_dict = getattr(layer, "engine_dict", None)
            if isinstance(engine_dict, dict):
                inner = engine_dict.get("Text") or engine_dict.get("text")
                if isinstance(inner, str) and inner:
                    return inner
    except Exception as exc:  # noqa: BLE001
        print(f"[psd-importer] _extract_psd_embedded_yaml で例外: {exc}")
    return None


def _compute_psd_resize_scale(
    canvas_size: tuple[int, int], max_width: int, max_height: int
) -> float:
    w, h = canvas_size
    sx = (max_width / w) if (max_width and w > max_width) else 1.0
    sy = (max_height / h) if (max_height and h > max_height) else 1.0
    return min(sx, sy, 1.0)


def _maybe_resize_imported_image(
    image: Image.Image, scale: float, resample: int
) -> Image.Image:
    if scale >= 1.0:
        return image
    new_w = max(1, round(image.width * scale))
    new_h = max(1, round(image.height * scale))
    return image.resize((new_w, new_h), resample)


def _bake_import_options(
    image: Image.Image,
    bake_white_transparent: bool,
    bake_black_line_aa: bool,
    black_line_aa_preset: str | None = None,
) -> Image.Image:
    """PSD インポータが PNG 保存する直前に適用する追加処理.

    順序は **必ず** 白透過 → 黒線 AA。黒線 AA をかけるとシルエット境界で
    純白が薄まって透過判定から漏れるため。``black_line_aa_preset`` は
    ``app/black_line_aa.py:BLACK_LINE_AA_PRESETS`` から sigma など実パラメータを引く。
    """
    if not bake_white_transparent and not bake_black_line_aa:
        return image
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    if bake_white_transparent:
        # compositor.remove_exact_white と同じ「純白だけを α=0 にする」処理。
        # 循環 import を避けるためここで直接 numpy する。
        import numpy as _np
        arr = _np.asarray(image, dtype=_np.uint8).copy()
        exact_white = (arr[:, :, 0] == 255) & (arr[:, :, 1] == 255) & (arr[:, :, 2] == 255)
        arr[exact_white, 3] = 0
        image = Image.fromarray(arr, mode="RGBA")
    if bake_black_line_aa:
        from .black_line_aa import antialias_black_lines, get_black_line_aa_preset
        params = get_black_line_aa_preset(black_line_aa_preset)
        image = antialias_black_lines(
            image,
            sigma=params["sigma"],
            black_threshold=params["black_threshold"],
            inpaint_max_iterations=params["inpaint_max_iterations"],
        )
    return image


def convert_psd_importer_session(
    psd_path: Path,
    target_dir: Path,
    character_id: str,
    name: str,
    parsed: dict[str, Any],
    *,
    append: bool = False,
    yaml_text: str | None = None,
    image_format: str = "png",
    max_width: int = 0,
    max_height: int = 0,
    resampling: str = "lanczos",
    # インポート時の追加処理 (両方既定 OFF):
    #   bake_white_transparent: PNG 保存前に純白 (#FFFFFF) を alpha=0 にする。
    #     これは ``app/compositor.remove_exact_white`` 相当を素材レベルで焼き込む。
    #     新 PSD は元から alpha 抜きされていることが多いので、必要なケースだけ ON。
    #   bake_black_line_aa: PNG 保存前に黒線 AA (``black_line_aa.antialias_black_lines``)
    #     を適用する。順序は必ず 白透過 → 黒線 AA (アンチエイリアスをかけると
    #     境界で純白が失われるため、先に白を抜く)。
    #   black_line_aa_preset: 黒線 AA のパラメータプリセット ID
    #     (``BLACK_LINE_AA_PRESETS``)。未指定 / 未知の id は "normal" にフォールバック。
    bake_white_transparent: bool = False,
    bake_black_line_aa: bool = False,
    black_line_aa_preset: str | None = None,
) -> dict[str, Any]:
    # image_format: "png" (lossless 既定) / "avif" (Pillow 12+ ネイティブ。容量 1/30〜1/40)
    image_format = (image_format or "png").lower()
    if image_format not in {"png", "avif"}:
        raise ValueError(f"未対応の image_format: {image_format}")
    image_ext = f".{image_format}"
    resampling = (resampling or "lanczos").lower()
    if resampling not in _PSD_IMPORTER_RESAMPLING_MAP:
        raise ValueError(f"未対応の resampling: {resampling}")
    resample_filter = _PSD_IMPORTER_RESAMPLING_MAP[resampling]
    max_width = max(0, int(max_width or 0))
    max_height = max(0, int(max_height or 0))
    try:
        from psd_tools import PSDImage
    except ImportError as exc:
        raise RuntimeError("psd-toolsがインストールされていません") from exc

    psd = PSDImage.open(psd_path)
    resize_scale = _compute_psd_resize_scale(psd.size, max_width, max_height)
    target_dir.mkdir(parents=True, exist_ok=True)

    imported_canvas_w = max(1, round(psd.size[0] * resize_scale))
    default_character_x = max(0, (1920 - imported_canvas_w) // 2)

    # Phase 6: PSD ルート直下に `import_manifest.yml` という名前の TypeTool レイヤーが
    # あれば、その埋め込みテキストを優先 YAML として採用する。引数 `parsed` (フロント
    # から来た YAML) は無視。配布用 PSD 1 枚で完結させるための機構。
    embedded_yaml_text = _extract_psd_embedded_yaml(psd)
    if embedded_yaml_text:
        try:
            parsed = parse_psd_importer_yaml(embedded_yaml_text)
        except Exception as exc:  # noqa: BLE001
            print(f"[psd-importer] PSD 埋め込み import_manifest.yml の解析に失敗: {exc}")

    manifest: dict[str, Any]
    existing_yaml_data: dict[str, Any] | None = None
    if append:
        manifest_path = target_dir / "character_manifest.json"
        if not manifest_path.exists():
            raise RuntimeError("既存のキャラクターマニフェストが見つかりません")
        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)
        for required_key in ("backHairs", "bases", "cheeks", "eyes", "mouths", "bangs", "fronts"):
            manifest.setdefault(required_key, [])
        manifest.setdefault("defaults", {}).setdefault(
            "character", {"x": default_character_x, "y": 0, "scale": 1}
        )
        manifest["defaults"].setdefault("removeWhite", False)
        # 既存 import_manifest.yml (legacy .import.yaml fallback あり) をマージ用にロード
        existing_yaml_text = read_import_manifest_yaml_text(target_dir)
        if existing_yaml_text is not None:
            try:
                existing_yaml_data = parse_psd_importer_yaml(existing_yaml_text)
            except Exception:
                existing_yaml_data = None
    else:
        manifest = {
            "version": 4,
            "id": character_id,
            "name": name,
            # Phase 1 で 7 カテゴリ化。新規 manifest 初期化でも backHairs を含めること
            # (含めないと後段の `manifest[manifest_key].append(entry)` が
            # KeyError: 'backHairs' を投げる)。
            "backHairs": [],
            "bases": [],
            "cheeks": [],
            "eyes": [],
            "mouths": [],
            "bangs": [],
            "fronts": [],
            "defaults": {
                # 既定 X は (1920 - インポート後の横幅) / 2 で中央寄せ。
                # 1440px 取り込みなら 240、 1920px 取り込みなら 0。
                "character": {"x": default_character_x, "y": 0, "scale": 1},
                # PSD インポートでは「白を抜く」のはレイヤー側で既に α 抜きされていることがほぼ
                # 全てなので、明示指定が無ければ false を初期値とする (誤って白を抜いて
                # キャラの肌色が透ける事故を避ける)。import_manifest.yml が removeWhite を
                # 明示している場合は apply_import_manifest_yaml_to_character で上書きされる。
                "removeWhite": False,
            },
        }

    map_entries: dict[str, str] = {
        str(key): str(value)
        for key, value in (parsed.get("map") or {}).items()
        if key and value
    }
    combo_to_map_key: dict[str, str] = {combination: key for key, combination in map_entries.items()}

    # combination → 立てるべきフラグ名 set。
    # - 旧 map: ブロックの推奨キー (例: mouth_closed) を flag に転写する。
    # - flags: ブロックは category に応じた既知フラグだけ採用 (typo 防止)。
    flags_by_combination: dict[str, set[str]] = {}
    for recommended_key, combination in map_entries.items():
        flag_name = PSD_IMPORTER_RECOMMENDED_KEY_TO_FLAG.get(recommended_key)
        if flag_name and combination:
            flags_by_combination.setdefault(combination, set()).add(flag_name)
    raw_flags = parsed.get("flags") or {}
    if isinstance(raw_flags, dict):
        all_known_flags: set[str] = set()
        for known in PSD_IMPORTER_FLAG_KEYS_BY_CATEGORY.values():
            all_known_flags.update(known)
        for combination, flag_list in raw_flags.items():
            if not isinstance(flag_list, list):
                continue
            for flag_name in flag_list:
                if isinstance(flag_name, str) and flag_name in all_known_flags:
                    flags_by_combination.setdefault(combination, set()).add(flag_name)

    used_files: dict[str, set[str]] = {key: set() for key in PSD_IMPORTER_DIR_FOR_CATEGORY}
    used_ids: dict[str, set[str]] = {key: set() for key in PSD_IMPORTER_DIR_FOR_CATEGORY}
    existing_by_combination: dict[tuple[str, str], dict[str, Any]] = {}
    for category, manifest_key in PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY.items():
        for entry in manifest.get(manifest_key, []) or []:
            path_str = entry.get("path") or ""
            if path_str:
                used_files[category].add(Path(path_str).name)
            entry_id = entry.get("id") or ""
            if entry_id:
                used_ids[category].add(entry_id)
            combo = entry.get("sourceCombination") or ""
            if combo:
                existing_by_combination[(category, combo)] = entry

    def _drop_entry(category: str, manifest_key: str, victim: dict[str, Any]) -> None:
        path_str = victim.get("path") or ""
        if path_str:
            old_path = (PROJECT_ROOT / path_str).resolve()
            if old_path.exists() and old_path.is_file():
                try:
                    old_path.unlink()
                except OSError:
                    pass
            used_files[category].discard(Path(path_str).name)
        used_ids[category].discard(victim.get("id") or "")
        manifest[manifest_key] = [e for e in manifest.get(manifest_key, []) if e is not victim]

    for category, manifest_key in PSD_IMPORTER_MANIFEST_KEY_FOR_CATEGORY.items():
        entries = (parsed.get("categories") or {}).get(category) or []
        for combination in entries:
            paths = parse_psd_combination_paths(combination)
            if not paths:
                continue
            map_key = combo_to_map_key.get(combination)
            label, desired_id = _resolve_layer_label_and_id(category, combination, map_key)

            # 既存エントリは「YAML の combination」と「sanitize 後 id」の双方で探す。
            # 前者は通常の照合、後者は YAML categories がサニタイズ済みラベルに化け
            # ているケース (歴史データ) を救済する。どちらかに当たれば file path /
            # path を上書き対象として扱える。
            existing_entry = existing_by_combination.get((category, combination))
            if existing_entry is None:
                for entry in manifest.get(manifest_key, []) or []:
                    if entry.get("id") == desired_id:
                        existing_entry = entry
                        break

            # ★ 原文 combination で PSD を直接照合できなければ、サニタイズ済みラベル
            # からの逆引きを試みる。歴史的に sourceCombination が `!*` を失ったまま
            # 保存されてしまった zun2 等のケースで、再インポートが透明 PNG を量産
            # して顔素材を消失させる事故を防ぐ。逆引きできた場合はそれを以降の
            # composite と sourceCombination 保存に使う (= self-heal)。
            effective_combination = combination
            effective_paths = paths
            if not psd_has_layers_for_combination(psd, combination):
                recovered = reverse_sanitized_label_to_combination(psd, combination)
                if recovered:
                    print(
                        f"[psd-importer] {target_dir.name}: '{combination}' をサニタイズ済み "
                        f"ラベルとして '{recovered}' に逆引きしました (sourceCombination を更新)"
                    )
                    effective_combination = recovered
                    effective_paths = parse_psd_combination_paths(recovered)
                else:
                    if append and existing_entry:
                        print(
                            f"[psd-importer] {target_dir.name}: '{combination}' は新 PSD に "
                            f"対応レイヤーが無いため既存ファイルを温存します"
                        )
                    else:
                        print(
                            f"[psd-importer] {target_dir.name}: '{combination}' のレイヤーが "
                            f"PSD に見つからないため登録をスキップします"
                        )
                    continue

            # YAML categories に列挙されたエントリは毎回必ず再書き出しする
            # (= 既存ファイルがあれば一度落としてから書き直す)。
            # 旧実装は「id + basename が完全一致なら skip」していたが、これだと:
            #   - PSD 側のレイヤー絵柄を更新したいケースで反映されない
            #   - 過去に透明 placeholder で上書きされた事故 PNG がそのまま残る
            # の 2 つを取りこぼす。「指定されたものは確実に書き出す」シンプルな
            # 仕様の方が、再インポートの動機 (画像を更新したい) と一致する。
            if existing_entry:
                _drop_entry(category, manifest_key, existing_entry)

            # 別 entry が同 id を使用している場合は append 側で上書き（plan: ID 重複時は append 側を尊重）。
            if desired_id in used_ids[category]:
                victim = next(
                    (e for e in manifest.get(manifest_key, []) if e.get("id") == desired_id),
                    None,
                )
                if victim is not None:
                    _drop_entry(category, manifest_key, victim)

            sub_dir = target_dir / PSD_IMPORTER_DIR_FOR_CATEGORY[category]
            sub_dir.mkdir(parents=True, exist_ok=True)

            file_basename = f"{label}{image_ext}"
            counter = 2
            while file_basename in used_files[category] or (sub_dir / file_basename).exists():
                file_basename = f"{label}_{counter}{image_ext}"
                counter += 1
            output_path = sub_dir / file_basename

            image = composite_psd_paths(psd, effective_paths)
            # composite 結果が完全透明だった場合は書き出さない。直接マッチ + 逆引き
            # の両方が成功した後でも、PSD レイヤーが空 (例: アジャストメントだけの
            # フォルダ) のときに発生し得るので、二重防御として保存前にチェック。
            if image.mode == "RGBA":
                alpha = image.getchannel("A")
                if alpha.getextrema() == (0, 0):
                    if existing_entry:
                        # _drop_entry で既存ファイルは消えているので戻せない。既存
                        # entry を manifest に書き戻して状態だけは整合させる
                        # (画像ファイルは無いが、これ以上事態を悪化させない)。
                        manifest[manifest_key].append(existing_entry)
                        used_ids[category].add(existing_entry.get("id") or "")
                        old_path = Path(existing_entry.get("path") or "").name
                        if old_path:
                            used_files[category].add(old_path)
                    print(
                        f"[psd-importer] WARN: '{combination}' の合成結果が完全透明だった "
                        f"ため書き出しを中止しました"
                    )
                    continue
            image = _maybe_resize_imported_image(image, resize_scale, resample_filter)
            image = _bake_import_options(
                image, bake_white_transparent, bake_black_line_aa, black_line_aa_preset
            )
            image.save(output_path)
            used_files[category].add(file_basename)
            used_ids[category].add(desired_id)

            entry: dict[str, Any] = {
                "id": desired_id,
                "name": label,
                "path": relative_to_root(output_path).replace("\\", "/"),
                # 逆引きで原文を復元できた場合は self-heal で原文を保存。
                # これで次回の refresh / append では YAML categories も原文に戻る。
                "sourceCombination": effective_combination,
            }
            # combination に flags が指定されていれば、そのカテゴリで意味のある
            # ものだけを entry.flags へ書き出す。flags map のキーは元 YAML 由来
            # (combination 文字列) なので、ここでも元 combination を使う。
            valid_flags_for_category = PSD_IMPORTER_FLAG_KEYS_BY_CATEGORY.get(
                category, set()
            )
            applicable = flags_by_combination.get(combination, set()) & valid_flags_for_category
            if applicable:
                entry["flags"] = {flag: True for flag in sorted(applicable)}
            manifest[manifest_key].append(entry)

    if not manifest["bases"]:
        base_dir = target_dir / "base"
        base_dir.mkdir(parents=True, exist_ok=True)
        empty_canvas = Image.new("RGBA", psd.size, (0, 0, 0, 0))
        empty_canvas = _maybe_resize_imported_image(empty_canvas, resize_scale, resample_filter)
        base_path = base_dir / f"base{image_ext}"
        empty_canvas.save(base_path)
        manifest["bases"].append(
            {
                "id": "base_base",
                "name": "base",
                "path": relative_to_root(base_path).replace("\\", "/"),
            }
        )

    thumb_entries = parsed.get("thumb") or []
    for combination in thumb_entries:
        paths = parse_psd_combination_paths(combination)
        if not paths:
            continue
        thumb_paths = paths
        # サニタイズ済みラベルなら逆引きを試みる。逆引きも不可なら既存 thumb 温存。
        if not psd_has_layers_for_combination(psd, combination):
            recovered = reverse_sanitized_label_to_combination(psd, combination)
            if recovered:
                print(
                    f"[psd-importer] {target_dir.name}: thumb '{combination}' を "
                    f"'{recovered}' に逆引きしました"
                )
                thumb_paths = parse_psd_combination_paths(recovered)
            elif append:
                print(
                    f"[psd-importer] {target_dir.name}: thumb '{combination}' は新 PSD に "
                    f"対応レイヤーが無いため既存 thumb.png を温存します"
                )
                continue
            else:
                print(
                    f"[psd-importer] {target_dir.name}: thumb '{combination}' のレイヤーが "
                    f"PSD に見つからないためサムネ生成をスキップします"
                )
                continue
        thumb_image = composite_psd_paths(psd, thumb_paths)
        thumb_image = _maybe_resize_imported_image(thumb_image, resize_scale, resample_filter)
        thumb_image.save(target_dir / "thumb.png")
        break

    if manifest["bases"]:
        manifest["defaults"].setdefault("baseId", manifest["bases"][0]["id"])

    # import_manifest.yml 永続化（character_manifest.json には任意フィールドとして "importYaml" を追記）
    merged_yaml_data = _merge_psd_import_yaml(existing_yaml_data, parsed) if append else parsed
    if not merged_yaml_data.get("id"):
        merged_yaml_data["id"] = manifest.get("id", character_id)
    if not merged_yaml_data.get("name"):
        merged_yaml_data["name"] = manifest.get("name", name)
    yaml_to_save = serialize_psd_importer_yaml(merged_yaml_data)
    if not yaml_to_save and yaml_text:
        yaml_to_save = yaml_text
    (target_dir / IMPORT_YAML_FILENAME).write_text(yaml_to_save, encoding="utf-8")
    manifest["importYaml"] = IMPORT_YAML_FILENAME

    manifest_path = target_dir / "character_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    # YAML 内の flags / removeWhite / voice / color / expressionPresets /
    # hairstylePresets を統合ヘルパで反映する (manifest 書き戻し + preset JSON
    # 展開 + import_manifest.yml の透過ミラー再生成までを一括実行)。
    try:
        from .scenario import (
            apply_import_manifest_yaml_to_character as _apply_import_manifest,
        )
        applied_counts = _apply_import_manifest(target_dir, manifest, merged_yaml_data)
        if applied_counts.get("expression") or applied_counts.get("hairstyle"):
            print(
                f"[psd-importer] {target_dir.name}: presets applied "
                f"(expression={applied_counts['expression']}, hairstyle={applied_counts['hairstyle']})"
            )
    except Exception as exc:  # noqa: BLE001
        # preset 展開で失敗してもインポート自体は成功扱い (レイヤー画像は揃っている)。
        print(f"[psd-importer] import_manifest.yml の preset 展開に失敗: {exc}")

    return manifest


def _merge_psd_import_yaml(
    existing: dict[str, Any] | None, incoming: dict[str, Any]
) -> dict[str, Any]:
    """既存 import_manifest.yml をベースに新規 YAML をマージ。append 側の値を尊重する。

    voice / color / removeWhite / expressionPresets / hairstylePresets /
    schemaVersion も持ち回す (append でも配布用メタが落ちないようにする)。
    """
    def _carry_meta(src: dict[str, Any], dst: dict[str, Any]) -> None:
        """schemaVersion / voice / color / removeWhite / expressionPresets /
        hairstylePresets を src → dst に転写する。"""
        if src.get("schemaVersion"):
            dst["schemaVersion"] = int(src["schemaVersion"])
        if isinstance(src.get("voice"), dict):
            dst["voice"] = dict(src["voice"])
        if src.get("color"):
            dst["color"] = str(src["color"])
        if isinstance(src.get("removeWhite"), bool):
            dst["removeWhite"] = bool(src["removeWhite"])
        if isinstance(src.get("expressionPresets"), list):
            dst["expressionPresets"] = [dict(item) for item in src["expressionPresets"] if isinstance(item, dict)]
        if isinstance(src.get("hairstylePresets"), list):
            dst["hairstylePresets"] = [dict(item) for item in src["hairstylePresets"] if isinstance(item, dict)]

    if not existing:
        result: dict[str, Any] = {
            "id": incoming.get("id", ""),
            "name": incoming.get("name", ""),
            "categories": {
                key: list((incoming.get("categories") or {}).get(key) or [])
                for key in PSD_IMPORTER_DIR_FOR_CATEGORY
            },
            "thumb": list(incoming.get("thumb") or []),
            "map": dict(incoming.get("map") or {}),
            "flags": {
                str(k): list(v) for k, v in (incoming.get("flags") or {}).items()
            },
        }
        _carry_meta(incoming, result)
        return result

    result = {
        "id": incoming.get("id") or existing.get("id", ""),
        "name": incoming.get("name") or existing.get("name", ""),
        "categories": {key: [] for key in PSD_IMPORTER_DIR_FOR_CATEGORY},
        "thumb": list(existing.get("thumb") or []),
        "map": dict(existing.get("map") or {}),
        "flags": {
            str(k): list(v) for k, v in (existing.get("flags") or {}).items()
        },
    }
    # メタ情報は既存をベースに incoming で上書き
    _carry_meta(existing, result)
    _carry_meta(incoming, result)
    # categories は重複排除しつつ既存→incoming の順で連結。
    for key in PSD_IMPORTER_DIR_FOR_CATEGORY:
        merged: list[str] = []
        seen: set[str] = set()
        for combo in (existing.get("categories") or {}).get(key) or []:
            if combo not in seen:
                merged.append(combo)
                seen.add(combo)
        for combo in (incoming.get("categories") or {}).get(key) or []:
            if combo not in seen:
                merged.append(combo)
                seen.add(combo)
        result["categories"][key] = merged
    # incoming の thumb があれば既存を上書き。
    incoming_thumb = list(incoming.get("thumb") or [])
    if incoming_thumb:
        result["thumb"] = incoming_thumb
    # map は既存に incoming を上書きマージ。さらに、incoming の同じ map key が既存と被ったら incoming を尊重。
    for key, value in (incoming.get("map") or {}).items():
        if key and value:
            result["map"][key] = value
    # flags は incoming で上書き (空配列も尊重 = 「フラグなし」を明示できる)。
    for key, value in (incoming.get("flags") or {}).items():
        if not key:
            continue
        if isinstance(value, list):
            result["flags"][str(key)] = list(value)
    return result

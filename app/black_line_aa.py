"""黒線アンチエイリアス (PSD インポート時に焼く).

汎用 MLAA とは別物の、純黒 (#000000) 線画専用 AA。

アルゴリズム:
  1. 黒線マスク: ``RGB == (0,0,0) AND alpha > 0`` のピクセルを抽出。
  2. inpaint: 黒線ピクセルの RGB を、近傍の非黒不透明ピクセルの平均色で
     埋める (= 黒インクを「取り除いた下地」を作る)。3x3 近傍を使った
     反復ダイレーションで実装。透明ピクセル (a=0) は混ぜない (= 白キーの
     ゴミ色を引きずらない)。
  3. soft mask: 黒線マスクを ``ImageFilter.GaussianBlur(radius=sigma)`` で
     ぼかす。それから ``preserve_core`` で「元から黒だったピクセル」の値を
     1.0 に戻す (線の芯はシャープに保つ)。
  4. composite: 黒 ``(0,0,0)`` レイヤーを soft mask の alpha で base の上に
     premultiplied composite する。これで:
       - 内部黒線 → 周囲の肌・服色に滑らかにブレンド
       - シルエット黒線 → 外側は透明 base 上に黒の半透明アルファが乗り、
         どんな背景にも自然に合成できる

design notes:
  - 入力は ``Image.Image`` (mode 任意)。中で RGBA に正規化する。
  - 純黒の定義: RGB が完全に (0,0,0)。R/G/B の許容ノイズも考えると
    ``threshold`` パラメータで「<=N」判定にすると安定する場合があるが、
    線画は概ね真黒で塗られているので既定は厳格 (==0) にしておく。
  - sigma の既定は 0.6 px。1px 線に対して半径 0.5〜0.8 程度が「線芯を
    保ったままエッジだけが羽化する」現実的な範囲。
  - 黒線が無い画像 (例えば顔の頬パーツ単体) は no-op として原本を返す。
"""

from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image, ImageFilter


def _build_black_mask(arr: np.ndarray, threshold: int = 0) -> np.ndarray:
    """純黒不透明ピクセルの bool mask を返す.

    threshold=0 で RGB が完全に (0,0,0) のみ抽出。
    threshold>0 で `R<=N AND G<=N AND B<=N` まで黒扱い (圧縮ノイズ吸収)。
    """
    r = arr[:, :, 0]
    g = arr[:, :, 1]
    b = arr[:, :, 2]
    a = arr[:, :, 3]
    if threshold <= 0:
        rgb_black = (r == 0) & (g == 0) & (b == 0)
    else:
        rgb_black = (r <= threshold) & (g <= threshold) & (b <= threshold)
    return rgb_black & (a > 0)


def _fill_black_with_neighbors(
    arr: np.ndarray,
    black_mask: np.ndarray,
    max_iterations: int = 8,
) -> np.ndarray:
    """黒線ピクセルの RGB を、近傍の非黒不透明ピクセルの平均色で埋める.

    反復ダイレーション:
      - "valid" 集合 = 非黒不透明ピクセル
      - 各反復で、まだ valid でない黒ピクセルに対し 3x3 近傍を見て
        「valid な隣人」の RGB を平均し、自分の RGB に入れて自分も valid に。
      - 線が太い場合は反復で内側まで届く。max_iterations 回で打ち切り。

    透明 (a=0) はサンプリングから除外 (白キーのゴミ色を線色に混ぜない)。
    出力は ``arr`` のコピー (RGB だけ書き換え、alpha は不変)。
    """
    H, W = arr.shape[:2]
    result = arr.copy()
    rgb = result[..., :3].astype(np.float32)
    alpha = result[..., 3]
    valid = (~black_mask) & (alpha > 0)

    for _ in range(max_iterations):
        to_fill = black_mask & ~valid
        if not to_fill.any():
            break

        # 3x3 近傍の平均を、padded 配列の slice で計算する。
        rgb_pad = np.pad(rgb, ((1, 1), (1, 1), (0, 0)), mode="edge")
        valid_pad = np.pad(valid, ((1, 1), (1, 1)), mode="constant", constant_values=False)

        sum_rgb = np.zeros((H, W, 3), dtype=np.float32)
        count = np.zeros((H, W), dtype=np.float32)
        for dy in range(3):
            for dx in range(3):
                if dy == 1 and dx == 1:
                    continue
                v = valid_pad[dy : dy + H, dx : dx + W]
                r = rgb_pad[dy : dy + H, dx : dx + W, :]
                sum_rgb += r * v[..., None]
                count += v.astype(np.float32)

        has_neighbor = (count > 0) & to_fill
        if not has_neighbor.any():
            # どの黒ピクセルにも非黒の隣人が居ない (= 画像全部黒 or 巨大黒塊の芯)。
            # これ以上ダイレーションしても進展しないので打ち切り。
            break

        avg = sum_rgb[has_neighbor] / count[has_neighbor, None]
        rgb[has_neighbor] = avg
        valid |= has_neighbor

    result[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    return result


def antialias_black_lines(
    image: Image.Image,
    *,
    sigma: float = 0.6,
    black_threshold: int = 0,
    inpaint_max_iterations: int = 8,
) -> Image.Image:
    """純黒 (#000000) 線画専用のアンチエイリアス処理.

    Args:
        image: 任意 mode の PIL Image。RGBA に変換して処理する。
        sigma: 黒線マスクの Gaussian blur 半径 (px)。0.6 推奨。
        black_threshold: 黒判定の閾値。0 で純黒のみ、>0 で暗ピクセルも黒扱い。
        inpaint_max_iterations: inpaint の反復回数上限。線が太い場合に増やす。

    Returns:
        新しい RGBA Image。元画像と同じ寸法。
    """
    rgba = image.convert("RGBA")
    arr = np.asarray(rgba, dtype=np.uint8)
    if arr.size == 0:
        return rgba

    black_mask = _build_black_mask(arr, threshold=black_threshold)
    if not black_mask.any():
        # 黒線が無い (頬のグラデパーツなど) → 何もしない。
        return rgba

    # base = 黒線を抜いて近傍色で塗り潰した版。
    base = _fill_black_with_neighbors(arr, black_mask, max_iterations=inpaint_max_iterations)

    # soft mask = 黒線マスクを Gaussian blur (Pillow 経由)。
    mask_u8 = (black_mask.astype(np.uint8) * 255)
    mask_img = Image.fromarray(mask_u8, mode="L")
    blurred = mask_img.filter(ImageFilter.GaussianBlur(radius=float(sigma)))
    soft = np.asarray(blurred, dtype=np.float32) / 255.0
    # core preserve: 元から黒だったピクセルは soft=1.0 (線芯はシャープに保つ)。
    soft = np.maximum(soft, black_mask.astype(np.float32))

    # premultiplied composite: black layer (RGB=0, A=soft) を base (RGB=base_rgb, A=base_a) の
    # 上に乗せる。
    #   out_A = soft + base_A * (1 - soft)
    #   out_RGB_pm = 0 * soft + base_RGB * base_A * (1 - soft)
    #   out_RGB = out_RGB_pm / out_A  (out_A>0)
    base_rgb = base[..., :3].astype(np.float32) / 255.0
    base_a = base[..., 3].astype(np.float32) / 255.0

    soft3 = soft[..., None]
    base_a3 = base_a[..., None]
    out_a = soft + base_a * (1.0 - soft)
    out_rgb_pm = base_rgb * base_a3 * (1.0 - soft3)

    out_rgb = np.zeros_like(base_rgb)
    nonzero = out_a > 1e-4
    nonzero3 = nonzero[..., None].repeat(3, axis=-1)
    safe_a = np.where(nonzero, out_a, 1.0)
    out_rgb = np.where(nonzero3, out_rgb_pm / safe_a[..., None], 0.0)

    out = np.zeros_like(arr)
    out[..., :3] = np.clip(out_rgb * 255.0, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(out_a * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(out, mode="RGBA")


# ---------------------------------------------------------------------------
# プリセット定義: PSD インポータ UI で選択可能なパラメータ組み合わせ。
#
# key の意味:
#   sigma                 : 黒線マスクの Gaussian blur 半径 (px)。大きいほど線が
#                            周囲色に溶け込む / 柔らかい印象に。
#   black_threshold       : 黒判定の閾値 (0..255)。0 で純黒のみ、>0 で「ほぼ黒」も対象。
#                            圧縮ノイズで純黒が崩れた素材や、ダーク色を線扱いしたい
#                            キャラに向けて上げる。
#   inpaint_max_iterations: inpaint (近傍非黒色で埋める) の反復回数上限。太い黒塊
#                            (太眉、まつ毛、太枠等) を内側まで埋めるには 16〜32 必要。
# ---------------------------------------------------------------------------
BLACK_LINE_AA_PRESETS: list[dict[str, Any]] = [
    {
        "id": "sharp",
        "label": "シャープ",
        "description": "線芯くっきり、外側フリンジ最小。元の線質を残したいとき向け。",
        "params": {"sigma": 0.4, "black_threshold": 0, "inpaint_max_iterations": 8},
    },
    {
        "id": "normal",
        "label": "標準",
        "description": "バランス重視の既定値。多くの線画に最初に試す値。",
        "params": {"sigma": 0.6, "black_threshold": 0, "inpaint_max_iterations": 8},
    },
    {
        "id": "soft",
        "label": "ソフト",
        "description": "線を周囲色によく馴染ませる。柔らかい絵柄や淡い印象向け。",
        "params": {"sigma": 1.0, "black_threshold": 0, "inpaint_max_iterations": 8},
    },
    {
        "id": "mild",
        "label": "マイルド",
        "description": "かなり柔らかい印象。輪郭は溶けるが空気感が出る。",
        "params": {"sigma": 1.5, "black_threshold": 0, "inpaint_max_iterations": 8},
    },
    {
        "id": "thick-tolerant",
        "label": "太線対応",
        "description": "太い黒塊や圧縮ノイズの近黒も対象にする。標準よりやや軟調。",
        "params": {"sigma": 0.7, "black_threshold": 10, "inpaint_max_iterations": 16},
    },
]

DEFAULT_BLACK_LINE_AA_PRESET = "normal"


def get_black_line_aa_preset(preset_id: str | None) -> dict[str, Any]:
    """プリセット ID からパラメータ dict を引く。未知 / 空なら DEFAULT。"""
    pid = (preset_id or DEFAULT_BLACK_LINE_AA_PRESET).strip().lower()
    for preset in BLACK_LINE_AA_PRESETS:
        if preset["id"] == pid:
            return dict(preset["params"])
    # 未知の id は default にフォールバック (UI と backend が乖離しても安全に倒れる)。
    for preset in BLACK_LINE_AA_PRESETS:
        if preset["id"] == DEFAULT_BLACK_LINE_AA_PRESET:
            return dict(preset["params"])
    return {"sigma": 0.6, "black_threshold": 0, "inpaint_max_iterations": 8}

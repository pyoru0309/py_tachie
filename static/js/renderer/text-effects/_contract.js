// =============================================================================
// renderer/text-effects/_contract.js
//
// TextClip 用プリセットの「契約」を文書化したファイル。実体は JSDoc 型のみで、
// 実行時の側は static/js/renderer/text-effects.js の registry が見る。
//
// プリセットの slot は § dev_docs/archive/text_system_plan.md §4.1 に従い固定する:
//
//   slot                          | preset 例
//   ------------------------------|----------------------------------------
//   "animation_in"  / "animation_out"  | fade_slide / typewriter / pop_per_char
//   "animation_body"              | shake_beat
//   "effect"                      | neon_glow / rgb_shift / glitch_scan
//
// 1 つのプリセットが複数 slot を受けることがある (fade_slide は in/out 両方)。
// その場合は `slots: ["animation_in","animation_out"]` のように配列で登録する。
//
// data 側 (telop オブジェクト) の置き先:
//   - animation スロット系
//       → clip.animation[in|out|body] = { preset, params }
//         (キー名 in/out/body と slot 名 animation_in/out/body の対応は registry が解決)
//   - effect スロット
//       → clip.effectPreset = "id"  /  clip.effectParams = { ... }
// =============================================================================

/**
 * @typedef {Object} TextEffectContext
 * @property {number} canvasW           出力 canvas 幅 (= 1920 既定)
 * @property {number} canvasH           出力 canvas 高 (= 1080 既定)
 * @property {object|null} underlayInfo 自分より下のレイヤーの色情報 (Phase 2+)
 * @property {number|null} sceneBpm     scene.bpm (= shake_beat 等が参照)
 * @property {number|null} beatPhase    [0..1) の拍位相 (= sceneSec * bpm/60 の小数部)
 * @property {number} characterAnimationFps  量子化 fps (= 8/12/24)
 * @property {number} clipDurationSec   clip 全体の長さ (秒)。out 系で使う
 * @property {string} slot              draw 呼出時の slot 名 ("animation_in" 等)
 */

/**
 * @typedef {Object} TextEffectRuntimeFlags
 * @property {boolean} needsOffscreenRedraw  clip-local offscreen の再ベイクが要るか
 * @property {boolean} needsLayerComposite   renderLayer plane へ毎フレーム drawImage するか
 * @property {boolean} [fullCanvasOffscreen] true なら 1920×1080 fallback
 */

/**
 * @typedef {Object} TextEffectControl
 * @property {string} key
 * @property {string} label
 * @property {"number"|"select"|"color"|"checkbox"|"text"} type
 * @property {number} [min] [max] [step]
 * @property {Array<{value:any,label:string}>} [options]
 * @property {any} [defaultValue]
 */

/**
 * @typedef {Object} TextEffectPreset
 * @property {string} id              "fade_slide" / "typewriter" / "neon_glow" 等
 * @property {string} label           UI 表示名 (日本語可)
 * @property {string[]} slots         このプリセットが受ける slot 名 (例: ["animation_in","animation_out"])
 * @property {boolean} needsOffscreenRedraw
 * @property {boolean} needsLayerComposite
 * @property {boolean} [fullCanvasOffscreen]
 * @property {Object<string,any>} defaultParams
 * @property {TextEffectControl[]} controls
 * @property {(params: object, context: TextEffectContext) => TextEffectRuntimeFlags} [resolveRuntimeFlags]
 * @property {(ctx: CanvasRenderingContext2D, clip: object, params: object, localSec: number, frameIdx: number, context: TextEffectContext, baseDraw: function) => void} draw
 *     ctx に描く。context.slot で「いま animation_in なのか out なのか」を判定する。
 *     animation_in: localSec = sceneSec - clipStart      (0..params.durSec の窓で呼ばれる)
 *     animation_out: localSec = clipDurationSec - (sceneSec - clipStart)  (残り時間、0..params.durSec の窓)
 *     animation_body / effect: localSec = sceneSec - clipStart (clip 全範囲)
 *     baseDraw(ctx) = 「素の caption 描画 1 件分」をその ctx 上で実行する callback。
 *                     プリセットの transform / alpha を ctx.save/restore で囲って呼ぶ。
 */

export const TEXT_EFFECT_SLOT_VALUES = [
  "animation_in",
  "animation_out",
  "animation_body",
  "effect",
];

// animation スロット名 ↔ data 側のキー名のマッピング。
// drawTextClip 側 (Phase 1-3) が clip.animation[in/out/body] を読むときに使う。
export const ANIMATION_SLOT_TO_DATA_KEY = {
  animation_in: "in",
  animation_out: "out",
  animation_body: "body",
};

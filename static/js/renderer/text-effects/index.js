// =============================================================================
// renderer/text-effects/index.js
//
// テキストエフェクトプリセットの一括登録ハブ。
// このファイルを import すれば、各プリセットモジュールが副作用で
// registerEffectPreset() を実行して registry に載る。
//
// 呼び出し側は最低 1 か所でこれを import すればよい (telop.js / scene-builder.js
// 経由のどこかで)。複数回 import されても registerEffectPreset 側の警告で
// 検知できる。
// =============================================================================

import "./fade.js";
import "./fade_slide.js";
import "./typewriter.js";
import "./neon_glow.js";
import "./rgb_shift.js";
import "./pop_per_char.js";
import "./glitch_scan.js";
import "./shake_beat.js";

// Phase 4 時点でレジストリ登録される 7 プリセット:
//   animation: fade_slide / typewriter / pop_per_char (in 系) / shake_beat (body)
//   effect   : neon_glow / rgb_shift / glitch_scan
//
// Phase 3 までの `huge_handwritten` は Phase 4 で廃止し、
// 同等表現は poster_typography テンプレ生成 (= 複数 TextClip を一度に生成)
// 経由で作る方針に倒した。旧 disk データの effectPreset === "huge_handwritten"
// は app/scenario.py:_normalize_telop で null に倒される。

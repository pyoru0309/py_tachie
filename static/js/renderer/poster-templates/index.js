// =============================================================================
// renderer/poster-templates/index.js
//
// poster_typography テンプレ (Phase 4) の一括登録ハブ。
// 各テンプレモジュールは副作用で registerPosterTemplate() を呼ぶので、
// このファイルを 1 か所で import すれば registry に全テンプレが揃う。
//
// 利用側 (poster-typography-dialog.js / text-motion.js) は
//   `import { listPosterTemplates, getPosterTemplate } from "./renderer/poster-templates/registry.js";`
//   `import "./renderer/poster-templates/index.js";`
// のように registry と副作用 import を別ファイルから読む。
// =============================================================================

import "./kanji_kana_pair.js";
import "./central_emphasis.js";
import "./repeated_ghost.js";
import "./diagonal_phrase.js";

// =============================================================================
// renderer/poster-templates/registry.js
//
// poster_typography テンプレ (Phase 4) のレジストリ。
// 各テンプレは「1 入力テキスト + パラメータ → 複数 TextClip」を生成する関数を持つ。
// effectPreset と違って単一 clip にかかる視覚フィルタではなく、「テロップ追加時の
// テンプレ」として複数 clip をまとめて scenario に挿入するための機構。
//
// 公開 API:
//   registerPosterTemplate(template)
//   getPosterTemplate(id)
//   listPosterTemplates()
//
// テンプレ contract:
//   {
//     id: "kanji_kana_pair",
//     label: "漢字＋かな (フリガナ風)",
//     description: "...",                   // ダイアログの説明文
//     defaultParams: { ... },                // params の初期値
//     controls: [{ key, label, type, ... }], // text-motion.js の _buildPresetControl と
//                                            // 同じ形 (UI を自動生成)
//     generate(params, ctx) -> Array<Partial<TextClip>>
//   }
//
// generate() の戻り値は「TextClip の patch 配列」。呼び出し側 (= poster-typography-dialog.js)
// が defaultTelop() を base にマージし、id / startFrame / durationFrame /
// metadata.posterTypography を最終的に詰める。生成器側は「テキスト・位置・スタイル」
// だけを返せばよく、frame 系や永続化用 metadata は気にしない。
//
// ctx (= テンプレ呼出 context):
//   canvasW: 1920, canvasH: 1080  (出力解像度)
// =============================================================================

const _registry = new Map();

export function registerPosterTemplate(template) {
  if (!template || typeof template !== "object") {
    throw new Error("registerPosterTemplate: template must be an object");
  }
  const id = String(template.id || "").trim();
  if (!id) throw new Error("registerPosterTemplate: template.id is required");
  if (typeof template.generate !== "function") {
    throw new Error(`registerPosterTemplate: template.generate must be a function (id=${id})`);
  }
  if (_registry.has(id)) {
    // 同 id の重複登録は警告して上書き (HMR / テスト都合)。
    console.warn(`[poster-templates] overwriting template "${id}"`);
  }
  _registry.set(id, {
    id,
    label: String(template.label || id),
    description: String(template.description || ""),
    defaultParams: { ...(template.defaultParams || {}) },
    controls: Array.isArray(template.controls) ? template.controls.slice() : [],
    generate: template.generate,
  });
}

export function getPosterTemplate(id) {
  if (!id) return null;
  return _registry.get(String(id)) || null;
}

export function listPosterTemplates() {
  return Array.from(_registry.values());
}

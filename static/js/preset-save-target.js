// =============================================================================
// preset-save-target.js
//
// 「プルダウン + プリセット名 + 保存」型のプリセット (表情 / 配置 / 前景・背景 /
// オーラ・雷・光の筋) で、保存ボタンが どのプリセットへ書くか を決める共通ルール。
//
//   - プリセット名が空、または選択中プリセットの名前のまま → 選択中を上書き
//     (何も選んでいなくて名前が空 → 既定名 + 番号で新規)
//   - 名前を変えた → 別名で新規保存 (選択中のプリセットは触らない)
//   - ただし同じ名前のプリセットが既にある → 確認してからそのプリセットを上書き
//
// 以前は「選択中なら必ず上書き」だったため、既存プリセットを選んで値を少し変え、
// 名前を変えて保存すると、元のプリセットが名前ごと書き換わっていた。
// =============================================================================
import { promptConfirm } from "./dialog.js";

const normName = (name) => String(name || "").trim().normalize("NFC");

// presets: その系統で候補になるプリセット (キャラ別のものは呼び出し側で絞る)
// 戻り値: { id, existing, name } / キャンセル時は null。
//   existing = 上書きする既存プリセット (新規なら null)
export async function resolvePresetSaveTarget({ presets, selectedId, name, fallbackName, newId, label }) {
  const list = Array.isArray(presets) ? presets : [];
  const typed = normName(name);
  const selected = selectedId ? list.find((p) => p.id === selectedId) : null;
  if (selected && (!typed || typed === normName(selected.name))) {
    return { id: selected.id, existing: selected, name: selected.name };
  }
  if (!typed) {
    // 名前が空の新規保存は、既定名に番号を付けて既存と重ならないようにする。
    const base = normName(fallbackName) || label;
    const taken = new Set(list.map((p) => normName(p.name)));
    let finalName = base;
    for (let n = 2; taken.has(finalName); n += 1) finalName = `${base} ${n}`;
    return { id: newId(), existing: null, name: finalName };
  }
  const finalName = typed;
  const sameName = list.find((p) => normName(p.name) === finalName);
  if (sameName) {
    const ok = await promptConfirm({
      title: `${label}プリセットの上書き`,
      message: `「${sameName.name}」という名前の${label}プリセットが既にあります。上書きしますか？`,
      note: "別のプリセットとして残したいときは、名前を変えてから保存してください。",
      confirmLabel: "上書きする",
      cancelLabel: "やめる",
    });
    return ok ? { id: sameName.id, existing: sameName, name: sameName.name } : null;
  }
  return { id: newId(), existing: null, name: finalName };
}

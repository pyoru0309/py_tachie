// =============================================================================
// text-motion.js
//
// TextClip 拡張 (Phase 1+) の UI 部品。既存テロップエディタの末尾に
// 「アニメーション」「エフェクト」セクションを挿入する形で動く。
// renderTelopEditor から `appendTextMotionSections(panel, telop, ctx)` で呼ばれる。
//
// ctx: { currentTelop, editTelop, scheduleScenarioSave, recordHistory, renderPreview, renderTelopEditor }
//
// 設計判断:
//   - Phase 1 MVP では「フォント/色/サイズ等」は既存 caption フォームをそのまま使い、
//     animation/effectPreset/renderLayer の項目だけ別ブロックで追加する。
//   - 仕様 §8.2 の「右パネル構成」(MV 専用パネル) は Phase 2 で本格化する。
//   - renderLayer は Phase 1/2 では disabled 表示 (Phase 3 で plane 分割が入ってから解禁)。
//   - occlusion セクションは Phase 5 まで UI を出さない (§8.2 ★)。
// =============================================================================

import { listEffectPresets, getEffectPreset } from "./renderer/text-effects.js";
import { buttonMarkup } from "./utils.js";
import { buildColorSwatch } from "./telop.js";
import { openPosterTypographyDialog } from "./poster-typography-dialog.js";
import { getPosterTemplate } from "./renderer/poster-templates/registry.js";
// プリセットを副作用登録するため一度 import しておく。
import "./renderer/text-effects/index.js";

const ANIMATION_SLOT_DEFS = [
  { key: "in",   label: "登場アニメ", uiSlot: "animation_in",   description: "fade_slide / typewriter など" },
  { key: "out",  label: "退場アニメ", uiSlot: "animation_out",  description: "fade_slide など" },
  { key: "body", label: "持続モーション", uiSlot: "animation_body", description: "shake_beat など (Phase 3 で実装)" },
];

function _ensureAnimation(telop) {
  if (!telop.animation || typeof telop.animation !== "object") {
    telop.animation = { in: {preset:null,params:{}}, out: {preset:null,params:{}}, body: {preset:null,params:{}} };
  }
  for (const slot of ["in", "out", "body"]) {
    if (!telop.animation[slot] || typeof telop.animation[slot] !== "object") {
      telop.animation[slot] = { preset: null, params: {} };
    } else {
      if (!("preset" in telop.animation[slot])) telop.animation[slot].preset = null;
      if (!telop.animation[slot].params || typeof telop.animation[slot].params !== "object") {
        telop.animation[slot].params = {};
      }
    }
  }
  return telop.animation;
}

function _buildPresetControl(control, params, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "preset-control";
  const labelText = document.createElement("span");
  labelText.className = "preset-control-label";
  labelText.textContent = control.label || control.key;
  wrap.append(labelText);
  let input;
  const cur = params[control.key];
  if (control.type === "select" && Array.isArray(control.options)) {
    input = document.createElement("select");
    for (const opt of control.options) {
      const o = document.createElement("option");
      o.value = String(opt.value);
      o.textContent = opt.label;
      input.append(o);
    }
    input.value = cur != null ? String(cur) : String(control.options[0]?.value ?? "");
    input.addEventListener("change", () => {
      // 元の value 型 (string/number/bool) を尊重して書き戻し
      const raw = input.value;
      const orig = control.options.find((o) => String(o.value) === raw);
      onChange(orig ? orig.value : raw);
    });
  } else if (control.type === "checkbox") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!cur;
    input.addEventListener("change", () => onChange(input.checked));
  } else if (control.type === "color") {
    // 既存のテロップ色入力 (光彩 / ドロップシャドウ / 文字色) と同じ swatch + HEX 並置 UI。
    // ネイティブ <input type="color"> 単体だと「色がわからない表示」になるため必ず本ヘルパ経由。
    const fallback = (typeof control.defaultValue === "string") ? control.defaultValue : "#ffffff";
    const initial = cur != null ? String(cur) : fallback;
    const swatch = buildColorSwatch(initial, fallback, (v) => onChange(v));
    wrap.append(swatch);
    return wrap;   // input/label の append は不要 (swatch が両方を内包)
  } else if (control.type === "text") {
    input = document.createElement("input");
    input.type = "text";
    input.value = cur != null ? String(cur) : "";
    input.addEventListener("change", () => onChange(input.value));
  } else {
    // number (既定)
    input = document.createElement("input");
    input.type = "number";
    if (control.min != null) input.min = String(control.min);
    if (control.max != null) input.max = String(control.max);
    if (control.step != null) input.step = String(control.step);
    input.value = cur != null ? String(cur) : "";
    input.addEventListener("change", () => {
      const n = Number(input.value);
      onChange(Number.isFinite(n) ? n : 0);
    });
  }
  wrap.append(input);
  return wrap;
}

function _buildAnimationSection(animation, slotKey, slotLabel, slotUiSlot, slotDescription, ctx) {
  // 候補プリセットが 1 つも無い slot は UI に出さない (= Phase 2 時点では animation_body)。
  // 既存 telop オブジェクトに「以前選択した preset」が残っている場合は、それを保存し
  // 続けるためにセクションを出してリセット手段を提供する。
  const candidates = listEffectPresets({ slot: slotUiSlot });
  const currentPresetId = animation?.[slotKey]?.preset || null;
  if (candidates.length === 0 && !currentPresetId) return null;

  const section = document.createElement("section");
  section.className = "text-motion-section animation-slot";
  const header = document.createElement("div");
  header.className = "text-motion-section-header";
  const title = document.createElement("strong");
  title.textContent = slotLabel;
  header.append(title);
  const note = document.createElement("span");
  note.className = "text-motion-section-note";
  note.textContent = slotDescription;
  header.append(note);
  section.append(header);

  // プリセット選択
  const presetSelect = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "なし";
  presetSelect.append(noneOpt);
  for (const p of candidates) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    presetSelect.append(o);
  }
  const currentEntry = animation[slotKey] || { preset: null, params: {} };
  presetSelect.value = currentEntry.preset || "";

  const presetLabel = document.createElement("label");
  presetLabel.className = "preset-row";
  const presetCaption = document.createElement("span");
  presetCaption.className = "preset-control-label";
  presetCaption.textContent = "プリセット";
  presetLabel.append(presetCaption, presetSelect);
  section.append(presetLabel);

  // params エリア
  const paramsHolder = document.createElement("div");
  paramsHolder.className = "preset-params";
  section.append(paramsHolder);

  const rebuildParams = () => {
    paramsHolder.innerHTML = "";
    const live = ctx.currentTelop();
    if (!live) return;
    const liveAnim = _ensureAnimation(live);
    const id = liveAnim[slotKey]?.preset || null;
    if (!id) return;
    const preset = getEffectPreset(id);
    if (!preset) {
      const warn = document.createElement("p");
      warn.className = "text-motion-warn";
      warn.textContent = `プリセット "${id}" は未登録です`;
      paramsHolder.append(warn);
      return;
    }
    // params に未指定キーがあれば preset.defaultParams で補完
    const params = liveAnim[slotKey].params = {
      ...preset.defaultParams,
      ...(liveAnim[slotKey].params || {}),
    };
    for (const control of preset.controls) {
      const node = _buildPresetControl(control, params, (val) => {
        ctx.editTelop((t) => {
          const a = _ensureAnimation(t);
          a[slotKey].params[control.key] = val;
        });
        ctx.scheduleScenarioSave();
        ctx.renderPreview();
      });
      paramsHolder.append(node);
    }
  };

  presetSelect.addEventListener("change", () => {
    const id = presetSelect.value || null;
    ctx.editTelop((t) => {
      const a = _ensureAnimation(t);
      a[slotKey].preset = id;
      // プリセット切り替え時は params を defaults に初期化 (旧プリセットのキーが
      // 残らないように)。
      if (id) {
        const p = getEffectPreset(id);
        a[slotKey].params = p ? { ...p.defaultParams } : {};
      } else {
        a[slotKey].params = {};
      }
    });
    ctx.scheduleScenarioSave();
    ctx.recordHistory();
    rebuildParams();
    ctx.renderPreview();
  });

  rebuildParams();
  return section;
}

function _buildEffectSection(telop, ctx) {
  // effectPreset は mv_text 専用 (caption はサーバ normalize で null に倒される)。
  // ただし UI 上は両方の kind で表示し、選択時に kind を自動で mv_text に切り替える方が
  // ユーザー体験がよい。Phase 1 では「caption のときは "MV 文字に変換" 案内」のみ出す。
  const section = document.createElement("section");
  section.className = "text-motion-section effect-slot";
  const header = document.createElement("div");
  header.className = "text-motion-section-header";
  const title = document.createElement("strong");
  title.textContent = "視覚エフェクト";
  header.append(title);
  const note = document.createElement("span");
  note.className = "text-motion-section-note";
  note.textContent = "neon_glow / rgb_shift など (Phase 2 で実装)";
  header.append(note);
  section.append(header);

  const presetSelect = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "なし";
  presetSelect.append(noneOpt);
  const candidates = listEffectPresets({ slot: "effect" });
  for (const p of candidates) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    presetSelect.append(o);
  }
  presetSelect.value = telop.effectPreset || "";
  if (telop.kind !== "mv_text") {
    presetSelect.disabled = true;
    presetSelect.title = "「MV 文字に変換」を押してから選択できます";
  }
  const row = document.createElement("label");
  row.className = "preset-row";
  const cap = document.createElement("span");
  cap.className = "preset-control-label";
  cap.textContent = "プリセット";
  row.append(cap, presetSelect);
  section.append(row);

  const paramsHolder = document.createElement("div");
  paramsHolder.className = "preset-params";
  section.append(paramsHolder);

  const rebuildParams = () => {
    paramsHolder.innerHTML = "";
    const live = ctx.currentTelop();
    if (!live) return;
    const id = live.effectPreset;
    if (!id) return;
    const preset = getEffectPreset(id);
    if (!preset) {
      const warn = document.createElement("p");
      warn.className = "text-motion-warn";
      warn.textContent = `プリセット "${id}" は未登録です`;
      paramsHolder.append(warn);
      return;
    }
    if (!live.effectParams || typeof live.effectParams !== "object") live.effectParams = {};
    live.effectParams = { ...preset.defaultParams, ...live.effectParams };
    for (const control of preset.controls) {
      const node = _buildPresetControl(control, live.effectParams, (val) => {
        ctx.editTelop((t) => {
          if (!t.effectParams || typeof t.effectParams !== "object") t.effectParams = {};
          t.effectParams[control.key] = val;
        });
        ctx.scheduleScenarioSave();
        ctx.renderPreview();
      });
      paramsHolder.append(node);
    }
  };

  presetSelect.addEventListener("change", () => {
    const id = presetSelect.value || null;
    ctx.editTelop((t) => {
      t.effectPreset = id;
      if (id) {
        const p = getEffectPreset(id);
        t.effectParams = p ? { ...p.defaultParams } : {};
      } else {
        t.effectParams = {};
      }
    });
    ctx.scheduleScenarioSave();
    ctx.recordHistory();
    rebuildParams();
    ctx.renderPreview();
  });

  rebuildParams();
  return section;
}

function _buildKindToggleButton(telop, ctx) {
  // kind=caption → 「MV 文字に変換」, kind=mv_text → 「Caption に戻す」
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "compact-action-button text-motion-kind-toggle";
  if (telop.kind === "mv_text") {
    btn.innerHTML = buttonMarkup("subtitles", "Caption に戻す");
    btn.title = "MV 文字モードを解除して通常のテロップに戻します。effectPreset / effectParams は無効化されます。";
  } else {
    btn.innerHTML = buttonMarkup("auto_awesome", "MV 文字に変換");
    btn.title = "視覚エフェクトを有効化できる MV 文字モードに切り替えます。";
  }
  btn.addEventListener("click", () => {
    ctx.editTelop((t) => {
      if (t.kind === "mv_text") {
        t.kind = "caption";
        t.effectPreset = null;
        t.effectParams = {};
      } else {
        t.kind = "mv_text";
      }
    });
    ctx.scheduleScenarioSave();
    ctx.recordHistory();
    ctx.renderTelopEditor();   // セクション再構築
    ctx.renderPreview();
  });
  return btn;
}

function _buildRenderLayerSection(telop, ctx) {
  // Phase 3 で plane 分割が入って有効化。キャラの前後・前景の前後にテロップを挟める。
  const section = document.createElement("section");
  section.className = "text-motion-section render-layer-slot";
  const header = document.createElement("div");
  header.className = "text-motion-section-header";
  const title = document.createElement("strong");
  title.textContent = "描画レイヤー";
  header.append(title);
  const note = document.createElement("span");
  note.className = "text-motion-section-note";
  note.textContent = "キャラの前後や前景の前後にテキストを置ける";
  header.append(note);
  section.append(header);

  const select = document.createElement("select");
  for (const { value, label } of [
    { value: "overlay",      label: "最前面 (オーバーレイ)" },
    { value: "above_bg",     label: "背景の上 (キャラより奥)" },
    { value: "above_chars",  label: "キャラの上 (前景より奥)" },
    { value: "above_fg",     label: "前景の上 (セリフより奥)" },
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    select.append(o);
  }
  select.value = telop.renderLayer || "overlay";
  select.addEventListener("change", () => {
    ctx.editTelop((t) => { t.renderLayer = select.value; });
    ctx.scheduleScenarioSave();
    ctx.recordHistory();
    ctx.renderPreview();
  });

  const row = document.createElement("label");
  row.className = "preset-row";
  const cap = document.createElement("span");
  cap.className = "preset-control-label";
  cap.textContent = "レイヤー";
  row.append(cap, select);
  section.append(row);
  return section;
}

// ★ Phase 4: poster_typography テンプレ生成由来の clip には、グループ情報と
//   「テンプレを再適用」ボタンを表示する。個別調整した clip でも metadata は
//   残っているので、ここから「同じ groupId の clip 群を再生成」できる。
//   metadata.posterTypography を持たない手動 clip では何も出さない。
function _buildPosterTypographySection(telop) {
  const meta = telop?.metadata?.posterTypography;
  if (!meta || !meta.templateId || !meta.groupId) return null;
  const tpl = getPosterTemplate(meta.templateId);

  const section = document.createElement("section");
  section.className = "text-motion-section poster-template-info";

  const header = document.createElement("div");
  header.className = "text-motion-section-header";
  const title = document.createElement("strong");
  title.textContent = "テンプレ生成由来";
  header.append(title);
  const note = document.createElement("span");
  note.className = "text-motion-section-note";
  note.textContent = tpl ? tpl.label : meta.templateId;
  header.append(note);
  section.append(header);

  const info = document.createElement("p");
  info.className = "poster-template-info-text";
  const role = meta.role ? ` / 役割: ${meta.role}` : "";
  info.textContent = `グループ: ${meta.groupId}${role}`;
  section.append(info);

  if (meta.sourceText) {
    const src = document.createElement("p");
    src.className = "poster-template-info-text";
    src.textContent = `生成元テキスト: ${meta.sourceText}`;
    section.append(src);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "compact-action-button";
  btn.innerHTML = buttonMarkup("autorenew", "テンプレを再適用");
  btn.title = "同じグループの TextClip をまとめて再生成します。個別に編集した clip は上書きされます。";
  btn.addEventListener("click", () => {
    openPosterTypographyDialog({
      mode: "regenerate",
      groupId: meta.groupId,
      templateId: meta.templateId,
      params: meta.params || {},
      sourceText: meta.sourceText || "",
      durationFrame: telop.durationFrame,
    });
  });
  section.append(btn);

  return section;
}

// 外向け API: 既存テロップカード本文 (body) の末尾に追加するノード群を返す。
// renderTelopEditor からこれを呼んで append する。
//
// 並び順 (ユーザー混乱対策):
//   1. テンプレ生成由来情報 (該当する clip のみ)
//   2. 登場 / 退場 / 持続モーション   ← Caption でも MV でも有効
//   3. 描画レイヤー                    ← Caption でも MV でも有効
//   4. ─── 区切り ───
//   5. 「MV 文字 + 視覚エフェクト」グループ  ← MV 文字モード時だけ意味がある
//        - kind 切替ボタン (badge 付き)
//        - 視覚エフェクト preset
//
// 旧版では 1〜4 と effect が縦に並んでいて、登場アニメ等もまとめて「MV 専用」と
// 誤解されることがあった。MV 切替と effect だけを最下段にまとめて、その上の
// セクションは Caption でも使えることを視覚的に明示する。
export function appendTextMotionSections(parent, telop, ctx) {
  if (!parent || !telop) return;
  _ensureAnimation(telop);

  const container = document.createElement("div");
  container.className = "text-motion-container";

  // テンプレ生成由来なら情報セクションを先頭に置く (= 一番目立つ位置)
  const posterSection = _buildPosterTypographySection(telop);
  if (posterSection) container.append(posterSection);

  // 登場 / 退場 / 持続モーション (Caption でも MV でも有効)
  for (const def of ANIMATION_SLOT_DEFS) {
    const section = _buildAnimationSection(
      telop.animation, def.key, def.label, def.uiSlot, def.description, ctx,
    );
    if (section) container.append(section);
  }

  container.append(_buildRenderLayerSection(telop, ctx));

  // ─── MV 文字 / 視覚エフェクト グループ (最下段) ───
  // この 2 つは互いに依存しており Caption では効かないことを視覚的なまとまりで示す。
  // 上のアニメーション / レイヤー系は Caption でも効くので、明示的に「ここから下は
  // MV 文字モード時のみ」と分かるように区切り + 補足説明を入れる。
  const mvWrapper = document.createElement("div");
  mvWrapper.className = "text-motion-mv-group";
  const mvHint = document.createElement("p");
  mvHint.className = "text-motion-mv-hint";
  mvHint.textContent =
    "↓ ここから下は「MV 文字モード」時のみ反映されます (登場アニメ・退場アニメ・持続モーション・描画レイヤーは通常テロップでも有効です)。";
  mvWrapper.append(mvHint);

  // kind 切替ボタン + 現在の kind バッジ
  const toggleRow = document.createElement("div");
  toggleRow.className = "text-motion-kind-row";
  toggleRow.append(_buildKindToggleButton(telop, ctx));
  const kindBadge = document.createElement("span");
  kindBadge.className = "text-motion-kind-badge";
  kindBadge.dataset.kind = telop.kind || "caption";
  kindBadge.textContent = telop.kind === "mv_text" ? "MV 文字" : "通常テロップ";
  toggleRow.append(kindBadge);
  mvWrapper.append(toggleRow);

  // 視覚エフェクト preset (caption のときは disabled)
  mvWrapper.append(_buildEffectSection(telop, ctx));

  container.append(mvWrapper);

  parent.append(container);
}

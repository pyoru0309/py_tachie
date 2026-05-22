// =============================================================================
// dev/visualizer-lab.js
//
// Visualizer Lab (/dev/visualizers/) のフロントエンド。
//
// - /api/visualizer/plugins から plugin 一覧を取得
// - /api/dev/visualizer/fixtures から音源 fixture 一覧を取得
// - PARAMS から自動生成した form をユーザーが操作 → debounce して
//   /api/dev/visualizer/preview を叩き、本番 layerData.visualizer 互換 payload を取得
// - 受け取った gl.module を loadVisualizerModule → createVisualizerLayer して
//   1920x1080 の THREE.Scene に乗せる (本体 scenario state には依存しない)
// - 24fps (or plugin GL_FRAME_RATE) で再生 / time slider でスクラブ
//
// 既存の本体実装と共有しているのは:
//   /static/js/renderer/core.js          (initRenderer / renderScene)
//   /static/js/visualizers/index.js      (loadVisualizerModule / fetchVisualizerStreams)
//   /static/js/font.js                   (fontResolver の resolver 用)
// =============================================================================
import * as THREE from "three";

import {
  initRenderer,
  renderScene,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
} from "/static/js/renderer/core.js";
import {
  loadVisualizerModule,
  fetchVisualizerStreams,
} from "/static/js/visualizers/index.js";
import {
  backgroundInfoFromColor,
  defaultBackgroundInfo,
} from "/static/js/visualizers/_kit.js";

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  previewFrame: $("previewFrame"),
  previewCanvas: $("previewCanvas"),
  playButton: $("playButton"),
  timelineRange: $("timelineRange"),
  frameReadout: $("frameReadout"),
  metaPlugin: $("metaPlugin"),
  metaFps: $("metaFps"),
  metaFrames: $("metaFrames"),
  metaStreams: $("metaStreams"),
  metaFixture: $("metaFixture"),
  logBox: $("logBox"),
  pluginSelect: $("pluginSelect"),
  durationInput: $("durationInput"),
  audioFixtureSelect: $("audioFixtureSelect"),
  previewAudio: $("previewAudio"),
  bgColorInput: $("bgColorInput"),
  bgColorText: $("bgColorText"),
  bgTransparent: $("bgTransparent"),
  bgPresetButtons: document.querySelectorAll(".bg-presets button"),
  paramsList: $("paramsList"),
};

// -----------------------------------------------------------------------------
// 状態
// -----------------------------------------------------------------------------

const state = {
  plugins: [],            // { key, name, params, gl? }
  fixtures: [],           // { key, label }
  fonts: [],              // { id, name, weights } -- /api/manifest 由来
  fontWeights: [],        // { id, name }
  defaultFontId: "",
  defaultFontWeightId: "",
  currentPlugin: null,
  paramsValues: {},       // 現在の params (PARAMS のキー → value)
  payload: null,          // /api/dev/visualizer/preview の戻り値
  glLayer: null,          // createVisualizerLayer が返した { object3D, update, dispose }
  scene: null,
  bgMesh: null,
  isPlaying: false,
  playStartedAtMs: 0,
  playStartFrameIdx: 0,
  rafId: 0,
};

// -----------------------------------------------------------------------------
// ログ
// -----------------------------------------------------------------------------

function log(msg, level = "info") {
  const div = document.createElement("div");
  div.className = level === "error" ? "err" : level === "warn" ? "warn" : "";
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.logBox.appendChild(div);
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `pill ${kind}`;
}

// -----------------------------------------------------------------------------
// renderer 初期化 (1920x1080 → CSS で縮小)
// -----------------------------------------------------------------------------

function ensureRenderer() {
  initRenderer(els.previewCanvas);
  // 表示サイズは CSS が決めるので、内部 buffer は 1920x1080 のまま。
  els.previewCanvas.style.width = "100%";
  els.previewCanvas.style.height = "100%";
}

function buildScene() {
  // 背景と scene は毎回作り直して良いが、glLayer は runPreview が
  // ライフサイクルを持つので **ここでは触らない**。
  // (以前は disposeCurrentScene() で glLayer も null 化していて、
  //  「runPreview が glLayer をセット → buildScene() で再 null 化」のため
  //  startPlayback の `!state.glLayer` ガードに引っかかって再生ボタンが
  //  反応しなかった。Playwright で確認: hasGlLayer=false / hasPayload=true)
  disposeSceneShellOnly();
  state.scene = new THREE.Scene();

  // 背景 plane (色 or 透過)。
  if (!els.bgTransparent.checked) {
    const mat = new THREE.MeshBasicMaterial({
      color: els.bgColorInput.value || "#000000",
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    const geom = new THREE.PlaneGeometry(CANVAS_WIDTH, CANVAS_HEIGHT);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 0);
    mesh.renderOrder = -1;
    state.bgMesh = mesh;
    state.scene.add(mesh);
  }
  // visualizer layer を scene に挿す (runPreview が事前にセット済み)。
  if (state.glLayer?.object3D) {
    state.glLayer.object3D.renderOrder = 100;
    state.scene.add(state.glLayer.object3D);
  }
}

// scene + bgMesh だけ破棄。glLayer は触らない (= runPreview が管理)。
function disposeSceneShellOnly() {
  if (state.bgMesh) {
    try { state.bgMesh.geometry?.dispose(); } catch (_) {}
    try { state.bgMesh.material?.dispose(); } catch (_) {}
    state.bgMesh = null;
  }
  state.scene = null;
}

function renderFrame(frameIdx) {
  if (!state.scene) return;
  if (state.glLayer?.update) {
    const dur = Number(state.payload?.frameDurationSec) || (1 / 24);
    const elapsed = frameIdx * dur;
    try {
      state.glLayer.update({
        elapsedSec: elapsed,
        sceneSec: elapsed,
        frameIdx,
      });
    } catch (err) {
      log(`plugin.update threw: ${err?.message ?? err}`, "error");
    }
  }
  renderScene(state.scene);
  els.frameReadout.textContent = `${frameIdx} / ${(state.payload?.frameCount ?? 0) - 1}`;
}

// -----------------------------------------------------------------------------
// fixture / plugin の読み込み
// -----------------------------------------------------------------------------

async function loadPluginList() {
  const res = await fetch("/api/visualizer/plugins");
  if (!res.ok) throw new Error(`plugin list fetch failed: ${res.status}`);
  const data = await res.json();
  state.plugins = data.plugins || [];
  els.pluginSelect.innerHTML = "";
  for (const p of state.plugins) {
    const opt = document.createElement("option");
    opt.value = p.key;
    opt.textContent = p.gl ? p.name : `${p.name} (Python only)`;
    if (!p.gl) opt.disabled = true;
    els.pluginSelect.appendChild(opt);
  }
}

async function loadFixtures() {
  const res = await fetch("/api/dev/visualizer/fixtures");
  if (!res.ok) throw new Error(`fixtures fetch failed: ${res.status}`);
  const data = await res.json();
  state.fixtures = data.fixtures || [];
  els.audioFixtureSelect.innerHTML = "";
  // 合成 fixture と asset 系の間にセパレータを 1 行入れて見分けやすく。
  let lastWasSynthetic = false;
  for (const f of state.fixtures) {
    const isAsset = String(f.key || "").startsWith("asset:");
    if (isAsset && lastWasSynthetic) {
      const sep = document.createElement("option");
      sep.disabled = true;
      sep.textContent = "── 共通アセットの音源 ──";
      els.audioFixtureSelect.appendChild(sep);
      lastWasSynthetic = false;
    }
    if (!isAsset) lastWasSynthetic = true;
    const opt = document.createElement("option");
    opt.value = f.key;
    opt.textContent = f.label;
    if (Number.isFinite(Number(f.durationSec)) && Number(f.durationSec) > 0) {
      opt.dataset.durationSec = String(Number(f.durationSec));
    }
    els.audioFixtureSelect.appendChild(opt);
  }
  els.audioFixtureSelect.value = "beat";
}

function fixtureByKey(key) {
  return state.fixtures.find((f) => f.key === key) || null;
}

// dev page の背景は単色 or 透過チェック柄。チェック柄は「不明」扱いで
// 中間グレー (luminance=0.5) フォールバック。本体側は scene-builder が画像/動画を
// サンプルしてくれるので、dev page だけのこの最小経路で十分。
function computeDevBackgroundInfo() {
  if (els.bgTransparent.checked) {
    return defaultBackgroundInfo();
  }
  const hex = els.bgColorInput.value || "#000000";
  return backgroundInfoFromColor(hex, { source: "solid" });
}

// fixture が `asset:<rel>` のときだけ <audio> に共通アセットの URL をセット。
// それ以外 (silence/sine/beat/sweep/noise) は src を外して鳴らさない。
function updatePreviewAudioSrc() {
  const audio = els.previewAudio;
  if (!audio) return;
  const key = els.audioFixtureSelect.value || "";
  // url はサーバの fixtures レスポンスから貰う (= /assets/assets/audio/... の正規)。
  const fx = fixtureByKey(key);
  const want = key.startsWith("asset:") ? String(fx?.url || "") : "";
  // 既に同じ src なら何もしない (CurrentTime 巻き戻しを避ける)
  const current = audio.getAttribute("src") || "";
  if (current === want) return;
  audio.pause();
  audio.removeAttribute("src");
  if (want) {
    audio.src = want;
    audio.loop = true;
    audio.currentTime = 0;
    // load() は src 変更後に明示的に呼ぶ (一部ブラウザで preload が走らないため)
    try { audio.load(); } catch (_) {}
  }
}

// 共通アセットの書体・ウェイト一覧を取得して、font / font_weight 型 PARAMS の
// セレクタに反映する。本体 (dialog.js) と同じく `/api/manifest` の
// `config.fonts` / `config.fontWeights` を引用 (= active project があれば
// そのプロジェクトの auto-scan 結果、無ければ system default)。
async function loadFontsFromManifest() {
  try {
    const res = await fetch("/api/manifest");
    if (!res.ok) return;
    const data = await res.json();
    const cfg = data?.config || {};
    state.fonts = Array.isArray(cfg.fonts) ? cfg.fonts : [];
    state.fontWeights = Array.isArray(cfg.fontWeights) ? cfg.fontWeights : [];
    state.defaultFontId = String(cfg.defaultFont || "");
    state.defaultFontWeightId = String(cfg.defaultFontWeight || "");
  } catch (err) {
    log(`書体一覧の取得に失敗: ${err?.message ?? err}`, "warn");
  }
}

// -----------------------------------------------------------------------------
// PARAMS から form を組み立て
// -----------------------------------------------------------------------------

function pluginByKey(key) {
  return state.plugins.find((p) => p.key === key) || null;
}

function fontNameById(id) {
  if (!id) return "";
  const f = state.fonts.find((it) => String(it.id) === String(id));
  return f?.name || id;
}

// 書体 ID に紐づく weight 一覧 ({ id, name }[])。本体 font.js の
// weightItemsForFamily と同等。family 未指定 (= プロジェクト既定) のときは
// 全 weight を返す。
function weightItemsForFamily(familyId) {
  const all = state.fontWeights.length > 0
    ? state.fontWeights
    : [
        { id: "regular", name: "Regular" },
        { id: "medium", name: "Medium" },
        { id: "bold", name: "Bold" },
        { id: "black", name: "Black" },
      ];
  if (!familyId) return all;
  const f = state.fonts.find((it) => String(it.id) === String(familyId));
  if (!f?.weights) return all;
  const ids = Object.keys(f.weights);
  if (ids.length === 0) return all;
  // global の name (Bold / Medium 等) を保持。global に無い id でも素通し。
  return ids.map((id) => all.find((w) => w.id === id) || { id, name: id });
}

// font_weight セレクタの中身を「family が持つ weight」だけに絞って再描画する。
// 先頭は (プロジェクト既定) の空オプション。preferredValue が新リストにあれば
// それを採用、無ければ regular → 先頭、空文字の順でフォールバック。
function fillFontWeightSelector(selectEl, familyId, preferredValue) {
  const items = weightItemsForFamily(familyId);
  selectEl.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = state.defaultFontWeightId
    ? `(プロジェクト既定: ${state.defaultFontWeightId})`
    : "(プロジェクト既定)";
  selectEl.appendChild(empty);
  for (const w of items) {
    const o = document.createElement("option");
    o.value = String(w.id || "");
    o.textContent = String(w.name || w.id || "");
    selectEl.appendChild(o);
  }
  let next = String(preferredValue ?? "");
  const exists = items.some((w) => String(w.id) === next);
  if (!exists) {
    if (items.some((w) => w.id === "regular")) next = "regular";
    else if (items[0]) next = String(items[0].id);
    else next = "";
  }
  selectEl.value = next;
}

// 本体 font.js の FONT_WEIGHT_CSS と同じテーブル。dev page は本体 state に依存
// しないため局所コピー。新 ID (extra_light) と旧 ID (extralight) の両方に対応。
const FONT_WEIGHT_CSS = {
  thin: 100,
  extralight: 200, extra_light: 200,
  light: 300,
  demilight: 350, demi_light: 350,
  regular: 400,
  medium: 500,
  semibold: 600, semi_bold: 600,
  bold: 700,
  extrabold: 800, extra_bold: 800,
  black: 900,
};

// 本体 font.js の fontFamilyCssStack と同じ規約 (Noto Sans JP / Hiragino Sans /
// Yu Gothic / sans-serif の固定 fallback、LINE Seed JP は family 未指定時のみ使う)。
function fontFamilyCssStack(familyId) {
  const f = state.fonts.find((it) => String(it.id) === String(familyId));
  const displayName = f?.name || familyId || "";
  const fallback = [`"Noto Sans JP"`, `"Hiragino Sans"`, `"Yu Gothic"`, "sans-serif"];
  if (displayName && displayName !== "LINE Seed JP") {
    return [`"${displayName}"`, ...fallback].join(", ");
  }
  return [`"LINE Seed JP"`, ...fallback].join(", ");
}

// 書体が持たない weight が要求された場合に regular にフォールバックする
// (本体 font.js の resolveFontWeightCss と同じロジック / Pillow paths_for_weight
// と整合。canvas2d の synthetic bold (= 太らせ描画) を防ぐ)。
function resolveFontWeightCss(familyId, weightId) {
  const f = state.fonts.find((it) => String(it.id) === String(familyId));
  const available = f?.weights ? Object.keys(f.weights) : [];
  let actual = weightId;
  if (!available.includes(weightId)) {
    if (available.includes("regular")) actual = "regular";
    else if (available.includes("medium")) actual = "medium";
    else if (available.includes("bold")) actual = "bold";
    else actual = available[0] || "regular";
  }
  return String(FONT_WEIGHT_CSS[actual] ?? 400);
}

function buildFontResolver() {
  return (familyId, weightId) => {
    const id = familyId || state.defaultFontId;
    const wid = weightId || state.defaultFontWeightId;
    return { family: fontFamilyCssStack(id), weight: resolveFontWeightCss(id, wid) };
  };
}

// assets/ 配下の ttf を FontFace で動的登録する。本体 font.js の
// registerProjectFonts と同等。Python 側の existing_font_path と同じく
// 「最初に load() 成功した候補を採用」セマンティクス。
const _registeredFontFaces = new Set();

async function registerDevPageFonts() {
  if (!window.FontFace) return;
  const tasks = [];
  for (const font of state.fonts) {
    if (!font?.name || !font?.weights) continue;
    for (const [weightId, paths] of Object.entries(font.weights)) {
      const candidates = Array.isArray(paths) ? paths : [paths];
      tasks.push(_registerFontFamilyWeight(font.name, weightId, candidates));
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

async function _registerFontFamilyWeight(name, weightId, candidates) {
  const cssWeight = String(FONT_WEIGHT_CSS[weightId] ?? 400);
  for (const localPath of candidates) {
    if (typeof localPath !== "string") continue;
    // assets/ と projects/ プレフィックスのみ受け付ける (system path は無視)。
    if (!localPath.startsWith("assets/") && !localPath.startsWith("projects/")) continue;
    const url = `/assets/${localPath}`;
    const key = `${name}::${cssWeight}::${url}`;
    if (_registeredFontFaces.has(key)) return;
    try {
      const face = new FontFace(name, `url(${url})`, { weight: cssWeight, style: "normal" });
      await face.load();
      document.fonts.add(face);
      _registeredFontFaces.add(key);
      return;
    } catch (_err) {
      // 候補が実在しない / 読めないときはサイレントで次へ。
    }
  }
}

function rebuildParamsForm(plugin) {
  els.paramsList.innerHTML = "";
  state.paramsValues = {};
  if (!plugin) return;
  for (const spec of plugin.params || []) {
    const row = document.createElement("div");
    row.className = "param";

    const labelEl = document.createElement("label");
    labelEl.textContent = spec.label || spec.key;
    row.appendChild(labelEl);

    const initial = spec.default;
    state.paramsValues[spec.key] = initial;

    // valueEl: number は <input type="number"> 連動、それ以外は表示用 <span>。
    let valueEl;
    if (spec.type === "number") {
      valueEl = document.createElement("input");
      valueEl.type = "number";
      valueEl.className = "value value-number";
      if (spec.min != null) valueEl.min = String(spec.min);
      if (spec.max != null) valueEl.max = String(spec.max);
      if (spec.step != null) valueEl.step = String(spec.step);
      valueEl.value = String(initial ?? 0);
    } else {
      valueEl = document.createElement("span");
      valueEl.className = "value";
      if (spec.type === "color") valueEl.classList.add("value-color");
      valueEl.textContent = formatValue(initial, spec.type);
    }

    let input;
    if (spec.type === "color") {
      input = document.createElement("input");
      input.type = "color";
      input.value = initial || "#ffffff";
      input.className = "param-color-input";
    } else if (spec.type === "select") {
      input = document.createElement("select");
      const options = spec.options || [];
      const list = options.length > 0 ? options : [{ value: initial ?? "", label: String(initial ?? "(既定)") }];
      for (const opt of list) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label || opt.value;
        input.appendChild(o);
      }
      input.value = initial ?? list[0]?.value ?? "";
    } else if (spec.type === "font") {
      // 共通アセットの書体一覧 (manifest.config.fonts) を反映。先頭は
      // "(プロジェクト既定)"。
      input = document.createElement("select");
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = state.defaultFontId
        ? `(プロジェクト既定: ${fontNameById(state.defaultFontId)})`
        : "(プロジェクト既定)";
      input.appendChild(empty);
      for (const f of state.fonts) {
        const o = document.createElement("option");
        o.value = String(f.id || "");
        o.textContent = String(f.name || f.id || "");
        input.appendChild(o);
      }
      input.value = String(initial ?? "");
    } else if (spec.type === "font_weight") {
      input = document.createElement("select");
      // 中身は family が決まってから fillFontWeightSelector() で填め直す。
      // 初期は全 weight を入れておく (family 未指定時のフォールバック)。
      fillFontWeightSelector(input, "", initial);
    } else {
      // number: スライダー
      input = document.createElement("input");
      input.type = "range";
      input.min = String(spec.min ?? 0);
      input.max = String(spec.max ?? 100);
      input.step = String(spec.step ?? 0.01);
      input.value = String(initial ?? 0);
    }
    // スライダー / セレクト / カラー: 値の確定先は state.paramsValues、表示は valueEl。
    // input/select/color の dataset で type を持たせて、後段の連動 (font 変更で
     // weight セレクタを絞り込む) から target を見つけられるようにする。
    input.dataset.paramKey = spec.key;
    input.dataset.paramType = spec.type;

    input.addEventListener("input", () => {
      let v = input.value;
      if (spec.type !== "color" && spec.type !== "select" && spec.type !== "font" && spec.type !== "font_weight") {
        v = Number(v);
      }
      state.paramsValues[spec.key] = v;
      if (spec.type === "number") {
        valueEl.value = String(v);
      } else {
        valueEl.textContent = formatValue(v, spec.type);
      }
      // family を変えた瞬間、同じパネル内の font_weight セレクタを書体が持つ
      // weight だけに絞り込む (本体 weightItemsForFamily と同等の挙動)。
      // 値が新リストに無ければ regular → 先頭、空文字の順でフォールバック。
      // 同じ row 内の値表示 (valueEl) も忘れず更新する。
      if (spec.type === "font") {
        for (const wsel of els.paramsList.querySelectorAll('select[data-param-type="font_weight"]')) {
          fillFontWeightSelector(wsel, v, wsel.value);
          state.paramsValues[wsel.dataset.paramKey] = wsel.value;
          const row = wsel.closest(".param");
          const ve = row?.querySelector(".value");
          if (ve) ve.textContent = formatValue(wsel.value, "font_weight");
        }
      }
      schedulePreview();
    });
    // 数値入力欄 → スライダー逆方向同期。range の min/max を超えても state には保存
    // (範囲外の値も試したいケースがあるため)。スライダー位置だけ silent clamp。
    if (spec.type === "number") {
      valueEl.addEventListener("input", () => {
        const v = Number(valueEl.value);
        if (!Number.isFinite(v)) return;
        state.paramsValues[spec.key] = v;
        input.value = String(v); // range が自動 clamp する
        schedulePreview();
      });
    }

    row.appendChild(input);
    row.appendChild(valueEl);
    els.paramsList.appendChild(row);
  }

  // 全 param 描画後、font_weight セレクタを「同じ panel 内の font 値」で絞る。
  // PARAMS で font が無いプラグインなら "" (= 全 weight) のままで挙動継続。
  const fontSel = els.paramsList.querySelector('select[data-param-type="font"]');
  const familyId = fontSel ? fontSel.value : "";
  for (const wsel of els.paramsList.querySelectorAll('select[data-param-type="font_weight"]')) {
    const initial = wsel.value || state.paramsValues[wsel.dataset.paramKey] || "";
    fillFontWeightSelector(wsel, familyId, initial);
    state.paramsValues[wsel.dataset.paramKey] = wsel.value;
    const row = wsel.closest(".param");
    const ve = row?.querySelector(".value");
    if (ve) ve.textContent = formatValue(wsel.value, "font_weight");
  }
}

function formatValue(v, type) {
  if (type === "color") {
    // #RRGGBB を大文字で表示。短縮 (#rgb) は #RRGGBB へ展開。
    let s = String(v ?? "").trim();
    if (!s.startsWith("#")) s = "#" + s;
    if (s.length === 4) s = "#" + s.slice(1).split("").map((c) => c + c).join("");
    return s.toUpperCase();
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  if (typeof v === "string" && v.length > 14) return v.slice(0, 12) + "…";
  return String(v ?? "");
}

// -----------------------------------------------------------------------------
// /api/dev/visualizer/preview を叩いて GL plugin をロード
// -----------------------------------------------------------------------------

let _previewSeq = 0;
let _previewTimer = 0;
function schedulePreview() {
  // input を連打している間は最後の 1 回だけ送る (debounce 80ms)。
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(() => { runPreview().catch((e) => log(String(e), "error")); }, 80);
}

async function runPreview() {
  const plugin = state.currentPlugin;
  if (!plugin) return;
  const seq = ++_previewSeq;
  setStatus("loading", "warn");

  const body = {
    pluginKey: plugin.key,
    params: state.paramsValues,
    durationSec: Number(els.durationInput.value) || 8,
    fps: 24,
    audioFixture: els.audioFixtureSelect.value,
    backgroundColor: els.bgColorInput.value,
  };

  let payload;
  try {
    const res = await fetch("/api/dev/visualizer/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`preview API ${res.status}: ${txt}`);
    }
    payload = await res.json();
  } catch (err) {
    setStatus("error", "err");
    log(String(err?.message ?? err), "error");
    return;
  }
  if (seq !== _previewSeq) return; // 後発で上書きされた

  state.payload = payload;
  els.metaPlugin.textContent = payload.pluginKey;
  els.metaFps.textContent = String(payload.fps ?? 24);
  els.metaFrames.textContent = String(payload.frameCount);
  els.metaFixture.textContent = payload.fixture ?? "-";
  els.metaStreams.textContent = payload.gl?.streams
    ? Object.keys(payload.gl.streams).join(", ") || "(none)"
    : "(no GL)";

  if (!payload.gl?.module) {
    setStatus("no GL", "err");
    log(`plugin ${payload.pluginKey} に GL_MODULE がありません`, "warn");
    return;
  }

  // 既存の GL layer を捨てて再構築。
  try {
    if (state.glLayer) {
      try { state.glLayer.dispose?.(); } catch (_) {}
      state.glLayer = null;
    }
    const mod = await loadVisualizerModule(payload.gl.module);
    const { audioData, streamShapes, streamMeta } = await fetchVisualizerStreams(payload.gl.streams || {});
    // FontFace 登録済みのものが描画前に確実に解決済みになるよう、本体
    // scene-builder と同じく document.fonts.ready を待つ。countdown の
    // 初フレが system fallback になる事故 (Pillow と全く違う絵) の回避。
    if (document.fonts?.ready) {
      try { await document.fonts.ready; } catch (_) {}
    }
    const layer = await mod.createVisualizerLayer({
      THREE,
      renderer: null, // dev page では効果用 RT を使う plugin はない想定
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      params: payload.gl.params || {},
      audioData,
      streamShapes,
      streamMeta,
      frameDurationSec: payload.frameDurationSec,
      frameCount: payload.frameCount,
      cutStartSec: 0,
      sceneTotalSec: payload.sceneTotalSec,
      fontResolver: buildFontResolver(),
      // 背景の見た目を渡す。dev page は単色 or 透過チェック柄。
      background: computeDevBackgroundInfo(),
    });
    if (!layer?.object3D) throw new Error("createVisualizerLayer returned no object3D");
    state.glLayer = layer;
    buildScene();
    seekToFrame(0);
    setStatus("ready", "ok");
  } catch (err) {
    setStatus("error", "err");
    log(`load failed: ${err?.message ?? err}`, "error");
  }
}

// -----------------------------------------------------------------------------
// 再生 / シーク
// -----------------------------------------------------------------------------

function hasAudio() {
  const audio = els.previewAudio;
  return !!(audio && audio.src && audio.readyState > 0);
}

function frameToSec(frame) {
  const dur = Number(state.payload?.frameDurationSec) || (1 / 24);
  return frame * dur;
}

function seekToFrame(idx, { syncAudio = false } = {}) {
  if (!state.payload) return;
  const max = Math.max(0, (state.payload.frameCount ?? 1) - 1);
  const clamped = Math.max(0, Math.min(max, Math.floor(idx)));
  els.timelineRange.value = String(clamped / Math.max(1, max));
  renderFrame(clamped);
  // ★ 通常再生中 (= startPlayback の rAF tick 経由) は audio.currentTime を触らない。
  // ブラウザは毎フレームの代入で再シークしてクリックノイズが出るため。
  // ループ巻き戻しは <audio loop=true> が自動でやる。
  // ユーザの明示的 seek (slider drag) のときだけ syncAudio:true で揃える。
  if (syncAudio && hasAudio()) {
    const dur = els.previewAudio.duration;
    const t = frameToSec(clamped);
    try {
      els.previewAudio.currentTime = Number.isFinite(dur) && dur > 0 ? t % dur : t;
    } catch (_) {}
  }
}

function startPlayback() {
  if (!state.payload || !state.glLayer) return;
  state.isPlaying = true;
  els.playButton.textContent = "停止";
  state.playStartedAtMs = performance.now();
  state.playStartFrameIdx = currentFrameIdxFromSlider();
  cancelAnimationFrame(state.rafId);
  // 共通アセット音源 fixture を選んでいるときだけ実際に再生 (loop=true で
  // タイムライン側の `frame > max → 0` リセットと自然に同期)。playPromise の
  // reject は無視 (autoplay policy で blocked される可能性がある = ユーザ
  // クリックを契機にしているのでほぼ通るはずだが、念のため)。
  if (hasAudio()) {
    try {
      els.previewAudio.currentTime = frameToSec(state.playStartFrameIdx);
      const pp = els.previewAudio.play();
      if (pp && typeof pp.catch === "function") pp.catch(() => {});
    } catch (_) {}
  }
  const tick = () => {
    if (!state.isPlaying) return;
    const elapsedMs = performance.now() - state.playStartedAtMs;
    const dur = Number(state.payload.frameDurationSec) || (1 / 24);
    const max = Math.max(0, (state.payload.frameCount ?? 1) - 1);
    let frame = state.playStartFrameIdx + Math.floor((elapsedMs / 1000) / dur);
    if (frame > max) {
      frame = 0;
      state.playStartedAtMs = performance.now();
      state.playStartFrameIdx = 0;
    }
    seekToFrame(frame);
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

function stopPlayback() {
  state.isPlaying = false;
  els.playButton.textContent = "再生";
  cancelAnimationFrame(state.rafId);
  if (els.previewAudio) {
    try { els.previewAudio.pause(); } catch (_) {}
  }
}

function currentFrameIdxFromSlider() {
  const max = Math.max(0, (state.payload?.frameCount ?? 1) - 1);
  return Math.round(Number(els.timelineRange.value) * max);
}

// -----------------------------------------------------------------------------
// イベント
// -----------------------------------------------------------------------------

function applyBgColor(value) {
  els.bgColorInput.value = value;
  els.bgColorText.value = value;
  els.bgTransparent.checked = false;
  els.previewFrame.classList.remove("checker");
  buildScene();
  if (state.payload) renderFrame(currentFrameIdxFromSlider());
}

function bindEvents() {
  els.pluginSelect.addEventListener("change", () => {
    const key = els.pluginSelect.value;
    state.currentPlugin = pluginByKey(key);
    rebuildParamsForm(state.currentPlugin);
    updateUrlParams();
    schedulePreview();
  });
  els.durationInput.addEventListener("change", () => {
    updateUrlParams();
    schedulePreview();
  });
  els.audioFixtureSelect.addEventListener("change", () => {
    // asset 系 fixture を選んだ瞬間、タイムラインを音源の実時間に揃える。
    // ループ再生は <audio loop> + startPlayback() の `frame > max → frame = 0`。
    const f = fixtureByKey(els.audioFixtureSelect.value);
    const dur = f && Number.isFinite(Number(f.durationSec)) && Number(f.durationSec) > 0
      ? Number(f.durationSec)
      : null;
    if (dur != null) {
      els.durationInput.value = String(Math.round(dur * 100) / 100);
    }
    updatePreviewAudioSrc();
    updateUrlParams();
    schedulePreview();
  });

  els.bgColorInput.addEventListener("input", (e) => {
    els.bgColorText.value = e.target.value;
    applyBgColor(e.target.value);
  });
  els.bgColorText.addEventListener("change", (e) => {
    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
      applyBgColor(e.target.value);
    }
  });
  els.bgTransparent.addEventListener("change", () => {
    els.previewFrame.classList.toggle("checker", els.bgTransparent.checked);
    buildScene();
    if (state.payload) renderFrame(currentFrameIdxFromSlider());
  });
  els.bgPresetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.bg;
      if (v === "checker") {
        els.bgTransparent.checked = true;
        els.previewFrame.classList.add("checker");
        buildScene();
        if (state.payload) renderFrame(currentFrameIdxFromSlider());
      } else if (v) {
        applyBgColor(v);
      }
    });
  });

  els.timelineRange.addEventListener("input", () => {
    if (state.isPlaying) stopPlayback();
    // 手動 seek は audio も揃える (= ノイズが出るが、それは 1 回だけなので許容)
    seekToFrame(currentFrameIdxFromSlider(), { syncAudio: true });
  });

  els.playButton.addEventListener("click", () => {
    if (state.isPlaying) stopPlayback();
    else startPlayback();
  });

  // Space キーで再生/停止 (フォーカスが input でないとき)。
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (["input", "select", "textarea"].includes(tag)) return;
    e.preventDefault();
    if (state.isPlaying) stopPlayback();
    else startPlayback();
  });
}

// -----------------------------------------------------------------------------
// boot
// -----------------------------------------------------------------------------

// URL クエリ → 初期選択。?plugin=floating_particles&fixture=sweep&duration=12 等。
// 開発者がブックマーク / 共有しやすいよう、プラグイン切替時にも URL を書き換える。
function readUrlParams() {
  const u = new URLSearchParams(window.location.search);
  const out = {
    plugin: (u.get("plugin") || u.get("key") || "").trim(),
    fixture: (u.get("fixture") || "").trim(),
    duration: u.get("duration"),
  };
  const d = Number(out.duration);
  out.duration = Number.isFinite(d) && d > 0 ? d : null;
  return out;
}

function updateUrlParams() {
  const params = new URLSearchParams();
  if (state.currentPlugin?.key) params.set("plugin", state.currentPlugin.key);
  // fixture は既定値 (beat) のときだけ省略して URL を短く保つ。
  const fixture = els.audioFixtureSelect.value || "";
  if (fixture && fixture !== "beat") params.set("fixture", fixture);
  const dur = Number(els.durationInput.value);
  if (Number.isFinite(dur) && dur > 0 && dur !== 8) {
    params.set("duration", String(dur));
  }
  const qs = params.toString();
  const next = qs
    ? `${window.location.pathname}?${qs}`
    : window.location.pathname;
  // pushState ではなく replaceState: ブックマーク可能にしつつ戻るボタンを汚さない。
  history.replaceState(null, "", next);
}

async function boot() {
  ensureRenderer();
  bindEvents();
  try {
    await Promise.all([loadPluginList(), loadFixtures(), loadFontsFromManifest()]);
  } catch (err) {
    setStatus("error", "err");
    log(String(err?.message ?? err), "error");
    return;
  }
  // assets/ 配下の ttf を FontFace 登録 (= 「ねこスプーン」等のローカルフォントが
  // canvas 描画でも反映されるようにする)。失敗しても処理続行。
  await registerDevPageFonts();
  if (state.plugins.length === 0) {
    setStatus("no plugins", "err");
    log("プラグインが 1 つも検出されませんでした", "error");
    return;
  }

  // URL 初期値を反映。?plugin=foo を最優先、無効値ならフォールバック (GL 対応の先頭)。
  const url = readUrlParams();
  let initial = null;
  if (url.plugin) {
    initial = state.plugins.find((p) => p.key === url.plugin) || null;
    if (!initial) {
      log(`?plugin=${url.plugin} に該当プラグイン無し。先頭にフォールバック`, "warn");
    } else if (!initial.gl) {
      log(`?plugin=${url.plugin} は GL 非対応 (Python only) なので preview は走りません`, "warn");
    }
  }
  if (!initial) {
    initial = state.plugins.find((p) => !!p.gl) || state.plugins[0];
  }
  if (url.fixture) {
    const exists = Array.from(els.audioFixtureSelect.options).some((o) => o.value === url.fixture);
    if (exists) {
      els.audioFixtureSelect.value = url.fixture;
      // URL に明示的な duration が無く、asset 系 fixture を選んだ場合は音源時間を初期 duration に。
      if (url.duration == null) {
        const f = fixtureByKey(url.fixture);
        if (f && Number.isFinite(Number(f.durationSec)) && Number(f.durationSec) > 0) {
          els.durationInput.value = String(Math.round(Number(f.durationSec) * 100) / 100);
        }
      }
    }
  }
  if (url.duration != null) {
    els.durationInput.value = String(url.duration);
  }

  els.pluginSelect.value = initial.key;
  state.currentPlugin = initial;
  rebuildParamsForm(initial);
  updatePreviewAudioSrc();
  updateUrlParams();
  await runPreview();
}

// 開発デバッグ用: モジュール内 state を window に露出 (本ページが SPLITE_DEV_TOOLS
// 限定なので影響範囲は dev のみ)。Playwright や DevTools console から `__vizLabState`
// で覗ける。
window.__vizLabState = state;
window.__vizLabApi = { runPreview, startPlayback, stopPlayback, seekToFrame };

boot().catch((err) => log(String(err), "error"));

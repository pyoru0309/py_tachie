// =============================================================================
// renderer/scene-builder.js
//
// /api/v2/scene-bundle のレスポンス (layerData) から THREE.Scene を組み立てる。
// レイヤー構成:
//   bg_color → visualizer(below_bg) → bg_image → visualizer(above_bg) →
//   video_layer(above_bg) → characters (under / eye / mouth / over) →
//   visualizer(above_chars) → fg → video_layer(above_fg) → visualizer(above_fg) →
//   dialogue → telop
//
// テロップ・セリフ・ビジュアライザはすべて scene 内 plane に取り込まれて
// いるので、preview / 一時停止 / サムネ / export はすべて WebGL canvas 1 枚に
// 閉じる。
//
// 返値の SceneInstance は:
//   - scene: THREE.Scene (renderScene に渡す)
//   - update({ eyeKey, mouthKey, speakerId, ..., elapsedSec }): per-frame state を反映
//   - dispose(): texture release / geometry dispose
// =============================================================================
import * as THREE from "three";

import * as _kitBg from "/static/js/visualizers/_kit.js";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "./core.js";
import { loadTexture, releaseTexture } from "./texture-cache.js";
import {
  createSilhouettePass,
  bindSilhouetteLayers,
  renderSilhouetteRT,
} from "./effects/silhouette.js";
import { createBlurPass } from "./effects/gaussian-blur.js";
import { createCoverPass } from "./effects/cover.js";
import { createTintPlane, setTint } from "./effects/tint.js";
import { createCharacterMaterial } from "./effects/character-material.js";
import {
  createDialogueCanvasTexture,
  drawDialogueOnCanvas,
  drawDialogueBoxFillOnCanvas,
  drawDialogueBoxBorderOnCanvas,
  loadDialogueOverlayImage,
} from "./dialogue.js";
import { createDialogueBoxBlendMaterial } from "./effects/dialogue-box-blend.js";
import {
  createTelopCanvasTexture,
  refreshTelopCanvas,
  disposeTelopState,
  TELOP_CANVAS_WIDTH,
  TELOP_CANVAS_HEIGHT,
} from "./telop.js";
import { mapVideoLayerSec } from "./video-layer-time.js";
import { computeVideoFit } from "./effects/video-fit.js";

// silhouette / blur のための padding。Pillow の GaussianBlur 同等の広がりを
// 期待するなら 3σ 分の余裕が必要。本実装は blurPx を 2σ として扱うので、
// 3σ ≒ 1.5 × blurPx。安全側で `ceil(blurPx * 3) + 2` まで取って端の dark
// fringe を抑制する (Pillow と同等)。最低 80 で短小 blur の安定性も確保。
const EFFECT_PADDING_MIN = 80;
function computeEffectPadding(...blurPxList) {
  const maxBlur = blurPxList.reduce((a, b) => Math.max(a, Number(b) || 0), 0);
  return Math.max(EFFECT_PADDING_MIN, Math.ceil(maxBlur * 3) + 2);
}

// renderOrder は数値が小さい方が先に描画 (=奥)。深度テストは無効化して
// renderOrder だけで重ね順を決める (透明 plane の z-fighting 回避)。
//
// 背景レイヤーの 5 段重ね (新設計 2026-05-24):
//   -10 ORDER_BG_COLOR        単色塗りつぶし (常に最下層、画像と共存可)
//   -5  ORDER_VIZ_BELOW_BG    ビジュアライザー (背景画像の下)、新規モード
//    0  ORDER_BG_IMAGE        背景画像 / videoTrack
//   25  ORDER_VIZ_ABOVE_BG    ビジュアライザー (背景の上)
//   50  ORDER_VIDEO_LAYER_ABOVE_BG  動画レイヤー (= 背景の一種として扱える)
// 旧定数 ORDER_BG (=0) は ORDER_BG_IMAGE に統一。
const ORDER_BG_COLOR = -10;
const ORDER_VIZ_BELOW_BG = -5;
const ORDER_BG_IMAGE = 0;
const ORDER_BG = ORDER_BG_IMAGE; // 互換 alias (旧コードが参照する間だけ残す)
const ORDER_VIZ_ABOVE_BG = 25;     // 背景画像の上、動画レイヤーの下
const ORDER_VIDEO_LAYER_ABOVE_BG = 50; // 動画レイヤーは「背景の一種」として最上層に置く
const ORDER_CHAR_BASE = 100;       // キャラ間の差は (count-1-index) で +10 (前にあるキャラほど手前)
const ORDER_CHAR_UNDER_OFFSET = 0;
const ORDER_CHAR_EYE_OFFSET = 1;
const ORDER_CHAR_MOUTH_OFFSET = 2;
const ORDER_CHAR_OVER_OFFSET = 3;
const ORDER_VIZ_ABOVE_CHARS = 900; // キャラの直上、前景の下
const ORDER_CHAR_LAYOUT_BORDER = 920; // B-2: マルチキャラレイアウトの分割線 / 外周線。キャラの上、上字幕/visualizer(above_chars) の下
const ORDER_FG = 1000;
const ORDER_VIDEO_LAYER_ABOVE_FG = 1250; // 前景の直上、visualizer (above_fg) の下
const ORDER_VIZ_ABOVE_FG = 1500;   // 前景の直上、セリフの下
// セリフ枠 = (背景 fill) → (ボーダー) → (本文) の順で重ねる。
// 背景・ボーダーは独自 blend (screen / multiply) を使うため別 plane を取る。
const ORDER_DIALOGUE_BOX_FILL = 1900;
const ORDER_DIALOGUE_BOX_BORDER = 1950;
const ORDER_DIALOGUE = 2000;
const ORDER_TELOP = 3000;          // セリフの上 (テロップは画面の最前面)
// renderLayer ごとのテキスト plane (Phase 3): TextClip.renderLayer の値に応じて
// 異なる ORDER で plane を持つ。視覚的には:
//   above_bg     → 背景の直上、video_layer(above_bg) と viz(above_bg) の間
//   above_chars  → キャラの直上、viz(above_chars) と前景の間
//   above_fg     → 前景の直上、viz(above_fg) とセリフの間
//   overlay      → ORDER_TELOP と同じ (= 最前面)。互換のため別定数は持たない
const ORDER_TEXT_ABOVE_BG = 75;
const ORDER_TEXT_ABOVE_CHARS = 950;
const ORDER_TEXT_ABOVE_FG = 1550;
const ORDER_TEXT_OVERLAY = ORDER_TELOP;
const TEXT_LAYER_ORDER_BY_KEY = {
  above_bg: ORDER_TEXT_ABOVE_BG,
  above_chars: ORDER_TEXT_ABOVE_CHARS,
  above_fg: ORDER_TEXT_ABOVE_FG,
  overlay: ORDER_TEXT_OVERLAY,
};
const TEXT_LAYER_KEYS = ["above_bg", "above_chars", "above_fg", "overlay"];

function makeMaterial(texture) {
  return new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    // ★ Y-down カメラ (`OrthographicCamera(0, W, 0, H, ...)`) は projectionMatrix の
    //   Y スケールが負で、クリップ空間で winding が反転する。three.js の
    //   renderBufferDirect は `object.matrixWorld.determinant() < 0` しか見ない
    //   ので、カメラ側の反転は補正されず、PlaneGeometry が裏面扱いとなって
    //   FrontSide カリングで全フラグメントが落ちる。DoubleSide で両面描画する
    //   ことで「draw call は出ているのに readPixels が全 0」現象を回避する。
    side: THREE.DoubleSide,
    // 平面スプライト + transparent + DoubleSide では three.js が 2 パス
    // 描画 (back→front) する事があり、α が二重合成されてエフェクトの
    // 見た目が変わる。forceSinglePass で一度に描画させる。
    forceSinglePass: true,
  });
}

// 単色塗り plane (texture 無し)。背景画像が未指定のときの単色背景に使う。
function makeColorPlane(width, height, color, opacity, renderOrder, x, y) {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color || "#000000"),
    transparent: true,
    opacity: Math.max(0, Math.min(1, Number(opacity) || 0)),
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x + width / 2, y + height / 2, 0);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  mesh.visible = (Number(opacity) || 0) > 0;
  return mesh;
}

function makePlane(width, height, texture, renderOrder, x, y) {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = makeMaterial(texture);
  const mesh = new THREE.Mesh(geometry, material);
  // Y-down camera: 描画位置はプレーン中心 (x + w/2, y + h/2)。
  mesh.position.set(x + width / 2, y + height / 2, 0);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  mesh.visible = !!texture;
  return mesh;
}

// キャラ用の plane (Group の内側に置く想定で position は 0,0)。
// MeshBasicMaterial 版 (silhouette scene 用、色フィルタは silhouette には不要)。
function makeCharPlane(width, height, texture, renderOrder) {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = makeMaterial(texture);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, 0, 0);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  mesh.visible = !!texture;
  return mesh;
}

// ShaderMaterial 版 (メイン scene のキャラ表示用)。色フィルタ uniform を持つ。
function makeCharPlaneShader(width, height, texture, renderOrder, colorFilter) {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = createCharacterMaterial(texture, colorFilter);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, 0, 0);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  mesh.visible = !!texture;
  return mesh;
}

// B-2: crop ({x,y,width,height}) をキャラ ShaderMaterial の uClipRect uniform に
// 流し込む。three.js の clippingPlanes 機構は ShaderMaterial の動的 recompile が
// 不安定だったため、custom uniform 経由 (fragment shader で discard) に切替。
function _applyCropToCharacterMeshes(meshes, crop) {
  if (!crop) return;
  const x = Number(crop.x);
  const y = Number(crop.y);
  const w = Number(crop.width);
  const h = Number(crop.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0) || !(h > 0)) return;
  for (const mesh of meshes) {
    const uniform = mesh?.material?.uniforms?.uClipRect;
    if (uniform?.value?.set) {
      uniform.value.set(x, y, w, h);
    }
  }
}

async function buildBackground(scene, layerData, urls, renderer, videoProvider) {
  // 背景は最下層に「単色塗りつぶし」(ORDER_BG_COLOR=-10) を常に敷き、
  // その上に「画像 / videoTrack」(ORDER_BG_IMAGE=0) を必要に応じて重ねる。
  // 透過 PNG 等の背景画像でも下の色が透ける + ビジュアライザー (below_bg) を
  // 両者の間に挟める。
  //
  // 戻り値: { colorMesh?, mesh?, bgBlur?, bgCover?, videoProvider? }
  //   - colorMesh: 色 plane (opacity>0 のときのみ)
  //   - mesh:      画像 / video plane (画像 or videoTrack があるときのみ)
  const result = { mesh: null, colorMesh: null, bgBlur: null, bgCover: null };

  // 1) 単色塗りつぶし (常に最下層、画像と共存)
  const colorOpacity = Math.max(0, Math.min(1, Number(layerData.background?.colorOpacity) || 0));
  if (colorOpacity > 0) {
    const color = String(layerData.background?.color || "#000000");
    const colorMesh = makeColorPlane(
      CANVAS_WIDTH, CANVAS_HEIGHT, color, colorOpacity, ORDER_BG_COLOR, 0, 0,
    );
    scene.add(colorMesh);
    result.colorMesh = colorMesh;
  }

  // 2) videoTrack を WebGL bg plane として取り込む経路 (背景画像と排他)。
  //   2026-05-05: video frame の "取り出し方" を VideoProvider に抽象化。
  //     - preview: VideoTextureProvider (HTMLVideoElement + THREE.VideoTexture)
  //     - export:  WebCodecsVideoProvider (frame-accurate decode)
  //   どちらも getTexture() で THREE.Texture を返すので、ここでは provider に
  //   関与せず Texture を貼るだけ。dispose 時の texture 解放は provider 側。
  if (videoProvider && layerData?.hasVideoTrack) {
    const videoTex = videoProvider.getTexture();
    const mesh = makePlane(CANVAS_WIDTH, CANVAS_HEIGHT, videoTex, ORDER_BG_IMAGE, 0, 0);
    scene.add(mesh);
    result.mesh = mesh;
    result.videoProvider = videoProvider;
    return result;
  }

  // 3) 背景画像 (scene-bundle が assetUrl で元素材を直接 texture 化、cover を専用 RT に焼く)
  const url = layerData.background?.assetUrl || null;
  if (!url) {
    // 画像が無い場合は色 plane だけで終わり。色も無いなら null を返さず result を返す
    // (= 透過のまま) ── visualizer (below_bg) が単独で描かれるケースもあるため。
    return result.colorMesh ? result : null;
  }
  urls.push(url);
  const texture = await loadTexture(url);
  if (!texture) return result.colorMesh ? result : null;
  const blurPx = Math.max(0, Number(layerData.background?.blurPx) || 0);
  let displayTexture = texture;
  // Pillow ImageFilter.GaussianBlur(radius=R) は σ ≒ R で広がるが、
  // gaussian-blur.js の apply は σ = blurPx / 2 にしている (glow / dropShadow
  // の見た目を CSS filter:blur と揃えるための既定値)。bg だけ Pillow と
  // 揃えたいので、bg pass.apply に渡すときは blurPx を 2 倍する。
  // (glow / shadow の係数には触らない。)
  const bgBlurArg = blurPx * 2;
  // direct-bg は **常に** cover RT を経由する。理由:
  //   1. texture-cache.loadTexture(url) は同じ URL に対し同一 Texture インスタンス
  //      を返すので、`texture.repeat / offset` を直接書き換えると、同じ素材が
  //      別用途で参照された場合に crop transform が漏れる
  //   2. blur 経路は元々 cover RT が必要 (blur shader は ShaderMaterial で
  //      texture.matrix を honor しないため)。cover RT を統一すれば分岐が消える
  const img = texture.image;
  const srcW = (img && (img.naturalWidth || img.videoWidth || img.width)) || 0;
  const srcH = (img && (img.naturalHeight || img.videoHeight || img.height)) || 0;
  if (renderer && srcW > 0 && srcH > 0) {
    result.bgCover = createCoverPass(CANVAS_WIDTH, CANVAS_HEIGHT);
    const coveredTex = result.bgCover.apply(renderer, texture, srcW, srcH);
    if (blurPx > 0) {
      result.bgBlur = createBlurPass(CANVAS_WIDTH, CANVAS_HEIGHT);
      displayTexture = result.bgBlur.pass.apply(renderer, coveredTex, bgBlurArg);
    } else {
      displayTexture = coveredTex;
    }
  }
  const mesh = makePlane(CANVAS_WIDTH, CANVAS_HEIGHT, displayTexture, ORDER_BG_IMAGE, 0, 0);
  scene.add(mesh);
  result.mesh = mesh;
  return result;
}

async function buildForeground(scene, layerData, urls) {
  // assetUrl で元素材を直接 texture 化し、contain (min-scale, no crop) で
  // 中央配置する。
  const url = layerData.foreground?.assetUrl || null;
  if (!url) return null;
  urls.push(url);
  const texture = await loadTexture(url);
  if (!texture) return null;
  const img = texture.image;
  const srcW = (img && (img.naturalWidth || img.videoWidth || img.width)) || 0;
  const srcH = (img && (img.naturalHeight || img.videoHeight || img.height)) || 0;
  if (srcW <= 0 || srcH <= 0) {
    // 画像 size 不明: 全画面に貼り付けて素通し (defensive)。
    const mesh = makePlane(CANVAS_WIDTH, CANVAS_HEIGHT, texture, ORDER_FG, 0, 0);
    scene.add(mesh);
    return mesh;
  }
  const scale = Math.min(CANVAS_WIDTH / srcW, CANVAS_HEIGHT / srcH);
  const planeW = Math.max(1, Math.round(srcW * scale));
  const planeH = Math.max(1, Math.round(srcH * scale));
  // 表示位置 (plane 左上)。foreground.x / y が数値なら絶対座標 (0,0 = 画面左上、
  // キャラ x/y と同じルール)、未指定 (null) なら従来どおり中央配置。
  const fgX = Number(layerData.foreground?.x);
  const fgY = Number(layerData.foreground?.y);
  const x = Number.isFinite(fgX) ? Math.round(fgX) : Math.floor((CANVAS_WIDTH - planeW) / 2);
  const y = Number.isFinite(fgY) ? Math.round(fgY) : Math.floor((CANVAS_HEIGHT - planeH) / 2);
  const mesh = makePlane(planeW, planeH, texture, ORDER_FG, x, y);
  scene.add(mesh);
  return mesh;
}

// 動画レイヤーの alpha 計算 (opacity * fadeIn factor * fadeOut factor)。
// inactive / ended のときは 0 を返す (= mesh.visible=false にもなるが、
// 念のため material.opacity も 0 に倒しておくと数値的に明示できる)。
function _computeVideoLayerAlpha(layer, result) {
  if (!layer || !result || result.state !== "active") return 0;
  let alpha = Number(layer.opacity);
  if (!Number.isFinite(alpha)) alpha = 1.0;
  alpha = Math.max(0, Math.min(1, alpha));
  const localSec = Number(result.localSec) || 0;
  const spanSec = Number(result.spanSec) || 0;
  if (layer.fadeInEnabled) {
    const fadeIn = Math.max(0, Number(layer.fadeInSec) || 0);
    if (fadeIn > 0) {
      alpha *= Math.max(0, Math.min(1, localSec / fadeIn));
    }
  }
  if (layer.fadeOutEnabled) {
    const fadeOut = Math.max(0, Number(layer.fadeOutSec) || 0);
    if (fadeOut > 0 && spanSec > 0) {
      const remaining = spanSec - localSec;
      alpha *= Math.max(0, Math.min(1, remaining / fadeOut));
    }
  }
  return Math.max(0, Math.min(1, alpha));
}

// 動画レイヤー (videoLayers) を per-layer plane で scene に積む。
//
// 引数:
//   videoLayerProvidersById: Map<layerId, VideoProvider>
//     各 layer の getTexture() を呼び出して plane に貼る。
//     preview では VideoTextureProvider (HTMLVideoElement + VideoTexture)、
//     export では WebCodecsVideoProvider (frame-accurate decode) が想定。
//   videoLayerDurations: Map<src, { duration, width, height, hasAudio }>
//     /api/video-duration から解決済み。trim 終端 / fit 計算に使う。
//
// 戻り値:
//   { entries: [...{ mesh, layer, provider, durationSec, fps }] }
//   update({ sceneSec, fps }) で各 entry の mesh.visible / texture offset を更新する。
//
// scene-bundle 経路:
//   layerData.videoLayers: 正規化済みの videoLayer 配列 (server から渡ってくる)
//   layerData.fps: project fps (24)
async function buildVideoLayers(
  scene,
  layerData,
  urls,
  videoLayerProvidersById,
  videoLayerDurations,
) {
  const layers = Array.isArray(layerData?.videoLayers) ? layerData.videoLayers : [];
  if (!layers.length) return null;
  const entries = [];
  for (const layer of layers) {
    if (!layer || !layer.id || !layer.src) continue;
    const provider = videoLayerProvidersById?.get?.(layer.id) || null;
    if (!provider) continue;
    const texture = provider.getTexture?.();
    if (!texture) continue;

    // /api/video-duration から解決した width / height があれば fit に使う。
    // 未解決 (preview の初回 build など) は VideoTexture.image の videoWidth を
    // 後追いで読む手もあるが、ここでは contain の default (素材アスペクト不明 = stage 内接)
    // にフォールバックする。
    const meta = videoLayerDurations?.get?.(layer.src) || null;
    const srcW = (meta?.width || 0) > 0
      ? meta.width
      : (texture.image?.videoWidth || texture.image?.naturalWidth || texture.image?.width || 1920);
    const srcH = (meta?.height || 0) > 0
      ? meta.height
      : (texture.image?.videoHeight || texture.image?.naturalHeight || texture.image?.height || 1080);
    const fitResult = computeVideoFit(
      srcW, srcH, layer.fit, layer.scale, layer.offsetX, layer.offsetY,
    );

    // VideoTexture は cover crop を offset/repeat で表現する。flipY=false 前提
    // (video-provider が設定済)。
    try {
      texture.offset.set(fitResult.uvOffsetX, fitResult.uvOffsetY);
      texture.repeat.set(fitResult.uvScaleX, fitResult.uvScaleY);
      texture.needsUpdate = true;
    } catch (_) {}

    const renderOrder = layer.layer === "above_bg"
      ? ORDER_VIDEO_LAYER_ABOVE_BG
      : ORDER_VIDEO_LAYER_ABOVE_FG;
    const mesh = makePlane(
      Math.max(1, fitResult.planeW),
      Math.max(1, fitResult.planeH),
      texture,
      renderOrder,
      fitResult.planeX,
      fitResult.planeY,
    );
    // 初期状態は非表示 (= update で sceneSec が来てから判定)。
    mesh.visible = false;
    scene.add(mesh);
    entries.push({
      mesh,
      layer,
      provider,
      // ★ duration はここで固定値として持たない。update() で
      //   videoLayerDurations.get(layer.src) を毎フレーム参照する (P1-A 対応)。
      //   build 時に未解決でも、fetch 完了後の次フレームで自然に visible になる。
    });
  }
  if (!entries.length) return null;
  // videoLayerDurations 参照を結果に含めて update() から見えるようにする。
  return { entries, videoLayerDurations };
}

// scene 内の全テロップを 1 枚の overlay plane (ORDER_TELOP) として scene に追加する。
// per-frame の出入りは ``refreshTelopCanvas`` が active set を判定して、変化が
// あったときだけ canvas を再描画 + texture.needsUpdate する (毎フレーム redraw は
// しない)。canvas は scene の lifecycle (= same token) で使い回す。
async function buildTelops(scene, layerData) {
  const telops = Array.isArray(layerData?.telops) ? layerData.telops : null;
  if (!telops || telops.length === 0) return null;
  // FontFace のロードが終わるのを待ってから 1 度初期化描画する。dialogue 経路と同じ。
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch {}
  }
  // ★ Phase 3: renderLayer ごとに plane を分ける。
  //   各 clip の renderLayer (overlay / above_bg / above_chars / above_fg) を見て
  //   グループ化、そのキーごとに 1 plane を作成。該当 clip がないキーは plane を
  //   作らない (VRAM 節約)。
  const groups = new Map();    // key (above_bg/...) → telop[]
  for (const t of telops) {
    if (!t || typeof t !== "object") continue;
    let key = String(t.renderLayer || "overlay");
    if (!TEXT_LAYER_KEYS.includes(key)) key = "overlay";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  if (groups.size === 0) return null;
  const layers = [];
  for (const key of TEXT_LAYER_KEYS) {
    const subset = groups.get(key);
    if (!subset || subset.length === 0) continue;
    const { canvas, texture } = createTelopCanvasTexture();
    const renderOrder = TEXT_LAYER_ORDER_BY_KEY[key];
    const mesh = makePlane(TELOP_CANVAS_WIDTH, TELOP_CANVAS_HEIGHT, texture, renderOrder, 0, 0);
    scene.add(mesh);
    layers.push({
      key,
      mesh,
      canvas,
      canvasTexture: texture,
      telops: subset,
      // underlayInfo は scene 構築後に buildScene が詰める。
      state: { lastFingerprint: null, underlayInfo: null },
    });
  }
  return { layers };
}

// HEX (#rrggbb / #rgb) を relative luminance に変換。
// 0..1。明るい色ほど 1 に近い。
function _hexLuminance(hex) {
  const m = String(hex || "").trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return 0.5;
  let r, g, b;
  if (m[1].length === 3) {
    r = parseInt(m[1][0] + m[1][0], 16);
    g = parseInt(m[1][1] + m[1][1], 16);
    b = parseInt(m[1][2] + m[1][2], 16);
  } else {
    r = parseInt(m[1].slice(0, 2), 16);
    g = parseInt(m[1].slice(2, 4), 16);
    b = parseInt(m[1].slice(4, 6), 16);
  }
  // Rec. 709 weights (sRGB 近似)。
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function _pickBlendMode(hex) {
  // 明るめ (luminance > 0.5) → screen / 暗め → multiply。
  return _hexLuminance(hex) > 0.5 ? "screen" : "multiply";
}

// セリフ枠用に「mask 描画済み canvas + ブレンド shader plane」を 1 枚作る。
// draw(canvas, layout) で 1 回だけ描画 → CanvasTexture → ShaderMaterial plane。
// transparentBackground=true のときは screen/multiply ではなく通常 alpha 合成。
// (背景透明書き出しでセリフ枠がキャラ上にしか出ない症状の対策)
function _buildDialogueBoxPlane(scene, layout, opacityNorm, color, renderOrder, drawFn, options = {}) {
  if (opacityNorm <= 0) return null;
  const { canvas, texture } = createDialogueCanvasTexture();
  drawFn(canvas, layout);
  texture.needsUpdate = true;
  const mode = _pickBlendMode(color);
  const material = createDialogueBoxBlendMaterial(texture, mode, opacityNorm, {
    transparentBackground: !!options.transparentBackground,
  });
  const geometry = new THREE.PlaneGeometry(CANVAS_WIDTH, CANVAS_HEIGHT);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 0);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, canvasTexture: texture };
}

// 背景が透明 (= 画像も動画も plane 不在、colorOpacity=0) かどうかを判定する。
// buildBackground の null return と同条件。透明背景時にセリフ枠 fill/border の
// 合成式を通常 alpha に倒すフラグとして使う。
function _isTransparentBackground(layerData) {
  if (layerData?.hasVideoTrack) return false;
  if (layerData?.background?.assetUrl) return false;
  const colorOpacity = Math.max(0, Math.min(1, Number(layerData?.background?.colorOpacity) || 0));
  return colorOpacity <= 0;
}

async function buildDialogue(scene, layerData, urls, options = {}) {
  // scene-bundle が compute_dialogue_layout の raw payload を返す。canvas2D で
  // 描画して CanvasTexture 化する (Pillow 焼き込み PNG は撤去済み)。
  // options.transparentBackground = true のとき、セリフ枠の合成式を screen/multiply
  // ではなく通常 alpha 合成に倒す (透明背景時にキャラ上以外の領域でセリフ枠が
  // 見えなくなるバグ対策)。
  const dialogue = layerData.dialogue || null;
  if (!dialogue || !dialogue.raw) return null;
  // FontFace のロードを待つ。未ロード状態で描くとシステムフォントへ
  // フォールバックされて期待と違う絵になる。
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch {}
  }
  const raw = dialogue.raw;
  // セリフ枠の背景 / ボーダーは独自 blend (screen / multiply) を使うため別 plane へ。
  // boxOpacity (0..255) を 0..1 正規化して shader uOpacity に渡す。0 で完全に no-op。
  // 透明背景時のみ、screen/multiply ではなく通常 alpha 合成に切り替える
  // (透明書き出しでセリフ枠がキャラ上にしか出ないバグの対策)。
  // ★ 「実際に背景 plane が作られたか」で判定する。layerData.background.assetUrl が
  //    あっても、ファイルが見つからず loadTexture が失敗したケースでは plane は作られず
  //    canvas は透明のままになる。assetUrl の有無だけで判定すると誤判定して
  //    セリフ枠がキャラ上にしか乗らないバグになる。
  const transparentBackground = options.transparentBackground === undefined
    ? _isTransparentBackground(layerData)
    : !!options.transparentBackground;
  let boxFill = null;
  let boxBorder = null;
  if (raw.box) {
    const fillOpacityNorm = Math.max(0, Math.min(1, (Number(raw.box.fillOpacity) || 0) / 255));
    const borderOpacityNorm = Math.max(0, Math.min(1, (Number(raw.box.borderOpacity) || 0) / 255));
    if (raw.showSpeechBox !== false && fillOpacityNorm > 0) {
      boxFill = _buildDialogueBoxPlane(
        scene, raw, fillOpacityNorm, raw.box.fillColor || "#141C20",
        ORDER_DIALOGUE_BOX_FILL, drawDialogueBoxFillOnCanvas,
        { transparentBackground },
      );
    }
    const bw = Math.max(0, Number(raw.box.borderWidth) || 0);
    if (raw.showSpeechBox !== false && bw > 0 && borderOpacityNorm > 0) {
      boxBorder = _buildDialogueBoxPlane(
        scene, raw, borderOpacityNorm, raw.box.borderColor || "#ffffff",
        ORDER_DIALOGUE_BOX_BORDER, drawDialogueBoxBorderOnCanvas,
        { transparentBackground },
      );
    }
  }
  const overlayImg = await loadDialogueOverlayImage(raw.overlayImageUrl || null);
  const { canvas, texture } = createDialogueCanvasTexture();
  // 本文 (overlay 画像 / speaker / 本文) は normal blending で従来通り描画。
  drawDialogueOnCanvas(canvas, raw, overlayImg);
  texture.needsUpdate = true;
  const mesh = makePlane(CANVAS_WIDTH, CANVAS_HEIGHT, texture, ORDER_DIALOGUE, 0, 0);
  scene.add(mesh);
  // canvasTexture は texture-cache 管理外なので scene.dispose で個別破棄する。
  return { mesh, canvasTexture: texture, boxFill, boxBorder };
}

// 背景レイヤー (画像 / 動画 / 透過) から ctx.background 用の dict を生成。
// _kit.js のヘルパで luminance / contrastColor までまとめる。CORS で読めない
// (tainted) や image 未ロードの場合は default (gray 0.5) フォールバック。
//
// 注:
//   - VideoProvider 経路 (videoTrack) は VideoTexture.image = HTMLVideoElement を sample
//   - 通常 bg は v2 direct-texture で `loadTexture(url)` 結果の Image を使う
//   - cover RT 経由のテクスチャは Image を持たないが、その場合でも
//     texture-cache 共有のオリジナル Image を取得できれば sample 可
async function computeBackgroundInfoForScene(bg, videoProvider, layerData) {
  if (videoProvider && layerData?.hasVideoTrack) {
    const tex = videoProvider.getTexture?.();
    const img = tex?.image;
    if (img) return _kitBg.backgroundInfoFromImage(img, { source: "video" });
    return _kitBg.defaultBackgroundInfo();
  }
  // bg.mesh.material.map.image は v2 direct-texture 経路ならオリジナル Image。
  // cover RT を経由した場合 image は RT (= 読みにくい) なので、元 URL から
  // 再度 fetch + decode する経路を fallback として用意。
  const tex = bg?.mesh?.material?.map;
  const candidate = tex?.image;
  const w = candidate?.naturalWidth || candidate?.videoWidth || candidate?.width || 0;
  if (candidate && w > 0) {
    return _kitBg.backgroundInfoFromImage(candidate, { source: "image" });
  }
  const url = layerData?.background?.assetUrl || layerData?.background?.url || null;
  if (!url) return _kitBg.defaultBackgroundInfo();
  try {
    const img = await loadImageElementForSampling(url);
    if (img) return _kitBg.backgroundInfoFromImage(img, { source: "image" });
  } catch (_) {}
  return _kitBg.defaultBackgroundInfo();
}

function loadImageElementForSampling(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function buildVisualizer(scene, layerData, urls, renderer, backgroundInfo = null) {
  const viz = layerData.visualizer;
  if (!viz) return null;
  const layerKey = String(viz.layer || "above_bg");
  let renderOrder = ORDER_VIZ_ABOVE_BG;
  if (layerKey === "below_bg") renderOrder = ORDER_VIZ_BELOW_BG;
  else if (layerKey === "above_chars") renderOrder = ORDER_VIZ_ABOVE_CHARS;
  else if (layerKey === "above_fg") renderOrder = ORDER_VIZ_ABOVE_FG;

  // GL plugin 経路のみ (PNG 連番 fallback は撤去済)。
  if (!viz.gl?.module) return null;
  try {
    const { loadVisualizerModule, fetchVisualizerStreams } = await import(
      "/static/js/visualizers/index.js"
    );
    // フォント解決: visualizer の params.fontFamily / fontWeight は内部 ID
    // ("line_seed_jp" / "regular") なので、CSS の family stack / numeric weight に
    // 変換して plugin に渡す。
    const { fontFamilyCssStack, resolveFontWeightCss } = await import("/static/js/font.js");
    const fontResolver = (familyId, weightId) => ({
      family: fontFamilyCssStack(familyId || ""),
      weight: resolveFontWeightCss(familyId || "", weightId || "regular"),
    });
    const mod = await loadVisualizerModule(viz.gl.module);
    const { audioData, streamShapes, streamMeta } = await fetchVisualizerStreams(viz.gl.streams || {});
    const layer = await mod.createVisualizerLayer({
      THREE,
      renderer,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      params: viz.gl.params || {},
      audioData,
      streamShapes,
      streamMeta,
      frameDurationSec: Number(viz.frameDurationSec) || (1 / 12),
      frameCount: Number(viz.frameCount) || 0,
      cutStartSec: Number(viz.cutStartSec) || 0,
      sceneTotalSec: Number(viz.sceneTotalSec) || 0,
      fontResolver,
      // 背景の見た目 (luminance / averageColor / contrastColor / source)。
      // 「自分より下のレイヤーの平均明るさ」を見て加算合成回避や影付け判定に使う。
      background: backgroundInfo || _kitBg.defaultBackgroundInfo(),
      // scene の「基本」タブで設定された BPM。0 / null のとき plugin 側で
      // 自身の既定値にフォールバックする。export 経路も layerData.idleMotion 経由で
      // 同じ値が乗るので preview / export で挙動が一致する。
      sceneBpm: Number(layerData?.idleMotion?.bpm) || 0,
    });
    if (!layer?.object3D) {
      throw new Error(`visualizer ${viz.gl.module}: createVisualizerLayer returned no object3D`);
    }
    // renderOrder は plugin で個別に設定済みでも、最終的に scene-builder が
    // viz.layer に従って上書きする (plugin が層配置に責任を持たない設計)。
    //
    // THREE.Group は不可: three.js の projectObject (WebGLRenderer 内部) が
    // `if (object.isGroup) groupOrder = object.renderOrder` で子孫に
    // groupOrder を伝播し、reversePainterSortStable が groupOrder を
    // renderOrder より優先する。プラグイン側は THREE.Object3D を使う規約だが、
    // 防御的に Group のときは parent 側は default 0 のまま放置する。
    if (!layer.object3D.isGroup) {
      layer.object3D.renderOrder = renderOrder;
    }
    layer.object3D.traverse?.((obj) => {
      if (
        obj !== layer.object3D
        && (obj.isMesh || obj.isInstancedMesh || obj.isLine || obj.isLineSegments || obj.isPoints)
      ) {
        obj.renderOrder = renderOrder;
      }
    });
    scene.add(layer.object3D);
    return {
      kind: "gl",
      glLayer: layer,
      disposed: false,
    };
  } catch (err) {
    console.warn("[visualizer] GL plugin failed:", err);
    return null;
  }
}

// B-2: characterLayout.border が enabled なら分割線 + 任意で外周線を描く。
// 各セグメントは細長い PlaneGeometry で表現 (WebGL の LineBasicMaterial は
// 線幅 1px 固定なので不可)。renderOrder = キャラより前、テロップより後。
function buildCharacterLayoutBorder(scene, layerData) {
  const layout = layerData?.characterLayout;
  const border = layout?.border;
  const width = Number(border?.width) || 0;
  // DEBUG (B-2): border 描画が走るかの可視化。問題切り分けが終わったら削除する。
  if (window.__spliteDebugLayoutBorder) {
    console.log("[layoutBorder]", { layout, border, width });
  }
  if (!layout || !border || width <= 0) return null;

  // pattern からスロット矩形を取得 → 線分集合を作る。
  const slotRects = _computeSlotRects(layout.pattern);
  if (window.__spliteDebugLayoutBorder) {
    console.log("[layoutBorder] slotRects=", slotRects.length, "pattern=", layout.pattern);
  }
  if (slotRects.length === 0) return null;

  const segments = _collectBorderSegments(slotRects, !!border.includeOuter);
  if (window.__spliteDebugLayoutBorder) {
    console.log("[layoutBorder] segments=", segments.length, segments);
  }
  if (segments.length === 0) return null;

  const color = new THREE.Color(border.color || "#ffffff");
  // ★ transparent: true は必須。THREE は opaque pass → transparent pass の順で
  // 描画するため、キャラやテロップ (= transparent: true) より下のレンダ順でも、
  // border が opaque だと「opaque pass で先に描く → 後の transparent pass が上塗り」
  // で隠れる。transparent: true にすれば同じ transparent pass 内で renderOrder の
  // 大小に従って正しく重なる。
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });

  const group = new THREE.Group();
  // ★ group.renderOrder は設定しない (= 既定 0 のまま)。THREE の projectObject は
  //   Group の renderOrder を子メッシュの groupOrder として伝播し、描画ソート
  //   (painterSortStable) は groupOrder を renderOrder より先に比較する。group に
  //   920 を入れると子の groupOrder=920 となり、scene 直下のテロップ/セリフ
  //   (groupOrder=0, renderOrder 2000/3000) より後に描かれて border が最前面に
  //   乗ってしまう (= テロップ文字が border に隠れる)。group は 0 のままにして、
  //   各メッシュの mesh.renderOrder=920 (下記) だけで重ね順を決める。
  // 外周線 (canvas edge) は中心が画面端にあると線幅の半分が画面外に切れて
  // 「指定値の半分しか見えない」現象になる。境界辺は線幅 / 2 だけ内側に
  // オフセットして、画面内に収まる形で描く。
  const halfWidth = width / 2;
  const W = CANVAS_WIDTH;
  const H = CANVAS_HEIGHT;
  const eq = (a, b) => Math.abs(a - b) < 0.5;
  for (const seg of segments) {
    // seg = { x1, y1, x2, y2 } in world coords (0..1920, 0..1080)
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const length = Math.hypot(dx, dy);
    if (length <= 0) continue;
    let offsetX = 0;
    let offsetY = 0;
    if (eq(seg.x1, 0) && eq(seg.x2, 0)) offsetX = halfWidth;        // 左外周 → 右へ
    else if (eq(seg.x1, W) && eq(seg.x2, W)) offsetX = -halfWidth;  // 右外周 → 左へ
    if (eq(seg.y1, 0) && eq(seg.y2, 0)) offsetY = halfWidth;        // 上外周 → 下へ
    else if (eq(seg.y1, H) && eq(seg.y2, H)) offsetY = -halfWidth;  // 下外周 → 上へ
    const geometry = new THREE.PlaneGeometry(length, width);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      (seg.x1 + seg.x2) / 2 + offsetX,
      (seg.y1 + seg.y2) / 2 + offsetY,
      0,
    );
    mesh.rotation.z = Math.atan2(dy, dx);
    mesh.renderOrder = ORDER_CHAR_LAYOUT_BORDER;
    mesh.frustumCulled = false;
    if (window.__spliteDebugLayoutBorder) {
      console.log("[layoutBorder] mesh", {
        pos: { x: mesh.position.x, y: mesh.position.y },
        rot: mesh.rotation.z,
        size: { w: length, h: width },
        color: material.color.getHexString(),
      });
    }
    group.add(mesh);
  }
  scene.add(group);
  if (window.__spliteDebugLayoutBorder) {
    console.log("[layoutBorder] scene.children.length=", scene.children.length,
      "group.children.length=", group.children.length,
      "rendererClipEnabled=", (typeof window !== "undefined" && window.__spliteRendererCheck) ? window.__spliteRendererCheck() : "(n/a)");
  }
  return { group, material };
}

// pattern からスロット矩形 (1920×1080 内) を返す。
// スロット index 0 から左→右 / 上→下 順。
function _computeSlotRects(pattern) {
  const W = CANVAS_WIDTH;
  const H = CANVAS_HEIGHT;
  switch (pattern) {
    case "vertical_2":
      return [{ x: 0, y: 0, w: W / 2, h: H }, { x: W / 2, y: 0, w: W / 2, h: H }];
    case "vertical_3":
      return [0, 1, 2].map((i) => ({ x: (W / 3) * i, y: 0, w: W / 3, h: H }));
    case "vertical_4":
      return [0, 1, 2, 3].map((i) => ({ x: (W / 4) * i, y: 0, w: W / 4, h: H }));
    case "horizontal_2":
      return [{ x: 0, y: 0, w: W, h: H / 2 }, { x: 0, y: H / 2, w: W, h: H / 2 }];
    case "horizontal_3":
      return [0, 1, 2].map((i) => ({ x: 0, y: (H / 3) * i, w: W, h: H / 3 }));
    case "horizontal_4":
      return [0, 1, 2, 3].map((i) => ({ x: 0, y: (H / 4) * i, w: W, h: H / 4 }));
    case "grid_2x2":
      return [
        { x: 0, y: 0, w: W / 2, h: H / 2 },
        { x: W / 2, y: 0, w: W / 2, h: H / 2 },
        { x: 0, y: H / 2, w: W / 2, h: H / 2 },
        { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
      ];
    case "t_top":  // 上 1 + 下 2
      return [
        { x: 0, y: 0, w: W, h: H / 2 },
        { x: 0, y: H / 2, w: W / 2, h: H / 2 },
        { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
      ];
    case "t_bottom":  // 上 2 + 下 1
      return [
        { x: 0, y: 0, w: W / 2, h: H / 2 },
        { x: W / 2, y: 0, w: W / 2, h: H / 2 },
        { x: 0, y: H / 2, w: W, h: H / 2 },
      ];
    case "l_left":  // 左 1 + 右 2
      return [
        { x: 0, y: 0, w: W / 2, h: H },
        { x: W / 2, y: 0, w: W / 2, h: H / 2 },
        { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
      ];
    case "l_right":  // 左 2 + 右 1
      return [
        { x: 0, y: 0, w: W / 2, h: H / 2 },
        { x: 0, y: H / 2, w: W / 2, h: H / 2 },
        { x: W / 2, y: 0, w: W / 2, h: H },
      ];
    default:
      return [];
  }
}

// スロット矩形群から、描画すべき border 線分の重複を除去した集合を返す。
// includeOuter=true なら外周 (0,0)-(1920,1080) の 4 辺も含める。
function _collectBorderSegments(slotRects, includeOuter) {
  const segments = new Map();  // key: "x1,y1-x2,y2" canonical
  const addSeg = (x1, y1, x2, y2) => {
    // 同じ線分の重複登録を排除 (= 隣接スロットの共有辺は 1 本に集約)。
    // 端点の order を正規化してキー化。
    const a = `${x1.toFixed(2)},${y1.toFixed(2)}`;
    const b = `${x2.toFixed(2)},${y2.toFixed(2)}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!segments.has(key)) {
      segments.set(key, { x1, y1, x2, y2 });
    }
  };
  for (const r of slotRects) {
    const x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
    addSeg(x1, y1, x2, y1);  // 上辺
    addSeg(x2, y1, x2, y2);  // 右辺
    addSeg(x1, y2, x2, y2);  // 下辺
    addSeg(x1, y1, x1, y2);  // 左辺
  }
  const result = Array.from(segments.values());
  if (!includeOuter) {
    // 外周 (キャンバス端) の辺を除外。
    return result.filter((seg) => !_isCanvasEdge(seg));
  }
  return result;
}

function _isCanvasEdge(seg) {
  const W = CANVAS_WIDTH;
  const H = CANVAS_HEIGHT;
  const eq = (a, b) => Math.abs(a - b) < 0.5;
  // 完全に左 / 右 / 上 / 下 端と一致する線分
  return (
    (eq(seg.x1, 0) && eq(seg.x2, 0)) ||
    (eq(seg.x1, W) && eq(seg.x2, W)) ||
    (eq(seg.y1, 0) && eq(seg.y2, 0)) ||
    (eq(seg.y1, H) && eq(seg.y2, H))
  );
}

async function buildCharacter(scene, char, charIndex, urls, characterEffects, characterCount) {
  // 配列上の前 (= index 小) のキャラほど手前 (= renderOrder 大) に描く。
  // UI の「登場キャラ」リストは上から順に並んでおり、「前へ」「後ろへ」ボタンが
  // index ±1 で移動する。「前へ」を押したときに視覚的にも前面へ出ることが
  // ユーザーの素直な期待なので、index ↘ → renderOrder ↗ の関係にする。
  const total = Math.max(1, Number(characterCount) || 1);
  const drawSlot = total - 1 - charIndex;
  const baseOrder = ORDER_CHAR_BASE + drawSlot * 10;
  const w = char.layerWidth * char.scale;
  const h = char.layerHeight * char.scale;
  const x = char.x;
  const y = char.y;

  const collect = async (url) => {
    if (!url) return null;
    urls.push(url);
    return loadTexture(url);
  };

  const [
    underTex,
    overTex,
    eyeOpenTex,
    eyeHalfTex,
    eyeClosedTex,
    mouthDefaultTex,
    mouthClosedTex,
    mouthMidTex,
    mouthOpenTex,
  ] = await Promise.all([
    collect(char.underUrl),
    collect(char.overUrl),
    collect(char.eyeUrls?.open),
    collect(char.eyeUrls?.half),
    collect(char.eyeUrls?.closed),
    collect(char.mouthUrls?.default),
    collect(char.mouthUrls?.closed),
    collect(char.mouthUrls?.mid),
    collect(char.mouthUrls?.open),
  ]);

  const eyeTextures = { open: eyeOpenTex, half: eyeHalfTex, closed: eyeClosedTex };
  // mouthTextures.default = カット選択の口 (= state["mouth"])。
  // 喋っていない / 口パク OFF / 非話者 では default を使う。
  const mouthTextures = {
    default: mouthDefaultTex,
    closed: mouthClosedTex,
    mid: mouthMidTex,
    open: mouthOpenTex,
  };

  // キャラごとに Group を作り、内側 mesh は (0,0) に置く。Group の position
  // を per-frame で動かすことで shake / idle motion を表現 (Phase B-1)。
  const group = new THREE.Group();
  group.position.set(x + w / 2, y + h / 2, 0);
  // 基準位置を後から取り出せるよう保持。
  const basePos = { x: x + w / 2, y: y + h / 2 };

  // 左右反転 (flipX): キャラ本体レイヤー (under/eye/mouth/over) と silhouette を
  // 中心軸 (0,0) で反転させる。Group 全体に scale.x = -1 をかけると glow/dropShadow
  // 用 plane や shadow offsetX まで反転してしまうので、本体だけ別の中間 Group に
  // 入れて scale を適用する。silhouette scene 側も別 Group で反転する。
  const flipX = !!char.flipX;
  const bodyGroup = new THREE.Group();
  if (flipX) bodyGroup.scale.x = -1;
  group.add(bodyGroup);

  // 色フィルタはメイン scene のキャラ plane だけに適用 (silhouette 側は alpha のみ
  // 使うので無関係)。char.colorFilter は scene-bundle が per-character payload に
  // raw 値を乗せる。enabled=false / 未指定なら uniform 0 で no-op。
  const cf = char.colorFilter;
  const underMesh = makeCharPlaneShader(w, h, underTex, baseOrder + ORDER_CHAR_UNDER_OFFSET, cf);
  const eyeMesh = makeCharPlaneShader(w, h, eyeTextures.open || null, baseOrder + ORDER_CHAR_EYE_OFFSET, cf);
  // 初期表示は default (= カット選択の口)。再生開始まで「閉じ口」が一瞬出るのを防ぐ。
  const mouthMesh = makeCharPlaneShader(
    w, h, mouthTextures.default || mouthTextures.closed || null,
    baseOrder + ORDER_CHAR_MOUTH_OFFSET, cf,
  );
  const overMesh = makeCharPlaneShader(w, h, overTex, baseOrder + ORDER_CHAR_OVER_OFFSET, cf);

  if (underMesh.visible) bodyGroup.add(underMesh);
  if (eyeMesh.visible) bodyGroup.add(eyeMesh);
  if (mouthMesh.visible) bodyGroup.add(mouthMesh);
  if (overMesh.visible) bodyGroup.add(overMesh);

  // B-2: char.crop が指定されていれば、各 ShaderMaterial の uClipRect uniform を
  // 書き換えて fragment shader 側で矩形外を discard させる。silhouette 側
  // (= 別 scene、makeCharPlane の MeshBasicMaterial) は今回は対象外 — glow/dropShadow
  // 利用時は effect bleed が起こりうるが、要件次第で後回し。
  _applyCropToCharacterMeshes([underMesh, eyeMesh, mouthMesh, overMesh], char.crop);

  scene.add(group);

  // エフェクト (光彩 / ドロップシャドウ) のセットアップ。両方 disabled なら null。
  // characterEffects は cut.state.characterEffects を全キャラ共通で受け取る。
  let effects = null;
  const glowCfg = characterEffects?.glow?.enabled ? characterEffects.glow : null;
  const shadowCfg = characterEffects?.dropShadow?.enabled ? characterEffects.dropShadow : null;
  if (glowCfg || shadowCfg) {
    // padding は glow / shadow いずれかの blur 半径に追従して必要量を確保する。
    const effectPadding = computeEffectPadding(
      glowCfg?.blurPx,
      shadowCfg?.blurPx,
    );
    const silhouette = createSilhouettePass(w, h, effectPadding);
    // silhouette scene 用の別 mesh (メイン Group とは別 parent が必要)。
    // silhouette.scene の camera は中心 (0,0)、Y-down。plane は中心配置。
    const silUnder = makeCharPlane(w, h, underTex, 0);
    const silEye = makeCharPlane(w, h, eyeTextures.open || null, 1);
    const silMouth = makeCharPlane(
      w, h, mouthTextures.default || mouthTextures.closed || null, 2,
    );
    const silOver = makeCharPlane(w, h, overTex, 3);
    // 左右反転は silhouette 側にも適用する (= glow/dropShadow も反転後のキャラ形状で
    // 生成)。silhouette.scene のカメラ中心 (0,0) を軸に反転するため、平面を一段
    // Group に入れて scale.x = -1 を掛ける。
    const silBodyGroup = new THREE.Group();
    if (flipX) silBodyGroup.scale.x = -1;
    silBodyGroup.add(silUnder, silEye, silMouth, silOver);
    silhouette.scene.add(silBodyGroup);

    // glow / shadow で blur 量が違うので別 blur pass を持つ (どちらか有効なら 1 個でも OK)。
    const blurGlow = glowCfg ? createBlurPass(silhouette.width, silhouette.height) : null;
    const blurShadow = shadowCfg ? createBlurPass(silhouette.width, silhouette.height) : null;

    let glowPlane = null;
    if (glowCfg) {
      glowPlane = createTintPlane(silhouette.width, silhouette.height);
      // v1 と同じく glow はキャラの「下」に置いて発光感を出す (周囲だけ見える)。
      glowPlane.renderOrder = baseOrder - 1;
      glowPlane.position.set(0, 0, 0);
      group.add(glowPlane);
    }
    let shadowPlane = null;
    if (shadowCfg) {
      shadowPlane = createTintPlane(silhouette.width, silhouette.height);
      shadowPlane.renderOrder = baseOrder - 2;
      const ox = Number(shadowCfg.offsetX) || 0;
      const oy = Number(shadowCfg.offsetY) || 0;
      shadowPlane.position.set(ox, oy, 0);
      group.add(shadowPlane);
    }
    effects = {
      silhouette,
      silhouettePlanes: { under: silUnder, eye: silEye, mouth: silMouth, over: silOver },
      blurGlow,
      blurShadow,
      glowPlane,
      shadowPlane,
      glowCfg,
      shadowCfg,
    };
    // B-2: crop が指定されていれば、光彩 / ドロップシャドウの tint plane も
    // キャラ本体と同じ world-space 矩形でクリップする (= 隣スロットへの滲み防止)。
    // tint plane はキャラ group 配下なので uClipRect は world 座標のままでよい。
    _applyCropToCharacterMeshes([glowPlane, shadowPlane], char.crop);
  }

  return {
    id: char.id,
    isSpeaker: !!char.isSpeaker,
    // blinkEligible: false ならこのキャラの目パチを skip し eyeKey を強制 "open"
    // にする (= eyeTextures.open = カット選択の目で固定)。
    blinkEligible: char.blinkEligible !== false,
    group,
    bodyGroup,
    basePos,
    // ドラッグ&ドロップのヒットテスト用。w/h はスケール適用後のシーン座標サイズ。
    layerWidth: w,
    layerHeight: h,
    flipX,
    // B-2: マルチキャラレイアウトの crop (= 表示される矩形)。ヒットテストで
    // bbox と crop の交差を取って「画面に出ていない領域はクリックでも当たらない」
    // 挙動にするために露出する。
    crop: char.crop || null,
    eyeMesh,
    mouthMesh,
    eyeTextures,
    mouthTextures,
    effects,
    // BPM 同期の上下ゆれ (bob)。motion とは独立した per-character エフェクトで、
    // update() 内で sceneSec から sin 波の Y オフセットを計算して dy に加算する。
    bob: _normalizeBob(char.bob),
  };
}

// BPM 上下ゆれパラメータの検証。bpm / amplitudePx がともに正のときだけ有効。
function _normalizeBob(raw) {
  if (!raw || typeof raw !== "object") return null;
  const bpm = Number(raw.bpm);
  const amplitudePx = Number(raw.amplitudePx);
  if (!(bpm > 0) || !(amplitudePx > 0)) return null;
  return { bpm, amplitudePx };
}

export async function buildScene(
  layerData,
  renderer = null,
  videoProvider = null,
  videoLayerProvidersById = null,
  videoLayerDurations = null,
) {
  const scene = new THREE.Scene();
  const urls = [];
  const meshes = { bg: null, fg: null, dialogue: null, telops: null, characters: [], videoLayers: null };
  const characterEffects = layerData.characterEffects || {};
  const cutStartSec = Number(layerData.cutStartSec) || 0;
  const projectFps = Number(layerData?.fps) > 0 ? Number(layerData.fps) : 24;

  // 並列で 1 カット分の素材をロード。Promise.all で揃ったら一括で Scene 構築。
  // visualizer だけ「背景の見た目 (luminance / averageColor / ...)」を ctx.background
  // として受け取りたいため、bgPromise を then で連結して bg 完了後に build する。
  // 他のレイヤーは bg と並列のままなので、シーケンシャル化による体感低下は出ない。
  //
  // ★ visualizer 無いカットでは ctx.background 計算ごと skip する。
  // computeBackgroundInfoForScene は cover RT 経由で `tex.image` が取れないと
  // 元 URL を再 fetch + Image decode するので無視できないコストがある。
  // 新プロジェクトの初期カットは通常 visualizer なしなので、ここを skip しないと
  // プロジェクト切替時の新シーン構築が遅延し、前プロジェクトの最後のフレームが
  // canvas に残った状態 (preserveDrawingBuffer=true) で見えてしまう。
  const characterCount = (layerData.characters || []).length;
  const bgPromise = buildBackground(scene, layerData, urls, renderer, videoProvider);
  // 背景情報 (luminance / averageColor 等) は visualizer と telop (neon_glow.autoAttenuateBright 等)
  // で共用する。telop プリセットの中に「underlayInfo を使うものがあれば」計算するのが理想だが、
  // 判定コストが微妙にかさむため、テロップが 1 件でもあれば常に計算してしまう。
  // visualizer がある場合は元々計算するので、ここで Promise を 1 本化して二重計算を避ける。
  const wantsBackgroundInfo = !!layerData?.visualizer
    || (Array.isArray(layerData?.telops) && layerData.telops.length > 0);
  const backgroundInfoPromise = wantsBackgroundInfo
    ? bgPromise.then((bg) => computeBackgroundInfoForScene(bg, videoProvider, layerData))
    : Promise.resolve(null);
  const visualizerPromise = layerData?.visualizer
    ? backgroundInfoPromise.then((backgroundInfo) =>
        buildVisualizer(scene, layerData, urls, renderer, backgroundInfo))
    : Promise.resolve(null);
  // dialogue のセリフ枠 blend は「実際に背景 plane が作られたか」を必要とする。
  // assetUrl があっても loadTexture が失敗 (404 等) して plane が作られないケースは
  // 透明背景と同じ挙動になるので、bg 結果を待ってから dialogue を構築する。
  // ★ 新仕様: 背景色 plane (colorMesh) も背景の一部としてカウントする
  //   (= 色だけでも通常 blend を維持。旧コードと互換の挙動)。
  const dialoguePromise = bgPromise.then((bg) => {
    const hasBgPlane = !!(bg && (bg.mesh || bg.colorMesh));
    return buildDialogue(scene, layerData, urls, {
      transparentBackground: !hasBgPlane,
    });
  });
  const all = await Promise.all([
    bgPromise,
    buildForeground(scene, layerData, urls),
    dialoguePromise,
    visualizerPromise,
    buildTelops(scene, layerData),
    buildVideoLayers(scene, layerData, urls, videoLayerProvidersById, videoLayerDurations),
    backgroundInfoPromise,
    ...((layerData.characters || []).map(
      (char, i, arr) => buildCharacter(scene, char, i, urls, characterEffects, arr.length),
    )),
  ]);
  meshes.bg = all[0];
  meshes.fg = all[1];
  meshes.dialogue = all[2];
  meshes.visualizer = all[3];
  meshes.telops = all[4];
  meshes.videoLayers = all[5];
  const sceneBackgroundInfo = all[6] || null;
  meshes.characters = all.slice(7, 7 + characterCount).filter(Boolean);
  // B-2: マルチキャラレイアウトの border (分割線 + 任意で外周線)。キャラ build 後に
  // 1 度だけ作って scene に追加する (cut.state.characterLayout に依存)。
  meshes.layoutBorder = buildCharacterLayoutBorder(scene, layerData);
  // テロップの neon_glow.autoAttenuateBright 等が参照する。
  // 動画背景の場合は frame ごとに変わるが、scene 開始時のサンプルで代用。
  // ★ Phase 3 で renderLayer 単位に plane を分割したため、各 layer の state に個別に underlayInfo を入れる。
  if (meshes.telops?.layers) {
    for (const layer of meshes.telops.layers) {
      layer.state.underlayInfo = sceneBackgroundInfo;
    }
  }

  let disposed = false;

  function update({
    eyeKey = "open",
    // eyeKeyByChar: { [charId]: "open"|"closed"|"half" }。指定があれば per-char
    // キャラごとに割り当てる (均等方式 / 中目あり/なしでパターン長が異なる場合に使用)。
    // 該当 id が無いキャラは eyeKey にフォールバック。
    eyeKeyByChar = null,
    mouthKey = "closed",
    speakerId = null,
    shakeDx = 0,
    shakeDy = 0,
    idleDx = 0,
    idleDy = 0,
    // M-2: per-character motion offset { [charId]: { dx, dy, scale? } }。
    // 指定があれば shake / move / zoom はこちらを優先。指定なしのキャラは
    // 旧 scene global の shakeDx/Dy (= speaker のみ) を fallback。
    motionOffsetByChar = null,
    elapsedSec = 0,
    // テロップ可視判定用の「量子化していない」cut-local 秒。
    // elapsedSec は characterAnimationFps (8/12/24) で量子化されているため、
    // 直接 telop.startFrame との比較に使うと、startFrame が量子化境界に乗っていない
    // 場合に「playhead をテロップ先頭に合わせたのに、量子化で前のフレームに丸め
    // られて telop が表示されない」現象が起きる (例: startFrame=7, animationFps=12 →
    // 7/24=0.2917s, quantized=0.25s で start を下回る)。telop の表示判定だけは
    // 量子化前の値を優先して使う。未指定時は従来通り elapsedSec にフォールバック。
    rawElapsedSec = null,
  } = {}) {
    if (disposed) return;

    // テロップ overlay: scene 内の active set が変わったら canvas を再描画する。
    // sceneSec = cutStartSec + rawElapsedSec (どちらも秒)。telop の startFrame /
    // durationFrame は scene 全体での絶対座標。
    if (meshes.telops?.layers) {
      const telopElapsed = (rawElapsedSec != null && Number.isFinite(Number(rawElapsedSec)))
        ? Number(rawElapsedSec)
        : (Number(elapsedSec) || 0);
      const sceneSec = cutStartSec + telopElapsed;
      // ★ renderLayer ごとの plane を個別に更新する (Phase 3)。
      // scene.bpm は scene-bundle の idleMotion.bpm に乗る (visualizer と同じ経路)。
      // shake_beat / beatPhase 計算で使う。
      const sceneBpm = Number(layerData?.idleMotion?.bpm) || null;
      for (const layer of meshes.telops.layers) {
        const visible = refreshTelopCanvas(
          layer.canvas,
          layer.canvasTexture,
          layer.telops,
          sceneSec,
          layer.state,
          {
            characterAnimationFps: layerData?.characterAnimationFps,
            sceneBpm,
            underlayInfo: layer.state.underlayInfo || null,
          },
        );
        if (layer.mesh.visible !== visible) layer.mesh.visible = visible;
      }
    }

    // 動画レイヤー: 各 entry に対し mapVideoLayerSec で active/inactive/ended を判定し
    // mesh.visible を切り替える。テロップと同じく rawElapsedSec から sceneSec を組む。
    // (active のときの video.currentTime 同期は preview/export の provider 側で行う)
    if (meshes.videoLayers && Array.isArray(meshes.videoLayers.entries)) {
      const vlElapsed = (rawElapsedSec != null && Number.isFinite(Number(rawElapsedSec)))
        ? Number(rawElapsedSec)
        : (Number(elapsedSec) || 0);
      const sceneSec = cutStartSec + vlElapsed;
      // P1-A: build 時の固定 durationSec ではなく Map から毎フレーム参照する。
      //   prepareVideoLayersForPreview が await せずに build しているため、
      //   build 直後は duration 未解決の layer がある。fetch 完了後の次フレームで
      //   Map に値が入った瞬間に自然に visible へ切り替わる必要がある。
      const durations = meshes.videoLayers.videoLayerDurations;
      for (const entry of meshes.videoLayers.entries) {
        const dur = Number(durations?.get?.(entry.layer?.src)?.duration) || 0;
        // duration 未解決時は mesh を非表示 (= 表示開始を保留)。
        if (dur <= 0) {
          if (entry.mesh.visible) entry.mesh.visible = false;
          continue;
        }
        const result = mapVideoLayerSec(entry.layer, sceneSec, projectFps, dur);
        const alpha = _computeVideoLayerAlpha(entry.layer, result);
        const shouldBeVisible = result.state === "active" && alpha > 0;
        if (entry.mesh.visible !== shouldBeVisible) {
          entry.mesh.visible = shouldBeVisible;
        }
        // material.opacity を毎フレーム更新。MeshBasicMaterial は transparent:true なので
        // alpha が透過合成に効く (= 既存の plane 構造のまま fade in/out が成立)。
        if (shouldBeVisible && entry.mesh.material) {
          entry.mesh.material.opacity = alpha;
        }
      }
    }

    // ビジュアライザのフレーム選択 (連番 PNG を elapsedSec で量子化)。
    // GPU の Texture は 1 枚だけ使い回し、image を差し替えて upload する。
    // 必要な範囲だけ lazy load する (build 時に全 frame を発火しない)。
    if (meshes.visualizer && meshes.visualizer.kind === "gl") {
      // GL plugin 経路: plugin の update() に frameState を渡すだけ。
      // 内部の uniforms / geometry は plugin が管理する。
      //
      // 重要: playback.js が renderActiveScene に渡す elapsedSec は **カット内秒**
      // (cut-local) であり、scene 内通算秒ではない。サーバ側 gl_data_streams は
      // `time_grid = cut_start_sec + i / fps` で per-cut の N_frames 行 (cut-local
      // index) を焼くので、frameIdx は cut-local の elapsedSec / dur で取る。
      // 以前は `(elapsedSec - cutStartSec)` していたが、elapsedSec が cut-local
      // のままなので scene 開始から遠いカットほど負値 → 0 clamp で
      // 「1 frame 目で止まる」症状を起こしていた。
      const viz = meshes.visualizer;
      if (!viz.disposed && viz.glLayer?.update) {
        const dur = Number(layerData.visualizer?.frameDurationSec) || (1 / 12);
        const cutStart = Number(layerData.visualizer?.cutStartSec) || 0;
        let frameIdx = Math.floor(elapsedSec / dur);
        if (frameIdx < 0) frameIdx = 0;
        const fmax = (Number(layerData.visualizer?.frameCount) || 0) - 1;
        if (fmax >= 0 && frameIdx > fmax) frameIdx = fmax;
        const sceneSec = cutStart + elapsedSec;
        try {
          // contract:
          //   elapsedSec : cut-local (秒)
          //   sceneSec   : scene 内通算秒 = cutStartSec + elapsedSec
          //   frameIdx   : cut-local visualizer frame index
          viz.glLayer.update({ elapsedSec, sceneSec, frameIdx });
        } catch (err) {
          console.warn("[visualizer] GL plugin update threw:", err);
        }
      }
    }
    for (const charInstance of meshes.characters) {
      // 目パチ: blinkEligible=false (= カット選択 eye が blinkOpen フラグなし、または
      // manifest に blinkClosed が無い) のキャラは "open" 固定。
      // eyeTextures.open = カット選択の目なので、結果としてカット選択がそのまま出る。
      // half テクスチャが無い (= blinkHalf 未設定) ときは closed → open にフォールバック
      // させて 2 段目パチにする (user_guide/technical/psd-layer-rules.md の最低構成: open + closed)。
      // eyeKeyByChar が指定されていれば per-char の値を優先する (均等方式)。
      const perCharEyeKey = eyeKeyByChar ? eyeKeyByChar[charInstance.id] : undefined;
      const baseEyeKey = perCharEyeKey != null ? perCharEyeKey : eyeKey;
      const localEyeKey = charInstance.blinkEligible ? baseEyeKey : "open";
      let nextEyeTex = charInstance.eyeTextures[localEyeKey];
      if (!nextEyeTex && localEyeKey === "half") {
        nextEyeTex = charInstance.eyeTextures.closed;
      }
      if (!nextEyeTex) nextEyeTex = charInstance.eyeTextures.open || null;
      if (charInstance.eyeMesh.material.uniforms.uMap.value !== nextEyeTex) {
        charInstance.eyeMesh.material.uniforms.uMap.value = nextEyeTex;
        charInstance.eyeMesh.visible = !!nextEyeTex;
      }
      // 口パク: speaker のみ mouthKey を反映。それ以外 / 口パク終了 / OFF は
      // "default" (= カット選択の口) を出す。default が無ければ closed → null の順。
      const localMouthKey = charInstance.id === speakerId ? mouthKey : "default";
      const nextMouthTex =
        charInstance.mouthTextures[localMouthKey]
        || charInstance.mouthTextures.default
        || charInstance.mouthTextures.closed
        || null;
      if (charInstance.mouthMesh.material.uniforms.uMap.value !== nextMouthTex) {
        charInstance.mouthMesh.material.uniforms.uMap.value = nextMouthTex;
        charInstance.mouthMesh.visible = !!nextMouthTex;
      }
      // モーション:
      //   - M-2 で per-character motion 対応。motionOffsetByChar[charId] があれば
      //     その dx/dy/scale を使う (= shake / move / zoom を 1 経路で扱う)。
      //   - 未指定なら旧経路 (scene global shakeDx/Dy を speaker のみに適用)。
      //   - idle は常に全員に追加。
      const isSpeaker = charInstance.isSpeaker;
      const charMotion = motionOffsetByChar?.[charInstance.id];
      let dx = idleDx;
      let dy = idleDy;
      if (charMotion) {
        dx += Number(charMotion.dx) || 0;
        dy += Number(charMotion.dy) || 0;
      } else if (isSpeaker) {
        dx += shakeDx;
        dy += shakeDy;
      }

      // BPM 同期の上下ゆれ (bob)。motion とは独立に加算する (= 揺れながら移動 / 拡大
      // できる)。位相はシーン内通算秒 (cutStartSec + elapsedSec) で計算するので、
      // カットを跨いでも波が連続する (= scene-level bpmBob と同じ時間基準)。
      const bob = charInstance.bob;
      if (bob) {
        const bobSceneSec = cutStartSec + (Number(elapsedSec) || 0);
        const period = 60 / bob.bpm;
        if (period > 0) {
          dy += bob.amplitudePx * Math.sin((2 * Math.PI * bobSceneSec) / period);
        }
      }

      // 回転 / 拡大の中心 (= pivot)。指定があればその点を中心に回転・拡大した
      // 結果の basePos を group.position として書く (= group 構造は変えない)。
      // 指定なし or scale=1, rotation=0 のときは basePos そのまま (= 旧挙動)。
      const motionScaleRaw = Number(charMotion?.scale);
      const motionScale = (Number.isFinite(motionScaleRaw) && motionScaleRaw > 0) ? motionScaleRaw : 1;
      const motionRotDeg = Number(charMotion?.rotationDeg);
      const motionRotRad = Number.isFinite(motionRotDeg) ? motionRotDeg * Math.PI / 180 : 0;
      const pivotXRaw = Number(charMotion?.pivotX);
      const pivotYRaw = Number(charMotion?.pivotY);
      const hasCustomPivot = Number.isFinite(pivotXRaw) && Number.isFinite(pivotYRaw);
      let positionX = charInstance.basePos.x + dx;
      let positionY = charInstance.basePos.y + dy;
      if (hasCustomPivot && (motionScale !== 1 || motionRotRad !== 0)) {
        // pivot 中心の scale + rotation 合成:
        //   new_pos = pivot + R(θ) · (S · (basePos - pivot)) + (dx, dy)
        // ここで S = motionScale, R(θ) = 2D 回転行列。
        const offX = (charInstance.basePos.x - pivotXRaw) * motionScale;
        const offY = (charInstance.basePos.y - pivotYRaw) * motionScale;
        const cosθ = Math.cos(motionRotRad);
        const sinθ = Math.sin(motionRotRad);
        positionX = pivotXRaw + (offX * cosθ - offY * sinθ) + dx;
        positionY = pivotYRaw + (offX * sinθ + offY * cosθ) + dy;
      }
      if (window.__spliteDebugMotion && charMotion) {
        console.log("[scene-builder] motion apply", {
          charId: charInstance.id,
          basePos: { x: charInstance.basePos.x, y: charInstance.basePos.y },
          charMotion,
          finalPos: { x: positionX, y: positionY },
          dx, dy, hasCustomPivot,
        });
      }
      charInstance.group.position.set(positionX, positionY, 0);
      if (motionScale !== 1) {
        charInstance.group.scale.set(motionScale, motionScale, 1);
      } else if (charInstance.group.scale.x !== 1 || charInstance.group.scale.y !== 1) {
        charInstance.group.scale.set(1, 1, 1);
      }
      if (charInstance.group.rotation.z !== motionRotRad) {
        charInstance.group.rotation.z = motionRotRad;
      }
      // move motion: 各 mesh material の uAlphaMul uniform に opacity を流し込む。
      // ShaderMaterial uniform を直接書き換え (= 再 compile 不要)。
      const motionOpacity = Number.isFinite(Number(charMotion?.opacity))
        ? Math.max(0, Math.min(1, Number(charMotion.opacity))) : 1;
      const _applyOpacityToMesh = (mesh) => {
        const u = mesh?.material?.uniforms?.uAlphaMul;
        if (u && u.value !== motionOpacity) u.value = motionOpacity;
      };
      _applyOpacityToMesh(charInstance.bodyGroup?.children?.[0]); // under
      // bodyGroup 直下の全 mesh に伝搬。flipX で bodyGroup.scale.x=-1 になっていても
      // uniforms の伝搬は children 走査で十分。
      if (charInstance.bodyGroup) {
        for (const child of charInstance.bodyGroup.children) _applyOpacityToMesh(child);
      }

      // エフェクト (光彩 / ドロップシャドウ)。renderer が無い (= 初期化失敗) ときは
      // skip。silhouette + blur は重い (1184x1696 RT を毎フレーム 3 pass 等)
      // ので、eye / mouth が前フレームと同じなら再計算をまるごと skip する。
      // 表情が変わるのは目パチ / 口パクのときだけなので、ほとんどのフレームで
      // skip できる。tint plane の material には前回の blurred texture が
      // bind されたまま残るため見た目は変わらない。
      const eff = charInstance.effects;
      if (eff && renderer) {
        const effDirty =
          eff._lastEyeTex !== nextEyeTex || eff._lastMouthTex !== nextMouthTex;
        if (effDirty) {
          eff._lastEyeTex = nextEyeTex;
          eff._lastMouthTex = nextMouthTex;
          // silhouette scene の eye/mouth を最新表情に揃えてから RT へ焼く。
          bindSilhouetteLayers(eff.silhouette, eff.silhouettePlanes, nextEyeTex, nextMouthTex);
          renderSilhouetteRT(renderer, eff.silhouette);
        }

        if (eff.glowPlane && eff.glowCfg) {
          const opacity = Math.max(0, Math.min(1, Number(eff.glowCfg.opacity) || 0));
          const blurPx = Math.max(0, Number(eff.glowCfg.blurPx) || 0);
          if (opacity > 0 && blurPx > 0) {
            // 表情が変わったときだけ blur を再計算。前回の rtB.texture が
            // 既に bind されているので、skip しても見た目は維持される。
            if (effDirty || eff._lastGlowBlurPx !== blurPx) {
              eff._lastGlowBlurPx = blurPx;
              const blurredTex = eff.blurGlow.pass.apply(
                renderer,
                eff.silhouette.rt.texture,
                blurPx,
              );
              setTint(eff.glowPlane.material, {
                texture: blurredTex,
                color: eff.glowCfg.color || "#ffffff",
                opacity,
              });
            } else {
              // 色 / opacity のみ変わるケースは uniform だけ更新 (blur は再利用)
              setTint(eff.glowPlane.material, {
                color: eff.glowCfg.color || "#ffffff",
                opacity,
              });
            }
            eff.glowPlane.visible = true;
          } else {
            eff.glowPlane.visible = false;
          }
        }

        if (eff.shadowPlane && eff.shadowCfg) {
          const opacity = Math.max(0, Math.min(1, Number(eff.shadowCfg.opacity) || 0));
          const blurPx = Math.max(0, Number(eff.shadowCfg.blurPx) || 0);
          if (opacity > 0 && blurPx > 0) {
            if (effDirty || eff._lastShadowBlurPx !== blurPx) {
              eff._lastShadowBlurPx = blurPx;
              const blurredTex = eff.blurShadow.pass.apply(
                renderer,
                eff.silhouette.rt.texture,
                blurPx,
              );
              setTint(eff.shadowPlane.material, {
                texture: blurredTex,
                color: eff.shadowCfg.color || "#000000",
                opacity,
              });
            } else {
              setTint(eff.shadowPlane.material, {
                color: eff.shadowCfg.color || "#000000",
                opacity,
              });
            }
            eff.shadowPlane.visible = true;
          } else {
            eff.shadowPlane.visible = false;
          }
        }
      }
    }
    // (旧) ここで `renderer.setRenderTarget(null)` を呼んでいたが、3 つの
    // v2 プロジェクト (dj_txt / dj_cp_v2 / test3_v2) で全レイヤー不可視 +
    // readPixels 全ゼロという退行が出たため除去。silhouette/blur 各 pass は
    // 内部で setRenderTarget(prev) で復帰しており、効かないカット (キャラ無し)
    // でこの行が不要、効くカットでも内部復帰で十分。
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose();
        // material.map (Texture) は texture-cache 側の参照カウントに任せる。
        if (obj.material) {
          obj.material.map = null;
          obj.material.dispose();
        }
      }
    });
    // エフェクト用の RT / blur ヘルパを個別 dispose (silhouette scene は外部参照されない)。
    for (const charInstance of meshes.characters) {
      const eff = charInstance.effects;
      if (eff) {
        eff.silhouette?.dispose();
        eff.blurGlow?.dispose();
        eff.blurShadow?.dispose();
      }
    }
    // 背景 cover / blur 用 RT も解放。cover は v2 direct-texture + blur のときだけ
    // 生成される (それ以外は texture.repeat/offset で済ませる)。
    meshes.bg?.bgCover?.dispose();
    meshes.bg?.bgBlur?.dispose();
    // VideoProvider (videoTrack 経路) を dispose。Texture (VideoTexture や
    // WebCodecs 経由のテクスチャ) は provider 内で解放される。
    meshes.bg?.videoProvider?.dispose?.();
    // 動画レイヤーの provider は scene-builder では解放しない。
    // 理由: export で scene 単位の providers Map を caller (export-session) が
    // 持ち、cut 切替で setActiveScene が旧 scene を dispose するたびに
    // ここで provider まで閉じてしまうと、次 cut の build で「同じ src の素材を
    // 描画したいのに provider が closed」状態になり、シーン跨ぎで videoLayer が
    // 消える。preview の VideoTextureProvider についても caller (playback.js)
    // 側で前回 providers を dispose してから new する形に統一済み。
    // ここで触らないことで lifecycle を caller 専管に揃える。
    // dialogue v2 経路の CanvasTexture も texture-cache 経由ではないので
    // dialogue / telop の CanvasTexture を個別に dispose (texture-cache 管理外)。
    meshes.dialogue?.canvasTexture?.dispose();
    meshes.dialogue?.boxFill?.canvasTexture?.dispose();
    meshes.dialogue?.boxBorder?.canvasTexture?.dispose();
    // Phase 3: layer 別 plane を全部 dispose する。
    if (meshes.telops?.layers) {
      for (const layer of meshes.telops.layers) {
        try { layer.canvasTexture?.dispose?.(); } catch (_) {}
        try { disposeTelopState(layer.state); } catch (_) {}
      }
    }
    // ビジュアライザ: GL plugin を dispose。disposed フラグを先に立てて
    // in-flight な update が走らないようガード。
    if (meshes.visualizer) {
      meshes.visualizer.disposed = true;
      try { meshes.visualizer.glLayer?.dispose?.(); } catch (err) {
        console.warn("[visualizer] GL plugin dispose threw:", err);
      }
    }
    // ロード時に collect した URL をすべて release。
    for (const url of urls) {
      releaseTexture(url);
    }
  }

  // token は scene-bundle が返した payload SHA1 (state hash)。playLiveCutV2 が
  // 「同じ token = 同じ state」のときに dispose+build を skip して既存 scene を
  // 流用するために露出しておく。
  const token = layerData?.token || null;

  // meshes は本番フローでは外から触らないが、PoC ベンチが visualizer 内部状態へ
  // 介入できるようにここで露出する (v2-export-bench: preloadVisualizerImages)。
  return { scene, update, dispose, token, meshes };
}

// =============================================================================
// gap scene (multi-cut export 用): カット未配置の区間 (post-roll telop / カット間
// gap) を描くための最小 scene。
//
// v1 (`app/export_video.py:_gap_frame_canvas_arr`) と同じ構成を WebGL で再現:
//   - 背景: scene.background の画像 (cover-fit) または透過 (alpha=0 クリア)
//   - active telop: sceneSec で active な scene-level telops を上から
//   - character / fg / dialogue / visualizer は描かない
//
// 通常の SceneInstance とは独立した別 scene として持ち、export ループ側で
// 「gap frame は gapInstance を render、cut frame は activeSceneInstance を render」
// と切替える。bg texture は `cover.js` で 1 回焼いて使い回す (毎フレーム再 cover
// しない)。telops plane は CanvasTexture で sceneSec が変わるたびに refresh。
//
// 引数:
//   sceneBackground: { type: "image", url } | null  (= 透過)
//   sceneTelops:     telop オブジェクトの配列 (= scene-bundle が返す scene 全テロップ)
//   renderer:        THREE.WebGLRenderer (cover RT 用)
// =============================================================================
export async function buildGapScene({
  sceneBackground,
  sceneTelops,
  renderer,
  // 動画レイヤー (videoLayers) も gap 区間で再生される可能性がある。
  // - sceneVideoLayers: scene.videoLayers の配列 (正規化済)
  // - videoLayerProvidersById: 各 layer.id → VideoProvider (texture 供給)
  // - videoLayerDurations: Map<src, { duration, width, height, hasAudio }>
  // - fps: project fps
  sceneVideoLayers = null,
  videoLayerProvidersById = null,
  videoLayerDurations = null,
  fps = 24,
}) {
  const scene = new THREE.Scene();
  const urls = [];
  let bgMesh = null;
  let bgCover = null;
  let bgTexture = null;

  // 背景画像があれば cover で 1920x1080 に焼いて表示。なければ scene には何も
  // 載せず、render 直前の renderer.setClearColor((0,0,0), 0) で透明にする。
  if (sceneBackground?.url) {
    urls.push(sceneBackground.url);
    bgTexture = await loadTexture(sceneBackground.url);
    if (bgTexture && renderer) {
      const img = bgTexture.image;
      const srcW = (img && (img.naturalWidth || img.width)) || 0;
      const srcH = (img && (img.naturalHeight || img.height)) || 0;
      if (srcW > 0 && srcH > 0) {
        bgCover = createCoverPass(CANVAS_WIDTH, CANVAS_HEIGHT);
        const coveredTex = bgCover.apply(renderer, bgTexture, srcW, srcH);
        bgMesh = makePlane(CANVAS_WIDTH, CANVAS_HEIGHT, coveredTex, ORDER_BG, 0, 0);
        scene.add(bgMesh);
      }
    }
  }

  // telops plane: 通常 scene と同じ ORDER_TELOP。CanvasTexture は最初空で、
  // update(sceneSec) が来たら refreshTelopCanvas で active set を再描画する。
  const { canvas: telopCanvas, texture: telopTexture } = createTelopCanvasTexture();
  const telopMesh = makePlane(CANVAS_WIDTH, CANVAS_HEIGHT, telopTexture, ORDER_TELOP, 0, 0);
  scene.add(telopMesh);
  const telopState = { lastFingerprint: null };
  const telops = Array.isArray(sceneTelops) ? sceneTelops : [];

  // 動画レイヤー (gap 区間でも再生する)。通常 scene と同じ ORDER スロットに plane を追加。
  const vlEntries = [];
  if (Array.isArray(sceneVideoLayers) && videoLayerProvidersById) {
    for (const layer of sceneVideoLayers) {
      if (!layer?.id || !layer?.src) continue;
      const provider = videoLayerProvidersById.get(layer.id);
      if (!provider) continue;
      const texture = provider.getTexture?.();
      if (!texture) continue;
      const meta = videoLayerDurations?.get?.(layer.src) || null;
      const srcW = (meta?.width || 0) > 0
        ? meta.width
        : (texture.image?.videoWidth || texture.image?.naturalWidth || 1920);
      const srcH = (meta?.height || 0) > 0
        ? meta.height
        : (texture.image?.videoHeight || texture.image?.naturalHeight || 1080);
      const fitResult = computeVideoFit(
        srcW, srcH, layer.fit, layer.scale, layer.offsetX, layer.offsetY,
      );
      try {
        texture.offset.set(fitResult.uvOffsetX, fitResult.uvOffsetY);
        texture.repeat.set(fitResult.uvScaleX, fitResult.uvScaleY);
        texture.needsUpdate = true;
      } catch (_) {}
      const renderOrder = layer.layer === "above_bg"
        ? ORDER_VIDEO_LAYER_ABOVE_BG
        : ORDER_VIDEO_LAYER_ABOVE_FG;
      const mesh = makePlane(
        Math.max(1, fitResult.planeW),
        Math.max(1, fitResult.planeH),
        texture,
        renderOrder,
        fitResult.planeX,
        fitResult.planeY,
      );
      mesh.visible = false;
      scene.add(mesh);
      // durationSec は固定で持たず、毎フレーム videoLayerDurations から参照する。
      vlEntries.push({ mesh, layer });
    }
  }

  let disposed = false;

  function update({ sceneSec = 0, characterAnimationFps = 12 } = {}) {
    if (disposed) return;
    const visible = refreshTelopCanvas(
      telopCanvas, telopTexture, telops, sceneSec, telopState,
      { characterAnimationFps },
    );
    if (telopMesh.visible !== visible) telopMesh.visible = visible;
    // 動画レイヤー: 同じ sceneSec で active 判定。
    // duration は Map から毎フレーム参照する (build 時に未解決でも fetch 完了で
    // 自動的に visible に切り替わる)。fade in/out の alpha も計算して
    // material.opacity に反映する。
    for (const entry of vlEntries) {
      const dur = Number(videoLayerDurations?.get?.(entry.layer?.src)?.duration) || 0;
      if (dur <= 0) {
        if (entry.mesh.visible) entry.mesh.visible = false;
        continue;
      }
      const result = mapVideoLayerSec(entry.layer, sceneSec, fps, dur);
      const alpha = _computeVideoLayerAlpha(entry.layer, result);
      const shouldBe = result.state === "active" && alpha > 0;
      if (entry.mesh.visible !== shouldBe) entry.mesh.visible = shouldBe;
      if (shouldBe && entry.mesh.material) {
        entry.mesh.material.opacity = alpha;
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { telopTexture.dispose(); } catch (_) {}
    try { disposeTelopState(telopState); } catch (_) {}
    if (bgMesh) {
      try { bgMesh.material?.dispose?.(); } catch (_) {}
      try { bgMesh.geometry?.dispose?.(); } catch (_) {}
    }
    if (bgCover?.dispose) {
      try { bgCover.dispose(); } catch (_) {}
    }
    // videoLayer plane の geometry/material は scene.traverse で個別解放しない
    // (texture は provider 側で持つ) → 明示的に dispose する。
    for (const entry of vlEntries) {
      try { entry.mesh.material?.dispose?.(); } catch (_) {}
      try { entry.mesh.geometry?.dispose?.(); } catch (_) {}
    }
    for (const url of urls) {
      try { releaseTexture(url); } catch (_) {}
    }
  }

  return {
    scene,
    update,
    dispose,
    // 透過判定: bg が無いなら gap render 直前に renderer.setClearColor((0,0,0), 0)
    // で背景を透明にする (preview には影響させない)。
    isTransparent: !bgMesh,
  };
}


// PoC ベンチ互換: 旧 PNG 連番 visualizer の事前 fetch helper。GL 経路では
// 何もしない (no-op)。
export async function preloadVisualizerImages(_sceneInstance) {
  return 0;
}

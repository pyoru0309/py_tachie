// =============================================================================
// renderer/transition-composite.js
//
// フルライブ・境界またぎトランジションの dual-RT 合成。
//
// カット境界をまたぐ窓 [境界-D/2, 境界+D/2] の間、前カット (from) と現カット (to)
// の **両シーンをそれぞれ RenderTarget に毎フレーム描画** し (= 口パク/目パチ/
// モーション/BPM 揺れが両方動き続ける)、progress (0→1) に応じて合成シェーダで
// 混ぜて canvas へ出力する。
//
// 既存の「カット内オーバーレイ」(scene-builder の meshes.transition) は先頭カット
// (前カット無し) のホワイトイン/ブラックインだけに残し、2 カット間のトランジション
// はこの合成経路を使う。
//
// 向きは scene-builder の overlay と同一: PlaneGeometry(W,H) を main camera で描画。
// vUv.y=0=画面上 / vUv.x=0=画面左。RT texel は v=0=画面下なので uv.y を反転して
// サンプルする (overlay の uFlipY=1 と等価)。色空間も overlay と同じく RT.texture を
// SRGB 扱い + #include <colorspace_fragment> で linear→sRGB 変換する。
// =============================================================================
import * as THREE from "three";
import { getRenderer, renderScene, CANVAS_WIDTH, CANVAS_HEIGHT } from "./core.js";

const COMPOSITE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uTexA;   // from (退場する前カット)
  uniform sampler2D uTexB;   // to   (登場する現カット)
  uniform float uProgress;   // 0..1 (境界またぎ全体の進捗)
  uniform int uMode;         // 0 cross / 1 wipe / 2 zoom / 3 white / 4 black
  uniform float uWipeAxis;   // 0 horiz(x) / 1 vert(y)
  uniform float uWipeInvert; // 0: coord<p で reveal / 1: coord>1-p で reveal
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float p = uProgress;
    // RT は v=0=画面下 → 上下反転してサンプル (overlay uFlipY=1 と同じ)。
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    vec4 outc;
    if (uMode == 1) {
      // ワイプ: B が A の上を coord 方向にリビールしていく。
      float coord = (uWipeAxis < 0.5) ? vUv.x : vUv.y;
      bool revealed = (uWipeInvert < 0.5) ? (coord < p) : (coord > 1.0 - p);
      outc = revealed ? vec4(texture2D(uTexB, uv).rgb, 1.0)
                      : vec4(texture2D(uTexA, uv).rgb, 1.0);
    } else if (uMode == 3 || uMode == 4) {
      // ホワイト/ブラック: 前半 A→単色、後半 単色→B の 2 段階。
      if (p < 0.5) {
        float k = p / 0.5;
        outc = vec4(mix(texture2D(uTexA, uv).rgb, uColor, k), 1.0);
      } else {
        float k = (p - 0.5) / 0.5;
        outc = vec4(mix(uColor, texture2D(uTexB, uv).rgb, k), 1.0);
      }
    } else {
      // クロスフェード / クロスズーム: 両カットをクロスディゾルブ。
      vec2 uvA = uv;
      vec2 uvB = uv;
      if (uMode == 2) {
        float zA = 1.0 + p * 0.3;         // A は離脱しながら拡大
        float zB = 1.0 + (1.0 - p) * 0.3; // B は拡大状態から等倍へ settle
        uvA = (uv - 0.5) / zA + 0.5;
        uvB = (uv - 0.5) / zB + 0.5;
      }
      vec3 a = texture2D(uTexA, uvA).rgb;
      vec3 b = texture2D(uTexB, uvB).rgb;
      outc = vec4(mix(a, b, p), 1.0);
    }
    gl_FragColor = outc;
    #include <colorspace_fragment>
  }
`;

const _MODE = { crossfade: 0, wipe: 1, crosszoom: 2, whiteout: 3, blackout: 4 };

let _rtA = null;
let _rtB = null;
let _scene = null;
let _camera = null;
let _mesh = null;
let _mat = null;

function _makeRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  return rt;
}

function _ensure() {
  const w = CANVAS_WIDTH;
  const h = CANVAS_HEIGHT;
  if (!_rtA) _rtA = _makeRT(w, h);
  if (!_rtB) _rtB = _makeRT(w, h);
  if (!_scene) {
    _mat = new THREE.ShaderMaterial({
      uniforms: {
        uTexA: { value: null },
        uTexB: { value: null },
        uProgress: { value: 0 },
        uMode: { value: 0 },
        uWipeAxis: { value: 0 },
        uWipeInvert: { value: 0 },
        uColor: { value: new THREE.Color(0x000000) },
      },
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    const geo = new THREE.PlaneGeometry(w, h);
    _mesh = new THREE.Mesh(geo, _mat);
    _mesh.position.set(w / 2, h / 2, 0);
    _mesh.frustumCulled = false;
    _scene = new THREE.Scene();
    _scene.add(_mesh);
    // overlay と同じ Y-down ortho カメラ。
    _camera = new THREE.OrthographicCamera(0, w, 0, h, -1000, 1000);
    _camera.position.set(0, 0, 10);
    _camera.updateProjectionMatrix();
  }
}

// SceneInstance を 1 つ RenderTarget へ描画する。inst の自前トランジション
// overlay は焼き込まない (= dual-RT 合成側で混ぜるため)。
function _renderInstToRT(renderer, rt, inst, state) {
  if (!inst) return false;
  if (typeof inst.update === "function") {
    try { inst.update(state || {}); } catch (_) { /* ignore */ }
  }
  const tmesh = inst.meshes && inst.meshes.transition;
  const wasVisible = tmesh ? tmesh.visible : false;
  if (tmesh) tmesh.visible = false;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderScene(inst.scene);
  if (tmesh) tmesh.visible = wasVisible;
  return true;
}

// 2 カットを合成して canvas へ描画する。
//   fromInst/fromState: 退場する前カット (A)。null 可 (= uColor で代替)。
//   toInst/toState:     登場する現カット (B)。toTex 指定時は無視。
//   toTex:              B を毎フレーム描画する代わりに使う静的テクスチャ。
//                       (A 側 = 前カット尾で「次カットの先頭フレーム」を出す用途。
//                        B は境界前にまだ始まっていないので先頭フレーム静止が正)。
//   cfg:   { type, durationFrame, wipeDirection }
//   progress: 0..1 (境界またぎ窓全体の進捗)
// 戻り値: 実際に合成描画したら true。
export function renderTransitionComposite({ fromInst, fromState, toInst, toState, toTex, cfg, progress }) {
  const renderer = getRenderer();
  if (!renderer || (!toInst && !toTex)) return false;
  const type = cfg && cfg.type ? String(cfg.type) : "none";
  if (!(type in _MODE)) return false;
  _ensure();
  const prevTarget = renderer.getRenderTarget();

  // from (A) を RT へ。無ければ uColor / もしくは B のみ。
  const hasFrom = _renderInstToRT(renderer, _rtA, fromInst, fromState);
  if (!toTex) _renderInstToRT(renderer, _rtB, toInst, toState);

  renderer.setRenderTarget(prevTarget); // 通常は null (canvas)
  const u = _mat.uniforms;
  u.uMode.value = _MODE[type];
  u.uProgress.value = Math.max(0, Math.min(1, Number(progress) || 0));
  const toTexture = toTex || _rtB.texture;
  u.uTexA.value = hasFrom ? _rtA.texture : toTexture; // from 無しは B で代替
  u.uTexB.value = toTexture;
  u.uColor.value.setHex(type === "whiteout" ? 0xffffff : 0x000000);
  if (type === "wipe") {
    const dir = (cfg && cfg.wipeDirection) || "right";
    u.uWipeAxis.value = (dir === "up" || dir === "down") ? 1 : 0;
    u.uWipeInvert.value = (dir === "left" || dir === "up") ? 1 : 0;
  }
  renderScene2(_scene, _camera);
  return true;
}

// core.renderScene は main camera 固定なので、合成専用カメラで描く版を持つ。
function renderScene2(scene, camera) {
  const renderer = getRenderer();
  if (!renderer || !scene || !camera) return;
  renderer.render(scene, camera);
}

export function disposeTransitionComposite() {
  if (_rtA) { _rtA.dispose(); _rtA = null; }
  if (_rtB) { _rtB.dispose(); _rtB = null; }
  if (_mesh) { _mesh.geometry.dispose(); _mesh = null; }
  if (_mat) { _mat.dispose(); _mat = null; }
  _scene = null;
  _camera = null;
}

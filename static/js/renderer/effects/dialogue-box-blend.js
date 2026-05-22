// =============================================================================
// renderer/effects/dialogue-box-blend.js
//
// セリフ枠 (背景 fill / ボーダー) の ShaderMaterial。
//
// 入力テクスチャ (canvas) は次の前提で焼かれている:
//   - 内側 (枠の塗り or ボーダーリング) は純色 (alpha=1.0)
//   - 外側は完全透明 (alpha=0.0)
//   - エッジは anti-alias で alpha が補間される (0..1)
//
// 2 つの合成モード:
//
// (A) 不透明背景時 (デフォルト): 「明るい色 → screen / 暗い色 → multiply」
//
//   ▼ multiply モード (暗い色用)
//     srcColor = mix(vec3(1.0), texture.rgb, effA)
//     blend = src * dst             (multiply)
//     gl_blend = blendSrc=ZeroFactor, blendDst=SrcColorFactor
//     → effA=0 で srcColor=white → dst を変更しない (no-op)
//     → effA=1, texture=black の領域では dst を 0 に塗る
//
//   ▼ screen モード (明るい色用)
//     srcColor = texture.rgb * effA
//     blend = src + dst * (1 - src) (screen)
//     gl_blend = blendSrc=OneFactor, blendDst=OneMinusSrcColorFactor
//     → effA=0 で srcColor=black → dst を変更しない (no-op)
//     → effA=1, texture=white の領域では dst を白で飽和させる
//
//   dst の alpha は触らない (= 既存 framebuffer の alpha を維持):
//     blendSrcAlpha=ZeroFactor, blendDstAlpha=OneFactor
//
// (B) 透明背景時 (transparentBackground=true): 通常 premultiplied alpha 合成
//
//   screen / multiply は「下の色を変化させる」モードで、下に何もないピクセルでは
//   意味が崩れる (dst.a=0 のまま src.a を書き込まない → 「キャラクタ画像の上に
//   しかセリフ枠が乗らない」バグになる)。透明書き出し用に通常 alpha 合成に倒す。
//
//     srcColor = texture.rgb * effA   (premultiplied)
//     srcAlpha = effA
//     blending = NormalBlending + premultipliedAlpha:true
//
//   不透明背景時の screen/multiply のニュアンスは失われるが、下に何もない時点で
//   その「下の色を変える」効果自体が意味を持たないので、見た目の損失は無い。
//
// uOpacity=0 のときは effA=0 → どちらのモードでも no-op (= 「濃さ 0 で透明」)。
// =============================================================================
import * as THREE from "three";

const VERT_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// uMode: 0 = multiply, 1 = screen, 2 = normal-premultiplied (透明背景用)
const FRAG_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform float uOpacity;
  uniform int uMode;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float effA = t.a * uOpacity;
    if (uMode == 2) {
      // 透明背景: premultiplied alpha で素直に乗せる。
      gl_FragColor = vec4(t.rgb * effA, effA);
    } else if (uMode == 1) {
      // screen: srcColor = boxColor * effA。effA=0 で black → no-op。
      gl_FragColor = vec4(t.rgb * effA, 1.0);
    } else {
      // multiply: srcColor = mix(white, boxColor, effA)。effA=0 で white → no-op。
      gl_FragColor = vec4(mix(vec3(1.0), t.rgb, effA), 1.0);
    }
    #include <colorspace_fragment>
  }
`;

export function createDialogueBoxBlendMaterial(texture, mode, opacity, options = {}) {
  const transparentBackground = !!options.transparentBackground;
  const isScreen = !transparentBackground && mode === "screen";
  const uMode = transparentBackground ? 2 : (isScreen ? 1 : 0);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uOpacity: { value: Math.max(0, Math.min(1, Number(opacity) || 0)) },
      uMode: { value: uMode },
    },
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    ...(transparentBackground
      ? {
          // 透明背景: 通常 alpha 合成 (premultiplied)。dst.a も更新する。
          blending: THREE.NormalBlending,
          premultipliedAlpha: true,
        }
      : {
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: isScreen ? THREE.OneFactor : THREE.ZeroFactor,
          blendDst: isScreen ? THREE.OneMinusSrcColorFactor : THREE.SrcColorFactor,
          blendEquationAlpha: THREE.AddEquation,
          // dst.a を保つ: src.a を捨て、dst.a をそのまま残す。
          blendSrcAlpha: THREE.ZeroFactor,
          blendDstAlpha: THREE.OneFactor,
        }),
  });
  return material;
}

// =============================================================================
// renderer/effects/character-material.js
//
// キャラ素材 (under/eye/mouth/over) 用の ShaderMaterial。
// 色フィルタ (cut.state.characterEffects.colorFilter) を uniform で適用する。
//
// 数式は v1 (compositor._apply_color_filter_inplace_ndarray) と一致:
//   filter_color = colorFilter.color (HEX → 0..1 vec3)
//   opacity      = colorFilter.opacity (0..1)
//   final_rgb    = src_rgb * (1 - opacity + opacity * filter_color)
// アルファは変更しない。
//
// 色フィルタが無効 (enabled=false / opacity<=0) のときは uOpacity=0 で
// no-op となる (= MeshBasicMaterial と同じ表示)。
// =============================================================================
import * as THREE from "three";

const VERT_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// three.js は texture.colorSpace = SRGB のテクスチャを GL の sRGB 内部形式で
// アップロードしており、`texture2D` は GPU 側でハードウェア自動デコードされ
// 「線形 (linear-sRGB)」値を返す。custom ShaderMaterial の fragment 末尾で
// `#include <colorspace_fragment>` を通さないと、その線形値がそのまま fb に
// 書かれ、display が sRGB エンコード前提で解釈するため全体が暗くなる
// (LinearTosRGB 変換抜けと同義)。three.js 公式 docs の Color Management
// 推奨パスに従う。
//
// uFilterColor は THREE.Color uniform 経由で渡される。three.js は
// THREE.Color をカラーマネジメント込みで処理し、シェーダには linear-sRGB
// 値を送るので、c.rgb (linear) と同じ空間で乗算が成立する。
// 旧実装は Vector3 で sRGB スケール値を送っていたため、linear * sRGB の
// 混合空間演算となり、色フィルタ効果がほぼ消える状態だった。
const FRAG_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform vec3 uFilterColor;   // linear-sRGB (THREE.Color uniform 経由)
  uniform float uFilterOpacity; // 0..1
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    vec3 mixed = mix(vec3(1.0), uFilterColor, uFilterOpacity);
    gl_FragColor = vec4(c.rgb * mixed, c.a);
    #include <colorspace_fragment>
  }
`;

export function createCharacterMaterial(texture, colorFilter) {
  const enabled = !!(colorFilter && colorFilter.enabled);
  const opacity = enabled ? Math.max(0, Math.min(1, Number(colorFilter.opacity) || 0)) : 0;
  // THREE.Color('#xxxxxx') は内部で sRGB → linear-sRGB working space に変換し、
  // uniform 出力時もそのまま linear 値を送る。
  const filterColor = new THREE.Color(colorFilter?.color || "#ffffff");
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uFilterColor: { value: filterColor },
      uFilterOpacity: { value: opacity },
    },
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    // メインシーンの Y-down カメラ (projectionMatrix の Y スケール負) で
    // winding が反転して裏面カリングされる現象を回避するため両面描画。
    // 詳細は scene-builder.js makeMaterial のコメント参照。
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
}

// 色フィルタの動的更新は Phase B-2 段階では不要 (cut 切替で SceneInstance を作り直す)。
// 必要になったら uniform を書き換える (THREE.Color の自動 sRGB→linear 変換を
// 効かせるため、`set('#xxxxxx')` を使うこと。Vector3 の `set(r,g,b)` だと
// 0..1 の sRGB 値を linear と誤って扱ってしまう):
//
//   material.uniforms.uFilterColor.value.set("#c2e6ff");
//   material.uniforms.uFilterOpacity.value = opacity;

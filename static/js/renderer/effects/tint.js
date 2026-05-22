// =============================================================================
// renderer/effects/tint.js
//
// 「alpha texture を任意色 + 不透明度で塗る」用の ShaderMaterial と Mesh。
// 光彩 / ドロップシャドウの最終合成段で使う。
//
// fragment は a = sampled.a; gl_FragColor = vec4(color, a * opacity)。
// straight alpha を出力するので transparent: true + 標準 NormalBlending
// (SrcAlpha + OneMinusSrcAlpha) と整合する。
// =============================================================================
import * as THREE from "three";

const VERT_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 出力は straight alpha (rgb は uColor のまま、alpha だけ silhouette α × opacity)。
// three.js の標準 NormalBlending (SrcAlpha + OneMinusSrcAlpha) は straight alpha
// 入力前提で正しく動くので、これで合成式が一致する。
// 末尾の colorspace_fragment は character-material と同様の理由で必須:
// uColor は THREE.Color uniform 経由で linear 値が渡るため、linear のままで
// fb に書くと display が sRGB として誤解釈して暗くなる。
const FRAG_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float a = texture2D(uMap, vUv).a;
    gl_FragColor = vec4(uColor, a * uOpacity);
    #include <colorspace_fragment>
  }
`;

export function createTintMaterial(initialColor = "#ffffff") {
  const color = new THREE.Color(initialColor);
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null },
      uColor: { value: color },
      uOpacity: { value: 0 },
    },
    vertexShader: VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // 標準の SrcAlpha + OneMinusSrcAlpha で十分 (アウトプットは straight alpha)。
    // tint plane はメインシーンの Y-down カメラ配下なので、scene-builder.js
    // makeMaterial と同じ理由で DoubleSide を必須とする。
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
}

export function createTintPlane(width, height) {
  const material = createTintMaterial();
  const geometry = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

export function setTint(material, { texture, color, opacity }) {
  if (texture !== undefined) material.uniforms.uMap.value = texture;
  if (color !== undefined) material.uniforms.uColor.value.set(color);
  if (opacity !== undefined) material.uniforms.uOpacity.value = opacity;
}

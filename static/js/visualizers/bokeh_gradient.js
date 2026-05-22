// =============================================================================
// visualizers/bokeh_gradient.js
//
// 2 色のグラデーション背景の上に、ぼけた円がゆっくり漂う。音には反応しない。
//
// 描画は 1920x1080 を覆う 1 枚の plane + ShaderMaterial で完結 (1 draw call)。
// CPU は毎フレーム最大 MAX_CIRCLES 個の (x, y, radius, alpha) を vec4 uniform 配列に
// 詰めるだけ。位置と不透明度はシーン秒の closed-form sin/cos で決まるため、
// シーク・書き出し・ライブプレビューのいずれでも同じフレームを再現する。
// =============================================================================
import {
  clamp01,
  numParam,
} from "/static/js/visualizers/_kit.js";

const MAX_CIRCLES = 32;
const TAU = Math.PI * 2;

function normalizeParams(rawParams) {
  const p = rawParams || {};
  const minRadius = Math.max(1, numParam(p.minRadius, 80));
  const maxRadius = Math.max(minRadius, numParam(p.maxRadius, 240));
  let minAlpha = clamp01(numParam(p.minAlpha, 0.2));
  let maxAlpha = clamp01(numParam(p.maxAlpha, 0.5));
  if (maxAlpha < minAlpha) maxAlpha = minAlpha;
  const starMinRadius = Math.max(0.1, numParam(p.starMinRadius, 1.5));
  const starMaxRadius = Math.max(starMinRadius, numParam(p.starMaxRadius, 4));
  let starMinAlpha = clamp01(numParam(p.starMinAlpha, 0.25));
  let starMaxAlpha = clamp01(numParam(p.starMaxAlpha, 0.75));
  if (starMaxAlpha < starMinAlpha) starMaxAlpha = starMinAlpha;
  return {
    colorA: String(p.colorA || "#5bd5ff"),
    colorB: String(p.colorB || "#ff5bd5"),
    gradientAngle: numParam(p.gradientAngle, 45),
    circleColor: String(p.circleColor || "#ffffff"),
    circleCount: Math.max(1, Math.min(MAX_CIRCLES, Math.round(numParam(p.circleCount, 7)))),
    minRadius,
    maxRadius,
    driftRadius: Math.max(0, numParam(p.driftRadius, 280)),
    driftSpeed: Math.max(0, numParam(p.driftSpeed, 0.18)),
    minAlpha,
    maxAlpha,
    alphaSpeed: Math.max(0, numParam(p.alphaSpeed, 0.4)),
    ringPos: Math.max(0.05, Math.min(0.98, numParam(p.ringPos, 0.82))),
    coreAlpha: clamp01(numParam(p.coreAlpha, 0.5)),
    seed: Math.max(0, Math.round(numParam(p.seed, 17))),
    starColor: String(p.starColor || "#ffffff"),
    starCount: Math.max(0, Math.min(400, Math.round(numParam(p.starCount, 80)))),
    starMinRadius,
    starMaxRadius,
    starMinAlpha,
    starMaxAlpha,
    starTwinkleSpeed: Math.max(0, numParam(p.starTwinkleSpeed, 1.0)),
    starDrift: Math.max(0, numParam(p.starDrift, 6)),
    starSeed: Math.max(0, Math.round(numParam(p.starSeed, 31))),
    opacity: clamp01(numParam(p.opacity, 1.0)),
  };
}

// 32-bit LCG。seed が同じなら円の初期配置・運動は再現される。
function lcg(seed) {
  let s = (Number(seed) | 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) / 0xffffffff);
  };
}

function buildCircles(p, width, height) {
  const rand = lcg(p.seed);
  const list = [];
  for (let i = 0; i < p.circleCount; i++) {
    const hx = rand() * width;
    const hy = rand() * height;
    const radius = p.minRadius + rand() * (p.maxRadius - p.minRadius);
    const baseAlpha = p.minAlpha + rand() * (p.maxAlpha - p.minAlpha);
    list.push({
      hx,
      hy,
      radius,
      drx: p.driftRadius * (0.5 + rand() * 0.7),
      dry: p.driftRadius * (0.4 + rand() * 0.8),
      afx: p.driftSpeed * (0.6 + rand() * 0.9),
      afy: p.driftSpeed * (0.5 + rand() * 1.0),
      pfx: rand() * TAU,
      pfy: rand() * TAU,
      baseAlpha,
      alphaAmp: (p.maxAlpha - p.minAlpha) * 0.5,
      alphaFreq: p.alphaSpeed * (0.5 + rand() * 1.5),
      alphaPhase: rand() * TAU,
    });
  }
  return list;
}

function buildStars(p, width, height) {
  const rand = lcg(p.starSeed);
  const list = [];
  for (let i = 0; i < p.starCount; i++) {
    const hx = rand() * width;
    const hy = rand() * height;
    const radius = p.starMinRadius + rand() * (p.starMaxRadius - p.starMinRadius);
    const baseAlpha = p.starMinAlpha + rand() * (p.starMaxAlpha - p.starMinAlpha);
    list.push({
      hx,
      hy,
      radius,
      drx: p.starDrift * (0.4 + rand() * 0.8),
      dry: p.starDrift * (0.3 + rand() * 0.9),
      afx: 0.25 + rand() * 0.5,
      afy: 0.2 + rand() * 0.5,
      pfx: rand() * TAU,
      pfy: rand() * TAU,
      baseAlpha,
      alphaAmp: (p.starMaxAlpha - p.starMinAlpha) * 0.5,
      alphaFreq: p.starTwinkleSpeed * (0.4 + rand() * 1.6),
      alphaPhase: rand() * TAU,
    });
  }
  return list;
}

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, cutStartSec } = ctx;
  // params は createVisualizerLayer 時点で snapshot で十分 (UI 変更時はシーン
  // ごと rebuild される)。bar_spectrum と同じ規約。
  const p = normalizeParams(params);
  const circles = buildCircles(p, width, height);
  const stars = buildStars(p, width, height);

  // 32 個の vec4 (x, y, radius, alpha) を毎フレーム更新する。
  const circleData = new Array(MAX_CIRCLES);
  for (let i = 0; i < MAX_CIRCLES; i++) circleData[i] = new THREE.Vector4(0, 0, 0, 0);

  const colorA = new THREE.Color(p.colorA);
  const colorB = new THREE.Color(p.colorB);
  const circleColor = new THREE.Color(p.circleColor);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uColorA: { value: new THREE.Vector3(colorA.r, colorA.g, colorA.b) },
      uColorB: { value: new THREE.Vector3(colorB.r, colorB.g, colorB.b) },
      uCircleColor: { value: new THREE.Vector3(circleColor.r, circleColor.g, circleColor.b) },
      uGradientAngle: { value: (p.gradientAngle * Math.PI) / 180 },
      uCircles: { value: circleData },
      uCircleCount: { value: p.circleCount },
      uRingPos: { value: p.ringPos },
      uCoreAlpha: { value: p.coreAlpha },
      uOpacity: { value: p.opacity },
      uResolution: { value: new THREE.Vector2(width, height) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      #define MAX_CIRCLES ${MAX_CIRCLES}
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform vec3 uCircleColor;
      uniform float uGradientAngle;
      uniform vec4 uCircles[MAX_CIRCLES];
      uniform int uCircleCount;
      uniform float uRingPos;
      uniform float uCoreAlpha;
      uniform float uOpacity;
      uniform vec2 uResolution;
      varying vec2 vUv;

      // bokeh プロファイル: r=0 で coreAlpha, r=ringPos でピーク 1.0, r>=1 で 0。
      float bokehShape(float r) {
        if (r >= 1.0) return 0.0;
        float up = mix(uCoreAlpha, 1.0, smoothstep(0.0, uRingPos, r));
        float down = 1.0 - smoothstep(uRingPos, 1.0, r);
        return r < uRingPos ? up : down;
      }

      void main() {
        // CSS linear-gradient と同じ向き: 0°=左→右, 45°=左下→右上 (vUv.y は y-down)
        vec2 dir = vec2(cos(uGradientAngle), -sin(uGradientAngle));
        float t = clamp(dot(vUv - 0.5, dir) + 0.5, 0.0, 1.0);
        vec3 col = mix(uColorA, uColorB, t);

        vec2 pixel = vUv * uResolution;
        for (int i = 0; i < MAX_CIRCLES; i++) {
          if (i >= uCircleCount) break;
          vec4 c = uCircles[i];
          float r = length(pixel - c.xy) / max(c.z, 1.0);
          float a = c.w * bokehShape(r);
          col = mix(col, uCircleColor, a);
        }

        gl_FragColor = vec4(col, uOpacity);
      }
    `,
  });

  const geom = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(width / 2, height / 2, 0);
  mesh.frustumCulled = false;

  // ------------------------------------------------------------------
  // 星粒 (スターダスト) レイヤー: InstancedMesh + per-instance alpha 属性
  // ------------------------------------------------------------------
  const starGeom = new THREE.PlaneGeometry(1, 1);
  const starAlphaArr = new Float32Array(Math.max(1, p.starCount));
  const starAlphaAttr = new THREE.InstancedBufferAttribute(starAlphaArr, 1);
  starAlphaAttr.setUsage(THREE.DynamicDrawUsage);
  starGeom.setAttribute("aInstAlpha", starAlphaAttr);

  const starColor = new THREE.Color(p.starColor);
  const starMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uStarColor: { value: new THREE.Vector3(starColor.r, starColor.g, starColor.b) },
      uOpacity: { value: p.opacity },
    },
    vertexShader: `
      attribute float aInstAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vAlpha = aInstAlpha;
        vec4 transformed = vec4(position, 1.0);
        #ifdef USE_INSTANCING
        transformed = instanceMatrix * transformed;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * transformed;
      }
    `,
    fragmentShader: `
      uniform vec3 uStarColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec2 uv2 = vUv * 2.0 - 1.0;
        float r = length(uv2);
        if (r >= 1.0) discard;
        // 中心は不透明、外周に向かってわずかにソフトに落ちる小さな円。
        float disk = 1.0 - smoothstep(0.7, 1.0, r);
        float a = disk * vAlpha * uOpacity;
        gl_FragColor = vec4(uStarColor, a);
      }
    `,
  });

  // starCount=0 のときも InstancedMesh は最低 1 つ作って alpha=0 で隠す方が単純。
  const starMesh = new THREE.InstancedMesh(starGeom, starMat, Math.max(1, p.starCount));
  starMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  starMesh.frustumCulled = false;
  starMesh.count = p.starCount;

  const _starMatrix = new THREE.Matrix4();
  const _starPos = new THREE.Vector3();
  const _starQuat = new THREE.Quaternion();
  const _starScale = new THREE.Vector3();

  // THREE.Group ではなく Object3D でラップ (bar_spectrum と同じ groupOrder 対策)。
  const root = new THREE.Object3D();
  root.add(mesh);
  root.add(starMesh);
  root.frustumCulled = false;

  function updateImpl(sceneSec) {
    const t = Number(sceneSec) || 0;
    // 大きなボケ円
    for (let i = 0; i < p.circleCount; i++) {
      const c = circles[i];
      const x = c.hx + Math.sin(t * c.afx + c.pfx) * c.drx;
      const y = c.hy + Math.cos(t * c.afy + c.pfy) * c.dry;
      let a = c.baseAlpha + c.alphaAmp * Math.sin(t * c.alphaFreq + c.alphaPhase);
      if (a < p.minAlpha) a = p.minAlpha;
      else if (a > p.maxAlpha) a = p.maxAlpha;
      circleData[i].set(x, y, c.radius, a);
    }
    for (let i = p.circleCount; i < MAX_CIRCLES; i++) {
      circleData[i].set(0, 0, 0, 0);
    }
    // 星粒
    for (let i = 0; i < p.starCount; i++) {
      const s = stars[i];
      const x = s.hx + Math.sin(t * s.afx + s.pfx) * s.drx;
      const y = s.hy + Math.cos(t * s.afy + s.pfy) * s.dry;
      let a = s.baseAlpha + s.alphaAmp * Math.sin(t * s.alphaFreq + s.alphaPhase);
      if (a < p.starMinAlpha) a = p.starMinAlpha;
      else if (a > p.starMaxAlpha) a = p.starMaxAlpha;
      // plane geom は 1x1 を中心基準。scale = 2*radius で直径 2r になる。
      const d = s.radius * 2;
      _starPos.set(x, y, 0);
      _starScale.set(d, d, 1);
      _starMatrix.compose(_starPos, _starQuat, _starScale);
      starMesh.setMatrixAt(i, _starMatrix);
      starAlphaArr[i] = a;
    }
    if (p.starCount > 0) {
      starMesh.instanceMatrix.needsUpdate = true;
      starAlphaAttr.needsUpdate = true;
    }
  }

  updateImpl(0);

  function update(frameState) {
    const sceneSecRaw = Number(frameState?.sceneSec);
    const sceneSec = Number.isFinite(sceneSecRaw)
      ? sceneSecRaw
      : (Number(cutStartSec) || 0) + (Number(frameState?.elapsedSec) || 0);
    updateImpl(sceneSec);
  }

  function dispose() {
    geom.dispose();
    material.dispose();
    starGeom.dispose();
    starMat.dispose();
  }

  return { object3D: root, update, dispose };
}

// =============================================================================
// visualizers/led_grid.js
//
// LED スクリーンを拡大したような光るグリッド。各セルが BPM 拍に同期して
// ランダムにオン/オフしながら 3 色のいずれかで光る。背景は透過。
//
// 描画はフルスクリーン 1 plane の ShaderMaterial 1 draw call で完結。
// セル位置・色・点灯タイミングは全て GLSL のハッシュ関数 + シーン秒で決まり、
// シーク / 書き出しでも同じフレームを再現する。
//
// 実効 BPM = params.bpm > 0 ? params.bpm : (ctx.sceneBpm || 120)
// =============================================================================
import { clamp01, numParam } from "/static/js/visualizers/_kit.js";

function normalizeParams(rawParams) {
  const p = rawParams || {};
  const subdivRaw = String(p.subdivision || "2");
  let subdivision = parseInt(subdivRaw, 10);
  if (!Number.isFinite(subdivision) || subdivision < 1) subdivision = 2;
  return {
    color1: String(p.color1 || "#3a8dff"),
    color2: String(p.color2 || "#a83cff"),
    color3: String(p.color3 || "#ff3cd6"),
    gridCols: Math.max(2, Math.min(120, Math.round(numParam(p.gridCols, 28)))),
    gridRows: Math.max(2, Math.min(80, Math.round(numParam(p.gridRows, 16)))),
    cellGap: Math.max(0, Math.min(0.95, numParam(p.cellGap, 0.45))),
    cornerRadius: clamp01(numParam(p.cornerRadius, 0.2)),
    blur: clamp01(numParam(p.blur, 0.6)),
    bpm: Math.max(0, numParam(p.bpm, 0)),
    subdivision,
    litRatio: Math.max(0.05, Math.min(1.0, numParam(p.litRatio, 0.45))),
    onAlpha: clamp01(numParam(p.onAlpha, 0.9)),
    offAlpha: clamp01(numParam(p.offAlpha, 0.05)),
    decay: clamp01(numParam(p.decay, 0.5)),
    seed: Math.max(0, Math.round(numParam(p.seed, 5))),
    opacity: clamp01(numParam(p.opacity, 1.0)),
  };
}

export async function createVisualizerLayer(ctx) {
  const { THREE, width, height, params, cutStartSec, sceneBpm } = ctx;
  const p = normalizeParams(params);

  // BPM の優先順: plugin param > scene の「基本」タブ > フォールバック 120。
  const sceneBpmNum = Number(sceneBpm) || 0;
  const effectiveBpm = p.bpm > 0 ? p.bpm : (sceneBpmNum > 0 ? sceneBpmNum : 120);

  const c1 = new THREE.Color(p.color1);
  const c2 = new THREE.Color(p.color2);
  const c3 = new THREE.Color(p.color3);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uColor1: { value: new THREE.Vector3(c1.r, c1.g, c1.b) },
      uColor2: { value: new THREE.Vector3(c2.r, c2.g, c2.b) },
      uColor3: { value: new THREE.Vector3(c3.r, c3.g, c3.b) },
      uGrid: { value: new THREE.Vector2(p.gridCols, p.gridRows) },
      uCellGap: { value: p.cellGap },
      uCornerRadius: { value: p.cornerRadius },
      uBlur: { value: p.blur },
      uBeatsPerSec: { value: (effectiveBpm * p.subdivision) / 60.0 },
      uLitRatio: { value: p.litRatio },
      uOnAlpha: { value: p.onAlpha },
      uOffAlpha: { value: p.offAlpha },
      uDecay: { value: p.decay },
      uSeed: { value: p.seed },
      uOpacity: { value: p.opacity },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor1;
      uniform vec3 uColor2;
      uniform vec3 uColor3;
      uniform vec2 uGrid;
      uniform float uCellGap;
      uniform float uCornerRadius;
      uniform float uBlur;
      uniform float uBeatsPerSec;
      uniform float uLitRatio;
      uniform float uOnAlpha;
      uniform float uOffAlpha;
      uniform float uDecay;
      uniform float uSeed;
      uniform float uOpacity;
      uniform float uTime;
      varying vec2 vUv;

      float hash21(vec2 p) {
        p += uSeed * 13.37;
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        // セルインデックス & セル内ローカル座標 (0..1)
        vec2 cellId = floor(vUv * uGrid);
        vec2 cellLocal = fract(vUv * uGrid);

        // 拍カウント (BPM × subdivision)
        float beats = uTime * uBeatsPerSec;
        float beatIdx = floor(beats);
        float beatFrac = beats - beatIdx;

        // この拍でこのセルが点灯するかどうか
        float litRand = hash21(cellId + vec2(beatIdx * 7.31, beatIdx * 3.17));
        float isLit = step(1.0 - uLitRatio, litRand);
        // 拍内減衰
        float pulse = 1.0 - uDecay * beatFrac;
        float lit = isLit * pulse;

        // 色: 2 拍ごとに切り替わるよう beatIdx/2 でハッシュ
        float colorH = hash21(cellId + vec2(floor(beatIdx / 2.0) * 5.71, 91.3));
        vec3 col = mix(uColor1, uColor2, smoothstep(0.0, 0.5, colorH));
        col = mix(col, uColor3, smoothstep(0.5, 1.0, colorH));

        // セル形状: 中心からの角丸正方形 SDF。
        // cornerRadius=0 で正方形、=1 で完全な円 (fillSize と等しい半径)。
        vec2 d = abs(cellLocal - 0.5) * 2.0;
        float fillSize = max(0.001, 1.0 - uCellGap);
        float r = uCornerRadius * fillSize;
        vec2 q = d - vec2(fillSize - r);
        float sdf = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
        // エッジ幅は cell 内 NDC で 0.02..(1.0 - fillSize) の範囲。
        // blur=0 で hard edge、blur=1 で「セルがほぼ円形に拡散」する。
        float edge = mix(0.02, max(0.05, 1.0 - fillSize), uBlur);
        float shape = 1.0 - smoothstep(0.0, edge, sdf);
        // ブラー強めのとき中心からのガウシアン的減衰を追加してより「光った」感を出す
        if (uBlur > 0.3) {
          float r = length(d);
          float halo = exp(-r * r * mix(8.0, 1.5, uBlur));
          shape = max(shape, halo * uBlur);
        }

        float vis = mix(uOffAlpha, uOnAlpha, lit) * shape;
        gl_FragColor = vec4(col, vis * uOpacity);
      }
    `,
  });

  const geom = new THREE.PlaneGeometry(width, height);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(width / 2, height / 2, 0);
  mesh.frustumCulled = false;

  const root = new THREE.Object3D();
  root.add(mesh);
  root.frustumCulled = false;

  function updateImpl(sceneSec) {
    material.uniforms.uTime.value = Number(sceneSec) || 0;
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
  }

  return { object3D: root, update, dispose };
}

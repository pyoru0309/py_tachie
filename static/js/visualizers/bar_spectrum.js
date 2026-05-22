// =============================================================================
// visualizers/bar_spectrum.js
//
// シンプルな縦バーのスペクトラム。グロー / グラデーション無しの汎用版。
// mode で「下から伸びる (bottom)」「中央から両側へ (mirror)」を切り替える。
// =============================================================================
import {
  clamp01,
  numParam,
  sliceStreamRow,
} from "/static/js/visualizers/_kit.js";

const _tempMatrix = { current: null };
const _tempPos = { current: null };
const _tempQuat = { current: null };
const _tempScale = { current: null };

function normalizeParams(rawParams) {
  const p = rawParams || {};
  let dbFloor = numParam(p.dbFloor, -78);
  let dbCeil = numParam(p.dbCeil, -18);
  if (dbCeil <= dbFloor) dbCeil = dbFloor + 1;
  const x = numParam(p.x, 50);
  const y = numParam(p.y, 1080);
  const width = Math.max(1, numParam(p.width, 1820));
  const height = Math.max(1, numParam(p.height, 200));
  // 既にシーンへ保存された初版デフォルトは、ライブ用の床付き配置へ移行する。
  const hasInitialDraftDefaults = x === 120 && y === 870 && width === 1680 && height === 460;
  return {
    color: String(p.color || "#ffffff"),
    barCount: Math.max(1, Math.min(240, Math.round(numParam(p.barCount, 96)))),
    x: hasInitialDraftDefaults ? 0 : x,
    y: hasInitialDraftDefaults ? 1080 : y,
    width: hasInitialDraftDefaults ? 1920 : width,
    height: hasInitialDraftDefaults ? 300 : height,
    barGap: Math.max(0, Math.min(0.95, numParam(p.barGap, 0.7))),
    minHeight: Math.max(0, Math.min(80, numParam(p.minHeight, 3))),
    mode: String(p.mode || "bottom"),
    dbFloor,
    dbCeil,
    opacity: clamp01(numParam(p.opacity, 1.0)),
  };
}

function makeBarMaterial(THREE, color, opacity) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.NormalBlending,
    uniforms: {
      uOpacity: { value: opacity },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: `
      void main() {
        vec4 transformed = vec4(position, 1.0);
        #ifdef USE_INSTANCING
        transformed = instanceMatrix * transformed;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * transformed;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
      }
    `,
  });
}

export async function createVisualizerLayer(ctx) {
  const { THREE, params, streamMeta, streamShapes, frameCount } = ctx;
  const p = normalizeParams(params);

  _tempMatrix.current = _tempMatrix.current || new THREE.Matrix4();
  _tempPos.current = _tempPos.current || new THREE.Vector3();
  _tempQuat.current = _tempQuat.current || new THREE.Quaternion();
  _tempScale.current = _tempScale.current || new THREE.Vector3();

  // THREE.Group ではなく Object3D を使う。Group だと three.js の
  // projectObject が `groupOrder = group.renderOrder` を子孫に伝播させ、
  // reversePainterSortStable が groupOrder を renderOrder より優先するため、
  // scene-builder が Group に renderOrder=50 等を立てた瞬間に子孫が
  // groupOrder=50 となり、テロップ (groupOrder=0, renderOrder=3000) より
  // 後段にソートされて画面前面に出てしまう。
  const group = new THREE.Object3D();
  group.frustumCulled = false;

  const spectrumStream = streamMeta?.spectrum || null;
  const specShape = streamShapes?.spectrum || null;
  const bandsBaked = (() => {
    if (Array.isArray(specShape) && specShape.length >= 2) return Math.max(1, Number(specShape[1]));
    if (spectrumStream?.array && frameCount > 0) return Math.max(1, Math.floor(spectrumStream.array.length / frameCount));
    return p.barCount;
  })();
  const levelsBuf = new Float32Array(bandsBaked);

  const barGeom = new THREE.PlaneGeometry(1, 1);
  const barMat = makeBarMaterial(THREE, p.color, p.opacity);

  const bars = new THREE.InstancedMesh(barGeom, barMat, p.barCount);
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bars.frustumCulled = false;
  group.add(bars);

  let lastFrameIdx = -1;

  function setInstance(i, x, y, sx, sy) {
    _tempPos.current.set(x, y, 0);
    _tempScale.current.set(sx, sy, 1);
    _tempMatrix.current.compose(_tempPos.current, _tempQuat.current, _tempScale.current);
    bars.setMatrixAt(i, _tempMatrix.current);
  }

  function updateImpl(frameIdx) {
    if (frameIdx === lastFrameIdx) return;
    lastFrameIdx = frameIdx;

    const slot = p.width / p.barCount;
    const barW = Math.max(1, slot * (1 - p.barGap));
    const levels = sliceStreamRow(spectrumStream, frameIdx, bandsBaked, levelsBuf);

    for (let i = 0; i < p.barCount; i++) {
      const srcI = p.barCount === bandsBaked
        ? i
        : Math.round((i / Math.max(1, p.barCount - 1)) * (bandsBaked - 1));
      const v = Math.pow(clamp01(levels[srcI] || 0), 0.68);
      const h = Math.max(p.minHeight, v * p.height);
      const cx = p.x + i * slot + slot / 2;
      let cy;
      if (p.mode === "mirror") cy = p.y;
      else if (p.mode === "top") cy = p.y + h / 2;
      else cy = p.y - h / 2;
      setInstance(i, cx, cy, barW, h);
    }
    bars.instanceMatrix.needsUpdate = true;
    barMat.uniforms.uOpacity.value = p.opacity;
  }

  updateImpl(0);

  function update(frameState) {
    let idx = Math.max(0, Math.floor(Number(frameState?.frameIdx) || 0));
    const fmax = Math.max(0, (Number(frameCount) || 0) - 1);
    if (fmax >= 0 && idx > fmax) idx = fmax;
    updateImpl(idx);
  }

  function dispose() {
    barGeom.dispose();
    barMat.dispose();
  }

  return { object3D: group, update, dispose };
}

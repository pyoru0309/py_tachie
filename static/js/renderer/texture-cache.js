// =============================================================================
// renderer/texture-cache.js
//
// URL → Promise<THREE.Texture> の参照カウント付きキャッシュ。
// 同一 URL の重複ロードを避け、release で参照が 0 になったら dispose する。
//
// scene-bundle は state hash (token) でファイル名を固定するので、同一 state の
// カットを再選択すれば cache hit して GPU 再アップロードを避けられる。
// =============================================================================
import * as THREE from "three";

const cache = new Map();    // url -> Promise<THREE.Texture | null>
const refCounts = new Map(); // url -> number

const loader = new THREE.TextureLoader();

export function loadTexture(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) {
    refCounts.set(url, (refCounts.get(url) || 0) + 1);
    return cache.get(url);
  }
  const promise = new Promise((resolve, reject) => {
    loader.load(
      url,
      (texture) => {
        // sRGB 入力 (PNG/WebP は基本 sRGB)。
        texture.colorSpace = THREE.SRGBColorSpace;
        // Y 軸を flip しないことで、Camera を Y-down (top=0,bottom=H) に揃える。
        texture.flipY = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        resolve(texture);
      },
      undefined,
      (error) => {
        console.warn("[renderer] texture load failed", url, error);
        // 失敗しても reject しない。null を返してプレビューを継続する。
        resolve(null);
      },
    );
  });
  cache.set(url, promise);
  refCounts.set(url, 1);
  return promise;
}

export function releaseTexture(url) {
  if (!url || !cache.has(url)) return;
  const next = (refCounts.get(url) || 0) - 1;
  if (next > 0) {
    refCounts.set(url, next);
    return;
  }
  const promise = cache.get(url);
  cache.delete(url);
  refCounts.delete(url);
  promise.then((tex) => tex && tex.dispose()).catch(() => {});
}

export function clearTextureCache() {
  for (const [url, promise] of cache.entries()) {
    promise.then((tex) => tex && tex.dispose()).catch(() => {});
    cache.delete(url);
    refCounts.delete(url);
  }
}

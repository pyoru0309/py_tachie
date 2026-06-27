// =============================================================================
// renderer/text-layout.js
//
// テキスト 1 行を「グリフ単位レイアウト」に展開するユーティリティ。
// オプティカルカーニング (左右 ink ベアリング + 日本語 punctuation 係数)
// と letter_spacing (一律 px 加算、optical 後) の両方を一手で行う。
//
// API:
//   layoutTextRun(ctx, text, {
//     fontSpec,             // ctx.font に既に同じものを設定しておくこと (cache key 兼用)
//     fontSize,             // px (optical 詰めの上限とターゲット余白の基準)
//     letterSpacing = 0,    // px、optical 後に一律加算
//     opticalKerning = false,
//     maxTsumeEm = 0.35,    // 1 ペアあたりの最大詰め (em ratio)
//     minPairGapEm = 0.04,  // optical のターゲット余白 (em ratio)
//   })
//   → { glyphs: [{ text, x, advance, leftBearing, rightBearing }], width }
//
//   各 glyph は cursor (= origin x) の値を `x` に持つので、描画は
//     ctx.fillText(g.text, baseX + g.x, baselineY)
//   で OK。`width` は最終 cursor (最後の glyph の advance を含む) で、
//   行幅 = run.width となる。
//
// 仕組み:
//   - Intl.Segmenter("ja", {granularity:"grapheme"}) で grapheme 単位に分割
//     (濁点結合 / emoji / IVS を壊さない)
//   - measureText().actualBoundingBoxLeft / Right で ink ベアリングを取得
//     (alpha スキャン不要、Chrome 87+ / Safari 11.1+ / Firefox 116+)
//   - 隣接ペアごとに「左の右余白 + 右の左余白 - target」を pair class 係数で
//     スケールして詰める (上限 maxTsumeEm * fontSize)
//   - 最後に letterSpacing を一律加算 (= optical 後の再調整)
//
// キャッシュ:
//   1 fontSpec ごとに glyph metrics の Map を持つ。テロップ内容は固定なので
//   ほぼ追記のみ。GLYPH_CACHE_LIMIT_PER_FONT を超えたら oldest を捨てる。
//   フォント差し替え時は clearTextLayoutCache() を呼ぶ。
// =============================================================================

const _glyphCacheByFontSpec = new Map();
const GLYPH_CACHE_LIMIT_PER_FONT = 4096;

// =============================================================================
// 強めモード — 輪郭プロファイル + score 最小化方式
//
// 「衝突しない最大」ではなく「白場分布が自然な位置」を探す。
//   1. 各 glyph を off-screen に焼き、Y 行ごとの leftProfile/rightProfile と
//      density / 左右 straightness を抽出してキャッシュ
//   2. ペア (A, B) について shift を 0..maxPull で探索
//   3. 各 shift で gap[y] = (advance_A - shift) + B.leftProfile[y] - A.rightProfile[y]
//      を計算し、衝突 (gap<0) は除外、minGap 不足 / target 偏差 / variance を
//      合算した score の最小点を選ぶ
//   4. classTsumePrior (class だけで決まる定型詰め) + opticalResidual の
//      二段構えで finalShift を出す (全角ボディのリズムを完全に消さない)
//   5. 結果は (fontSpec, prev, cur, fontSize) で memoize
// =============================================================================

const _profileCacheByFontSpec = new Map();
const PROFILE_CACHE_LIMIT_PER_FONT = 1024;
const PROFILE_HEIGHT_EM = 2.0;     // canvas 高さ = fontSize * 2 (全 glyph 共通基準)
const PROFILE_BASELINE_EM = 1.4;
const PROFILE_INK_PAD_EM = 0.5;
const PROFILE_ALPHA_THRESHOLD = 16;
const PROFILE_LEFT_SENTINEL = 32767;
const PROFILE_RIGHT_SENTINEL = -32768;

const _pairShiftCache = new Map();
const PAIR_SHIFT_CACHE_LIMIT = 8192;

let _profileCanvas = null;
let _profileCtx = null;
function getProfileCanvas() {
  if (!_profileCanvas) {
    if (typeof document === "undefined" || typeof document.createElement !== "function") {
      return null;
    }
    _profileCanvas = document.createElement("canvas");
    _profileCtx = _profileCanvas.getContext("2d", { willReadFrequently: true });
  }
  return _profileCtx ? { canvas: _profileCanvas, ctx: _profileCtx } : null;
}

function getProfileCache(fontSpec) {
  let cache = _profileCacheByFontSpec.get(fontSpec);
  if (!cache) {
    cache = new Map();
    _profileCacheByFontSpec.set(fontSpec, cache);
  }
  return cache;
}

// 1 文字の輪郭プロファイル + 補助特徴量を作る。
//
// 戻り値:
//   advance       : px
//   leftProfile   : Int16Array(profileH)、origin 起点の ink 左端 x
//   rightProfile  : Int16Array(profileH)、origin 起点の ink 右端 x
//   profileH      : canvas 高さ (px、全 glyph 共通)
//   density       : 0..1、ink ピクセル数 / canvas 面積
//   leftStraightness  : 0..1、leftProfile の y 方向ばらつきが小さいほど 1 (= 直線的)
//   rightStraightness : 0..1、rightProfile 同上
function buildGlyphProfile(fontSpec, fontSize, ch) {
  const cv = getProfileCanvas();
  if (!cv) return null;
  const { canvas, ctx } = cv;

  const profileH = Math.ceil(fontSize * PROFILE_HEIGHT_EM);
  const baselineY = Math.ceil(fontSize * PROFILE_BASELINE_EM);
  const padX = Math.ceil(fontSize * PROFILE_INK_PAD_EM);

  ctx.font = fontSpec;
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText(ch);
  const advance = Math.max(1, Number(m.width) || 0);
  const inkLeft = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
  const inkRight = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : advance;

  const originX = padX + Math.max(0, inkLeft);
  const canvasW = Math.max(2, Math.ceil(originX + Math.max(advance, inkRight) + padX));

  if (canvas.width !== canvasW || canvas.height !== profileH) {
    canvas.width = canvasW;
    canvas.height = profileH;
  } else {
    ctx.clearRect(0, 0, canvasW, profileH);
  }
  ctx.font = fontSpec;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(ch, originX, baselineY);

  const data = ctx.getImageData(0, 0, canvasW, profileH).data;
  const leftProfile = new Int16Array(profileH);
  const rightProfile = new Int16Array(profileH);
  let inkCount = 0;
  for (let y = 0; y < profileH; y += 1) {
    let lx = -1;
    let rx = -1;
    const rowOff = y * canvasW * 4 + 3;
    for (let x = 0; x < canvasW; x += 1) {
      const a = data[rowOff + x * 4];
      if (a > PROFILE_ALPHA_THRESHOLD) {
        if (lx < 0) lx = x;
        rx = x;
        inkCount += 1;
      }
    }
    leftProfile[y] = lx < 0 ? PROFILE_LEFT_SENTINEL : (lx - originX);
    rightProfile[y] = rx < 0 ? PROFILE_RIGHT_SENTINEL : (rx - originX);
  }

  const density = inkCount / (canvasW * profileH);
  const leftStraightness = computeStraightness(leftProfile, fontSize);
  const rightStraightness = computeStraightness(rightProfile, fontSize);

  return {
    advance, leftProfile, rightProfile, profileH,
    density, leftStraightness, rightStraightness,
  };
}

// profile の y 方向ばらつきが小さいほど「直線的」と判断する係数 (0..1)。
// 標準偏差を fontSize * 0.5 で正規化して 1 から引く。
// 透明行 (sentinel) は除外。
function computeStraightness(profile, fontSize) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < profile.length; y += 1) {
    const v = profile[y];
    if (v >= 30000 || v <= -30000) continue;
    sum += v;
    count += 1;
  }
  if (count < 4) return 0.5;
  const mean = sum / count;
  let sumSq = 0;
  for (let y = 0; y < profile.length; y += 1) {
    const v = profile[y];
    if (v >= 30000 || v <= -30000) continue;
    const d = v - mean;
    sumSq += d * d;
  }
  const stdDev = Math.sqrt(sumSq / count);
  const norm = Math.min(1, stdDev / (fontSize * 0.5));
  return Math.max(0, 1 - norm);
}

function getOrBuildProfile(fontSpec, fontSize, ch) {
  const cache = getProfileCache(fontSpec);
  let entry = cache.get(ch);
  if (entry && entry.fontSize === fontSize) return entry;
  const built = buildGlyphProfile(fontSpec, fontSize, ch);
  if (!built) return null;
  built.fontSize = fontSize;
  if (cache.size >= PROFILE_CACHE_LIMIT_PER_FONT) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(ch, built);
  return built;
}

// 「気持ちいい」目標 gap (em)。
//   class scriptPair: 漢字+漢字は広め / かな同士は中 / 約物まわりは狭め
//   density: 黒密度の平均が高いほど少し広めに (空気を残す)
//   straightness: 直線同士は広め / 曲線同士は狭め
function computeTargetGapEm(prevClass, curClass, profA, profB) {
  let base = 0.10;
  if (prevClass === "kanji" && curClass === "kanji") base *= 1.6;
  else if (
    (prevClass === "kanji" && (curClass === "hiragana" || curClass === "katakana")) ||
    ((prevClass === "hiragana" || prevClass === "katakana") && curClass === "kanji")
  ) base *= 1.30;
  else if (
    (prevClass === "hiragana" || prevClass === "katakana") &&
    (curClass === "hiragana" || curClass === "katakana")
  ) base *= 1.0;
  else if (isAlnumClass(prevClass) && isAlnumClass(curClass)) base *= 0.85;
  else if (_PUNCTS.has(prevClass) || _PUNCTS.has(curClass)) base *= 0.55;
  else if (_BRACKETS.has(prevClass) || _BRACKETS.has(curClass)) base *= 0.55;

  const avgDensity = ((profA.density || 0.2) + (profB.density || 0.2)) * 0.5;
  // density 0 → 0.7, density 0.30+ → 1.2 (漢字は通常 0.20-0.30)
  const densityFactor = 0.7 + Math.min(1.0, avgDensity / 0.30) * 0.5;

  // 隣接面の直線性: A の右 + B の左
  const straightSum = (profA.rightStraightness || 0.5) + (profB.leftStraightness || 0.5);
  // straight 0 → 0.85, straight 2 → 1.15
  const straightFactor = 0.85 + (straightSum * 0.5) * 0.30;

  return base * densityFactor * straightFactor;
}

// クラス別の「最大 shift」(em)。漢字同士は字面密度高いので保守的。
function maxPullEmFor(prevClass, curClass) {
  if (prevClass === "kanji" && curClass === "kanji") return 0.18;
  if (_PUNCTS.has(prevClass) || _PUNCTS.has(curClass)) return 0.50;
  if (_BRACKETS.has(prevClass) || _BRACKETS.has(curClass)) return 0.50;
  return 0.40;
}

// クラス別の「これ以上は近づけない安全 gap」(em)。
function minGapEmFor(prevClass, curClass) {
  if (prevClass === "kanji" && curClass === "kanji") return 0.06;
  return 0.015;
}

// 空白文字の advance を「typography rule」で決める。
//
// 空白を透明 glyph として profile に放り込むと、輪郭エネルギーがゼロなので
// optical kerning では触れず、結果として 1em (全角) や ASCII 標準幅 (半角) が
// そのまま残る。これは見た目に空きすぎる場面が多い。代わりに「前後の字種 +
// 空白の種類」で目標値を直接決め、glyph の advance に反映する。
//
//   spaceClass:  "space" | "ideographic_space"
//   prevClass / nextClass: 隣接する非空白の class (連続空白の起点では prevClass、
//                          run の終わりでは nextClass を見る)
//   prevDensity / nextDensity: glyph の ink 密度 (0..1)、強めモードのみ取得可
//
// 戻り値: 目標 advance (em)
function computeSpaceTargetEm(prevClass, nextClass, spaceClass, prevDensity, nextDensity) {
  // 全角スペースは装飾的余白として保持しつつ、漢字隣で過剰に広く見えないよう
  // 中庸 0.65em (上限値 1.0em より下、下限値 0.5em より上)。
  if (spaceClass === "ideographic_space") {
    let base = 0.65;
    if (prevDensity != null && nextDensity != null) {
      const avg = (prevDensity + nextDensity) * 0.5;
      if (avg > 0.45) base *= 1.08;
      else if (avg < 0.22) base *= 0.9;
    }
    return base;
  }

  const isJp = (c) => c === "hiragana" || c === "katakana" || c === "kanji"
                    || c === "small_kana" || c === "long_sound";
  const isLatin = (c) => c === "latin" || c === "digit";
  const isPunctLike = (c) => _PUNCTS.has(c) || _BRACKETS.has(c);

  // 全体に少し狭め寄りに調整 (絶対値は書体差で揺れるが、目立つ書体で「広すぎ」と
  // 感じられない側に寄せる)。ユーザー側で letter_spacing で広げる方が、
  // 自分で詰めるより楽なため。
  let base;
  if (isPunctLike(prevClass) || isPunctLike(nextClass)) {
    base = 0.10; // 句読点 / 括弧まわり (0.08-0.18em の下寄り)
  } else if (isLatin(prevClass) && isLatin(nextClass)) {
    base = 0.24; // Latin native space (0.28-0.35em の下、見た目は半角強)
  } else if (isJp(prevClass) && isJp(nextClass)) {
    base = 0.15; // 日本語 + 日本語 (0.12-0.22em の中央寄り下)
  } else if ((isJp(prevClass) && isLatin(nextClass)) || (isLatin(prevClass) && isJp(nextClass))) {
    base = 0.18; // 日本語 + Latin の混在 (0.18-0.28em の下)
  } else {
    base = 0.20; // その他
  }

  if (prevDensity != null && nextDensity != null) {
    const avg = (prevDensity + nextDensity) * 0.5;
    if (avg > 0.45) base *= 1.08;       // 黒い漢字同士 → 空気を残す
    else if (avg < 0.22) base *= 0.9;   // かな・丸い字形 → 少し詰める
  }
  return base;
}

// profile cache から ink 密度を取得。強めモードで profile が焼かれている場合のみ
// 値を返し、それ以外は null (= density 補正なし)。
function getCachedDensity(fontSpec, fontSize, ch) {
  if (!fontSpec) return null;
  const cache = _profileCacheByFontSpec.get(fontSpec);
  if (!cache) return null;
  const entry = cache.get(ch);
  if (!entry || entry.fontSize !== fontSize) return null;
  return entry.density;
}

// (A, B) の bbox 最近接で「target に揃える詰め」を計算するフォールバック。
// findBestShift が「両 profile が ink を持つ y 行が少なすぎて score 信頼性が低い」と
// 判断した場合、または完全分離 (count=0) の場合に呼ぶ。
function bboxFallbackShift(profA, profB, targetGapPx, minGapPx, maxPullPx) {
  const ph = Math.min(profA.profileH, profB.profileH);
  let aRightMax = -Infinity;
  let bLeftMin = Infinity;
  const ar = profA.rightProfile;
  const bl = profB.leftProfile;
  for (let y = 0; y < ph; y += 1) {
    const arv = ar[y];
    const blv = bl[y];
    if (arv > -30000 && arv > aRightMax) aRightMax = arv;
    if (blv < 30000 && blv < bLeftMin) bLeftMin = blv;
  }
  if (aRightMax === -Infinity || bLeftMin === Infinity) return 0;
  const bboxGap = profA.advance + bLeftMin - aRightMax;
  // target に揃える詰め量。minGap と maxPull も保証。
  const desiredPull = bboxGap - targetGapPx;
  if (desiredPull <= 0) return 0;
  const safePull = Math.max(0, bboxGap - minGapPx);
  return Math.min(desiredPull, safePull, maxPullPx);
}

// shift を 0..maxPullPx の範囲で探索し、score 最小の shift を返す。
//
// score(shift) =
//   (visualGap - targetGapPx)^2          * weightTarget    — 平均が target に近いか
//   + (1/count) * Σ max(0, min - g[y])^2 * weightTooSmall  — 局所近すぎ (per-y 平均)
//   + (1/count) * Σ max(0, g[y] - max)^2 * weightTooLarge  — 局所空きすぎ (per-y 平均)
//
// max = targetGapPx * 1.8 (= target の約 2 倍より広い行はペナルティ)
//
// 旧式は variance(gap[y]) を使っていたが、gap[y] = baseGap[y] - shift で shift が
// 全 y で一定なため、Var(gap[y] - shift) = Var(gap[y]) → shift に依存せず argmin に
// 効かないバグがあった。Σmax(0, g[y]-max)² は shift で実際に値が変わる (詰めると
// max を超える行が減る) ので「片側だけ空く」形をきちんと抑制できる。
//
// count 正規化: 局所ペナルティは per-y 累積なので 1/count で平均化し、
// pair の overlap 行数 (count) の差で score スケールが偏らないようにする。
//
// 衝突 (gap[y] < 0 の y がある) は即除外。
//
// Y overlap (両方が ink を持つ y 行数) が profileH の 15% 未満のペアは、
// score 経路で「局所最適化」して行内リズムが崩れがちなので、bbox フォールバック
// (target に揃える) に倒す。「し+ゃ」「分+上」「↑+の」「ニ+ー」等が該当。
function findBestShift(profA, profB, fontSize, opts) {
  const {
    targetGapPx, minGapPx, maxPullPx,
    weightTarget = 1.0,
    weightTooSmall = 4.0,
    weightTooLarge = 0.6,
    maxGapMultiplier = 1.8,
  } = opts;

  const profileH = Math.min(profA.profileH, profB.profileH);
  const advA = profA.advance;
  const ar = profA.rightProfile;
  const bl = profB.leftProfile;

  // overlap 行数の事前測定 (Y 軸方向で両者が ink を持つ y の数)。
  let overlapRows = 0;
  for (let y = 0; y < profileH; y += 1) {
    if (ar[y] > -30000 && bl[y] < 30000) overlapRows += 1;
  }
  if (overlapRows < profileH * 0.15) {
    return bboxFallbackShift(profA, profB, targetGapPx, minGapPx, maxPullPx);
  }

  const maxGapPx = targetGapPx * maxGapMultiplier;
  const step = Math.max(0.5, fontSize * 0.005); // ≈ 0.6px @ fontSize=120

  let bestShift = 0;
  let bestScore = Infinity;

  for (let shift = 0; shift <= maxPullPx + 1e-6; shift += step) {
    let sum = 0;
    let count = 0;
    let collision = false;
    let sumTooSmallSq = 0;
    let sumTooLargeSq = 0;

    for (let y = 0; y < profileH; y += 1) {
      const arv = ar[y];
      const blv = bl[y];
      if (arv <= -30000 || blv >= 30000) continue;
      const g = advA - shift + blv - arv;
      if (g < 0) { collision = true; break; }
      sum += g;
      count += 1;
      const tooSmall = minGapPx - g;
      if (tooSmall > 0) sumTooSmallSq += tooSmall * tooSmall;
      const tooLarge = g - maxGapPx;
      if (tooLarge > 0) sumTooLargeSq += tooLarge * tooLarge;
    }
    if (collision || count === 0) continue;
    const visualGap = sum / count;
    const dev = visualGap - targetGapPx;

    const score =
      dev * dev * weightTarget +
      (sumTooSmallSq / count) * weightTooSmall +
      (sumTooLargeSq / count) * weightTooLarge;

    if (score < bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }

  // 念のため: bestScore が Infinity (= 全 shift で衝突 = ありえないが理論上)
  // のときも bbox フォールバック。overlap < 15% は冒頭で分岐済みなので通常到達しない。
  if (bestScore === Infinity) {
    return bboxFallbackShift(profA, profB, targetGapPx, minGapPx, maxPullPx);
  }
  return bestShift;
}

// ペア (prevCh, curCh) の最終 shift を求めて memoize。
// shift > 0 の値は「右文字を左に寄せる px 数」。
// outlineMarginPx > 0 が渡された場合、minGapPx に加算 (= stroke 同士の融合を防ぐ
// safety mergin)。memoize key にも outlineMarginPx を含めて区別する。
function computePairShift(fontSpec, fontSize, prevCh, curCh, prevClass, curClass, outlineMarginPx = 0) {
  const marginRounded = Math.round((outlineMarginPx || 0) * 10) / 10; // key 文字列を安定化
  const key = `${fontSpec}|${fontSize}|${marginRounded}|${prevCh}|${curCh}`;
  const cached = _pairShiftCache.get(key);
  if (cached !== undefined) return cached;

  const profA = getOrBuildProfile(fontSpec, fontSize, prevCh);
  const profB = getOrBuildProfile(fontSpec, fontSize, curCh);
  if (!profA || !profB) return 0;

  const targetGapPx = fontSize * computeTargetGapEm(prevClass, curClass, profA, profB);
  const minGapPx = fontSize * minGapEmFor(prevClass, curClass) + marginRounded;
  const maxPullPx = fontSize * maxPullEmFor(prevClass, curClass);

  const shift = findBestShift(profA, profB, fontSize, { targetGapPx, minGapPx, maxPullPx });

  if (_pairShiftCache.size >= PAIR_SHIFT_CACHE_LIMIT) {
    const firstKey = _pairShiftCache.keys().next().value;
    if (firstKey !== undefined) _pairShiftCache.delete(firstKey);
  }
  _pairShiftCache.set(key, shift);
  return shift;
}

// =============================================================================
// 素のオプティカル (強めモードの行均し)
//
// クラス別係数・固定 em パラメータ (target/maxPull/minGap) を一切介さず、
// 「行内の本文ペアの実測 gap の中央値」に全ペアを揃える。書体ごとの字面分布の
// 差を実測値が吸収するので、固定 em と違って書体を変えてもバラつかない。
//   - 約物 (句読点・括弧・！？) も今は均し対象に含める (素の状態をまず確認する)
//   - 空白絡みのペアは別軸 (computeSpaceTargetEm) なので対象外
// （約物の例外緩和・均一強度ノブ等の調整は今後の段階で追加予定）
// =============================================================================

// ペア (prevCh, curCh) の「詰める前 (shift=0)」の素の字面間白場 (px)。
//   meanGap : 両者が ink を持つ y 行の平均 gap (= 視覚的な平均アキ)
//   nearest : 最近接 gap (bbox。詰めても衝突させない上限の算出に使う)
function rawGapFromProfiles(profA, profB) {
  const profileH = Math.min(profA.profileH, profB.profileH);
  const advA = profA.advance;
  const ar = profA.rightProfile;
  const bl = profB.leftProfile;
  let sum = 0;
  let count = 0;
  let aRightMax = -Infinity;
  let bLeftMin = Infinity;
  for (let y = 0; y < profileH; y += 1) {
    const arv = ar[y];
    const blv = bl[y];
    if (arv > -30000 && blv < 30000) {
      sum += advA + blv - arv; // shift=0 のときの gap[y]
      count += 1;
    }
    if (arv > -30000 && arv > aRightMax) aRightMax = arv;
    if (blv < 30000 && blv < bLeftMin) bLeftMin = blv;
  }
  const nearest = (aRightMax > -Infinity && bLeftMin < Infinity)
    ? (advA + bLeftMin - aRightMax)
    : null;
  let meanGap;
  if (count > 0) meanGap = sum / count;
  else if (nearest != null) meanGap = nearest;
  else return null;
  return { meanGap, nearest: nearest != null ? nearest : meanGap };
}

const _pairRawGapCache = new Map();
const PAIR_RAW_GAP_CACHE_LIMIT = 8192;

// 行非依存 (fontSpec, fontSize, prevCh, curCh のみ) なので memoize 可。
function computePairRawGap(fontSpec, fontSize, prevCh, curCh) {
  const key = `${fontSpec}|${fontSize}|${prevCh}|${curCh}`;
  const cached = _pairRawGapCache.get(key);
  if (cached !== undefined) return cached;
  const profA = getOrBuildProfile(fontSpec, fontSize, prevCh);
  const profB = getOrBuildProfile(fontSpec, fontSize, curCh);
  const raw = (profA && profB) ? rawGapFromProfiles(profA, profB) : null;
  if (_pairRawGapCache.size >= PAIR_RAW_GAP_CACHE_LIMIT) {
    const firstKey = _pairRawGapCache.keys().next().value;
    if (firstKey !== undefined) _pairRawGapCache.delete(firstKey);
  }
  _pairRawGapCache.set(key, raw);
  return raw;
}

// 行内の本文ペア (空白絡みを除く全隣接ペア) の素 gap の中央値。
// 中央値なので「漢字ペアだけ広い」等の外れ値には引っ張られない。
function computeLineMedianGap(chars, isSpaceFlags, fontSpec, fontSize) {
  const gaps = [];
  for (let i = 1; i < chars.length; i += 1) {
    if (isSpaceFlags[i] || isSpaceFlags[i - 1]) continue;
    const ca = classify(chars[i - 1]);
    const cb = classify(chars[i]);
    // 約物・欧文絡みのペアは CJK 本文中央値の母集団から外す。約物は字面が片寄り、
    // 欧文 (Latin/digit) は和文フォント中で字幅が大きく中央値を釣り上げるため、
    // どちらも CJK 本文の字間基準を歪める (約物=A / 欧文=B 専用ルールで別途扱う)。
    if (_PUNCT_BRACKET_CLASSES.has(ca) || _PUNCT_BRACKET_CLASSES.has(cb)) continue;
    if (isAlnumClass(ca) || isAlnumClass(cb)) continue;
    const raw = computePairRawGap(fontSpec, fontSize, chars[i - 1], chars[i]);
    // 均し基準は nearest (bbox 実隙間)。meanGap (行平均アキ) はストロークが薄い字で
    // 釣り上がり、目に見える隙間 (bbox) と相関しないため使わない。
    if (raw && raw.nearest != null && Number.isFinite(raw.nearest)) gaps.push(raw.nearest);
  }
  return _medianOf(gaps);
}

// 欧文 (Latin/digit) 同士のペアの bbox gap 中央値。和文中央値とは別に持ち、
// 欧文連続部 (Everyday 等) を欧文自身のリズムで均す (B)。
function computeLineLatinMedian(chars, fontSpec, fontSize) {
  const gaps = [];
  for (let i = 1; i < chars.length; i += 1) {
    const ca = classify(chars[i - 1]);
    const cb = classify(chars[i]);
    if (!isAlnumClass(ca) || !isAlnumClass(cb)) continue;
    const raw = computePairRawGap(fontSpec, fontSize, chars[i - 1], chars[i]);
    if (raw && raw.nearest != null && Number.isFinite(raw.nearest)) gaps.push(raw.nearest);
  }
  return _medianOf(gaps);
}

function _medianOf(gaps) {
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return (gaps.length & 1) ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) * 0.5;
}

// 本文全体 (= テロップ/セリフの全行) の本文ペアの素 gap 中央値。
// computeLineMedianGap は 1 行内だけで中央値を取るため、行ごとに基準がぶれて
// 中央寄せ時に行幅の引き直しがガタつく。全行を 1 つの母集団にまとめて中央値を
// 取り、その値を layoutTextRun の medianGapOverride として全行に渡すことで、
// 揃え基準を本文単位で 1 つに固定する。強め (HQ optical) モードでのみ意味を
// 持ち、それ以外は null を返す (= 標準経路は従来どおり無調整)。
export function computeOpticalMedianGapForLines(lines, options = {}) {
  const {
    fontSpec,
    fontSize,
    opticalKerning = false,
    opticalKerningHighQuality = false,
  } = options;
  const fSize = Number(fontSize) || 0;
  if (!opticalKerning || !opticalKerningHighQuality || !fontSpec || fSize <= 0) {
    return null;
  }
  const gaps = [];
  for (const line of lines || []) {
    const chars = splitGraphemes(String(line || ""));
    if (chars.length < 2) continue;
    const cls = chars.map((c) => classify(c));
    for (let i = 1; i < chars.length; i += 1) {
      if (_SPACE_CLASSES.has(cls[i]) || _SPACE_CLASSES.has(cls[i - 1])) continue;
      // 約物・欧文絡みのペアは CJK 本文中央値の母集団から外す (computeLineMedianGap と同じ)。
      if (_PUNCT_BRACKET_CLASSES.has(cls[i]) || _PUNCT_BRACKET_CLASSES.has(cls[i - 1])) continue;
      if (isAlnumClass(cls[i]) || isAlnumClass(cls[i - 1])) continue;
      const raw = computePairRawGap(fontSpec, fSize, chars[i - 1], chars[i]);
      // 均し基準は nearest (bbox 実隙間)。computeLineMedianGap と同じ。
      if (raw && raw.nearest != null && Number.isFinite(raw.nearest)) gaps.push(raw.nearest);
    }
  }
  return _medianOf(gaps);
}

let _segmenter = null;
function getSegmenter() {
  if (_segmenter !== null) return _segmenter || null;
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      _segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
      return _segmenter;
    } catch (_e) {
      _segmenter = false;
      return null;
    }
  }
  _segmenter = false;
  return null;
}

function splitGraphemes(text) {
  const seg = getSegmenter();
  if (seg) {
    const out = [];
    for (const s of seg.segment(text)) out.push(s.segment);
    return out;
  }
  return Array.from(text);
}

function getGlyphCache(fontSpec) {
  let cache = _glyphCacheByFontSpec.get(fontSpec);
  if (!cache) {
    cache = new Map();
    _glyphCacheByFontSpec.set(fontSpec, cache);
  }
  return cache;
}

// ctx.font は呼び出し側で既に fontSpec に揃っている前提。
function measureGlyph(ctx, fontSpec, glyph) {
  const cache = getGlyphCache(fontSpec);
  let entry = cache.get(glyph);
  if (entry) return entry;

  const m = ctx.measureText(glyph);
  const advance = Number(m.width) || 0;
  // measureText の actualBoundingBoxLeft は「描画原点 x=0 から ink 左端まで、
  // 左方向を正」とする値。ink 左端の x 座標は -actualBoundingBoxLeft。
  // ここで保持する leftBearing は「ink 左端が origin より右にあれば正、
  // 左にはみ出していれば負」とする (= origin から ink 左端までの符号付き距離)。
  // 通常の漢字・かなは leftBearing >= 0、イタリック等で稀に負になる。
  const inkLeft = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
  const inkRight = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : advance;
  const leftBearing = -inkLeft;
  const rightBearing = advance - inkRight;

  entry = { advance, leftBearing, rightBearing };
  if (cache.size >= GLYPH_CACHE_LIMIT_PER_FONT) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(glyph, entry);
  return entry;
}

const _BRACKET_OPEN = new Set(Array.from("「『（〈《【〔〘〚([{‘“〝"));
const _BRACKET_CLOSE = new Set(Array.from("」』）〉》】〕〙〛)]}’”〞"));
const _PUNCT_MID = new Set(Array.from("、。，．・：；,."));
// 全角 `！？` は日本語本文に挿入されることが多く、左に大きな余白を抱えるので
// 強く詰める。ASCII `!?` は Latin の語末で控えめに詰めるべき (kern table 任せ)。
const _PUNCT_BANG_FULL = new Set(Array.from("！？"));
const _PUNCT_BANG_ASCII = new Set(Array.from("!?"));
const _SMALL_KANA = new Set(Array.from("ぁぃぅぇぉゃゅょっァィゥェォャュョッヮヵヶ"));

function classify(ch) {
  if (!ch) return "other";
  if (_BRACKET_OPEN.has(ch)) return "bracket_open";
  if (_BRACKET_CLOSE.has(ch)) return "bracket_close";
  if (_PUNCT_MID.has(ch)) return "punct";
  if (_PUNCT_BANG_FULL.has(ch)) return "punct_bang_full";
  if (_PUNCT_BANG_ASCII.has(ch)) return "punct_bang_ascii";
  if (_SMALL_KANA.has(ch)) return "small_kana";
  if (ch === "ー" || ch === "—" || ch === "～") return "long_sound";

  const cp = ch.codePointAt(0);
  if (cp === undefined) return "other";
  // ひらがな
  if (cp >= 0x3041 && cp <= 0x309F) return "hiragana";
  // カタカナ
  if (cp >= 0x30A0 && cp <= 0x30FF) return "katakana";
  // CJK 統合漢字 (基本 + Ext A)
  if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)) return "kanji";
  // ASCII / 全角英数
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0xFF10 && cp <= 0xFF19)) return "digit";
  if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) return "latin";
  if ((cp >= 0xFF21 && cp <= 0xFF3A) || (cp >= 0xFF41 && cp <= 0xFF5A)) return "latin";
  // 空白 (半角 / タブ / 全角)。全角は装飾目的で打たれがちで詰めの強さが
  // 異なるため、半角と分類を分ける。
  if (ch === " " || ch === "\t") return "space";
  if (ch === "　") return "ideographic_space"; // U+3000
  return "other";
}

const _SPACE_CLASSES = new Set(["space", "ideographic_space"]);

// 隣接ペアの「詰め強度」係数を 0..1 で返す。1 が最大、0 で詰めない。
//
// 方針: 字形がぶつかりやすい「漢字 + 漢字」だけ控えめにし、それ以外は等しく
// しっかり詰める。日本語フォントの Latin / digit は em-box の中央に小さく
// 配置されていて余白が大きいので、弱めると逆にスカスカに見える (例:
// 「Yo!」「MUSIC」)。本物の Latin 書体は kern table を持つので、それは CSS の
// `font-kerning: normal` (Canvas2D デフォルトで有効) に任せ、本実装は
// optical 詰めで「字面の余白だけ」削る役割に徹する。
const _PUNCTS = new Set(["punct", "punct_bang_full", "punct_bang_ascii"]);
const _BRACKETS = new Set(["bracket_open", "bracket_close"]);
// 約物 (句読点・全角/ASCII の ！？・括弧) をまとめた集合。
// 素のオプティカル (強めモード) では:
//   - 中央値の母集団から外す (本文ペアだけで基準を作る)
//   - ペアごとに別ルール (平均 gap ではなく bbox gap を中央値に合わせる) で詰める
// 字面が片寄って ink ボックスが小さい約物を平均 gap で均すと大穴になるため。
const _PUNCT_BRACKET_CLASSES = new Set([
  "punct", "punct_bang_full", "punct_bang_ascii", "bracket_open", "bracket_close",
]);

function pairClassFactor(left, right) {
  // 空白系の詰めは pairClassFactor を介さず layoutTextRun 側で
  // 「空白の advance 自体を縮める」特例として処理する (連続空白の保護を含む)。
  // ここに来るのは念のためのフォールバック。
  if (_SPACE_CLASSES.has(left) || _SPACE_CLASSES.has(right)) return 0;

  // 「punct + bracket_close」「bracket_open + punct」のように約物が連続するペアは
  // 両者ともベアリングが大きいので、フル係数で詰めると過剰に重なる。控えめに。
  if (right === "bracket_close" && _PUNCTS.has(left)) return 0.5;
  if (left === "bracket_open" && _PUNCTS.has(right)) return 0.5;
  // 約物同士 (! 」 や 、 ）など) も同様に控えめ。
  if (_PUNCTS.has(left) && _BRACKETS.has(right)) return 0.5;
  if (_BRACKETS.has(left) && _PUNCTS.has(right)) return 0.5;

  // 句読点・括弧まわりは強く詰める。
  if (left === "bracket_close") return 1.0;
  if (right === "bracket_open") return 1.0;
  if (left === "bracket_open") return 1.0;
  if (right === "bracket_close") return 1.0;
  if (left === "punct" || right === "punct") return 1.0;

  // 全角 ！？ は前後とも強く詰める (本文中の感嘆/疑問は左右の余白が大きい)。
  if (left === "punct_bang_full" || right === "punct_bang_full") return 1.0;
  // ASCII !? は Latin の語末で控えめに (本来は kern table 任せ)。
  if (left === "punct_bang_ascii" || right === "punct_bang_ascii") return 0.5;

  // 小書きかな・長音
  if (left === "small_kana" || right === "small_kana") return 0.55;
  if (left === "long_sound" || right === "long_sound") return 0.4;

  // 漢字同士は字面が真四角でぶつかりやすいので控えめに。
  if (left === "kanji" && right === "kanji") return 0.20;

  // 上記以外 (Latin / digit / かな・カタカナ・他) は均一に詰める。
  return 0.6;
}

// Latin/digit ペアに保証する最低詰め量 (em). M/U/W のように em-box 端まで使う
// 字はベアリング ≒ 0 で optical 詰めが効かないが、その隣に I/T/L のように
// 大きいベアリングを持つ字が来ると詰まり方が不均等になる。最低値を入れて
// 平均化する。
const _LATIN_MIN_TSUME_EM = 0.04;

// 約物アキ詰め (A) の目標アキ (em)。句読点・括弧の bbox gap をこの値まで詰める。
// 詰めすぎ (穴の逆=窮屈) を避け、本文 CJK の締まった字間と同程度の air を残す。
const PUNCT_AKI_EM = 0.10;

// 最低 ink gap フロア (C) の基本値 (em)。詰めた結果の bbox gap がこれを下回らない
// ようにして字面の接触・窮屈を防ぐ。縁取りがある場合は別途 2*outlineWidth と max を取る。
const MIN_INK_GAP_EM = 0.03;

// 詰め (E)。CJK 本文は「自然な bbox gap の中央値」をそのまま揃え目標にすると緩く、
// 理想カーニング (締まった均一組み) に届かない。中央値を固定 em 目標 (CJK_TIGHTEN_TARGET_EM)
// へ CJK_TIGHTEN_STRENGTH だけ寄せて締める:
//   target = median*(1-strength) + (fSize*targetEm)*strength
// これで緩い書体ほど絶対量で多く詰まり、各書体が締まった共通リズムへ寄る。
// 欧文 (Latin/digit) は元々詰まっているので中央値どおり (LATIN_GAP_TIGHTEN)。
const CJK_TIGHTEN_TARGET_EM = 0.08;
const CJK_TIGHTEN_STRENGTH = 0.75;
const LATIN_GAP_TIGHTEN = 1.0;

function isAlnumClass(c) {
  return c === "latin" || c === "digit";
}

export function layoutTextRun(ctx, text, options = {}) {
  const {
    fontSpec,
    fontSize,
    letterSpacing = 0,
    opticalKerning = false,
    // 高品位モード: 各 glyph を off-screen に焼いて Y 行ごとの輪郭から
    // 「衝突しない最大詰め」を直接求める。class ベースより強く・均等に詰まる代わりに
    // 初回 1 文字あたり off-screen canvas + getImageData の重い処理を行う。
    // テロップ単位で fontSpec / fontSize が固定なら 2 文字目以降は cache hit。
    opticalKerningHighQuality = false,
    maxTsumeEm = 0.35,
    minPairGapEm = 0.04,
    // outlineWidth (px) が指定されると、HQ モードの pair shift 計算で minGap に
    // outlineWidth * 1.5 を safety として加算する。stroke は両側に伸びるので
    // 片側ぶん (= outlineWidth) + 安全マージン 0.5 で計 1.5 倍。
    outlineWidth = 0,
    // 行均しの基準 gap を呼び出し側から固定する (= 本文全体で 1 つに統一する)。
    // 指定があれば行内中央値の計算をスキップしてこの値を使う。
    // computeOpticalMedianGapForLines の戻り値をそのまま渡す想定。
    medianGapOverride = null,
  } = options;
  if (!text) return { glyphs: [], width: 0 };

  const chars = splitGraphemes(text);
  if (chars.length === 0) return { glyphs: [], width: 0 };

  // fontSpec 不明時はキャッシュなしで素朴に計測 (テストやエッジケース用)。
  const useCache = !!fontSpec;

  const metrics = chars.map((ch) => {
    if (useCache) return measureGlyph(ctx, fontSpec, ch);
    const m = ctx.measureText(ch);
    return {
      advance: Number(m.width) || 0,
      leftBearing: -(Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0),
      rightBearing: (Number(m.width) || 0) - (Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : 0),
    };
  });

  const fSize = Number(fontSize) || 0;
  const targetSpacePx = fSize > 0 ? fSize * minPairGapEm : 0;
  const maxTsumePx = fSize > 0 ? fSize * maxTsumeEm : 0;

  // 各文字の class と空白判定を先に決めておく (ルックアラウンドで再利用)。
  const classes = chars.map((c) => classify(c));
  const isSpaceFlags = classes.map((c) => _SPACE_CLASSES.has(c));

  // 強めモード「素のオプティカル」: 行内の本文ペアを揃える基準 (実測 gap 中央値)。
  // クラス係数・固定 em を介さず書体非依存に均す。標準モードでは使わない。
  // medianGapOverride が渡されていれば本文全体で統一された基準を優先する。
  // 欧文 (Latin/digit) 同士は和文中央値とは別の欧文中央値で均す (B)。欧文中央値は
  // per-run 計算 (measure/draw とも同じ line から導くので中央寄せは自己整合)。
  let lineMedianGap = null;
  let lineLatinMedian = null;
  if (opticalKerning && opticalKerningHighQuality && fontSpec && fSize > 0) {
    lineMedianGap = (medianGapOverride != null && Number.isFinite(medianGapOverride))
      ? medianGapOverride
      : computeLineMedianGap(chars, isSpaceFlags, fontSpec, fSize);
    lineLatinMedian = computeLineLatinMedian(chars, fontSpec, fSize);
  }

  const glyphs = [];
  let cursor = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const m = metrics[i];
    let renderedAdvance = m.advance;
    const curClass = classes[i];
    const curIsSpace = isSpaceFlags[i];
    // 空白は描画しない (drawable=false)。描画関数側は drawable===false でスキップ。
    const drawable = !curIsSpace;

    if (i > 0) {
      let opticalAdjust = 0;
      if (opticalKerning && fSize > 0) {
        const prevClass = classes[i - 1];
        const prevIsSpace = isSpaceFlags[i - 1];
        if (curIsSpace && !prevIsSpace) {
          // 空白の advance を「typography rule」で決める (透明 glyph 扱いをしない)。
          //   ・連続空白 (run >= 2) の起点は装飾意図を尊重して native のまま
          //   ・run = 1 (= 単発空白) のときだけ target に縮める / 場合により広げる
          // 次の非空白 (= 右側の字種) もルックアヘッドで取得する。
          let runEnd = i;
          while (runEnd + 1 < chars.length && isSpaceFlags[runEnd + 1]) runEnd += 1;
          const runLen = runEnd - i + 1;
          if (runLen === 1) {
            const nextIdx = i + 1 < chars.length ? i + 1 : -1;
            const nextClass = nextIdx >= 0 ? classes[nextIdx] : null;
            // HQ モードでは前後 glyph の profile (density 含む) を強制 build。
            // 標準モードでは profile を作らないので getCachedDensity (= 既存 cache のみ)。
            // 初回レイアウトでも density 補正が効くように。
            const prevDensity = (opticalKerningHighQuality && fontSpec)
              ? (getOrBuildProfile(fontSpec, fSize, chars[i - 1])?.density ?? null)
              : getCachedDensity(fontSpec, fSize, chars[i - 1]);
            const nextDensity = (nextIdx >= 0 && opticalKerningHighQuality && fontSpec)
              ? (getOrBuildProfile(fontSpec, fSize, chars[nextIdx])?.density ?? null)
              : (nextIdx >= 0 ? getCachedDensity(fontSpec, fSize, chars[nextIdx]) : null);
            const targetEm = computeSpaceTargetEm(prevClass, nextClass, curClass, prevDensity, nextDensity);
            renderedAdvance = fSize * targetEm;
            // 空白が完全消失しないよう最低値をキープ。
            const minPx = fSize * (curClass === "ideographic_space" ? 0.40 : 0.10);
            if (renderedAdvance < minPx) renderedAdvance = minPx;
          }
          // run >= 2 のときは native advance のまま (装飾意図保護)。
        } else if (!curIsSpace && !prevIsSpace) {
          if (opticalKerningHighQuality && fontSpec) {
            // 強め (素のオプティカル): 行内の本文ペアを実測 gap の中央値に揃える。
            // gap が中央値より広いペアは詰め (shift>0)、狭いペアは広げる (shift<0)。
            // 詰める側だけ最近接 gap が負 (衝突) にならない範囲に制限する。
            const outlineMarginPx = (Number(outlineWidth) || 0) * 1.5;
            // 最低 ink gap フロア (C): 詰めた結果の bbox gap がこれを下回らないようにする。
            // 字面が触れて窮屈に見えるのを防ぎ、縁取りがあれば stroke 同士 (両側に
            // outlineWidth ずつ伸びる) の融合も防ぐ (= 2 * outlineWidth 以上を確保)。
            const minGapPx = Math.max(fSize * MIN_INK_GAP_EM, (Number(outlineWidth) || 0) * 2);
            // raw (ペアの素 gap 幾何) は中央値の有無に関係なく常に計算する。
            // 中央値除外で全欧文行 lineMedianGap=null でもオプティカルを止めない。
            const raw = computePairRawGap(fontSpec, fSize, chars[i - 1], chars[i]);
            const involvesPunct = _PUNCT_BRACKET_CLASSES.has(prevClass)
              || _PUNCT_BRACKET_CLASSES.has(curClass);
            // 本文同士の揃え目標: 欧文 (Latin/digit) 同士は欧文中央値、それ以外
            // (CJK 同士・CJK↔欧文境界) は和文中央値。さらに詰め係数 (E) を掛けて
            // 中央値より詰める (理想カーニングは自然な中央値より締まっているため)。
            const bothLatin = isAlnumClass(prevClass) && isAlnumClass(curClass);
            const rawTarget = (bothLatin && lineLatinMedian != null)
              ? lineLatinMedian
              : lineMedianGap;
            let bodyTarget = null;
            if (rawTarget != null) {
              if (bothLatin) {
                bodyTarget = rawTarget * LATIN_GAP_TIGHTEN;
              } else {
                // CJK: 中央値を固定 em 目標へ strength だけ寄せて締める (E)。
                const tEm = fSize * CJK_TIGHTEN_TARGET_EM;
                bodyTarget = rawTarget * (1 - CJK_TIGHTEN_STRENGTH) + tEm * CJK_TIGHTEN_STRENGTH;
              }
            }
            if (raw && involvesPunct && raw.nearest != null && Number.isFinite(raw.nearest)) {
              // 約物アキ詰め (A): 句読点・括弧は字面が片寄って ink ボックスが小さく、
              // 平均 gap を本文中央値に揃えると逆に大穴になる。約物は中央値に依存させず、
              // bbox gap (nearest) を固定の小さなアキ (約物半角相当) に詰めて隣字を寄せる。
              const target = Math.max(fSize * PUNCT_AKI_EM, minGapPx);
              let shift = raw.nearest - target;
              if (shift > 0) {
                const safePull = Math.max(0, raw.nearest - minGapPx);
                if (shift > safePull) shift = safePull;
              }
              opticalAdjust = -shift;
            } else if (raw && raw.nearest != null && Number.isFinite(raw.nearest) && bodyTarget != null) {
              // 本文同士: bbox gap (nearest) を目標中央値に揃える (D)。欧文/和文は別基準 (B)。
              // nearest を均すと目に見える隙間が直接そろう (meanGap は字形ノイズで乖離する)。
              const target = Math.max(bodyTarget, minGapPx);
              let shift = raw.nearest - target;
              if (shift > 0) {
                const safePull = Math.max(0, raw.nearest - minGapPx);
                if (shift > safePull) shift = safePull;
              }
              opticalAdjust = -shift;
            } else {
              // 目標中央値が取れない (本文ペアが無い等): 従来の score 最小化にフォールバック。
              const shift = computePairShift(
                fontSpec, fSize, chars[i - 1], chars[i], prevClass, curClass, outlineMarginPx,
              );
              if (shift > 0) opticalAdjust = -shift;
            }
          } else {
            // 標準: 左の右ベアリング + 右の左ベアリングを target まで詰める。
            const prev = metrics[i - 1];
            const pairSpace = (prev.rightBearing || 0) + (m.leftBearing || 0);
            const excess = pairSpace - targetSpacePx;
            if (excess > 0) {
              const factor = pairClassFactor(prevClass, curClass);
              if (factor > 0) {
                opticalAdjust = -Math.min(excess, maxTsumePx) * factor;
              }
            }
            // Latin/digit 同士は最低詰め量を保証して、M-U / U-S のような不均等を均す。
            if (isAlnumClass(prevClass) && isAlnumClass(curClass)) {
              const minNegative = -fSize * _LATIN_MIN_TSUME_EM;
              if (opticalAdjust > minNegative) opticalAdjust = minNegative;
            }
          }
        }
        // (curIsSpace && prevIsSpace) と (prevIsSpace && !curIsSpace) は触らない:
        // 連続空白の保護 / 空白の右隣は空白側で既に縮めているため。
      }
      cursor += opticalAdjust;
      // optical 後に letter_spacing を一律加算 (= ユーザー指定の「再調整」)。
      // ただし空白の左右では加算しない: 空白自体が単語区切りなので、文字間 px を
      // 増やしたときに空白幅まで連動して広がると不自然になる (空白は computeSpaceTargetEm
      // で別軸に決定)。
      if (!curIsSpace && !isSpaceFlags[i - 1]) {
        cursor += letterSpacing;
      }
    }
    glyphs.push({
      text: chars[i],
      x: cursor,
      advance: renderedAdvance,
      leftBearing: m.leftBearing,
      rightBearing: m.rightBearing,
      // 描画関数側は drawable === false ならスキップ (空白は ink を持たないので
      // fillText しても無害だが、明示的に区別したほうが意図が伝わる)。
      drawable,
    });
    cursor += renderedAdvance;
  }
  return { glyphs, width: cursor };
}

export function measureTextRunWidth(ctx, text, options = {}) {
  return layoutTextRun(ctx, text, options).width;
}

export function clearTextLayoutCache(fontSpec = null) {
  if (fontSpec) {
    _glyphCacheByFontSpec.delete(fontSpec);
    _profileCacheByFontSpec.delete(fontSpec);
    // pair shift cache は font 単位で間引けないので fontSpec 指定でも全消し
    // (fontSpec 変更時はそもそも cache キーが無効化されるので影響軽微)。
    _pairShiftCache.clear();
    _pairRawGapCache.clear();
  } else {
    _glyphCacheByFontSpec.clear();
    _profileCacheByFontSpec.clear();
    _pairShiftCache.clear();
    _pairRawGapCache.clear();
  }
}

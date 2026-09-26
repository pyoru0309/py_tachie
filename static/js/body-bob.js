// BPM 同期の体の揺れ (bob) の共通ロジック。シーン全体の揺れ (bpmBob) とキャラごとの
// 揺れ (character.bob) の両方をここで計算する。preview (playback.js) と書き出し
// (export/export-session.js) が同じ関数を使うので式は 1 箇所 (lipsync.js と同じ方針)。
//
// 揺れ方 (style):
//   wave   … 従来の常時サイン波 (溜めなし)
//   bounce … 溜め → 拍でなめらかに上がって戻る
//   hop    … 溜め → 拍でジャンプ (放物線)
//   kick   … 溜め → 拍で素早く上がり、ゆっくり戻る
//   nod    … 溜め → 拍で下へ沈む (うなずき)
// 跳ね系は 1 周期 (= 1 拍 × rate) のうち先頭 (1 - hold) だけ動き、残り hold は静止。
// 周期の頭 = 拍なので「＿＿＿■」の ■ が拍に乗る (周期なので ■＿＿＿ と同じ)。
//
// 拍位置 (beat position):
//   - BPM 手入力 / シーン BPM: シーン内通算秒 × bpm / 60 (従来と同じ位相)
//   - MIDI 自動検出: scene-bundle の beatMap (MIDI のテンポマップをカット内秒へ写した
//     折れ線)。テンポ変化にそのまま追従し、rate を掛けるので 180→220 を半分にすれば
//     90→110 で揺れる。
//
// 時間はキャラアニメ fps (8/12/24) でコマ打ちしない。溜めが長いと跳ねる区間は 0.1〜0.2 秒
// しかなく、12fps のコマ打ちでは 1 コマで終わって「一瞬浮くだけ」に見えるため。
// preview は実時間、書き出しは出力フレームの時刻を渡す。
//
// 口パクのときだけ揺らす (onlyWhileSinging):
//   周期 c で揺らすかは「直前の周期 c-1 か、周期 c の頭で声が出ていたか」で周期の頭に
//   決める。途中で切り替えないので、波でも跳ねでも動きが途切れて飛ぶことがない
//   (どの揺れ方も周期の頭で 0 に戻る)。

export const BOB_STYLES = ["wave", "bounce", "hop", "kick", "nod"];
export const BOB_RATES = [2, 1, 0.5, 0.25];
export const DEFAULT_BOB_HOLD = 0.7;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// シーン bpmBob / キャラ bob の生データ → 計算用の形。無効なら null。
// requireBpm=true (キャラ) は bpmSource="manual" のとき bpm > 0 が必要。
export function normalizeBob(raw, { requireBpm = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const amplitudePx = Number(raw.amplitudePx) || 0;
  if (!(amplitudePx > 0)) return null;
  const style = BOB_STYLES.includes(raw.style) ? raw.style : "wave";
  const rate = BOB_RATES.includes(Number(raw.rate)) ? Number(raw.rate) : 1;
  const holdRaw = Number(raw.hold);
  const hold = Number.isFinite(holdRaw) ? clamp(holdRaw, 0, 0.95) : DEFAULT_BOB_HOLD;
  const bpmSource = raw.bpmSource === "midi" ? "midi" : "manual";
  const bpm = Number(raw.bpm) || 0;
  if (requireBpm && bpmSource === "manual" && !(bpm > 0)) return null;
  return {
    amplitudePx,
    style,
    rate,
    hold,
    bpmSource,
    bpm,
    onlyWhileSinging: !!raw.onlyWhileSinging,
  };
}

// 1 周期内の位相 p (0..1) → 縦オフセット (px、+ が下)。
export function bobShapeOffset(bob, p) {
  const amp = bob.amplitudePx;
  if (bob.style === "wave") return amp * Math.sin(2 * Math.PI * p);
  const active = Math.max(0.05, 1 - bob.hold);
  if (p >= active) return 0;
  const q = p / active;
  switch (bob.style) {
    case "hop":
      return -amp * 4 * q * (1 - q);
    case "kick": {
      // 25% で一気に上がり (easeOutCubic)、残りでゆっくり戻る (easeInOutSine)。
      if (q < 0.25) {
        const r = q / 0.25;
        return -amp * (1 - (1 - r) ** 3);
      }
      const r = (q - 0.25) / 0.75;
      return -amp * (1 - (0.5 - 0.5 * Math.cos(Math.PI * r)));
    }
    case "nod":
      return amp * Math.sin(Math.PI * q);
    case "bounce":
    default:
      return -amp * Math.sin(Math.PI * q);
  }
}

// beatMap ({segments: [[t, beat, beatsPerSec], ...]}、t はカット内秒) から拍位置。
export function beatFromMap(beatMap, localSec) {
  const segs = beatMap?.segments;
  if (!Array.isArray(segs) || !segs.length) return null;
  let seg = segs[0];
  for (const s of segs) {
    if (s[0] <= localSec) seg = s;
    else break;
  }
  return seg[1] + (localSec - seg[0]) * seg[2];
}

// 周期位置 (拍位置 × rate)。取れなければ null (= 揺らさない)。
//   bpm: bpmSource="manual" のときに使う BPM (キャラ = bob.bpm、シーン = scene.bpm)
export function bobCyclePosition(bob, { bpm, beatMap, localSec, sceneSec }) {
  let beat = null;
  if (bob.bpmSource === "midi") beat = beatFromMap(beatMap, localSec);
  if (beat == null) {
    // MIDI が無い (外した) ときは手入力 / シーンの BPM に戻す。
    if (!(bpm > 0)) return null;
    beat = (sceneSec * bpm) / 60;
  }
  return beat * bob.rate;
}

// 周期 c で揺らすか (onlyWhileSinging)。voicedAtLocal(t) は「カット内 t 秒で声が出て
// いたか」。直前の周期と、周期 c の頭のフレームだけを見る (fps 刻みで遡る)。
// カット頭より前は分からないので見ない。
export function cycleIsVoiced({ cycle, localSec, cycleAt, voicedAtLocal, fps = 24, maxBackSec = 8 }) {
  const step = 1 / fps;
  const stop = Math.max(0, localSec - maxBackSec);
  let t = Math.floor(localSec * fps + 1e-6) / fps;
  let firstOfCycle = null;
  for (; t >= stop - 1e-9; t -= step) {
    const c = Math.floor(cycleAt(t) + 1e-9);
    if (c >= cycle) {
      firstOfCycle = t; // 遡るほど周期 c の頭に近づく
      continue;
    }
    if (c < cycle - 1) break;
    if (voicedAtLocal(t)) return true;
  }
  return firstOfCycle != null && voicedAtLocal(firstOfCycle);
}

// preview の実時間音量 (AnalyserNode) 用: 過去の観測から周期ごとの判定を固定する。
// observe → isActive の順に毎フレーム呼ぶ。
export function createStreamingVoiceGate() {
  const lastVoicedCycle = new Map();
  const decided = new Map();
  return {
    observe(charId, cycle, voiced) {
      if (!voiced) return;
      const prev = lastVoicedCycle.get(charId);
      if (prev == null || cycle > prev) lastVoicedCycle.set(charId, cycle);
    },
    isActive(charId, cycle) {
      const key = `${charId}:${cycle}`;
      if (!decided.has(key)) {
        const last = lastVoicedCycle.get(charId);
        decided.set(key, last != null && last >= cycle - 1);
        if (decided.size > 512) decided.delete(decided.keys().next().value);
      }
      return decided.get(key);
    },
  };
}

// 1 フレームぶんの { [charId]: dy }。シーンの揺れ (全員) + キャラの揺れ を合算する。
//   characters: layerData.characters ({ id, bob })
//   sceneBob: idleMotion.bpmBob、sceneBpm: idleMotion.bpm
//   beatMaps: layerData.beatMaps ({ scene, byChar })
//   isVoiced(charId, cycle, cycleAt, layer): onlyWhileSinging の判定 (呼び出し側が実装)。
//     layer は "scene" / "own" (周期の長さが違うので、判定を覚えるときは層ごとに分ける)
//   voicedAtLocal(charId, t) を渡せば isVoiced の代わりに cycleIsVoiced で判定する。
export function computeBobDyByChar({
  characters, sceneBob, sceneBpm, beatMaps, localSec, sceneSec, isVoiced, voicedAtLocal,
}) {
  const out = {};
  const scene = normalizeBob(sceneBob);
  for (const char of characters || []) {
    if (!char?.id) continue;
    let dy = 0;
    const layers = [];
    if (scene) layers.push({ layer: "scene", bob: scene, bpm: Number(sceneBpm) || 0, beatMap: beatMaps?.scene });
    const own = normalizeBob(char.bob, { requireBpm: true });
    if (own) {
      layers.push({
        layer: "own",
        bob: own,
        bpm: own.bpm,
        beatMap: beatMaps?.byChar?.[char.id] || beatMaps?.scene,
      });
    }
    for (const { layer, bob, bpm, beatMap } of layers) {
      const cycleAt = (t) => bobCyclePosition(bob, {
        bpm, beatMap, localSec: t, sceneSec: sceneSec - localSec + t,
      });
      const pos = cycleAt(localSec);
      if (pos == null) continue;
      const cycle = Math.floor(pos + 1e-9);
      if (bob.onlyWhileSinging) {
        const voiced = isVoiced
          ? isVoiced(char.id, cycle, cycleAt, layer)
          : (voicedAtLocal
            ? cycleIsVoiced({ cycle, localSec, cycleAt, voicedAtLocal: (t) => voicedAtLocal(char.id, t) })
            : false);
        if (!voiced) continue;
      }
      dy += bobShapeOffset(bob, pos - cycle);
    }
    out[char.id] = dy;
  }
  return out;
}

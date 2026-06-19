// ===========================================================================
// アプリ全体で共有する状態オブジェクト
// 各モジュールはこの state を import してプロパティを読み書きする (再代入禁止)
// ===========================================================================

export const state = {
  manifest: null,
  scenario: { version: 4, title: "scenario", scenes: [], cuts: [] },
  selectedCutId: null,
  // 複数選択中のカット ID 集合。Shift+矢印 / Shift+クリックで広げる。
  // 空 Set のときは selectedCutId のみが選択 (= 単一選択)。
  selectedCutIds: new Set(),
  // 範囲選択 (Shift+矢印 / Shift+クリック) のアンカー。
  cutSelectionAnchorId: "",
  selectedTelopId: null,
  // 複数選択中のテロップ ID 集合。常に selectedTelopId（プライマリ）を含む。
  // 単一選択時は { selectedTelopId } と同じ。空 Set のときは「未選択」を表す。
  selectedTelopIds: new Set(),
  // 効果音 (sound effect) の選択。テロップと同様に複数選択も可能。
  selectedSoundEffectId: null,
  // 複数選択中の効果音 ID 集合。常に selectedSoundEffectId（プライマリ）を含む。
  // 単一選択時は { selectedSoundEffectId } と同じ。空 Set のときは「未選択」。
  selectedSoundEffectIds: new Set(),
  // SE アセットの長さキャッシュ (Map<src, durationSec>)。timeline.js が描画時に
  // /api/audio-duration を引いて memoize する。未取得時は SOUND_EFFECT_CHIP_PX
  // の最小幅で描く。
  soundEffectDurations: new Map(),
  soundEffectDurationFetching: new Set(),
  // 動画レイヤー (videoLayer) の選択。テロップと同様に複数選択も可能。
  selectedVideoLayerId: null,
  // 複数選択中の動画レイヤー ID 集合。常に selectedVideoLayerId（プライマリ）を含む。
  // 単一選択時は { selectedVideoLayerId } と同じ。空 Set のときは「未選択」。
  selectedVideoLayerIds: new Set(),
  // 動画レイヤーのメタデータキャッシュ (Map<src, { duration, width, height, hasAudio }>)。
  // /api/video-duration を引いて memoize する。timeline の幅計算 / computeVideoFit
  // / 書き出し時の音声 mux 判定で共通利用する。
  videoLayerDurations: new Map(),
  videoLayerDurationFetching: new Set(),
  // ライブプレビュー用に保持する HTMLVideoElement (Map<videoLayerId, HTMLVideoElement>)。
  // playback.js が cut/scene 切替で create / dispose する。
  playbackVideoLayerEls: new Map(),
  // preview の VideoTextureProvider 群 (Map<videoLayerId, VideoTextureProvider>)。
  // scene rebuild ごとに「前回 → dispose、今回 → new」する。scene-builder の dispose
  // からは解放しない (cut 切替で次の scene が同じ provider を使い回す export と
  // lifecycle を揃えるため)。
  playbackVideoLayerProviders: new Map(),
  // VL preview audio (`<audio>` element + source→stream map) を group 単位で保持。
  // key は primary layer id (= group の最初の layer.id)。clean PCM (= aresample +
  // asetpts=N/SR/TB で sample-count base に振り直した連続 PCM) を src にして、
  // 編集 UI 上の source-time を `source_to_stream_time` で stream-time に変換して
  // `currentTime` に渡すことで「途中 seek 再生」でも PTS gap の影響なく preview
  // が export と一致する。VL の `<video>` 自体は muted=true にして映像専用に。
  // 詳細: [[project-vl-audio-source-time-preserving-2026-05-21]]
  playbackVideoLayerAudios: new Map(),
  // audio src の解決 + map info の fetch in-flight ガード (src 単位)。Map<src, Promise<{url, mapInfo}>>
  playbackVideoLayerAudioFetching: new Map(),
  // src → {url, mapInfo} の memoize。同 src の audio element はこれを共有する。
  playbackVideoLayerAudioInfo: new Map(),
  editorTarget: "cut", // "cut" | "telop" | "soundEffect" | "videoLayer" — 右パネルが何を編集しているか
  playbackTimer: null,
  playbackAudio: null,
  isPlaying: false,
  // 再生時のループモード:
  //   "off"   = ループなし (シナリオ末尾で停止)
  //   "cut"   = 現在のカットを繰り返す
  //   "scene" = シーン全体 (= 現在は scenario 全カット) を繰り返す
  // 将来「シーン」が複数になりプロジェクト = ステージ階層を持つ拡張時に
  // "stage" を追加予定。トグルは playback.js の playPreviewPlayback で参照。
  loopMode: "off",
  lastPath: null,
  previewRequestId: 0,
  // 事前解析 (プリレンダー) のカット単位ステータス Map<cutId, "analyzing"|"ready">。
  // タイムライン最上部の赤(解析中)/緑(解析済)ストリップ表示に使う。値が無いカットは
  // idle (= 未解析、薄グレー)。warm fetch (vizSourceBuild=true) 成功で ready になる。
  // プロジェクト跨ぎのカット ID は重複しない (cut_<ts>) ので明示クリア不要 (= 旧 ID は
  // 現カットに一致せず無視される)。同一プロジェクト内のカット編集後は再実行で更新。
  cutPrerenderStatus: new Map(),
  autoSaveTimer: null,
  isLoadingCut: false,
  projects: [],
  activeProjectId: "",
  // state.scenario / state.manifest がどのプロジェクトから読み込まれたか。
  // activeProjectId はサーバーの current_project や UI 操作で変わり得るため、
  // 保存時は loadedProjectId と保存先 projectId の一致を必ず確認する。
  loadedProjectId: "",
  projectDashboardVisible: true,
  projectFormMode: "create",
  projectFormProjectId: null,
  projectDeleteTarget: null,
  currentCharacters: [],
  selectedCharacterIndex: 0,
  // 「移動」モーションの基準 (X,Y) ピボット指定モード。true のとき preview canvas
  // のクリック/ドラッグが pivot X/Y input の書き換え経路として動く + 通常の
  // キャラドラッグは skip される。
  motionPivotPickingMode: false,
  // 音声合成連携の状態 (state は最後に取得したカタログ)。
  // 起動時に /api/tts/state を fetch して入れ、以降は全体設定 / キャラ紐付け /
  // セリフパネルから参照する。
  tts: null,
};

// デバッグ用: dev tools の console から `__spliteState` で state を参照できる。
// 本番でも害は無いので常に公開 (ESM module 内の `state` は private の symbol で、
// console から直に触れないため debugging が著しく困難になる)。
if (typeof window !== "undefined") {
  window.__spliteState = state;
}

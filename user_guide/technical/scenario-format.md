# シナリオ形式

シナリオは `projects/<project_id>/scenarios/main.json` に保存されます。
シナリオは `scenes[]` 配列でまとめられ、各シーンは背景動画 / BGM のメディアコンテキストを持ち、その中に **カット列 (`cuts`)** / **テロップ列 (`telops`)** / **効果音列 (`soundEffects`)** が並列で並びます。テロップ・効果音はカットの境界に縛られず、シーン全体に対して任意区間に置けます。

## 全体構造

```jsonc
{
  "version": 4,
  "title": "sample",
  "scenes": [
    {
      "id": "scene_001",
      "title": "シーン1",
      "background": "",
      "videoTrack": {
        "src": "assets/videos/loop.mp4",
        "muted": true,
        "fit": "cover",
        "trimStartSec": 0,
        "trimEndSec": null,
        "loop": "loop",
        "speed": 1.0
      },
      "bgmTracks": [
        {
          "src": "assets/audio/bgm.wav",
          "volume": 0.6,
          "trimStartSec": 0,
          "fadeInSec": 1.0,
          "fadeOutSec": 1.5,
          "useForLipSync": false
        }
      ],
      "soundEffects": [
        {
          "id": "se_001",
          "src": "assets/sound_effects/door.wav",
          "startFrame": 48,
          "volume": 1.0
        }
      ],
      "videoLayers": [
        {
          "id": "vl_001",
          "src": "assets/videos/title.mp4",
          "startFrame": 0,
          "trimStartSec": 0.0,
          "trimEndSec": 3.0,
          "fit": "contain",
          "scale": 1.0,
          "offsetX": 0,
          "offsetY": 0,
          "layer": "above_fg",
          "opacity": 1.0,
          "fadeInEnabled": false,
          "fadeInSec": 0.5,
          "fadeOutEnabled": true,
          "fadeOutSec": 0.8,
          "muted": false,
          "volume": 1.0
        }
      ],
      "bpm": null,
      "cuts": [],
      "telops": []
    }
  ]
}
```

| 項目 | 説明 |
| --- | --- |
| `version` | シナリオ形式のバージョン |
| `title` | シナリオ名 |
| `scenes` | シーン配列。1 シナリオに複数シーンを並べられる |

## シーン

| 項目 | 説明 |
| --- | --- |
| `id` | シーン ID (内部参照用) |
| `title` | UI に表示するシーン名 |
| `background` | 静止画背景パス (videoTrack を使う場合は空でも可) |
| `videoTrack` | 動画背景。`fit` (cover/contain/fit)、`muted`、`loop`、`trim`、`speed` を持つ |
| `bgmTracks` | BGM 配列。`volume` / `trimStartSec` / `fadeInSec` / `fadeOutSec` / `useForLipSync` / `loop` を持つ |
| `soundEffects` | 効果音配列。`{ id, src, startFrame, durationFrame, loop, fadeInSec, fadeOutSec, audioOffsetSec, volume, linkedCutId }` を持つ。詳細は下記 |
| `videoLayers` | 動画レイヤー配列。短いクリップ (タイトル / トランジション / 解説動画) を任意区間に置く。下記参照 |
| `bpm` | 任意。テロップやモーションの拍合わせに使用 |
| `cuts` | カット配列 |
| `telops` | テロップ配列 (カットと独立) |

`bgmTracks[].useForLipSync` は 1 シーンにつき 1 トラックだけ ON にできます (ラジオ式)。ON のトラックが口パク解析の入力になります (歌唱+伴奏を分けて納品する場合などに使用)。`loop` を ON にするとシーン終端まで素材を繰り返し再生します (複数 BGM が ON でも排他ではなく、それぞれ独立にループ)。

`soundEffects[]` はシーン中の任意位置に置ける効果音で、`startFrame` から `durationFrame` フレームだけ再生されます。`durationFrame=0` はアセット末尾までの自然終了。`loop=true` で素材長 < 区間長のとき素材を繰り返し、`audioOffsetSec` で素材内の頭出し位置 (= 素材の途中から鳴らす) を指定できます。`fadeInSec` / `fadeOutSec` は区間全体の先頭と末尾にだけ掛かります (= ループ反復の境目には掛けない)。同じ時刻に複数の効果音を重ねることもできます。書き出しでは `adelay` + `volume` + `atrim` で `amix` に合流します。

### videoLayers

`scene.videoLayers[]` は `scene.videoTrack` (背景動画) と違い、シーン中の任意区間に置ける短いクリップを表します。フェード / 配置 / 拡縮 / z 位置 (キャラの前 or 後ろ) を指定でき、書き出しでは GL plane として焼き、音声は ffmpeg amix に合流します。

| 項目 | 説明 |
| --- | --- |
| `id` | 内部 ID (`vl_xxxxx`) |
| `src` | manifest 経由で解決される動画パス (`assets/videos/...`) |
| `startFrame` | シーン頭からの配置フレーム (= タイムライン上の位置) |
| `trimStartSec` / `trimEndSec` | 動画素材内の使用範囲秒。`trimEndSec=null` は素材末尾まで |
| `fit` | `contain` / `cover` / `fill` |
| `scale` | fit 適用後の追加倍率 (縦横比維持、0.05〜4.0) |
| `offsetX` / `offsetY` | 中央アンカーからのピクセルオフセット (+X=右、+Y=下、±2000) |
| `layer` | `above_bg` (背景の上) / `above_fg` (前景の上) の 2 択 |
| `opacity` | フェード前のベース不透明度 (0.0〜1.0) |
| `fadeInEnabled` / `fadeInSec` | フェードインの有無と秒数 (0〜60) |
| `fadeOutEnabled` / `fadeOutSec` | フェードアウトの有無と秒数 (0〜60) |
| `muted` / `volume` | 音声ミュートと音量 (0.0〜2.0) |

`durationFrame` は持たず、タイムライン上の長さは `(trimEndSec - trimStartSec)` から派生します。loop / 速度変更は省略 (等倍再生のみ)。同一 `layer` 内では時間軸の重なり禁止 (UI のドラッグ / 複製は隣接位置にスナップ吐き出し)。異なる `layer` であれば時間軸で重ねられます。

書き出しの映像は client 側で per-layer `WebCodecsVideoProvider` を起動して frame を GL に焼き、音声は server 側で `-ss trim / -t span` + `adelay startFrame換算ms` + `volume` で `amix` に合流します (音声ストリーム無しの動画は ffprobe で自動判定して amix から除外)。

## カット

```jsonc
{
  "id": "cut_001",
  "startFrame": 0,
  "durationFrame": 72,
  "audio": "projects/default/assets/audio/voice.wav",
  "speakerCharacterId": "character_1",
  "state": { /* ... */ }
}
```

| 項目 | 説明 |
| --- | --- |
| `id` | カット ID |
| `startFrame` | シーン上のカット開始フレーム (project fps = 24 固定) |
| `durationFrame` | カットの表示フレーム数 (最小 1 frame) |
| `audio` | 音声素材のパス。空文字なら無音 |
| `speakerCharacterId` | 話者キャラクターのカット内 ID |
| `state` | 背景・セリフ・キャラクター状態 |

> **タイムコードはフレームベース**: スキーマ上はすべて `startFrame` / `durationFrame` で管理し、UI の表示は `MM:SS.FF` (`bindTimecodeInput` でフォーム入力をフレームへ正規化) です。書き出し fps は 8 / 12 / 24 から独立に選べます。

## state

```json
{
  "background": "assets/backgrounds/white.png",
  "showSpeechBox": true,
  "text": "こんにちは",
  "characters": [],
  "textStyle": {},
  "foreground": ""
}
```

| 項目 | 説明 |
| --- | --- |
| `background` | カット用の静止画背景 (シーンの `videoTrack` がない場合に使用) |
| `backgroundColor` / `backgroundColorOpacity` | 背景画像が無いときに表示される単色塗りつぶし |
| `backgroundBlurPx` | 背景画像への Gaussian blur (0 で無効) |
| `foreground` | カット最前面のオーバーレイ画像 (任意) |
| `foregroundX` / `foregroundY` | 前景画像の左上の表示位置 (px, 0,0 = 画面左上、2026-06 追加)。`null` (未指定) なら中央配置。キャラの `character.x/y` と同じ座標ルール |
| `showSpeechBox` | セリフ枠を表示するかどうか |
| `text` | セリフ本文 |
| `characters` | カット内に登場するキャラクター配列 |
| `textStyle` | セリフ表示設定 |
| `speakerCharacterId` | セリフの話者として扱うキャラの `id` |
| `characterEffects` | カット内全キャラに掛かる色フィルター / 光彩 / ドロップシャドウ |
| `characterLayout` | マルチキャラレイアウト設定 (2026-05 追加)。 `{ "pattern": "vertical_2"\|..., "border": { "width", "color", "includeOuter" } }`。`null` で「分割なし」 |
| `editingCharacterId` | 編集中キャラの `id` を per-cut で永続化 (2026-05 追加)。再生→停止→同じカットへ戻った際にセレクタが復元される。記録された `id` がカット内にいなければ index=0 (= 最前面) へフォールバック |
| `motionType` / `motionSettings` | **廃止** (2026-05): scene global motion は撤廃。読込時に話者キャラの `character.motion` へ自動 migration され、normalize 後の JSON にはこれらのキーは出力されない |

## キャラクター状態

```json
{
  "id": "character_1",
  "name": "キャラクター1",
  "characterId": "default",
  "baseId": "default",
  "cheekId": "",
  "eyeId": "open",
  "mouthId": "closed",
  "hairstylePresetId": "long",
  "frontIds": [],
  "removeWhite": true,
  "showCharacter": true,
  "eyeAboveBangs": false,
  "flipX": false,
  "character": {
    "x": 448,
    "y": 0,
    "scale": 1
  }
}
```

| 項目 | 説明 |
| --- | --- |
| `id` | カット内の登場キャラクター ID |
| `name` | カット内表示名 |
| `characterId` | 素材キャラクター定義の ID |
| `baseId` / `cheekId` / `eyeId` / `mouthId` | カテゴリ単位の ID 参照 (`base` / `cheek` / `eye` / `mouth`) |
| `hairstylePresetId` | アセット定義の **髪型プリセット** ID。プリセットの `(baseId, bangsId, backHairId)` がレンダ時に展開される。空文字なら「髪型なし」 (前髪・後ろ髪は表示されず、`baseId` だけで描画) |
| `frontIds` | 前面 (`front/`) のレイヤー ID 配列。複数同時表示が可能 |
| `removeWhite` | 白背景透過を行うかどうか (runtime) |
| `showCharacter` | このキャラクターを表示するかどうか |
| `eyeAboveBangs` | 前髪より目を前に重ねるカット時 ON |
| `flipX` | キャラ本体レイヤー (under / eye / mouth / over) のみを中心軸で左右反転する。光彩・ドロップシャドウは固定の向きを保つ。`character.scale` は負数化しないため、X / Y / 中央寄せ計算は影響を受けない |
| `character.x`, `character.y` | 配置座標 |
| `character.scale` | 拡大率 |
| `motion` | per-character モーション (2026-05 改修)。`{ "type": "shake_x"\|"shake_y"\|"zoom"\|"move", "settings": { ... } }` 形式。未設定 (= キーが無いか `null`) なら「動かない」。旧 cut 単位の `motionType` / `motionSettings` は読込時に話者キャラの `motion` へ自動 migration されます |
| `bob` | per-character の BPM 同期上下ゆれ (2026-06 追加)。`{ "bpm", "amplitudePx" }`。どちらかが 0 / 未設定 (`null`) なら無効。`motion` とは独立に加算されるため、移動・拡大と併用できる。位相はシーン内通算秒で計算し、カットを跨いで連続する |
| `crop` | マルチキャラレイアウト用の矩形クリップ `{ x, y, width, height }` (1920×1080 絶対座標)。`null` / 未設定なら全画面表示 |
| `layoutSlot` | マルチキャラレイアウトのスロット index (0 始まり)。 編集ダイアログ再開時の表示順を保つために保存 |

#### `motion.settings.move` の構造 (移動モーション)

```json
{
  "type": "move",
  "settings": {
    "move": {
      "startFrame": 0,
      "durationFrame": 48,
      "startX": 0, "startY": 0, "endX": 0, "endY": 0,
      "startOpacity": 0, "endOpacity": 1,
      "startRotation": 0, "endRotation": 360,
      "startScale": 0.5, "endScale": 1.0,
      "pivotX": 960, "pivotY": 540,
      "easing": "easeOut"
    }
  }
}
```

X/Y はキャラ基準位置からの相対オフセット、拡大率はキャラ `character.scale` への乗算係数、透明度・角度は絶対値です。`pivotX/Y` は回転 / 拡大の中心点 (= 1920×1080 絶対座標、デフォルト画面中央)。`easing` は `linear` / `easeIn` / `easeOut` / `easeInOut`。

> 内部的にレンダリングする際は、`baseId` / `hairstylePresetId` などをマニフェストの素材パスへ解決した `base` / `cheek` / `eye` / `mouth` / `bangs` / `back_hair` / `fronts` フィールドが補われます。シナリオ JSON 上は ID 参照だけが永続化されます。
>
> **(リリース前の破壊的変更)** 旧 `bangsId` フィールドは廃止されました (Phase 4+7 で `hairstylePresetId` に置換)。旧プロジェクトを開くと自動で剥がされ、アセット側にデフォルト髪型プリセットがあれば auto-select、なければ「髪型なし」になります。前髪が見えなくなる場合は アセット管理 → 髪型プリセットで定義してください。

## キャラクター定義の voice 紐付け

各キャラクター定義 (`assets/characters/<id>/character_manifest.json` または `projects/<project_id>/assets/characters/<id>/character_manifest.json`) には、ルート直下に `voice` フィールドが任意で入ります。

```json
{
  "id": "tsumugi2",
  "name": "つむぎ2",
  "version": 4,
  "defaults": { "...": "..." },
  "voice": { "id": "voicevox:春日部つむぎ/ノーマル", "emotion": "" }
}
```

| 項目 | 説明 |
| --- | --- |
| `voice.id` | アプリ名 prefix 付き voice ID (`voicevox:{narrator}/{styleName}` または `voicepeak:{narrator}`) |
| `voice.emotion` | VOICEPEAK の感情既定値。VOICEVOX には emotion 概念が無いので空欄 |

紐付けは編集画面の「キャラ管理」ダイアログから設定します。詳細は [音声合成 (VOICEVOX / VOICEPEAK) を使う](../tutorials/voice-synthesis.md) を参照してください。

## テキストスタイル

```json
{
  "fontSize": 54,
  "fontFamily": "noto_sans_jp",
  "fontWeight": "regular",
  "align": "left",
  "lines": 2,
  "boxOpacity": 215,
  "speechPlacement": "bottom",
  "boxBorderWidth": 3,
  "boxBorderColor": "#ffffff",
  "boxBackgroundColor": "#14181c",
  "textColor": "#ffffff",
  "textOutlineWidth": 0,
  "textOutlineColor": "#666666",
  "boxOverlayImage": "",
  "speechOffsetX": 120,
  "speechOffsetY": 70,
  "speechPaddingX": 60,
  "speechPaddingY": 70,
  "lineGap": 16,
  "speakerNameFontSize": 28,
  "inactiveCharacterOpacity": 0.5,
  "dialogueGlow": {
    "enabled": false,
    "color": "#ffffff",
    "blurPx": 12,
    "opacity": 0.8
  },
  "dialogueDropShadow": {
    "enabled": false,
    "color": "#000000",
    "blurPx": 6,
    "offsetX": 4,
    "offsetY": 4,
    "opacity": 0.7
  }
}
```

`boxOpacity` は内部的に 0-255 の値です。画面上の `帯の濃さ` は 0.0-1.0 で入力します。

`dialogueGlow` / `dialogueDropShadow` は **セリフ本文 (文字)** に掛ける光彩 / ドロップシャドウのカット単位設定です (話者名 / 装飾画像 / セリフ枠は対象外)。プロジェクト設定の `textDefaults.dialogueGlow` / `textDefaults.dialogueDropShadow` を上書きし、未指定なら既定値にフォールバックします。

### セリフ枠のブレンドモード

セリフ枠の **背景色 (`boxBackgroundColor`)** と **ボーダー色 (`boxBorderColor`)** は、それぞれの色の relative luminance (Rec. 709) から自動でブレンドモードが決まり、Three.js の `CustomBlending` で合成されます。明度 > 0.5 で **スクリーン**、それ以下で **乗算**。文字 (本文 / 話者名) / 装飾画像 は通常合成のままです。

ボーダーの不透明度は `boxOpacity` に連動するため、`帯の濃さ` を `0` にすると背景・ボーダー共に完全に no-op (= 何も合成しない) となります。

## テロップ

```jsonc
{
  "id": "telop_001",
  "startFrame": 28,
  "durationFrame": 48,
  "text": "♪",
  "position": "bottom",
  "x": null,
  "y": null,
  "style": {
    "fontFamily": "yawarakadragon",
    "fontWeight": "regular",
    "fontSize": 64,
    "textColor": "#ffffff",
    "outlineWidth": 4,
    "outlineColor": "#000000",
    "letterSpacing": 0,
    "lineGap": 16,
    "align": "center"
  }
}
```

| 項目 | 説明 |
| --- | --- |
| `id` | テロップ ID |
| `startFrame` / `durationFrame` | シーン上の開始フレームと表示フレーム数 |
| `text` | テロップ本文 (改行可) |
| `position` | `top` / `bottom` / `center` / `custom` のいずれか。`custom` のときだけ `x` / `y` を見る |
| `x` / `y` | 任意座標 (px)。`position` が `custom` のときに有効。`null` のままなら定型位置のフォールバックが使われる |
| `style.align` | 文字揃え。`left` / `center` / `right` |
| `style.glow` / `style.dropShadow` | テロップ文字の光彩 / ドロップシャドウ (各 `{enabled, color, blurPx, opacity, intensity[, offsetX, offsetY]}`)。テロップ既定値 (`telopDefaults.glow` / `telopDefaults.dropShadow`) の上書き。`intensity` (1〜8, 既定 1, 2026-06 追加) はぼかしで薄くなった発光・影を濃くするスタック合成回数 |
| `style` | 書体・色・アウトライン・サイズ・文字揃え・行間・字間・光彩・ドロップシャドウ |
| `linkedCutId` | 任意。設定時はその ID のカットに紐付き、カット並び替え / 複製 / 削除 / duration 変更に追従する。存在しない ID を指していたら正規化で `null` に倒される。`soundEffects[]` / `videoLayers[]` も同名のフィールドで同じ意味 |

テロップはカットに依存せず、シーン全体の任意の区間に置けます。タイムライン下のテロップ帯で開始・終了・スタイルを編集します (`s` / `e` キーで再生ヘッドにスナップ)。

## セリフのエクスポート / 取り込み

ヘッダーの `エクスポート` で、現在のシナリオから次の 2 つの YAML を `projects/<project_id>/export/<タイムスタンプ>-{serif,telop}.yaml` に書き出します。

- `serif.yaml`: カットごとのセリフ。フィールドは `index / speaker / voice / duration_sec / text`
- `telop.yaml`: テロップ。フィールドは `index / start_sec / duration_sec / text`

`speaker` はカット内の登場キャラインスタンス ID (`character_XXXX_n`) で、絵の再現のため YAML 上で書き換えないでください (キャラ配置・表情・XY・モーション・背景は `scenarios/main.json` 側にしか保存されません)。`voice` は `voicevox:四国めたん/ノーマル` / `voicepeak:Miyamai Moca/honwaka` のようなアプリ名 prefix 付きの完全形です。

セリフ YAML はそのまま **カット一括追加 → YAML から一括登録** に流し込めます。詳しくは [音声合成 (VOICEVOX / VOICEPEAK) を使う](../tutorials/voice-synthesis.md) を参照してください。

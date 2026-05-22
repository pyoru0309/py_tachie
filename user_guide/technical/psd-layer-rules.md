# PSD レイヤー命名規則

PSD からキャラクター素材を生成する場合、レイヤー名またはフォルダ名にカテゴリを含めます。
Clip Studio Paint や Photoshop からの PSD 保存を想定しています。

立ち絵システムのキャラクター素材は 7 カテゴリ (`back_hair` / `base` / `cheek` / `eye` / `mouth` / `bangs` / `front`) に固定です。

## 基本形式

レイヤー名は次のいずれかで書きます。半角コロン (`:`) と全角コロン (`：`) の両方を許可しています。

```text
カテゴリ/ID
カテゴリ:ID
```

または、カテゴリ名のフォルダの中に ID レイヤーを置きます。

```text
ベース
  通常
口
  閉じ
  半開き
  開き
```

ID は日本語でも構いません。UI の表示名としてそのまま使われ、ファイル名には安全な文字列へ変換されたものが使われます。

## 7 カテゴリ

| 内部カテゴリ | 推奨フォルダ名 | 受け付けるエイリアス |
| --- | --- | --- |
| `back_hair` | `back_hair/` | `back_hair` / `BackHair` / `Backhair` / `後ろ髪` / `うしろ髪` / `後髪` |
| `base` | `base/` | `base` / `ベース` / `基本` / `素体` / `体` / `身体` |
| `cheek` | `cheek/` | `cheek` / `頬` / `ほほ` / `チーク` |
| `eye` | `eye/` | `eye` / `目` / `眼` |
| `mouth` | `mouth/` | `mouth` / `口` |
| `bangs` | `bangs/` | `bangs` / `前髪` |
| `front` | `front/` | `front` / `前面` / `前景` / `手前` |

## 目パチ・口パクのフラグ

ファイル名やレイヤー名は **元の PSD レイヤー名のまま** インポートされます。目パチ・口パクの対象判定は、各レイヤーに付与する `flags` で行います。

| カテゴリ | フラグ | 役割 |
| --- | --- | --- |
| eye | `blinkOpen` | 「このレイヤーが選択されたカットでは目パチを動かす」マーク。複数立てて OK |
| eye | `blinkHalf` | 半目 (中間フレーム)。シーン全体で 1 枚 |
| eye | `blinkClosed` | 閉じ目 (閉じフレーム)。シーン全体で 1 枚 |
| mouth | `lipClosed` | 閉じ口 (シーン全体で 1 枚) |
| mouth | `lipMid` | 半開き口 (同) |
| mouth | `lipOpen` | 開き口 (同) |

フラグの設定はインポート後に **編集画面のキャラ管理 → レイヤー編集** からチェックボックスで行うのが基本です (詳細は [キャラクターモデル](character-model.md) 参照)。
インポート時にあらかじめフラグを宣言しておきたい場合は、`import_manifest.yml` の `flags:` ブロックを使います。

## サムネイル

PSD 内のレイヤー名が `thumb` / `thumbnail` / `サムネイル` / `サムネ` のいずれかなら、そのレイヤーをキャラサムネイルとして自動で書き出します (`<character_id>/thumb.png`)。
カテゴリレイヤーには含めず、独立して並べてください。レイヤーグループの中に置いても拾います。

## レイヤー例

英語名:

```text
back_hair/long
base/default
base/uniform_pose1
cheek/blush
eye/open
eye/half
eye/closed
mouth/closed
mouth/mid
mouth/open
bangs/default
front/hand_front
thumb
```

日本語名:

```text
後ろ髪/ロング
ベース/通常
ベース/制服_ポーズ1
頬/赤味
目/開き
目/半目
目/閉じ
口/閉じ
口/半開き
口/開き
前髪/通常
前面/手_正面
サムネイル
```

## 除外したいレイヤー

レイヤー名の先頭に `_` を付けると、インポート対象から外れます。
作画用の下書き、メモ、参考線、調整レイヤーなどに使ってください。

```text
_下書き
_メモ
_調整レイヤー
```

## 非表示レイヤー

PSD で非表示になっているレイヤーも、命名規則に合えばインポート対象になります。
1 枚の PSD に差分素材をすべてまとめて、表示の ON/OFF はインポート後に UI から決める運用を想定しています。

## インポータの取り込み設定

UI のダッシュボード → `PSD インポート` で開くダイアログから次の項目を指定できます。

| 設定 | 既定値 | 内容 |
| --- | --- | --- |
| 出力フォーマット | `png` | `png` (可逆) / `avif` (Pillow 12+ ネイティブ。容量 1/30〜1/40) |
| 縦上限 px | `0` (無制限) | 取り込み時に PSD キャンバスを縦最大値に合わせて等倍縮小 |
| 横上限 px | `0` (無制限) | 縦と横の小さい方の縮小率が適用される |
| 補間アルゴリズム | `lanczos` | `lanczos` / `bicubic` / `hamming` / `bilinear` / `box` / `nearest` |
| 追記 (append) | OFF | 既存キャラに新しいレイヤーだけ足したいときに ON |

縮小は等倍 (アスペクト比保持) で行い、`scale=1.0` 未満になるときだけリサイズが走ります。

## import_manifest.yml {#import-manifest-yml}

取り込み・レイヤー編集・プリセット保存に成功すると、キャラクターディレクトリ直下に `import_manifest.yml` が **毎回フル再生成** されます。`character_manifest.json` の内容と透過的にミラーされ、配布アセットの実体としてそのまま渡せます。

```yaml
schemaVersion: 1
id: yukari
name: 結月ゆかり
removeWhite: false
voice:
  id: voicevox:結月ゆかり/ノーマル
  emotion: ''
color: '#ffaa55'
後ろ髪:
  - ロング
ベース:
  - 制服_通常
頬:
  - 赤味
目:
  - 開き
  - 半目
  - 閉じ
口:
  - 閉じ
  - 半開き
  - 開き
前髪:
  - 通常
前面: []
サムネイル: 立ち絵
flags:
  "開き": [blinkOpen]
  "半目": [blinkHalf]
  "閉じ": [blinkClosed, lipClosed]
  "半開き": [lipMid]
expressionPresets:
  - { name: 通常, isDefault: true, cheek: '', eye: 開き, mouth: 閉じ }
  - { name: 笑顔, isDefault: false, cheek: 赤味, eye: 笑い, mouth: あ }
hairstylePresets:
  - { name: ロング, isDefault: true, base: 制服_通常, bangs: 通常, backHair: ロング }
```

- **PyYAML** で読み書きします (`requirements.txt` に `PyYAML>=6.0` を追加済み)。
- `flags:` の各キーはレイヤー名 (combination) で、値は当該レイヤーに立てるフラグの配列です。
- `expressionPresets` / `hairstylePresets` 内のレイヤー参照は **環境固有 ID ではなくレイヤー名** (= `character_manifest.json` の各エントリの `name` フィールド) で記述します。配布した YAML を別環境で取り込んでも layer 名一致で flags / preset を復元できます。
- `removeWhite` / `voice` / `color` は character_manifest.json の `defaults` / メタを反映します。空でも常に書き出します（透過ミラー）。
- 旧名 `.import.yaml` は read 経路で fallback 参照されます (write は新名のみ)。手動移行は不要です。

### PSD 内 `import_manifest.yml` テキストレイヤー (1 枚 PSD 配布用)

PSD のルート直下に `import_manifest.yml` という名前の **テキストレイヤー** を作って YAML 本文を書き込んでおくと、PSD インポート時にその内容が優先採用されます。配布側は PSD 1 枚だけ渡せばプリセットや flags まで再現できます。

- レイヤー名候補: `import_manifest.yml` / `import_manifest` / `.import.yaml` (旧名互換)
- TypeTool レイヤー (`layer.kind == "type"`) のみ対象。フォルダ内のレイヤーは無視（ルート直下のみ）
- 抽出に失敗した場合はフロントから渡した YAML が使われます（既存挙動）

## 作画時の注意

- 複雑なレイヤー効果、合成モード、クリッピング、ベクターマスクは PSD 読み込みで作画ソフトと完全一致しない場合があります。安定させたい場合は作画側でラスタライズしてから保存してください。
- 線画と塗りを別レイヤーで管理している場合は、最終的に 1 レイヤー (またはグループ) にまとめてからカテゴリ命名してください。
- 顔の後ろに回る手などは、作画側で顔位置をマスクした `base` レイヤーを別途用意するか、`bangs` / `front` を上手に使い分けてください。

## CLI からの取り込み

UI を経由しない取り込みは `tools/import_psd.py` を使います。共通キャラ素材の更新でよく使います。

```bash
python3 tools/import_psd.py assets/characters/<id>/psd/キャラクター.psd \
  --out assets/characters/<id>
```

CLI 版はカテゴリ振り分けまで行います。目パチ・口パクのフラグはインポート後に編集画面のキャラ管理 → レイヤー編集から付けてください (`character_manifest.json` の各エントリに `flags` フィールドが追加されます)。

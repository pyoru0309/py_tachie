# プラグイン規約 (短縮版)
#
# 1 ファイル = 1 プラグイン。最低限以下のモジュール変数を露出すること。
#
#   NAME    : str          # UI に表示する日本語名
#   PARAMS  : list[dict]   # ユーザーが調整可能なパラメータ仕様
#                          #   {"key", "type", "label", "default", ... }
#                          #   type: color / number / select / font / font_weight
#                          #   number は min/max/step 任意、select は options
#   GL_MODULE : str        # `/static/js/visualizers/<name>.js` 形式の URL。
#                          # ブラウザは三角描画 / canvas2D / GLSL を自前で実装。
#   GL_VERSION: int        # 互換性タグ (省略時は 1)
#
# 任意 (audio 解析が必要なプラグインのみ):
#   gl_data_streams(params, audio, time_grid_sec, fps) -> dict[str, ndarray|dict]
#       per-frame の解析データを numpy.ndarray の dict で返す。サーバが binary
#       stream (`viz/<token>_<name>.bin`) として書き出し、ブラウザに HTTP cache 経由で渡す。
#       audio は ``app.visualizer.AudioContext`` (sample_rate, pcm) で、``audio.window``
#       / ``audio.amplitude_db`` / ``audio.spectrum_db`` を呼んで解析する。
#
# 旧 Python `render(ctx)` (Pillow 焼き込み) 経路は撤去済み。GL 必須。

# Hushmark の開発

## ビルドとテスト

Node.js（22 以上）が必要です。

```sh
npm ci
npm run build      # webview/ を media/dist/ にまとめ、同梱したパッケージのライセンス文を書き出す（npm run watch で監視）
npm test           # 同期・表の分割・装飾などの単体テスト
npm run test:e2e -- all   # E2E テスト（下の「E2E テスト」を参照）
npm run package    # .vsix を作る
```

拡張を試すときは、ビルドしてから、このフォルダを開発中の拡張として読み込んだ VSCode を起動します。

```sh
code --extensionDevelopmentPath="$PWD" <試す Markdown ファイル>
```

## 構成

- `src/extension.js`：カスタムエディタの登録と、Webview と TextDocument の同期
  - `textMerge.js`：差分の計算と、ほかのエディタでの変更と重なった編集の位置合わせ
  - `links.js`：リンク先の正規化
- `webview/`：Webview 側
  - `main.js`：エディタの組み立て、拡張機能本体とのやり取り、キー操作
  - `livePreview.js`：装飾
  - `tableWidget.js`：表の表示とセルの編集
  - `cellEditor.js`：表のセルを編集する小さなエディタ
  - `tableModel.js`：表の分割と、セルへの書き込み
  - `inline.js`：表のセルの中のインライン Markdown の描画
  - `markdownSetup.js`・`cjkEmphasis.js`：Markdown の解析の設定と、日本語の文の強調の判定
  - `lineNumbers.js`・`lineHighlight.js`・`wrapIndent.js`・`verticalMove.js`・`metrics.js`：行番号、行の背景、折り返しの字下げ、上下の移動、文字の大きさと行の高さ
  - `textWidth.js`：文字列の表示幅と桁（全角を 2 桁、タブを tabSize の桁まで数える）
  - `palette.js`・`theme.js`：配色の生成（元の色から、読みやすさの基準を満たす色を作る）と、配色の適用
  - `findWidget.js`：検索ウィジェット
  - `platform.js`：OS ごとのキー操作の違い
  - `sync.js`：変更の形式
  - `strings.js`：画面に出す文言。英語を元にし、翻訳は拡張機能本体から受け取る
- `media/editor.css`：見た目。共通の骨組みと、プレビューのスタイル（`hushmark.previewStyle`）ごとの飾り

日本語の文の強調の判定（`cjkEmphasis.js`）は、Markdown の解析（@lezer/markdown）の内部の作りを使っています。@lezer/markdown を更新したときは、単体テストで確かめます。

## 文言の翻訳

画面に出す文言は英語で書き、日本語の翻訳を別のファイルに置きます。

- `package.json` の文言（設定の説明、コマンドの名前など）：`package.nls.json`（英語）と `package.nls.ja.json`（日本語）
- コードの中の文言（通知、Webview の検索ウィジェットや表のボタンなど）：`vscode.l10n.t()` で英語を書き、日本語は `l10n/bundle.l10n.ja.json`。Webview の文言は、`src/extension.js` の `WEBVIEW_STRINGS` に足すと、翻訳したものが Webview に渡る

## E2E テスト

実際の VSCode を別プロファイルで起動し、DevTools プロトコル経由で操作します。実際のマウスやキーボードは使わないので、実行中もほかの作業ができます。VSCode は、バージョンを固定したもの（`test/e2e/vscode.mjs` の `VSCODE_VERSION`）をこのフォルダの `.vscode-test` にダウンロードして使います。インストールしてある VSCode は使いません。

```sh
npm run test:e2e -- full       # 編集・表・検索・同期などを細かく確かめる
npm run test:e2e -- smoke      # 主な操作と、OS ごとに違うキー操作を短く確かめる
npm run test:e2e -- readonly   # 読み取り専用のファイルで編集できないことを確かめる
npm run test:e2e -- all        # full と readonly
```

テストごとに VSCode を起動し、終わると閉じます。次のオプションがあります。

| オプション | 内容 |
|---|---|
| `--keep` | 最後のテストの後も VSCode を閉じない。表示されたポートを `E2E_PORT` に入れると、`test/e2e/screenshot.mjs` で画面を保存できる |
| `--vsix <path>` | 開発中のフォルダではなく、この .vsix をインストールして試す |
| `--remote <host>` | Remote-SSH で ssh のホスト `<host>` につなぎ、接続先の `/tmp/hushmark-e2e/sample.md` で試す（`full` と `smoke` だけ）。拡張は接続先にインストールしたものを使う |
| `--version <v>` | VSCode のバージョン（`stable` も可） |
| `--locale <lang>` | VSCode の表示言語（例 `ja`）。言語パックをインストールし、一度起動して登録させてから起動し直す。`smoke` と `full` は英語の表示を前提にしているので、文言を目で確かめるときに使う |

VSCode は画面なしでは起動できないので、テスト中はウィンドウが出ます。macOS では、作業中のウィンドウからフォーカスを奪わないように起動します（`--locale` を指定したときを除く）。ウィンドウを出したくないときは、Docker を使い、Linux のコンテナの仮想ディスプレイで実行します。プロジェクトはイメージに写すので、このフォルダには書き込みません。

```sh
npm run test:e2e:docker -- all
```

CI（GitHub Actions）では、Linux で `all` を、macOS と Windows で `smoke` を実行します。

作業フォルダ（このフォルダの `.e2e`）は、起動のたびに丸ごと消して作り直します。VSCode の出力は `.e2e/vscode.log` に残ります。

`full`（`run.mjs`）と `readonly`（`readonly.mjs`）で確かめる内容は次のとおりです。

- 追記、取り消し、やり直し
- 表のセル編集（入力欄は触ったセルだけ）、Tab・↑↓での移動、`|` のエスケープ、セルの中での取り消し、＋列、ソース表示
- ファイル末尾のコードブロックの後ろへの入力
- チェックボックス
- 検索
- 外部での変更の反映
- IME の変換中の入力
- 見出しの `#` の前後で描かれるカーソルの位置、↑↓ の桁、Alt+Z、Ctrl+K の後のキー
- 表の長いセルの編集（列の幅を保つ）、← → でのセルの移動、省略されたセルへの入力、引用の中の表、長い表の検索
- 表のセルの文字参照
- 保存後のファイルと表示が一致し、改行が CRLF のままか
- 読み取り専用のファイルで編集できないこと、設定を変えると解除されること

`smoke`（`smoke.mjs`）では、ファイルを開くこと、追記と保存（改行が CRLF のまま）、取り消し、表のセルの編集、検索のキー操作、リンクの説明、折り返しの切り替えを確かめます。

## 開発で作るもの

| もの | 作るとき | 消し方 |
|---|---|---|
| E2E テストに使う VSCode（`.vscode-test`）と作業フォルダ（`.e2e`） | `npm run test:e2e` を実行したとき | このフォルダの中（git の管理外）にあるので、フォルダごと消す |
| Docker のイメージ `hushmark-e2e` | `npm run test:e2e:docker` を実行したとき | `docker image rm hushmark-e2e` |

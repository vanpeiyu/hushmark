# Hushmark の開発

## ビルドとテスト

Node.js（22 以上）が必要です。

```sh
npm ci
npm run build      # webview/ を media/dist/ に、Web 版の拡張機能本体を dist/web/ にまとめ、同梱したパッケージのライセンス文を書き出す（npm run watch で監視）
npm test           # 同期・表の分割・装飾などの単体テスト
npm run test:e2e -- all   # E2E テスト（下の「E2E テスト」を参照）
npm run test:web   # Web 版の VSCode でのスモークテスト（下の「Web 版のテスト」を参照）
npm run package    # .vsix を作る
```

拡張を試すときは、ビルドしてから、このフォルダを開発中の拡張として読み込んだ VSCode を起動します。

```sh
code --extensionDevelopmentPath="$PWD" <試す Markdown ファイル>
```

## 構成

- `src/extension.js`：カスタムエディタの登録と、Webview と TextDocument の同期。デスクトップ版はこのまま読み込み、Web 版（vscode.dev など）は `dist/web/extension.js` にまとめたものを読み込む。Web 版でも動くよう、Node の API（`fs` など）は使わないか、使えないときの扱いを決めておく
  - `textMerge.js`：差分の計算と、ほかのエディタでの変更と重なった編集の位置合わせ
  - `links.js`：リンク先の正規化
  - `diskChanges.js`：未保存の変更があるときに、ファイルが外で書き換えられたことの通知
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
npm run test:e2e -- restore    # ウィンドウを再読み込みしても、カーソルとスクロールの位置が戻ることを確かめる
npm run test:e2e -- all        # full と readonly と restore
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

CI（GitHub Actions）では、Linux で `all` と Web 版のテストを、macOS と Windows で `smoke` を実行します。

作業フォルダ（このフォルダの `.e2e`）は、起動のたびに丸ごと消して作り直します。VSCode の出力は `.e2e/vscode.log` に残ります。

`full`（`run.mjs`）と `readonly`（`readonly.mjs`）で確かめる内容は次のとおりです。

- 追記、取り消し、やり直し
- 表のセル編集（入力欄は触ったセルだけ）、Tab・↑↓での移動、`|` のエスケープ、セルの中での取り消し、＋列、ソース表示
- ファイル末尾のコードブロックの後ろへの入力
- チェックボックス
- 検索
- 外部での変更の反映（未保存の変更があるときの通知と Revert File を含む）
- IME の変換中の入力
- 見出しの `#` の前後で描かれるカーソルの位置、↑↓ の桁、Alt+Z、Ctrl+K の後のキー
- 表の長いセルの編集（列の幅を保つ）、← → でのセルの移動、省略されたセルへの入力、引用の中の表、長い表の検索
- 表のセルの文字参照
- 保存後のファイルと表示が一致し、改行が CRLF のままか
- 読み取り専用のファイルで編集できないこと、設定を変えると解除されること

`smoke`（`smoke.mjs`）では、ファイルを開くこと、追記と保存（改行が CRLF のまま）、取り消し、表のセルの編集、検索のキー操作、リンクの説明、折り返しの切り替えを確かめます。

## Web 版のテスト

`npm run test:web`（`test/web/smoke.mjs`）は、@vscode/test-web でブラウザー版の VSCode を起動し、Playwright の Chromium（画面なし）で操作します。ファイルを開くこと、見出しと表の表示、追記と保存を確かめます。

作業フォルダ（`.e2e/web`）は、VSCode からは読み取り専用に見えます。保存した内容はブラウザーの中に残り、ファイルには書き込まれません。そのため、ほかのツールでの変更の反映は確かめられません。失敗したときは、画面を `.e2e/web/failure.png` に、ブラウザーのエラーを `.e2e/web/console.log` に残します。

## README の GIF

README の GIF（英語の README の `docs/images/demo.gif` と、日本語の README の `docs/images/demo-ja.gif`）は、`npm run demo` で録り直します。日本語のものは、VSCode の表示言語を日本語にし、日本語の文での強調も見せます。E2E テストと同じく VSCode を起動して操作し（`test/demo/record.mjs`）、操作ごとに撮った画面をつないで GIF にします。フォントによって見た目が変わらないよう、E2E テストの Docker のイメージ（`hushmark-e2e`）の中で録ります。操作や文書を変えたときは、`--frames <フォルダ>` を付けて `node test/demo/record.mjs` を実行すると、撮った画面を PNG でも書き出すので、それで確かめます。

README は英語（`README.md`）と日本語（`README.ja.md`）の 2 つです。内容を変えるときは両方を直します。

## 変更の取り込み

`main` には PR を通して取り込みます。ルールセットで、次の条件を満たさないとマージできないようにしています。

- CI の 3 つのジョブ（`test (ubuntu-latest)`、`test (macos-latest)`、`test (windows-latest)`）が通っている
- ブランチが `main` の先端を含んでいる（含んでいなければ、下のように rebase で追従させ、CI を通し直す）

マージはマージコミットだけを使えるようにしています。マージした作業ブランチは自動で消えます。

```sh
git switch -c <ブランチ>
# 変更してコミットする
git push -u origin <ブランチ>
gh pr create --fill
gh pr checks --watch
gh pr merge --merge
```

ブランチを `main` に追従させるときは、`main` をマージせず、rebase します。`main` を取り込むマージコミットを作らず、`main` の履歴を PR ごとのマージコミットの並びに保つためです。PR の「Update branch」は `main` をマージするので使いません。

```sh
git fetch origin
git rebase origin/main
# 衝突したら、解消して git add し、git rebase --continue
git push --force-with-lease
```

## リリース

`v` で始まるタグを push すると、`.github/workflows/release.yml` が .vsix を作り、Release に添付します。ノートは `CHANGELOG.md` の該当するバージョンの節から作ります。タグが `package.json` のバージョンと違う場合や、タグのコミットが `main` に含まれない場合は失敗します。

GitHub の Secrets に `OVSX_PAT`（open-vsx.org の「Access Tokens」で作るトークン）があれば、同じ .vsix を Open VSX にも公開します（名前空間は `vanpeiyu`）。

Visual Studio Marketplace へは、ワークフローが終わった後に、Release に付いた .vsix を publisher の管理画面（https://marketplace.visualstudio.com/manage/publishers/vanpeiyu ）に手で上げます。初めての公開は「New extension」の「Visual Studio Code」から、2 回目からは拡張の「...」の「Update」から上げます。自動で公開しないのは、トークン（Azure DevOps の Personal Access Token）が 2026 年 12 月 1 日に廃止され、代わりの Microsoft Entra ID での認証には Azure のサブスクリプションが要るためです。

1. `package.json` と `package-lock.json` のバージョンを上げ（`npm version <version> --no-git-tag-version`）、`CHANGELOG.md` の `## 未リリース` の節を `## <version> - <日付>` に改めて、PR で `main` に取り込む。リリースまでの変更は、PR ごとに `## 未リリース` の節に書いておく
2. `main` の先端にタグを付けて push する

   ```sh
   git switch main && git pull
   git tag -a v<version> -m "Hushmark <version>"
   git push origin v<version>
   ```
3. ワークフローが終わったら、Release の .vsix を Visual Studio Marketplace の管理画面に上げる

## 開発で作るもの

| もの | 作るとき | 消し方 |
|---|---|---|
| E2E テストに使う VSCode（`.vscode-test`）と作業フォルダ（`.e2e`） | `npm run test:e2e` を実行したとき | このフォルダの中（git の管理外）にあるので、フォルダごと消す |
| Docker のイメージ `hushmark-e2e` | `npm run test:e2e:docker` を実行したとき | `docker image rm hushmark-e2e` |
| Web 版のテストに使う VSCode（`.vscode-test-web`） | `npm run test:web` を実行したとき | このフォルダの中（git の管理外）にあるので、フォルダごと消す |
| Web 版のテストに使う Chromium | `npm ci` のとき（Playwright がダウンロードする） | `~/.cache/ms-playwright`（Windows では `%LOCALAPPDATA%\ms-playwright`、macOS では `~/Library/Caches/ms-playwright`）を消す |

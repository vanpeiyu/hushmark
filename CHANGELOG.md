# 変更履歴

## 0.4.0 - 2026-10-10

VSCode のテキストエディタとの違いを減らしました。テキストエディタと同じキーと設定で編集でき、他の拡張機能の機能も使えます。表は作り直し、ソースの行のまま、セルの中で折り返して表示します。

これまでと変わる点：

- `hushmark.fontFamily` と `hushmark.lineHeight` をなくしました。VSCode の `editor.fontFamily` と `editor.lineHeight` を使います。Markdown にだけ適用するときは、`"[markdown]": { ... }` の中に書いてください（`editor.fontFamily` も、`"[markdown]"` の中の指定が効くようになりました）。
- プレビューの基本の色（`hushmark.previewColorScheme`）に `theme` を加え、既定にしました。背景、文字、選択範囲、カーソル、行の背景、行番号、検索の一致に VSCode のテーマの色を使い、見出しや表などの色はテーマの背景色に合わせて作ります。これまでの見た目にするには、`"hushmark.previewColorScheme": "auto"` を設定してください。
- Tab の字下げを、`editor.insertSpaces` と `editor.tabSize` に従わせました（これまでは空白 2 つでした）。タブで字下げした文書では、タブを入れます（`editor.detectIndentation`）。
- 合字は、VSCode の既定（`editor.fontLigatures` が `false`）と同じく、既定では使いません。

表：

- 表の表示を作り直しました。表のソースの 1 行を 1 行のまま、列をそろえて表の形で表示します。セルの文字は本文と同じく編集でき、セルをまたいだ選択や、表の外から表の中への選択もできます。これまでの、セルを押したままドラッグしても選択されない問題もなくなりました。
- 表のセルの中は、`editor.wordWrap` が `off` でも折り返します。
- 表の列の幅を、表の高さが低くなり、短いセルを折り返さないように決めるようにしました。ラベルだけが入る列など、長さが同じ列は同じ幅にします。
- 表の「ソース」ボタンをなくしました。揃え位置（`:--:`）は、区切りの行にカーソルを置いて変更します。表の中での Esc（表の下の行に出る）もなくしました。表のセルの中の画像と文字参照は、本文と同じくソースのまま表示します。

編集：

- VSCode のテキストエディタと同じキーで、行の操作（移動、コピー、削除、挿入、選択、インデント、コメント）、複数カーソル（Alt+クリック、Ctrl+D など）、矩形選択（Shift+Alt+ドラッグ）、選択範囲の拡大と縮小、折りたたみを使えるようにしました。
- Hushmark の操作を VSCode のコマンドにしました。VSCode の「キーボード ショートカット」で、キーを変えられます。
- 文字列を選んで記号（`*` など）を打つと選択範囲を囲み、括弧を自動で閉じるようにしました（`editor.autoSurround`、`editor.autoClosingBrackets`）。
- Ctrl+G で指定した行に移れるようにしました。
- 検索ウィジェットで、選択範囲内の検索（Alt+L）、大文字と小文字を保った置換（Alt+P）、すべての一致の選択（Alt+Enter）、検索語の履歴（↑ / ↓）を使えるようにしました。
- `editor.wordSegmenterLocales` に `ja` などを指定すると、語の単位の移動と削除、ダブルクリックでの選択で、日本語の文を語に分けるようにしました。
- テキストエディタとの間で開き直すと、カーソル、選択範囲、スクロールの位置を引き継ぐようにしました。
- 右クリックのメニューに、見出しや行への移動、太字、斜体、コメント、リネーム、ドキュメントの書式設定を加えました。

他の拡張機能：

- 他の拡張機能の機能を使えるようにしました。診断（スペルミスなどの波線と、F8 での移動）、クイックフィックス（Ctrl+.）、補完、リネーム（F2）、ドキュメントの書式設定（保存時の書式設定を含む）、ドキュメントリンクです。
- 画像の貼り付けとファイルのドロップが、`markdown.copyFiles.destination` などの VSCode の Markdown の設定に従うようにしました。

表示：

- ステータスバーに、カーソルの行と列、選択した文字数、文書の文字数を出すようにしました。
- 表示している位置を含む見出しを、エディタの上端に固定して出すようにしました（Sticky Scroll。`editor.stickyScroll.*`）。
- スクロールバーの上に、検索の一致、診断、カーソルの位置の目印を出すようにしました。
- VSCode のエディタの次の設定に従うようにしました。
  - カーソル：`editor.cursorStyle`、`editor.cursorBlinking`、`editor.cursorWidth`、`editor.cursorSmoothCaretAnimation`
  - 文字：`editor.fontWeight`、`editor.fontLigatures`、`editor.letterSpacing`、`editor.wordBreak`
  - 表示：`editor.selectionHighlight`、`editor.renderWhitespace`、`editor.renderControlCharacters`、`editor.unicodeHighlight.invisibleCharacters`、`editor.folding`、`editor.showFoldingControls`
  - スクロール：`editor.cursorSurroundingLines`、`editor.scrollBeyondLastLine`、`editor.smoothScrolling`、`editor.padding.top`、`editor.scrollbar.*`
  - そのほか：`editor.multiCursorModifier`、`editor.emptySelectionClipboard`、`editor.mouseWheelZoom`、`editor.links`、`editor.hover.*`
- README の操作の GIF を撮り直し、解像度を上げました。

## 0.3.1 - 2026-10-09

- README のインストールの節を、Visual Studio Marketplace と Open VSX からのインストールの案内にしました。.vsix からのインストールの手順は CONTRIBUTING.md に移しました。

## 0.3.0 - 2026-10-09

- 拡張の ID を `local.hushmark` から `vanpeiyu.hushmark` に変えました（Marketplace に公開するため）。0.2.0 以前を入れている場合は、`code --uninstall-extension local.hushmark` でアンインストールしてから入れ直してください。設定はそのまま使えます。
- 文書内のリンク（`#見出し`）を Ctrl+クリックすると、その見出しに移るようにしました。`other.md#見出し` は、開いた文書がこのエディタで開いたときに見出しに移ります。
- Ctrl+Shift+O（macOS では Cmd+Shift+O）で見出しの一覧を出し、選んだ見出しに移れるようにしました。
- Web 版の VSCode（vscode.dev、github.dev）で動くようにしました。
- ウィンドウを再読み込みしたり VSCode を起動し直したりしても、カーソルとスクロールの位置を保つようにしました。
- 画像のリンクにマウスを載せると、画像を浮かせて表示するようにしました。Ctrl+クリックで画像のファイルを開きます。表のセルの中の画像も同じです。
- 文字列を選んで URL を貼り付けると、選んだ文字列をその URL へのリンクにするようにしました。
- 画像を貼り付けると、文書と同じフォルダーに保存して画像のリンクを入れるようにしました。Shift を押しながらエクスプローラーからファイルをドロップすると、そのファイルへの相対パスのリンクを入れます。
- 表のセルで取り消しても、セルのカーソルが先頭に戻らず、取り消したところに置かれるようにしました。
- 表のセルの中の参照リンク（`[foo]`）も、文書に定義があればリンクにするようにしました。
- プレビューの色（`hushmark.previewColor`）の既定を、モノクロ（`mono`）からグリーン（`green`）にしました。アイコンの色と合わせています。これまでの見た目にするには、`"hushmark.previewColor": "mono"` を設定してください。
- 「モノクロ」（`hushmark.previewColor` の `mono`）で、リンクやチェックボックスなどのアクセントが青になっていたのを、無彩色にしました。リンクは下線を濃くして見分けられるようにしています。
- 狭い表で、表の上のボタンが左にはみ出していたのを直しました。
- 結合文字や絵文字を含む行で、↑ / ↓ で移るときの桁がずれていたのを直しました。
- ほかのツールで文書の離れた 2 か所が変わったときに、その間にあるカーソルが動いていたのを直しました。
- 長い文書で、カーソルの移動と入力を速くしました。
- README を英語にし、操作の GIF を載せました。日本語の README は README.ja.md です。

## 0.2.0 - 2026-10-08

- 未保存の変更があるときにファイルがほかのツールで書き換えられたら、通知するようにしました。通知の「Revert File」で、未保存の変更を捨ててファイルの内容を読み込めます。未保存の変更がないときは、これまでどおり表示に反映します。

## 0.1.1 - 2026-10-06

- ライトモードのページの背景を、すべてのスタイルで純白にしました。

## 0.1.0 - 2026-10-05

最初の公開版です。

- カーソルが触れている要素だけ Markdown の記号を表示するライブプレビューエディタ
- 日本語の文での強調（外側が日本語の文字や、内側が日本語の約物の強調）
- 記号を表示しても隠しても、見出し・引用・リスト・コードの文字の位置が変わらない表示
- 表の表示とセルの編集
- スタイルと色の組み合わせで選べる見た目
- 書式を変えない保存と、ほかのエディタでの変更との同期
- 英語と日本語の表示

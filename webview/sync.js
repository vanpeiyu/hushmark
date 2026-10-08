// Webview と VSCode の TextDocument の間でやり取りする変更の形式。
// 位置は行・列で送る。CodeMirror は改行を 1 文字と数えるが、CRLF の
// TextDocument では 2 文字になり、オフセットのままだと食い違うため。

// 差分の計算は拡張機能本体と同じものを使う
export { diffHunks, diffText } from '../src/textMerge.js';

/**
 * CodeMirror の ChangeSet を、変更前の文書に対する行・列の置換リストに変換する。
 * 各要素の範囲はすべて変更前の文書が基準で、WorkspaceEdit にそのまま積める。
 * @param {import('@codemirror/state').ChangeSet} changes
 * @param {import('@codemirror/state').Text} startDoc
 */
export function toLineChanges(changes, startDoc) {
  const out = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const a = startDoc.lineAt(fromA);
    const b = startDoc.lineAt(toA);
    out.push({
      fromLine: a.number - 1,
      fromCh: fromA - a.from,
      toLine: b.number - 1,
      toCh: toA - b.from,
      insert: inserted.toString(),
    });
  });
  return out;
}

// 文字列の表示幅と桁。等幅フォントで、半角を 1 桁、全角を 2 桁、タブを tabSize の桁までと数える。
// DOM に依存しないのでテストから直接呼べる。

/** 全角（2 桁）で表示する文字 */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u;

/** 文字列の表示幅（半角を 1、全角を 2 と数える） */
export function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

/** 桁 column にある文字 ch の後ろの桁 */
function nextColumn(column, ch, tabSize) {
  return ch === '\t' ? column + tabSize - (column % tabSize) : column + displayWidth(ch);
}

/** タブを tabSize の桁まで進め、全角を 2 桁と数えた幅 */
export function columnsOf(text, tabSize) {
  let column = 0;
  for (const ch of text) column = nextColumn(column, ch, tabSize);
  return column;
}

/** 文書の from から始まる text の中で、桁 column の位置。column が全角の文字の途中なら、その文字の前 */
export function posAtColumn(text, from, column, tabSize) {
  let current = 0;
  let pos = from;
  for (const ch of text) {
    const next = nextColumn(current, ch, tabSize);
    if (next > column) break;
    current = next;
    pos += ch.length;
  }
  return pos;
}

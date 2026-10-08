// 文字列の表示幅と桁。等幅フォントで、半角を 1 桁、全角と絵文字を 2 桁、タブを tabSize の桁までと数える。
// DOM に依存しないのでテストから直接呼べる。

/** 全角（2 桁）で表示する文字 */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u;
/** 絵文字として 2 桁で表示するもの（絵文字の表示が既定の文字、異体字セレクタで絵文字にした文字、国旗） */
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|\p{Regional_Indicator}/u;

/**
 * 見た目の 1 文字（書記素）ごとに分ける。結合文字（濁点の結合文字など）や、絵文字の組み合わせ（ZWJ で
 * つないだものや肌の色）は、前の文字と合わせて 1 文字にする
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function graphemes(text) {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** 見た目の 1 文字の幅 */
function graphemeWidth(g) {
  return WIDE.test(g) || EMOJI.test(g) ? 2 : 1;
}

/** 文字列の表示幅（半角を 1、全角と絵文字を 2 と数える） */
export function displayWidth(text) {
  let width = 0;
  for (const g of graphemes(text)) width += graphemeWidth(g);
  return width;
}

/** 桁 column にある文字 g の後ろの桁 */
function nextColumn(column, g, tabSize) {
  return g === '\t' ? column + tabSize - (column % tabSize) : column + graphemeWidth(g);
}

/** タブを tabSize の桁まで進め、全角と絵文字を 2 桁と数えた幅 */
export function columnsOf(text, tabSize) {
  let column = 0;
  for (const g of graphemes(text)) column = nextColumn(column, g, tabSize);
  return column;
}

/**
 * 文書の from から始まる text の中で、桁 column の位置。column が全角の文字の途中なら、その文字の前。
 * 見た目の 1 文字の途中（結合文字の前など）には置かない
 */
export function posAtColumn(text, from, column, tabSize) {
  let current = 0;
  let pos = from;
  for (const g of graphemes(text)) {
    const next = nextColumn(current, g, tabSize);
    if (next > column) break;
    current = next;
    pos += g.length;
  }
  return pos;
}

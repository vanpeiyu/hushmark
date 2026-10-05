// 日本語の文で **強調** が効かない問題への対策。
//
// CommonMark は、区切り記号（** や ~~）が強調を開けるか閉じられるかを、記号の前後の文字で決める
// （left-flanking / right-flanking）。記号の内側が約物（。」）など）のときは、外側が空白か約物でないと
// 開けも閉じもできない。そのため「**注意（readme.md 参照）。**の件」や「は**「重要」**です」のように、
// 日本語の文では強調にならない。
//
// markdown-cjk-friendly（https://github.com/tats-u/markdown-cjk-friendly）と同じく、
// 外側が CJK の文字なら、内側が約物でも開ける・閉じられるとみなす。
// Lezer の強調の解析はそのまま使い、作られた区切り記号の「開ける・閉じられる」の判定だけを置き換える
// （区切り記号の種類のオブジェクトが公開されておらず、自前の区切り記号では ** を太字にできないため）。

/** CommonMark の約物（Lezer と同じく Unicode の P と S） */
const PUNCTUATION = /[\p{P}\p{S}]/u;
const SPACE = /\s|^$/;
/** 漢字・かな・ハングルと、CJK の記号・約物・全角形 */
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}⺀-⿟　-〿㆐-ㇿ︰-﹏＀-￯]/u;

const OPEN = 1;
const CLOSE = 2;

/** pos の直前の 1 文字（サロゲートペアは 2 単位で取る） */
function charBefore(cx, pos) {
  const one = cx.slice(pos - 1, pos);
  return /[\udc00-\udfff]/.test(one) ? cx.slice(pos - 2, pos) : one;
}

function charAfter(cx, pos) {
  const one = cx.slice(pos, pos + 1);
  return /[\ud800-\udbff]/.test(one) ? cx.slice(pos, pos + 2) : one;
}

/**
 * 区切り記号の前後の文字から、CJK を考えた flanking を求める。
 * - 外側が CJK の文字なら、内側が約物でも開ける・閉じられる（は**「重要」**です）。
 * - 内側の CJK の約物（。」など）は約物として数えない。外側が数字や英字でも開ける・閉じられる
 *   （**重要。**2つ目、100**「上限」**）。英語の約物（" など）の扱いは CommonMark のまま。
 */
export function flanking(before, after) {
  const sBefore = SPACE.test(before);
  const sAfter = SPACE.test(after);
  const pBefore = PUNCTUATION.test(before);
  const pAfter = PUNCTUATION.test(after);
  const cBefore = CJK.test(before);
  const cAfter = CJK.test(after);
  // 内側の文字が約物でも、CJK の約物なら約物として扱わない
  const innerPBefore = pBefore && !cBefore;
  const innerPAfter = pAfter && !cAfter;
  return {
    left: !sAfter && (!innerPAfter || sBefore || pBefore || cBefore),
    right: !sBefore && (!innerPBefore || sAfter || pAfter || cAfter),
    pBefore,
    pAfter,
  };
}

/**
 * 組み込みの解析（name）を呼び、作られた区切り記号の side を置き換える。
 * 組み込みの解析が見つからないとき（Lezer の作りが変わったとき）は何もしない。
 */
function wrapParser(name, chars, side) {
  return (cx, next, start) => {
    if (!chars.includes(next)) return -1;
    const index = cx.parser.inlineNames.indexOf(name);
    if (index < 0) return -1;
    const count = cx.parts.length;
    const end = cx.parser.inlineParsers[index](cx, next, start);
    if (end < 0) return end;
    const delimiter = cx.parts[cx.parts.length - 1];
    if (cx.parts.length === count + 1 && delimiter && delimiter.from === start && 'side' in delimiter) {
      const f = flanking(charBefore(cx, delimiter.from), charAfter(cx, delimiter.to));
      delimiter.side = side(next, f);
    }
    return end;
  };
}

/** CommonMark の規則のうち、flanking だけを CJK を考えたものにする（_ の単語の中の扱いはそのまま） */
const emphasisSide = (next, { left, right, pBefore, pAfter }) => {
  const canOpen = left && (next === 42 || !right || pBefore);
  const canClose = right && (next === 42 || !left || pAfter);
  return (canOpen ? OPEN : 0) | (canClose ? CLOSE : 0);
};

const strikethroughSide = (_next, { left, right }) => (left ? OPEN : 0) | (right ? CLOSE : 0);

/** @lezer/markdown の拡張。GFM（Strikethrough）より後に入れる */
export const cjkFriendlyEmphasis = {
  parseInline: [
    { name: 'CJKFriendlyEmphasis', before: 'Emphasis', parse: wrapParser('Emphasis', [42, 95], emphasisSide) },
    { name: 'CJKFriendlyStrikethrough', before: 'Strikethrough', parse: wrapParser('Strikethrough', [126], strikethroughSide) },
  ],
};

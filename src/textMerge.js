'use strict';

// 文字列の差分と、Webview から届いた編集の位置合わせ。VSCode に依存しないので単体テストから直接呼べる。
// 改行は LF にそろえた文字列で扱う。位置は行・列で受け渡す（CRLF の文書でも行・列は同じため）。

/**
 * 2 つの文字列の差分を、共通の先頭と末尾を除いた 1 つの置換として返す。
 * @returns {{from: number, to: number, insert: string} | null}
 */
function diffText(oldText, newText) {
  if (oldText === newText) return null;
  const max = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  // サロゲートペアの途中で切らない
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start--;

  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start &&
         oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  if (endOld < oldText.length && isLowSurrogate(oldText.charCodeAt(endOld))) {
    endOld++;
    endNew++;
  }
  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}

/** diffHunks が行の単位で比べる範囲の上限（行数の積）。超えたら diffText の 1 つの置換にする */
const MAX_LINE_PAIRS = 4000000;

/**
 * 2 つの文字列の差分を、変わったところごとの置換の列として返す（位置はすべて oldText が基準で、前から順）。
 * 離れた 2 か所が変わったとき、diffText の 1 つの置換ではその間の文字も置き換えるので、間にあるカーソルが
 * 動いてしまう。共通の先頭と末尾を除いた範囲を行の単位で比べ（最長共通部分列）、変わった行のまとまりごとに
 * 置換を作る。それぞれの置換は、さらに文字の単位で最小にする。
 * @returns {{from: number, to: number, insert: string}[]}
 */
function diffHunks(oldText, newText) {
  const outer = diffText(oldText, newText);
  if (!outer) return [];
  // 範囲を行の境目まで広げる。末尾の後ろは両方に共通なので、newText でも行の終わりになる
  // lastIndexOf は負の位置を 0 として調べるので、先頭からの変更は分けて扱う
  const from = outer.from === 0 ? 0 : oldText.lastIndexOf('\n', outer.from - 1) + 1;
  const nl = oldText.indexOf('\n', outer.to);
  const oldTo = nl < 0 ? oldText.length : nl;
  const newTo = oldTo + (newText.length - oldText.length);
  // 各行を「行 + 改行」として比べる。範囲の最後の行にも改行を足しておき、最後に戻す
  const a = (oldText.slice(from, oldTo) + '\n').split(/(?<=\n)/);
  const b = (newText.slice(from, newTo) + '\n').split(/(?<=\n)/);
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LINE_PAIRS) return [outer];

  // 最長共通部分列の長さの表（後ろから）
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }

  const virtualEnd = oldTo - from + 1;
  const hunks = [];
  let i = 0;
  let j = 0;
  let oldPos = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      oldPos += a[i++].length;
      j++;
      continue;
    }
    let hunkFrom = oldPos;
    let insert = '';
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j >= m || (i < n && table[(i + 1) * w + j] >= table[i * w + j + 1])) oldPos += a[i++].length;
      else insert += b[j++];
    }
    let hunkTo = oldPos;
    // 足した改行にかかる置換は、本当の文字列での置換に直す（行の単位なので、insert は空か改行で終わる）
    if (hunkTo === virtualEnd) {
      if (hunkFrom === virtualEnd) {
        // 末尾への挿入: 足した改行の前に「改行 + 挿入する行」を入れる
        insert = `\n${insert.slice(0, -1)}`;
        hunkFrom--;
      } else if (insert.endsWith('\n')) {
        insert = insert.slice(0, -1);
      } else if (hunkFrom > 0) {
        // 末尾の行を消す: 足した改行の代わりに、その前の改行を消す
        hunkFrom--;
      }
      hunkTo--;
    }
    const oldSlice = oldText.slice(from + hunkFrom, from + hunkTo);
    const inner = diffText(oldSlice, insert);
    if (inner) hunks.push({ from: from + hunkFrom + inner.from, to: from + hunkFrom + inner.to, insert: inner.insert });
  }
  return hunks;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 各行の先頭のオフセット */
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function offsetAt(starts, text, line, ch) {
  if (line >= starts.length) return text.length;
  return Math.min(starts[line] + ch, line + 1 < starts.length ? starts[line + 1] - 1 : text.length);
}

function positionAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, ch: offset - starts[lo] };
}

/**
 * Webview の文書（base）に対する行・列の編集を、今の文書（current）に当てられる位置に直す。
 *
 * Webview に外からの変更（分割表示の別の側での編集、テキストエディタでの編集、git checkout など）が
 * まだ届いていないと、base と current は食い違う。その差（1 つの置換にまとめる）より前の編集はそのまま、
 * 後ろの編集はその分ずらす。差と重なる編集は、どちらを優先しても内容が壊れうるので null を返す
 * （呼び出し側は編集を捨て、全文を同期し直す）。
 *
 * @param {string} base 編集の前に Webview が持っていた全文
 * @param {string} current 今の文書の全文
 * @param {{fromLine: number, fromCh: number, toLine: number, toCh: number, insert: string}[]} changes
 *   すべて base に対する位置（toLineChanges の形式）
 * @returns 同じ形式で current に対する位置の編集。重なるときは null
 */
function rebaseChanges(base, current, changes) {
  if (base === current) return changes;
  const external = diffText(base, current);
  const baseStarts = lineStarts(base);
  const currentStarts = lineStarts(current);
  const shift = external.insert.length - (external.to - external.from);
  const out = [];
  for (const c of changes) {
    let from = offsetAt(baseStarts, base, c.fromLine, c.fromCh);
    let to = offsetAt(baseStarts, base, c.toLine, c.toCh);
    if (to <= external.from) {
      // 外からの変更より前
    } else if (from >= external.to) {
      from += shift;
      to += shift;
    } else {
      return null;
    }
    const a = positionAt(currentStarts, from);
    const b = positionAt(currentStarts, to);
    out.push({ fromLine: a.line, fromCh: a.ch, toLine: b.line, toCh: b.ch, insert: c.insert });
  }
  return out;
}

module.exports = { diffText, diffHunks, rebaseChanges };

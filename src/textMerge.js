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

module.exports = { diffText, rebaseChanges };

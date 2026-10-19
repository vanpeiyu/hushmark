// 太字と斜体の切り替え（hushmark.bold / hushmark.italic。既定のキーは Ctrl+B / Ctrl+I）。
// Typora や Word と同じく、同じ操作をもう一度すると元に戻る（トグル）。
//
// - 選択範囲が太字の中身か、記号を含めた太字の全体なら、太字を外す。そうでなければ囲む
// - 選択がないとき
//   - 空の「****」の間なら、それを消す（Ctrl+B を 2 回押したとき）
//   - 太字の中身の末尾なら、閉じの記号の後ろに出る（Ctrl+B → 入力 → Ctrl+B で太字を書き終える）
//   - 太字の中のそのほかの位置なら、太字を外す
//   - 英数字の語の途中なら、その語を囲む
//   - それ以外では「****」を入れて間にカーソルを置く
// 太字か斜体かは構文木で見分ける（太字の「**」の内側の「*」を斜体の記号と取り違えない）。

import { EditorSelection } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

const NODE = { '**': 'StrongEmphasis', '*': 'Emphasis' };
const WORD = /[\p{Script=Latin}\p{Nd}_]/u;

/** 要素の中身（最初と最後の記号の間） */
function innerOf(node) {
  const marks = node.getChildren('EmphasisMark');
  if (marks.length < 2) return null;
  return { from: marks[0].to, to: marks[marks.length - 1].from, open: marks[0], close: marks[marks.length - 1] };
}

/** from〜to を含む、種類が name の要素。内側のものから探す */
function elementAround(state, name, from, to) {
  for (let node = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (node.name === name && node.from <= from && node.to >= to) return node;
  }
  for (let node = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) {
    if (node.name === name && node.from <= from && node.to >= to) return node;
  }
  return null;
}

function unwrap(element, inner, range) {
  const open = inner.open.to - inner.open.from;
  const changes = [{ from: inner.open.from, to: inner.open.to }, { from: inner.close.from, to: inner.close.to }];
  const map = (pos) => Math.min(Math.max(pos, inner.from), inner.to) - open;
  return { changes, range: EditorSelection.range(map(range.anchor), map(range.head)) };
}

function toggleRange(state, marker, range) {
  const len = marker.length;
  const name = NODE[marker];
  const wrap = (from, to) => ({
    changes: [{ from, insert: marker }, { from: to, insert: marker }],
    range: EditorSelection.range(range.anchor + len, range.head + len),
  });

  if (!range.empty) {
    const element = elementAround(state, name, range.from, range.to);
    const inner = element && innerOf(element);
    if (inner && ((inner.from === range.from && inner.to === range.to) || (element.from === range.from && element.to === range.to))) {
      return unwrap(element, inner, range);
    }
    return wrap(range.from, range.to);
  }

  const pos = range.head;
  if (state.sliceDoc(pos - len, pos) === marker && state.sliceDoc(pos, pos + len) === marker) {
    return { changes: { from: pos - len, to: pos + len }, range: EditorSelection.cursor(pos - len) };
  }
  const element = elementAround(state, name, pos, pos);
  const inner = element && innerOf(element);
  if (inner && pos >= inner.from && pos <= inner.to) {
    if (pos === inner.to && inner.to > inner.from) return { range: EditorSelection.cursor(inner.close.to) };
    return unwrap(element, inner, range);
  }
  const word = state.wordAt(pos);
  if (word && word.from < pos && word.to > pos &&
      WORD.test(state.sliceDoc(pos - 1, pos)) && WORD.test(state.sliceDoc(pos, pos + 1))) {
    let { from, to } = word;
    while (from < pos && !WORD.test(state.sliceDoc(from, from + 1))) from++;
    while (to > pos && !WORD.test(state.sliceDoc(to - 1, to))) to--;
    return wrap(from, to);
  }
  return wrap(pos, pos);
}

/** marker（'**' か '*'）で囲む・外すコマンド */
export function toggleInline(marker) {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    dispatch(state.update(state.changeByRange((range) => {
      const result = toggleRange(state, marker, range);
      return { changes: result.changes || [], range: result.range };
    }), { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

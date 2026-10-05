// ↑ / ↓ でカーソルを動かすときの横位置。
//
// CodeMirror は画面上の横位置（px）を保って上下に動く。このエディタでは、カーソルが入った行で Markdown の
// 記号が出るので、移動先の行の文字の横位置が動き、見た目で選んだ位置と違う文字に着いてしまう。
// そこで、行をまたぐときは行頭からの桁数（全角は 2 桁、タブは tabSize の桁まで）を保って動く（logical）。
// VSCode も上下の移動では桁で横位置を決めている。
//
// 折り返した行の中（同じ行の見た目の行の間）は、CodeMirror のとおり見た目で動く。
// 上の行が折り返しているときは、その最後の見た目の行に着く。

import { Annotation, EditorSelection } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { columnsOf, posAtColumn } from './textWidth.js';


/** 最後に動かした先と、そのときに保っていた桁。続けて動かすときは、短い行を通っても元の桁に戻る */
let sticky = null;
/** ↑ / ↓ で動かした選択に付ける印。ほかの操作でカーソルが動いたら、保っていた桁を捨てる */
const verticalMoved = Annotation.define();
const forgetSticky = EditorView.updateListener.of((update) => {
  if (sticky && update.transactions.some((tr) => tr.selection && !tr.annotation(verticalMoved))) sticky = null;
});

const rowBoundary = (view, pos, assoc, forward) =>
  view.moveToLineBoundary(EditorSelection.cursor(pos, assoc), forward).head;

/**
 * pos がある見た目の行の先頭。最初の見た目の行なら行頭を返す
 * （行頭の ** などを幅ごと隠していると、CodeMirror は隠した記号の後ろを見た目の行の先頭として返すため）
 */
function rowStartOf(view, pos, assoc, line) {
  const start = rowBoundary(view, pos, assoc, false);
  if (start <= line.from) return line.from;
  const first = view.coordsAtPos(line.from, 1);
  const here = view.coordsAtPos(start, 1);
  return first && here && Math.abs(first.top - here.top) < 1 ? line.from : start;
}

/** range を 1 行上か下の行に、桁を保って動かした先。行の中で動くとき（折り返した行の途中）は null */
function moveRange(view, range, forward) {
  const { state } = view;
  const line = state.doc.lineAt(range.head);
  const rowStart = rowStartOf(view, range.head, range.assoc, line);
  const rowEnd = rowBoundary(view, range.head, range.assoc, true);
  if (forward ? rowEnd < line.to : rowStart > line.from) return null;
  const number = line.number + (forward ? 1 : -1);
  if (number < 1 || number > state.doc.lines) return null;
  const target = state.doc.line(number);
  const column = sticky && sticky.pos === range.head
    ? sticky.column
    : columnsOf(state.sliceDoc(rowStart, range.head), state.tabSize);
  // 下へは移動先の行の最初の見た目の行、上へは最後の見た目の行に着く
  const from = forward ? target.from : rowStartOf(view, target.to, -1, target);
  const to = forward ? rowBoundary(view, target.from, 1, true) : target.to;
  return { head: posAtColumn(state.sliceDoc(from, to), from, column, state.tabSize), column };
}

function move(forward, extend) {
  return (view) => {
    const { state } = view;
    const moved = state.selection.ranges.map((range) => moveRange(view, range, forward));
    // どれか 1 つでも行の中の移動なら、CodeMirror の動き（見た目）に任せる
    if (moved.some((m) => m === null)) return false;
    const ranges = state.selection.ranges.map((range, i) =>
      (extend ? EditorSelection.range(range.anchor, moved[i].head) : EditorSelection.cursor(moved[i].head)));
    const selection = EditorSelection.create(ranges, state.selection.mainIndex);
    view.dispatch({ selection, scrollIntoView: true, userEvent: 'select', annotations: verticalMoved.of(true) });
    sticky = { pos: selection.main.head, column: moved[state.selection.mainIndex].column };
    return true;
  };
}

export function verticalMove() {
  return [forgetSticky, keymap.of([
    { key: 'ArrowUp', run: move(false, false), shift: move(false, true) },
    { key: 'ArrowDown', run: move(true, false), shift: move(true, true) },
  ])];
}

// 語の単位の移動、選択、削除（Ctrl+← / →、Ctrl+Shift+← / →、Ctrl+Backspace / Delete、ダブルクリック）。
// VSCode の editor.wordSegmenterLocales に言語（ja など）を指定したときは、Intl.Segmenter で文を語に分け、その境目で動く。
// 指定がなければ（既定）、CodeMirror の既定のまま動く（日本語の文字の並びを 1 つの語として扱う。VSCode の既定と同じ）

import { Compartment, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { deleteGroupBackward, deleteGroupForward } from '@codemirror/commands';
import { adjustWordDeletion } from './inlineFormat.js';
import { lineMarkup } from './blockEditing.js';

const compartment = new Compartment();

/**
 * 行の中の語の境目（行の先頭からのオフセット）。空白と記号の並びは語に含めない
 * @returns {{ from: number, to: number }[]} 語の範囲
 */
export function wordSegments(text, locales) {
  const segmenter = new Intl.Segmenter(locales, { granularity: 'word' });
  const words = [];
  for (const { segment, index, isWordLike } of segmenter.segment(text)) {
    if (isWordLike) words.push({ from: index, to: index + segment.length });
  }
  return words;
}

/** pos から、次（forward）/ 前の語の境目。行の端では隣の行へ */
export function nextBoundary(text, pos, forward, locales) {
  const words = wordSegments(text, locales);
  if (forward) {
    // VSCode と同じく、語の終わりに止まる
    const word = words.find((w) => w.to > pos);
    return word ? word.to : text.length;
  }
  const word = [...words].reverse().find((w) => w.from < pos);
  return word ? word.from : 0;
}

function moveBy(locales, forward, extend) {
  return (view) => {
    const { state } = view;
    const selection = EditorSelection.create(state.selection.ranges.map((range) => {
      const line = state.doc.lineAt(range.head);
      const offset = range.head - line.from;
      let head;
      if (forward && offset === line.length) head = Math.min(line.to + 1, state.doc.length);
      else if (!forward && offset === 0) head = Math.max(line.from - 1, 0);
      else head = line.from + nextBoundary(line.text, offset, forward, locales);
      return extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head);
    }), state.selection.mainIndex);
    view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

/**
 * 語の単位の削除。locales があればその言語の語の境目で、なければ CodeMirror の Ctrl+Backspace / Delete と
 * 同じ範囲を消す。どちらも、隠した記号の片方だけを消さないように範囲を直す（adjustWordDeletion）
 */
function deleteBy(locales, forward) {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const wordAt = (text, pos, fwd) => nextBoundary(text, pos, fwd, locales.length ? locales : undefined);
    view.dispatch(state.changeByRange((range) => {
      if (!range.empty) return { changes: { from: range.from, to: range.to }, range: EditorSelection.cursor(range.from) };
      const line = state.doc.lineAt(range.head);
      const offset = range.head - line.from;
      let target;
      if (forward && offset === line.length) target = Math.min(line.to + 1, state.doc.length);
      else if (!forward && offset === 0) target = Math.max(line.from - 1, 0);
      else if (locales.length) target = line.from + nextBoundary(line.text, offset, forward, locales);
      else target = groupTarget(state, range, forward);
      const changes = adjustWordDeletion(state, Math.min(range.head, target), Math.max(range.head, target), forward, wordAt, lineMarkup);
      return { changes, range: EditorSelection.cursor(changes[0].from) };
    }), { userEvent: forward ? 'delete.forward' : 'delete.backward', scrollIntoView: true });
    return true;
  };
}

/** CodeMirror の Ctrl+Backspace / Delete が消す範囲の、カーソルと反対の端 */
function groupTarget(state, range, forward) {
  let target = range.head;
  (forward ? deleteGroupForward : deleteGroupBackward)({
    state: state.update({ selection: EditorSelection.cursor(range.head) }).state,
    dispatch: (tr) => { tr.changes.iterChangedRanges((fromA, toA) => { target = forward ? toA : fromA; }); },
  });
  return target;
}

/**
 * ダブルクリックした位置の語を選ぶ。位置は、1 回目のクリックで置いたカーソルにする。
 * 1 回目のクリックでカーソルが強調やリンクに入ると記号が出て文字がずれるので、2 回目のクリックの座標では
 * 別の文字（記号や隣の語）に当たるため。locales がなければ CodeMirror の語の区切りを使う
 */
const selectWordOnDoubleClick = (locales) => EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.detail !== 2 || event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    const sel = view.state.selection.main;
    const pos = sel.empty ? sel.head : view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const line = view.state.doc.lineAt(pos);
    const offset = pos - line.from;
    let word;
    if (locales.length) {
      const words = wordSegments(line.text, locales);
      const found = words.find((w) => w.from <= offset && offset < w.to) || words.find((w) => w.to === offset);
      word = found && { from: line.from + found.from, to: line.from + found.to };
    } else {
      word = view.state.wordAt(pos);
    }
    if (!word) return false;
    event.preventDefault();
    view.dispatch({ selection: EditorSelection.range(word.from, word.to), userEvent: 'select.pointer' });
    return true;
  },
});

function extensionFor(locales) {
  // 語の単位の削除は、言語の指定がなくても受ける（隠した記号の片方だけを消さないように直すため）
  const deleteKeys = (list) => Prec.high(keymap.of([
    { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: deleteBy(list, false) },
    { key: 'Mod-Delete', mac: 'Alt-Delete', run: deleteBy(list, true) },
  ]));
  if (!Array.isArray(locales) || locales.length === 0) return [deleteKeys([]), selectWordOnDoubleClick([])];
  // macOS では Option が語の単位（VSCode と同じ）
  return [
    Prec.high(keymap.of([
      { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', run: moveBy(locales, false, false), shift: moveBy(locales, false, true) },
      { key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight', run: moveBy(locales, true, false), shift: moveBy(locales, true, true) },
    ])),
    deleteKeys(locales),
    selectWordOnDoubleClick(locales),
  ];
}

const localesOf = (value) => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []);

export function wordSegmentation(options) {
  return compartment.of(extensionFor(localesOf(options.wordSegmenterLocales)));
}

export function reconfigureWordSegmentation(options) {
  return compartment.reconfigure(extensionFor(localesOf(options.wordSegmenterLocales)));
}

// 語の単位の移動、選択、削除（Ctrl+← / →、Ctrl+Shift+← / →、Ctrl+Backspace / Delete、ダブルクリック）。
// VSCode の editor.wordSegmenterLocales に言語（ja など）を指定したときは、Intl.Segmenter で文を語に分け、その境目で動く。
// 指定がなければ（既定）、CodeMirror の既定のまま動く（日本語の文字の並びを 1 つの語として扱う。VSCode の既定と同じ）

import { Compartment, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

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

function deleteBy(locales, forward) {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    view.dispatch(state.changeByRange((range) => {
      if (!range.empty) return { changes: { from: range.from, to: range.to }, range: EditorSelection.cursor(range.from) };
      const line = state.doc.lineAt(range.head);
      const offset = range.head - line.from;
      let target;
      if (forward && offset === line.length) target = Math.min(line.to + 1, state.doc.length);
      else if (!forward && offset === 0) target = Math.max(line.from - 1, 0);
      else target = line.from + nextBoundary(line.text, offset, forward, locales);
      const from = Math.min(range.head, target);
      const to = Math.max(range.head, target);
      return { changes: { from, to }, range: EditorSelection.cursor(from) };
    }), { userEvent: forward ? 'delete.forward' : 'delete.backward', scrollIntoView: true });
    return true;
  };
}

/** ダブルクリックした位置の語を選ぶ */
const selectWordOnDoubleClick = (locales) => EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.detail !== 2 || event.button !== 0 || event.shiftKey || event.altKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const line = view.state.doc.lineAt(pos);
    const offset = pos - line.from;
    const word = wordSegments(line.text, locales).find((w) => w.from <= offset && offset < w.to) ||
      wordSegments(line.text, locales).find((w) => w.to === offset);
    if (!word) return false;
    event.preventDefault();
    view.dispatch({ selection: EditorSelection.range(line.from + word.from, line.from + word.to), userEvent: 'select.pointer' });
    return true;
  },
});

function extensionFor(locales) {
  if (!Array.isArray(locales) || locales.length === 0) return [];
  // macOS では Option が語の単位（VSCode と同じ）
  return [
    Prec.high(keymap.of([
      { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', run: moveBy(locales, false, false), shift: moveBy(locales, false, true) },
      { key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight', run: moveBy(locales, true, false), shift: moveBy(locales, true, true) },
      { key: 'Mod-Backspace', mac: 'Alt-Backspace', run: deleteBy(locales, false) },
      { key: 'Mod-Delete', mac: 'Alt-Delete', run: deleteBy(locales, true) },
    ])),
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

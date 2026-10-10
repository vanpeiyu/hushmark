// VSCode のテキストエディタと同じ編集の操作。複数カーソル、矩形選択、行の操作、選択範囲の拡大と縮小、
// 選択範囲を記号で囲む操作、括弧の自動の閉じ、折りたたみ。
//
// 操作は actions（hushmark.<action> のコマンドから呼ばれる。commandKeys.js）にまとめる。
// VSCode の設定（editor.multiCursorModifier、editor.autoClosingBrackets、editor.autoSurround、editor.folding、
// editor.showFoldingControls）は editingOptions で受け取り、変わったら compartment で入れ替える。

import { Annotation, Compartment, EditorSelection, EditorState, Prec, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, crosshairCursor, rectangularSelection } from '@codemirror/view';
import {
  addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, deleteLine, indentLess, indentMore, insertBlankLine,
  moveLineDown, moveLineUp, selectLine, selectParentSyntax, toggleBlockComment, toggleComment, undoSelection,
} from '@codemirror/commands';
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import { closeBrackets } from '@codemirror/autocomplete';
import { codeFolding, foldAll, foldCode, foldGutter, unfoldAll, unfoldCode } from '@codemirror/language';
import { isMac } from './platform.js';

// ---------------------------------------------------------------------------
// 複数カーソルと矩形選択

/**
 * カーソルを足すクリックの修飾キー。VSCode の editor.multiCursorModifier に合わせる。
 * 'alt'（既定）なら Alt+クリック、'ctrlCmd' なら Ctrl+クリック（macOS では Cmd）。リンクを開くのはもう一方のキー（platform.js）
 */
let multiCursorModifier = 'alt';
const addsRange = (event) => (multiCursorModifier === 'ctrlCmd' ? (isMac ? event.metaKey : event.ctrlKey) : event.altKey);

/**
 * 選択範囲は、ブラウザーの選択の表示を使っている（editor.css）。ブラウザーの選択は 1 つしか描けないので、
 * 2 つ目以降の選択範囲は装飾で描く
 */
const secondarySelection = Decoration.mark({ class: 'cm-md-secondary-selection' });
const secondarySelections = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view.state); }
  update(update) { if (update.selectionSet || update.docChanged) this.decorations = this.build(update.state); }
  build(state) {
    const { ranges, mainIndex } = state.selection;
    if (ranges.length < 2) return Decoration.none;
    return Decoration.set(ranges.filter((r, i) => i !== mainIndex && !r.empty).map((r) => secondarySelection.range(r.from, r.to)), true);
  }
}, { decorations: (v) => v.decorations });

// ---------------------------------------------------------------------------
// 選択範囲の拡大と縮小（Shift+Alt+→ / ←）。拡大は構文木の親の範囲へ。縮小は、拡大する前の選択範囲に戻す

const expandHistory = StateField.define({
  create: () => [],
  update(stack, tr) {
    const pushed = tr.annotation(expandedFrom);
    if (pushed) return [...stack, pushed];
    if (tr.annotation(shrunk)) return stack.slice(0, -1);
    return tr.selection || tr.docChanged ? [] : stack;
  },
});
const expandedFrom = Annotation.define();
const shrunk = Annotation.define();

function smartSelectExpand(view) {
  const before = view.state.selection;
  if (!selectParentSyntax({ state: view.state, dispatch: (tr) => {
    if (tr.selection && !tr.selection.eq(before)) {
      view.dispatch({ selection: tr.selection, annotations: expandedFrom.of({ selection: before }), userEvent: 'select' });
    }
  } })) return false;
  return true;
}

function smartSelectShrink(view) {
  const stack = view.state.field(expandHistory);
  const last = stack[stack.length - 1];
  if (!last) return false;
  view.dispatch({ selection: last.selection, annotations: shrunk.of(true), userEvent: 'select' });
  return true;
}

// ---------------------------------------------------------------------------
// 行の操作のうち、CodeMirror にないもの

/** 現在の行の上に空の行を入れる（Ctrl+Shift+Enter） */
function insertLineBefore(view) {
  const { state } = view;
  if (state.readOnly) return false;
  const changes = [];
  const ranges = [];
  let shift = 0;
  const seen = new Set();
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (seen.has(line.number)) continue;
    seen.add(line.number);
    const indent = /^[ \t]*/.exec(line.text)[0];
    changes.push({ from: line.from, insert: `${indent}\n` });
    ranges.push(EditorSelection.cursor(line.from + shift + indent.length));
    shift += indent.length + 1;
  }
  view.dispatch({ changes, selection: EditorSelection.create(ranges), scrollIntoView: true, userEvent: 'input' });
  return true;
}

/** 選択範囲の各行の末尾にカーソルを置く（Shift+Alt+I） */
function insertCursorAtEndOfEachLineSelected(view) {
  const { state } = view;
  const ranges = [];
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      // 選択範囲が行頭で終わる最後の行は含めない（VSCode と同じ）
      if (n === last && n > first && range.to === line.from) continue;
      // 最後の行は選択範囲の終わり、ほかの行は行末
      ranges.push(EditorSelection.cursor(n === last ? range.to : line.to));
    }
  }
  if (ranges.length === 0) return false;
  view.dispatch({ selection: EditorSelection.create(ranges), userEvent: 'select' });
  return true;
}

// ---------------------------------------------------------------------------
// 選択範囲を記号で囲む（editor.autoSurround）と、括弧の自動の閉じ（editor.autoClosingBrackets）。
// 記号と括弧は、VSCode の Markdown の言語設定（markdown-basics の language-configuration.json）に合わせる

/** 選択範囲を囲む記号（surroundingPairs） */
const SURROUND = { '(': ')', '[': ']', '`': '`', _: '_', '*': '*', '{': '}', "'": "'", '"': '"', '<': '>', '~': '~', $: '$' };
const QUOTES = new Set(["'", '"', '`']);
/** 自動で閉じる括弧（autoClosingPairs） */
const CLOSE_BRACKETS = ['(', '[', '{', '<'];

let autoSurround = 'languageDefined';
let autoClosingBrackets = 'languageDefined';

const surroundInput = EditorView.inputHandler.of((view, from, to, text) => {
  const close = SURROUND[text];
  if (!close || autoSurround === 'never' || view.state.readOnly) return false;
  if (autoSurround === 'quotes' && !QUOTES.has(text)) return false;
  if (autoSurround === 'brackets' && QUOTES.has(text)) return false;
  const { state } = view;
  if (state.selection.ranges.some((r) => r.empty)) return false;
  view.dispatch(state.changeByRange((range) => ({
    changes: [{ from: range.from, insert: text }, { from: range.to, insert: close }],
    range: EditorSelection.range(range.anchor + (range.anchor > range.head ? 2 : 1), range.head + (range.anchor > range.head ? 1 : 2)),
  })), { userEvent: 'input.type' });
  return true;
});

const closeBracketsCompartment = new Compartment();
const closeBracketsExtension = () => (autoClosingBrackets === 'never' ? [] : [
  closeBrackets(),
  EditorState.languageData.of(() => [{ closeBrackets: { brackets: CLOSE_BRACKETS } }]),
]);

// ---------------------------------------------------------------------------
// 折りたたみ（editor.folding、editor.showFoldingControls）。範囲は Markdown の言語の定義（見出しの節、リスト、
// 引用、コードブロック）。折りたたみの印は、VSCode と同じく行番号の右に出す

let folding = true;
let showFoldingControls = 'mouseover';
const foldingCompartment = new Compartment();

const chevron = (open) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `cm-md-fold-marker${open ? '' : ' cm-md-fold-closed'}`);
  const path = svg.appendChild(document.createElementNS(ns, 'path'));
  // 開いているときは下向き、閉じているときは右向きの山形（VSCode の codicon の chevron と同じ形）
  path.setAttribute('d', open ? 'M3.5 6l4.5 4.5L12.5 6' : 'M6 3.5l4.5 4.5L6 12.5');
  return svg;
};

const foldingExtension = () => (folding ? [
  codeFolding({ placeholderDOM: (_view, onclick) => {
    const el = document.createElement('span');
    el.className = 'cm-md-fold-placeholder';
    el.textContent = '…';
    el.addEventListener('click', onclick);
    return el;
  } }),
  showFoldingControls === 'never' ? [] : foldGutter({ markerDOM: chevron }),
  EditorView.editorAttributes.of({ class: `cm-md-folding-${showFoldingControls}` }),
] : []);

// ---------------------------------------------------------------------------

/** VSCode のコマンドから呼ぶ操作（commandKeys.js の action） */
export const editingActions = {
  moveLinesUp: moveLineUp,
  moveLinesDown: moveLineDown,
  copyLinesUp: copyLineUp,
  copyLinesDown: copyLineDown,
  deleteLines: deleteLine,
  insertLineAfter: insertBlankLine,
  insertLineBefore,
  expandLineSelection: selectLine,
  indentLines: indentMore,
  outdentLines: indentLess,
  commentLine: toggleComment,
  blockComment: toggleBlockComment,
  insertCursorAbove: addCursorAbove,
  insertCursorBelow: addCursorBelow,
  insertCursorAtEndOfEachLineSelected,
  addSelectionToNextFindMatch: selectNextOccurrence,
  selectHighlights: selectSelectionMatches,
  cursorUndo: undoSelection,
  smartSelectExpand,
  smartSelectShrink,
  fold: (view) => folding && foldCode(view),
  unfold: (view) => folding && unfoldCode(view),
  foldAll: (view) => folding && foldAll(view),
  unfoldAll: (view) => folding && unfoldAll(view),
};

export function editing(options) {
  applyOptions(options);
  return [
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of(addsRange),
    // 矩形選択は、VSCode と同じく Shift+Alt を押しながらドラッグする
    rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
    crosshairCursor({ key: 'Alt' }),
    secondarySelections,
    expandHistory,
    Prec.high(surroundInput),
    closeBracketsCompartment.of(closeBracketsExtension()),
    foldingCompartment.of(foldingExtension()),
  ];
}

function applyOptions(options) {
  multiCursorModifier = options.multiCursorModifier === 'ctrlCmd' ? 'ctrlCmd' : 'alt';
  autoSurround = options.autoSurround || 'languageDefined';
  autoClosingBrackets = options.autoClosingBrackets || 'languageDefined';
  folding = options.folding !== false;
  showFoldingControls = options.showFoldingControls || 'mouseover';
}

/** 設定が変わったときの入れ替え */
export function reconfigureEditing(options) {
  applyOptions(options);
  return [
    closeBracketsCompartment.reconfigure(closeBracketsExtension()),
    foldingCompartment.reconfigure(foldingExtension()),
  ];
}

/** リンクを開くクリックの修飾キー。カーソルを足す修飾キーと重ならないようにする（VSCode と同じ） */
export function opensLink(event) {
  return multiCursorModifier === 'ctrlCmd' ? event.altKey : (isMac ? event.metaKey : event.ctrlKey);
}

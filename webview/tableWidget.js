// 表のウィジェット。表はいつも HTML の表として描き、触ったセルだけを小さなエディタ（cellEditor.js）にする。
// 行や列の追加、表全体のソース表示は、表にマウスを載せると出るボタンから行う。

import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { redo, selectAll, undo } from '@codemirror/commands';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { openLinkHandler, renderInline } from './inline.js';
import { cellChange, escapePipes, nowrapColumns } from './tableModel.js';
import { atVerticalEdge, cellKeymap, createCellEditor, placeCaret, replaceCellText, setCellText } from './cellEditor.js';
import { hasMod } from './platform.js';
import { t } from './strings.js';

// ---------------------------------------------------------------------------
// 表全体のソース表示

/** 表全体をソースで表示する／やめる。値は表の先頭の位置。 */
export const toggleRawTable = StateEffect.define();

/** ソースで表示している表の先頭の位置。カーソルが表から出たら元に戻す。 */
export const rawTables = StateField.define({
  create: () => [],
  update(list, tr) {
    let next = tr.docChanged ? list.map((pos) => tr.changes.mapPos(pos)) : list;
    for (const effect of tr.effects) {
      if (!effect.is(toggleRawTable)) continue;
      next = next.includes(effect.value) ? next.filter((p) => p !== effect.value) : [...next, effect.value];
    }
    if (next.length > 0 && (tr.selection || tr.docChanged)) {
      const head = tr.state.selection.main.head;
      next = next.filter((pos) => {
        const table = tableAt(tr.state, pos);
        return table && head >= table.from && head <= table.to;
      });
    }
    return next;
  },
});

export function isRawTable(state, from, to) {
  return state.field(rawTables).some((pos) => pos >= from && pos <= to);
}

/** pos を含む表の範囲（行頭から行末まで）と構文木のノード */
export function tableAt(state, pos) {
  const found = (node) => ({ from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to, node });
  for (const side of [1, -1]) {
    for (let node = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'Table') return found(node);
    }
  }
  // 引用・リスト・字下げの中の表は、行頭の記号の後ろから始まる。pos が行頭なら、その行の中を探す
  const line = state.doc.lineAt(pos);
  let table = null;
  syntaxTree(state).iterate({
    from: pos,
    to: line.to,
    enter(node) {
      if (table) return false;
      if (node.name === 'Table' && node.from <= line.to) {
        table = node.node;
        return false;
      }
      return undefined;
    },
  });
  return table ? found(table) : null;
}

// ---------------------------------------------------------------------------
// ↑↓ で表を飛び越えるところで、表の端の行のセルを編集する
// （CodeMirror はブロックのウィジェットの上をカーソルで通れないため）

export const enterTableByKeyboard = keymap.of([
  { key: 'ArrowUp', run: enterTable(-1) },
  { key: 'ArrowDown', run: enterTable(1) },
]);

function enterTable(direction) {
  return (view) => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const line = state.doc.lineAt(sel.head);
    const adjacentNumber = line.number + direction;
    if (adjacentNumber < 1 || adjacentNumber > state.doc.lines) return false;
    const table = tableAt(state, state.doc.line(adjacentNumber).from);
    if (!table || isRawTable(state, table.from, table.to)) return false;
    // 折り返した長い行の途中なら、まず行の中を動く
    const target = view.moveVertically(sel, direction > 0);
    if (state.doc.lineAt(target.head).number === line.number) return false;
    const ctl = findTable(view, table.from);
    if (!ctl) return false;
    startEditing(ctl, direction > 0 ? 0 : ctl.widget.model.rows.length - 1, 0, 'end');
    return true;
  };
}

// ---------------------------------------------------------------------------
// 検索の一致を表のセルに出す
// （表は HTML で描いているので、CodeMirror の一致の強調が届かない。一致を含むセルに色を付ける）


export const tableSearchHighlight = ViewPlugin.fromClass(class {
  constructor(view) {
    this.schedule(view);
  }

  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
        update.transactions.some((tr) => tr.effects.length > 0)) {
      this.schedule(update.view);
    }
  }

  schedule(view) {
    view.requestMeasure({ key: this, read: () => null, write: () => markTableMatches(view) });
  }
});

// ---------------------------------------------------------------------------
// 表の中の位置へのスクロール
// 表は 1 つのブロックのウィジェットなので、CodeMirror は表の中の位置を知らず、表の端までしかスクロールしない
// （長い表の中の文字列を検索すると、選んだ一致とは別の場所が見えてしまう）。
// 表の中の位置へスクロールするときは、その位置を含むセルを画面の中ほどに出す（VSCode の検索と同じ）

export const tableScrollHandler = EditorView.scrollHandler.of((view, range) => {
  const pos = range.head;
  for (const wrap of view.contentDOM.querySelectorAll('.cm-md-table-wrap')) {
    const ctl = wrap.mdTable;
    if (!ctl) continue;
    const base = view.posAtDOM(wrap);
    if (pos < base || pos > base + ctl.widget.source.length) continue;
    revealElement(view, cellAtOffset(ctl, pos - base) || wrap);
    return true;
  }
  return false;
});

/** 表の先頭からのオフセットを含むセルの要素 */
function cellAtOffset(ctl, offset) {
  const { rows } = ctl.widget.model;
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < rows[row].length; col++) {
      const cell = rows[row][col];
      if (!cell.missing && offset >= cell.from && offset <= cell.to) return cellElement(ctl, row, col);
    }
  }
  return null;
}

/** 要素が画面に入っていなければ、画面の中ほどに来るようにスクロールする */
function revealElement(view, el) {
  const scroller = view.scrollDOM;
  const target = el.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (target.top >= box.top && target.bottom <= box.bottom) return;
  scroller.scrollTop += (target.top + target.height / 2) - (box.top + box.height / 2);
}

/** 一致を含むセルに色を付ける。いまの一致を含むセルを返す */
function markTableMatches(view) {
  let current = null;
  const { state } = view;
  const query = getSearchQuery(state);
  const searching = searchPanelOpen(state) && query.valid && query.search !== '';
  const sel = state.selection.main;
  for (const wrap of view.contentDOM.querySelectorAll('.cm-md-table-wrap')) {
    const ctl = wrap.mdTable;
    if (!ctl) continue;
    const base = view.posAtDOM(wrap);
    const matches = [];
    if (searching) {
      const cursor = query.getCursor(state, base, base + ctl.widget.source.length);
      for (let r = cursor.next(); !r.done; r = cursor.next()) matches.push(r.value);
    }
    ctl.widget.model.rows.forEach((cells, row) => {
      cells.forEach((cell, col) => {
        const el = ctl.table.rows[row] && ctl.table.rows[row].cells[col];
        if (!el) return;
        const from = base + cell.from;
        const to = base + cell.to;
        const inCell = matches.filter((m) => m.from < to && m.to > from);
        const isCurrent = inCell.some((m) => m.from === sel.from && m.to === sel.to);
        el.classList.toggle('cm-md-cell-match', inCell.length > 0);
        el.classList.toggle('cm-md-cell-match-current', isCurrent);
        if (isCurrent) current = el;
      });
    });
  }
  return current;
}

// ---------------------------------------------------------------------------
// ウィジェット

export class TableWidget extends WidgetType {
  /**
   * @param model buildTableModel の結果。オフセットは表の先頭からの相対位置
   * @param source 表のソース全体
   */
  constructor(model, source) {
    super();
    this.model = model;
    this.source = source;
  }

  eq(other) { return other.source === this.source; }

  // ソースの行数（データの行と、2 行分の見出しの行）と同じ数の本文の行の高さになる（editor.css）
  get estimatedHeight() { return (this.model.rows.length + 1) * 28; }

  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const ctl = { widget: this, view, wrap, table: null, editing: null, rebuilding: false };
    wrap.mdTable = ctl;
    // ボタンを表の右上の外（上の行）に重ねるため、表の幅に縮む箱に入れる。
    // 横にはみ出す表は内側の箱でスクロールさせ、外の箱ではボタンを切り取らない
    const box = wrap.appendChild(document.createElement('div'));
    box.className = 'cm-md-table-box';
    box.appendChild(createToolbar(ctl));
    const scroller = box.appendChild(document.createElement('div'));
    scroller.className = 'cm-md-table-scroll';
    ctl.table = scroller.appendChild(document.createElement('table'));
    ctl.table.className = 'cm-md-table';
    renderTable(ctl);
    wrap.addEventListener('mousedown', (event) => onMouseDown(ctl, event));
    return wrap;
  }

  /** セルを編集している最中も入力欄を消さないよう、DOM は作り直さずに中身だけ差し替える */
  updateDOM(dom, view) {
    const ctl = dom.mdTable;
    if (!ctl) return false;
    const previous = ctl.widget;
    ctl.widget = this;
    ctl.view = view;
    const sameShape = previous.model.rows.length === this.model.rows.length &&
      previous.model.rows[0].length === this.model.rows[0].length;
    if (sameShape) patchTable(ctl);
    else renderTable(ctl);
    return true;
  }

  ignoreEvent() { return true; }

  /** 表が文書から消えたとき（外からの変更などで）。編集中のセルのエディタを破棄する */
  destroy(dom) {
    const ctl = dom.mdTable;
    if (ctl && ctl.editing) {
      const { editor } = ctl.editing;
      ctl.editing = null;
      editor.destroy();
    }
  }
}

function renderTable(ctl) {
  const editing = ctl.editing;
  const caret = editing ? editing.editor.state.selection.main.head : null;
  ctl.rebuilding = true;
  ctl.editing = null;
  if (editing) editing.editor.destroy();
  releaseColumns(ctl);
  ctl.table.textContent = '';
  const { aligns, rows } = ctl.widget.model;
  const nowrap = nowrapColumns(ctl.widget.model);
  const thead = ctl.table.appendChild(document.createElement('thead'));
  const tbody = ctl.table.appendChild(document.createElement('tbody'));
  rows.forEach((cells, row) => {
    const tr = (row === 0 ? thead : tbody).appendChild(document.createElement('tr'));
    cells.forEach((cell, col) => {
      const el = tr.appendChild(document.createElement(row === 0 ? 'th' : 'td'));
      el.dataset.row = String(row);
      el.dataset.col = String(col);
      if (aligns[col]) el.style.textAlign = aligns[col];
      el.classList.toggle('cm-md-cell-nowrap', nowrap[col]);
      showRendered(el, cell.text);
    });
  });
  ctl.rebuilding = false;
  // 行や列の数が変わっても、編集していたセルが残っていれば編集を続ける
  if (editing && rows[editing.row] && rows[editing.row][editing.col]) {
    startEditing(ctl, editing.row, editing.col, caret);
  }
}

function patchTable(ctl) {
  const { aligns, rows } = ctl.widget.model;
  const nowrap = nowrapColumns(ctl.widget.model);
  rows.forEach((cells, row) => {
    cells.forEach((cell, col) => {
      const el = cellElement(ctl, row, col);
      el.style.textAlign = aligns[col] || '';
      el.classList.toggle('cm-md-cell-nowrap', nowrap[col]);
      const editing = ctl.editing;
      if (editing && editing.row === row && editing.col === col) {
        // 取り消しなどで内容が変わったときだけセルのエディタを書き換える（前後の空白の違いは無視する）
        if (editing.editor.state.doc.toString().trim() !== cell.text) setCellText(editing.editor, cell.text);
      } else if (el.dataset.src !== cell.text) {
        showRendered(el, cell.text);
      }
    });
  });
}

function showRendered(el, text) {
  el.textContent = '';
  el.classList.remove('cm-md-cell-editing');
  renderInline(text, el);
  el.dataset.src = text;
}

function cellElement(ctl, row, col) {
  return ctl.table.rows[row].cells[col];
}

function findTable(view, from) {
  for (const wrap of view.contentDOM.querySelectorAll('.cm-md-table-wrap')) {
    if (wrap.mdTable && view.posAtDOM(wrap) === from) return wrap.mdTable;
  }
  return null;
}

function tableBase(ctl) {
  return ctl.view.posAtDOM(ctl.wrap);
}

// ---------------------------------------------------------------------------
// セルの編集

/**
 * セルを編集する。
 * 列の幅は編集を始める直前の幅で固定し、セルから出たら計算し直す（stopEditing）。
 * 編集中に中身が変わっても、列の幅が変わって表の形が崩れないようにするため。
 * @param caret 'end' | 'all' | 数値（カーソルの位置）| { x, y }（クリックした位置）
 */
function startEditing(ctl, row, col, caret = 'end') {
  if (ctl.editing) stopEditing(ctl);
  fixColumns(ctl);
  const cell = ctl.widget.model.rows[row][col];
  const el = cellElement(ctl, row, col);
  el.textContent = '';
  el.classList.add('cm-md-cell-editing');
  delete el.dataset.src;

  const editor = createCellEditor({
    parent: el,
    text: cell.text,
    openLink: (href) => ctl.view.state.facet(openLinkHandler)(href),
    keys: cellKeys(ctl),
    onChange: () => commit(ctl),
    readOnly: ctl.view.state.readOnly,
    onBlur: () => {
      if (!ctl.rebuilding && ctl.editing && ctl.editing.editor === editor) stopEditing(ctl);
    },
  });
  ctl.editing = { row, col, editor };
  editor.focus();
  placeCaret(editor, caret);
}

function stopEditing(ctl) {
  const editing = ctl.editing;
  if (!editing) return;
  ctl.editing = null;
  const el = editing.editor.dom.parentElement;
  editing.editor.destroy();
  const cell = ctl.widget.model.rows[editing.row] && ctl.widget.model.rows[editing.row][editing.col];
  if (el) showRendered(el, cell ? cell.text : '');
  releaseColumns(ctl);
}

/** 列の幅をいまの幅で固定する */
function fixColumns(ctl) {
  const table = ctl.table;
  const header = table.rows[0] ? [...table.rows[0].cells] : [];
  const widths = header.map((th) => th.getBoundingClientRect().width);
  // 表を描き直している途中で、まだ画面に置かれていないときは測れない（幅が 0 になる）ので固定しない
  if (!table.isConnected || widths.some((w) => w === 0)) return;
  table.style.width = `${table.getBoundingClientRect().width}px`;
  table.style.tableLayout = 'fixed';
  header.forEach((th, i) => {
    th.style.boxSizing = 'border-box';
    th.style.width = `${widths[i]}px`;
  });
}

function releaseColumns(ctl) {
  const table = ctl.table;
  table.style.width = '';
  table.style.tableLayout = '';
  for (const th of table.rows[0] ? table.rows[0].cells : []) {
    th.style.boxSizing = '';
    th.style.width = '';
  }
}

/** セルのエディタの内容を文書に書き込む */
function commit(ctl) {
  const editing = ctl.editing;
  if (!editing) return;
  const { editor } = editing;

  // | はセルの区切りになるので、打たれたらエスケープする
  const text = editor.state.doc.toString();
  const escaped = escapePipes(text);
  if (escaped !== text) {
    const head = editor.state.selection.main.head;
    replaceCellText(editor, escaped, escapePipes(text.slice(0, head)).length);
  }

  const view = ctl.view;
  const base = tableBase(ctl);
  const cell = ctl.widget.model.rows[editing.row][editing.col];
  const charAfter = view.state.sliceDoc(base + cell.to, base + cell.to + 1);
  const change = cellChange(ctl.widget.model, editing.row, editing.col, escaped, charAfter);
  if (!change || view.state.sliceDoc(base + change.from, base + change.to) === change.insert) return;
  view.dispatch({
    changes: { from: base + change.from, to: base + change.to, insert: change.insert },
    userEvent: 'input.type',
  });
}

/**
 * セルのエディタのキー。取り消しは本文の文書の履歴で行う。
 * VSCode の Webview は Ctrl+Z などを横取りするので、stopPropagation で止める
 */
function cellKeys(ctl) {
  const own = (key, run) => ({ key, run: () => { run(); return true; }, preventDefault: true, stopPropagation: true });
  // 端の行の途中ではまずセルの先頭（↑）／末尾（↓）に動き、そこからもう一度押すと隣のセルに移る
  // （テキストエディタで最初の行の ↑、最後の行の ↓ を押したときと同じ）
  const vertical = (forward) => (editor) => {
    if (!atVerticalEdge(editor, forward)) return false;
    const end = forward ? editor.state.doc.length : 0;
    if (editor.state.selection.main.head !== end) editor.dispatch({ selection: { anchor: end } });
    else moveVertical(ctl, forward ? 1 : -1);
    return true;
  };
  const horizontal = (forward) => (editor) => {
    const sel = editor.state.selection.main;
    if (!sel.empty || sel.head !== (forward ? editor.state.doc.length : 0)) return false;
    moveCell(ctl, forward ? 1 : -1, { caret: forward ? 0 : 'end', addRowAtEnd: false });
    return true;
  };
  return [
    // Ctrl+A は VSCode に渡すと、VSCode が Webview 全体を選ぶ命令（execCommand('selectAll')）を返し、
    // セルではなく本文の全体が選ばれて編集が終わる。セルの中だけで全部を選ぶ
    { key: 'Mod-a', run: selectAll, preventDefault: true, stopPropagation: true },
    own('Mod-z', () => undo(ctl.view)),
    own('Mod-y', () => redo(ctl.view)),
    own('Mod-Shift-z', () => redo(ctl.view)),
    // セルの先頭で ← を押すと前のセルの末尾へ、末尾で → を押すと次のセルの先頭へ移る
    { key: 'ArrowLeft', run: horizontal(false) },
    { key: 'ArrowRight', run: horizontal(true) },
    own('Tab', () => moveCell(ctl, 1)),
    own('Shift-Tab', () => moveCell(ctl, -1)),
    own('Enter', () => moveVertical(ctl, 1)),
    own('Shift-Enter', () => moveVertical(ctl, -1)),
    own('Escape', () => leaveTable(ctl, 1)),
    { key: 'ArrowDown', run: vertical(true) },
    { key: 'ArrowUp', run: vertical(false) },
    // 太字や検索など、本文のエディタと同じショートカット
    ...ctl.view.state.facet(cellKeymap),
  ];
}

/**
 * 前後のセルに移る。表の端を越えたら表の外に出る。
 * Tab では中身を選んで移り、最後のセルでは行を足す。← / → ではカーソルを端に置いて移り、行は足さない
 */
function moveCell(ctl, direction, { caret = 'all', addRowAtEnd = true } = {}) {
  const { row, col } = ctl.editing;
  const width = ctl.widget.model.rows[0].length;
  const index = row * width + col + direction;
  if (index < 0) return leaveTable(ctl, -1);
  if (index >= ctl.widget.model.rows.length * width) {
    // 最後のセルで Tab を押したら行を足して、その先頭のセルに移る
    if (addRowAtEnd && addRow(ctl)) return;
    return leaveTable(ctl, 1);
  }
  startEditing(ctl, Math.floor(index / width), index % width, caret);
}

function moveVertical(ctl, direction) {
  const { row, col } = ctl.editing;
  const next = row + direction;
  if (next < 0 || next >= ctl.widget.model.rows.length) return leaveTable(ctl, direction);
  startEditing(ctl, next, col, 'end');
}

/** 表の外にカーソルを出す。表が文書の端にあるときは空行を足す */
function leaveTable(ctl, direction) {
  const view = ctl.view;
  const base = tableBase(ctl);
  const end = base + ctl.widget.source.length;
  stopEditing(ctl);
  view.focus();
  if (direction > 0) {
    if (end < view.state.doc.length) view.dispatch({ selection: EditorSelection.cursor(end + 1), scrollIntoView: true });
    else view.dispatch({ changes: { from: end, insert: '\n' }, selection: EditorSelection.cursor(end + 1), scrollIntoView: true });
  } else if (base > 0) {
    view.dispatch({ selection: EditorSelection.cursor(base - 1), scrollIntoView: true });
  } else {
    view.dispatch({ changes: { from: 0, insert: '\n' }, selection: EditorSelection.cursor(0), scrollIntoView: true });
  }
}

// ---------------------------------------------------------------------------
// 行・列の追加とソース表示

/** 表の各行の構文木のノード（見出し、区切り、本体の順） */
function tableLines(ctl) {
  const table = tableAt(ctl.view.state, tableBase(ctl));
  if (!table) return null;
  const lines = [];
  for (let child = table.node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader' || child.name === 'TableRow' || child.name === 'TableDelimiter') {
      lines.push({ from: child.from, to: child.to, delimiter: child.name === 'TableDelimiter' });
    }
  }
  return lines;
}

/** 最後に行を足して、その先頭のセルを編集する。引用やリストの中の表では行頭の記号を再現できないので足さない */
function addRow(ctl) {
  const view = ctl.view;
  const lines = tableLines(ctl);
  if (!lines) return false;
  const last = lines[lines.length - 1];
  if (view.state.doc.lineAt(last.from).from !== last.from) return false;
  const width = ctl.widget.model.rows[0].length;
  const row = ctl.widget.model.rows.length;
  stopEditing(ctl);
  view.dispatch({ changes: { from: last.to, insert: '\n|' + '  |'.repeat(width) } });
  const updated = findTable(view, tableBase(ctl)) || ctl;
  if (updated.widget.model.rows[row]) startEditing(updated, row, 0, 'end');
  return true;
}

function addColumn(ctl) {
  const view = ctl.view;
  const lines = tableLines(ctl);
  if (!lines) return;
  const width = ctl.widget.model.rows[0].length;
  stopEditing(ctl);
  const changes = lines.map((line) => {
    const text = view.state.sliceDoc(line.from, line.to).trimEnd();
    const pipeAtEnd = /(^|[^\\])\|$/.test(text);
    const insert = (pipeAtEnd ? '' : ' |') + (line.delimiter ? '---|' : '  |');
    return { from: line.from + text.length, insert };
  });
  view.dispatch({ changes });
  const updated = findTable(view, tableBase(ctl)) || ctl;
  if (updated.widget.model.rows[0][width]) startEditing(updated, 0, width, 'end');
}

function showSource(ctl) {
  const view = ctl.view;
  const base = tableBase(ctl);
  stopEditing(ctl);
  view.focus();
  view.dispatch({ effects: toggleRawTable.of(base), selection: EditorSelection.cursor(base), scrollIntoView: true });
}

function createToolbar(ctl) {
  const bar = document.createElement('div');
  bar.className = 'cm-md-table-tools';
  const button = (label, title, action) => {
    const b = bar.appendChild(document.createElement('button'));
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    // マウスでは mousedown で押す（セルの編集のフォーカスを外さないため）。
    // キーボード（Enter・Space）で押されたとき（click の detail が 0）は click で押す
    b.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 0) action();
    });
    b.addEventListener('click', (event) => {
      event.preventDefault();
      if (event.detail === 0) action();
    });
  };
  button(t('+ Row'), t('Add a row at the end'), () => addRow(ctl));
  button(t('+ Column'), t('Add a column at the right'), () => addColumn(ctl));
  button(t('Source'), t('Edit the whole table as Markdown source'), () => showSource(ctl));
  return bar;
}

function onMouseDown(ctl, event) {
  if (event.button !== 0) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest('.cm-md-table-tools, .cm-md-cell-input')) return;
  const link = target.closest('[data-href]');
  if (link && hasMod(event)) {
    event.preventDefault();
    ctl.view.state.facet(openLinkHandler)(link.getAttribute('data-href'));
    return;
  }
  const cell = target.closest('th, td');
  if (!cell) return;
  event.preventDefault();
  startEditing(ctl, Number(cell.dataset.row), Number(cell.dataset.col), { x: event.clientX, y: event.clientY });
}

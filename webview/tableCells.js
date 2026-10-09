// 表の行を通常の行のまま、セルを折り返す箱として表示する（試作）。
//
// 表のソースの 1 行は、エディタの 1 行のまま。行を flex にし、セル（| と | の間）を幅の決まった箱、
// | を幅の決まった隙間にして、列をそろえる。セルの文字は通常の行の文字なので、カーソル、入力、選択、検索は
// 本文と同じ仕組みで動く。
//
// 列の幅は、各セルの中身を画面の外で描いて測り（最大の幅と最小の幅）、表示できる幅に収まるよう配分する。
// カーソルが表の中にある間は幅を変えず、表から出たときに計算し直す（入力のたびに右の列が動かないように）。
//
// 選択範囲は、本文と同じくブラウザーの選択の表示を使うので、セルが横に並んでも文字の上にだけ描かれる（editor.css）。

import { StateEffect } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { renderInline } from './inline.js';
import { displayWidth } from './textWidth.js';

/** 測り直した列の幅を表示に反映させる */
const widthsMeasured = StateEffect.define();

/** この幅以下のセルしかない列は折り返さない（tableModel.js の nowrapColumns と同じ考え方） */
const NOWRAP_WIDTH = 16;

const pipeHidden = Decoration.mark({ class: 'cm-md-tpipe' });
const pipeShown = Decoration.mark({ class: 'cm-md-tpipe cm-md-tpipe-shown' });

/**
 * 行の中の | の位置（行の先頭からのオフセット）。\| は区切りにしない
 * @returns {number[]}
 */
export function pipePositions(text) {
  const pipes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '|') pipes.push(i);
  }
  return pipes;
}

/**
 * 行をセルの範囲に分ける。先頭の | より前と最後の | より後ろは、空白だけならセルにしない
 * @returns {{from: number, to: number}[]} 行の先頭からのオフセット。| は含めない
 */
export function cellSpans(text) {
  const pipes = pipePositions(text);
  const bounds = [-1, ...pipes, text.length];
  const spans = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i] + 1;
    const to = bounds[i + 1];
    const outer = i === 0 || i === bounds.length - 2;
    if (outer && text.slice(from, to).trim() === '') continue;
    spans.push({ from, to });
  }
  return { pipes, spans };
}

/**
 * 列の幅の配分。ブラウザーの表の自動レイアウトに近い単純な方法。
 * 最大の幅の合計が収まればそのまま、収まらなければ最小の幅を確保して、残りを (最大 - 最小) の比で配る
 * @param {{min: number, max: number}[]} columns
 * @param {number} available
 */
export function distributeWidths(columns, available) {
  const sumMax = columns.reduce((s, c) => s + c.max, 0);
  if (!(available > 0) || sumMax <= available) return columns.map((c) => c.max);
  const sumMin = columns.reduce((s, c) => s + c.min, 0);
  if (sumMin >= available) return columns.map((c) => c.min);
  const extra = available - sumMin;
  const flexible = sumMax - sumMin;
  return columns.map((c) => c.min + (extra * (c.max - c.min)) / flexible);
}

/** 文書の中の表（引用やリストの中も含む） */
function tablesOf(state) {
  const tables = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === 'Table') {
        tables.push(ref.node);
        return false;
      }
      return ref.name === 'Document' || ref.name === 'Blockquote' || ref.name.endsWith('List') || ref.name === 'ListItem';
    },
  });
  return tables;
}

/** 表の行（見出し、区切り、データ）。区切りの行は Table の直下の TableDelimiter */
function rowsOf(table) {
  const rows = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader') rows.push({ node: child, kind: 'head' });
    else if (child.name === 'TableDelimiter') rows.push({ node: child, kind: 'delim' });
    else if (child.name === 'TableRow') rows.push({ node: child, kind: 'body' });
  }
  return rows;
}

function alignmentsOf(text) {
  return cellSpans(text).spans.map(({ from, to }) => {
    const cell = text.slice(from, to).trim();
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return null;
  });
}

/** 中身のないセル（|| の間や、ソースで省略されたセル）の箱 */
class EmptyCellWidget extends WidgetType {
  constructor(className, width) {
    super();
    this.className = className;
    this.width = width;
  }
  eq(other) { return other.className === this.className && other.width === this.width; }
  toDOM() {
    const span = document.createElement('span');
    span.className = this.className;
    if (this.width != null) span.style.width = `${this.width}px`;
    return span;
  }
  ignoreEvent() { return false; }
}

/** 表の構造（行ごとのセルの範囲）。文書の位置で持つ */
function tableLayout(state, table) {
  const rows = rowsOf(table).map(({ node, kind }) => {
    const line = state.doc.lineAt(node.from);
    // 行の範囲は、行頭の引用記号などの後ろから行末まで
    const text = state.sliceDoc(node.from, line.to);
    const { pipes, spans } = cellSpans(text);
    return {
      kind,
      line,
      from: node.from,
      text,
      pipes: pipes.map((p) => node.from + p),
      cells: spans.map((s) => ({ from: node.from + s.from, to: node.from + s.to, text: text.slice(s.from, s.to) })),
    };
  });
  const head = rows.find((r) => r.kind === 'head');
  const delim = rows.find((r) => r.kind === 'delim');
  return {
    from: table.from,
    rows,
    columns: head ? head.cells.length : 0,
    aligns: delim ? alignmentsOf(delim.text) : [],
  };
}

function buildDecorations(view, widthsByTable) {
  const { state } = view;
  const focused = view.hasFocus;
  const activeLines = new Set();
  if (focused) {
    for (const r of state.selection.ranges) {
      const last = state.doc.lineAt(r.to).number;
      for (let n = state.doc.lineAt(r.from).number; n <= last; n++) activeLines.add(n);
    }
  }
  const decorations = [];
  const layouts = [];
  for (const table of tablesOf(state)) {
    const layout = tableLayout(state, table);
    layouts.push(layout);
    const widths = widthsByTable.get(layout.from);
    const lastBody = layout.rows.length - 1;
    layout.rows.forEach((row, index) => {
      const active = activeLines.has(row.line.number);
      const lineClasses = ['cm-md-trow', `cm-md-trow-${row.kind}`];
      if (index === lastBody) lineClasses.push('cm-md-trow-last');
      if (row.kind === 'delim' && !active) lineClasses.push('cm-md-tdelim-hidden');
      decorations.push(Decoration.line({ class: lineClasses.join(' ') }).range(row.line.from));
      for (const pipe of row.pipes) decorations.push((active ? pipeShown : pipeHidden).range(pipe, pipe + 1));
      row.cells.forEach((cell, col) => {
        const extra = col >= layout.columns;
        const classes = ['cm-md-tcell'];
        if (extra) classes.push('cm-md-tcell-extra');
        const align = layout.aligns[col];
        if (align) classes.push(`cm-md-tcell-${align}`);
        const width = !extra && widths ? widths[col] : null;
        if (cell.to > cell.from) {
          decorations.push(Decoration.mark({
            class: classes.join(' '),
            attributes: width != null ? { style: `width: ${width}px` } : undefined,
          }).range(cell.from, cell.to));
        } else {
          decorations.push(Decoration.widget({ widget: new EmptyCellWidget(classes.join(' '), width), side: 1 }).range(cell.from));
        }
      });
      // ソースで省略されたセルは、行末に空の箱を足して列をそろえる
      for (let col = row.cells.length; col < layout.columns; col++) {
        const width = widths ? widths[col] : null;
        decorations.push(Decoration.widget({
          widget: new EmptyCellWidget('cm-md-tcell cm-md-tcell-missing', width),
          side: 1 + col,
        }).range(row.line.to));
      }
    });
  }
  return { decorations: Decoration.set(decorations, true), layouts };
}

// ---------------------------------------------------------------------------
// 列の幅の計測

const measureCache = new Map();
let measureFont = '';

/**
 * セルの中身の最大の幅と最小の幅（px）を、画面の外の箱で測る。
 * 箱をまとめて入れてから読むことで、レイアウトの計算を 2 回に抑える
 * 見出しの行のセルは太字なので、別に測る
 * @param {{text: string, head: boolean}[]} cells
 * @returns {Map<string, {min: number, max: number}>} キーは measureKey
 */
const measureKey = (text, head) => (head ? 'H' : 'D') + text;
function measureCells(host, cells) {
  const font = getComputedStyle(host).font + document.body.className;
  if (font !== measureFont) {
    measureCache.clear();
    measureFont = font;
  }
  const todo = [...new Map(cells.map((c) => [measureKey(c.text, c.head), c])).entries()]
    .filter(([key]) => !measureCache.has(key));
  if (todo.length > 0) {
    const boxes = todo.map(([, { text, head }]) => {
      const box = document.createElement('span');
      box.className = `cm-md-tcell cm-md-tmeasure-cell${head ? ' cm-md-tmeasure-head' : ''}`;
      box.style.width = 'max-content';
      renderInline(text, box);
      host.appendChild(box);
      return box;
    });
    const max = boxes.map((box) => box.getBoundingClientRect().width);
    for (const box of boxes) box.style.width = 'min-content';
    const min = boxes.map((box) => box.getBoundingClientRect().width);
    for (const box of boxes) box.remove();
    todo.forEach(([key], i) => measureCache.set(key, { min: min[i], max: max[i] }));
  }
  return measureCache;
}

function measureHost(view) {
  let host = view.dom.querySelector(':scope > .cm-md-tmeasure');
  if (!host) {
    host = document.createElement('div');
    host.className = 'cm-md-tmeasure';
    host.setAttribute('aria-hidden', 'true');
    view.dom.appendChild(host);
  }
  return host;
}

/**
 * 表を置ける幅（px）。セルの中は、editor.wordWrap によらず画面の幅で折り返す
 * （折り返さない設定では本文の幅が長い行に合わせて広がるので、画面に見えている幅を使う）
 */
function availableWidth(view, layout) {
  const content = view.contentDOM;
  const style = getComputedStyle(content);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const visible = view.scrollDOM.getBoundingClientRect().right - content.getBoundingClientRect().left;
  const inner = Math.min(content.clientWidth, visible) - padding;
  // 行の左右の余白と | の隙間の分を引く
  const line = content.querySelector('.cm-line');
  const lineStyle = line ? getComputedStyle(line) : null;
  const linePad = lineStyle ? parseFloat(lineStyle.paddingLeft) + parseFloat(lineStyle.paddingRight) : 0;
  const pipe = content.querySelector('.cm-md-tpipe');
  const pipeWidth = pipe ? pipe.getBoundingClientRect().width : 0;
  const head = layout.rows.find((r) => r.kind === 'head');
  const pipes = head ? head.pipes.length : layout.columns + 1;
  return inner - linePad - pipes * pipeWidth - 1;
}

function computeWidths(view, layout) {
  const bodyRows = layout.rows.filter((row) => row.kind !== 'delim');
  const sizes = measureCells(measureHost(view),
    bodyRows.flatMap((row) => row.cells.map((cell) => ({ text: cell.text, head: row.kind === 'head' }))));
  const columns = [];
  for (let col = 0; col < layout.columns; col++) {
    let min = 0;
    let max = 0;
    let short = true;
    for (const row of bodyRows) {
      const cell = row.cells[col];
      if (!cell) continue;
      const size = sizes.get(measureKey(cell.text, row.kind === 'head'));
      min = Math.max(min, size.min);
      max = Math.max(max, size.max);
      if (displayWidth(cell.text.trim()) > NOWRAP_WIDTH) short = false;
    }
    // 短いセルしかない列は折り返さない
    columns.push({ min: short ? max : min, max });
  }
  return distributeWidths(columns, availableWidth(view, layout)).map((w) => Math.ceil(w));
}

const sameWidths = (a, b) => a && b && a.length === b.length && a.every((w, i) => w === b[i]);

// ---------------------------------------------------------------------------

const tablePlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.widths = new Map();
    const built = buildDecorations(view, this.widths);
    this.decorations = built.decorations;
    this.layouts = built.layouts;
    this.scheduleMeasure();
  }

  update(update) {
    if (update.docChanged) {
      const mapped = new Map();
      for (const [pos, widths] of this.widths) mapped.set(update.changes.mapPos(pos, 1), widths);
      this.widths = mapped;
    }
    const measured = update.transactions.some((tr) => tr.effects.some((e) => e.is(widthsMeasured)));
    if (update.docChanged || update.selectionSet || update.focusChanged || measured ||
        syntaxTree(update.state) !== syntaxTree(update.startState)) {
      const built = buildDecorations(update.view, this.widths);
      this.decorations = built.decorations;
      this.layouts = built.layouts;
    }
    if (update.docChanged || update.geometryChanged || update.focusChanged || update.selectionSet ||
        syntaxTree(update.state) !== syntaxTree(update.startState)) {
      this.scheduleMeasure();
    }
  }

  scheduleMeasure() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.measure();
    });
  }

  measure() {
    const view = this.view;
    if (!view.dom.isConnected) return;
    const { state } = view;
    const heads = view.hasFocus ? state.selection.ranges.map((r) => r.head) : [];
    let changed = false;
    const next = new Map();
    for (const layout of this.layouts) {
      const last = layout.rows[layout.rows.length - 1];
      const to = last ? last.line.to : layout.from;
      const current = this.widths.get(layout.from);
      // カーソルが表の中にある間は幅を変えない
      if (current && heads.some((h) => h >= layout.from && h <= to)) {
        next.set(layout.from, current);
        continue;
      }
      const widths = computeWidths(view, layout);
      if (!sameWidths(widths, current)) changed = true;
      next.set(layout.from, widths);
    }
    if (next.size !== this.widths.size) changed = true;
    this.widths = next;
    if (changed) view.dispatch({ effects: widthsMeasured.of(null) });
  }

  destroy() {
    const host = this.view.dom.querySelector(':scope > .cm-md-tmeasure');
    if (host) host.remove();
  }
}, {
  // セルの箱は、強調などのほかの装飾より外側に置く（内側に入ると箱が分かれ、flex の項目が増えてしまう）
  provide: (plugin) => EditorView.outerDecorations.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
});

export function tableCells() {
  return tablePlugin;
}

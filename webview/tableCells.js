// 表の表示。表のソースの 1 行を、エディタの 1 行のまま表として見せる。
//
// 行を flex にし、セル（| と | の間）を幅の決まった箱、| を 1 文字分の隙間にして、列をそろえる。
// セルの文字は通常の行の文字なので、カーソル、入力、選択、検索は本文と同じ仕組みで動く。
// 選択範囲は、本文と同じくブラウザーの選択の表示を使うので、セルが横に並んでも文字の上にだけ描かれる（editor.css）。
//
// 列の幅は tableLayout.js で決める。そのために、各セルの中身を画面の外で描き、折り返せない単位の幅を測る。
// カーソルが表の中にある間は幅を変えず、表から出たときに計算し直す（入力のたびに右の列が動かないように）。

import { EditorSelection, EditorState, Prec, StateEffect, Transaction } from '@codemirror/state';
import { BlockWrapper, Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { cellParser } from './markdownSetup.js';
import { columnsOf } from './textWidth.js';
import { layoutColumns } from './tableLayout.js';
import { t } from './strings.js';

/** 測り直した列の幅を表示に反映させる */
const widthsMeasured = StateEffect.define();

const pipeHidden = Decoration.mark({ class: 'cm-md-tpipe' });
const pipeShown = Decoration.mark({ class: 'cm-md-tpipe cm-md-tpipe-shown' });
/**
 * セルの中で 2 つ以上続く空白の、最後の 1 つを除いた部分。white-space: break-spaces にして、途中で折り返せるようにする
 * （pre-wrap のままでは、続く空白は行末にぶら下がって箱からはみ出す）。最後の 1 つは、空白 1 つと同じく行末にぶら下げる
 */
const spaceRun = Decoration.mark({ class: 'cm-md-tspaces' });
/** セルの先頭の空白 1 つ。幅はセルの箱の左の余白で取る */
const leadingBlank = Decoration.replace({});

// ---------------------------------------------------------------------------
// 表の構造

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
 * @returns {{ pipes: number[], spans: {from: number, to: number, closed: boolean}[] }}
 *   行の先頭からのオフセット。範囲は | を含まない。closed は、両側を | で区切られたセルか
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
    spans.push({ from, to, closed: i > 0 && i < bounds.length - 2 });
  }
  return { pipes, spans };
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

/** 表の構造（行ごとのセルの範囲）。位置は文書の位置 */
function tableStructure(state, table) {
  const rows = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    const kind = child.name === 'TableHeader' ? 'head' : child.name === 'TableDelimiter' ? 'delim' : child.name === 'TableRow' ? 'body' : null;
    if (!kind) continue;
    const line = state.doc.lineAt(child.from);
    // 行の範囲は、行頭の引用記号などの後ろから行末まで
    const text = state.sliceDoc(child.from, line.to);
    const { pipes, spans } = cellSpans(text);
    rows.push({
      kind,
      line,
      from: child.from,
      text,
      pipes: pipes.map((p) => child.from + p),
      cells: spans.map((s) => ({ from: child.from + s.from, to: child.from + s.to, closed: s.closed, text: text.slice(s.from, s.to) })),
    });
  }
  const head = rows.find((r) => r.kind === 'head');
  const delim = rows.find((r) => r.kind === 'delim');
  return {
    from: table.from,
    to: rows.length ? rows[rows.length - 1].line.to : table.to,
    source: state.sliceDoc(table.from, rows.length ? rows[rows.length - 1].line.to : table.to),
    rows,
    columns: head ? head.cells.length : 0,
    aligns: delim ? alignmentsOf(delim.text) : [],
  };
}

// ---------------------------------------------------------------------------
// 装飾

/**
 * セルの先頭と末尾の、箱の幅に取っておく空白の幅（桁）。それぞれ空白 1 つ分まで。
 * 先頭の空白 1 つは隠し、その幅をセルの箱の左の余白にする（すべての行の文字の先頭がそろう）。
 * それより多い空白（列をそろえるための空白など）は、セルの中身と同じく幅を取って折り返す
 */
const leadingColumns = (text, tabSize) => blankColumns(/^[ \t]?/.exec(text)[0], tabSize);
const trailingColumns = (text, tabSize) => (/^[ \t]*$/.test(text) ? 0 : blankColumns(/[ \t]?$/.exec(text)[0], tabSize));
/** 空白の幅（桁）。タブがなければ文字数（入力のたびに全セルで数えるので、文字の分割を避ける） */
const blankColumns = (blank, tabSize) => (blank.includes('\t') ? columnsOf(blank, tabSize) : blank.length);

/** 先頭の空白の幅だけ、すべての行を寄せる指定（その空白は隠す） */
const leadingStyle = (columns) => (columns > 0 ? `padding-left: ${columns}ch;` : '');

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

/** 表にマウスを載せると出るボタン（行と列の追加）。見出しの行に置き、表の右上に浮かべる */
class TableToolsWidget extends WidgetType {
  constructor(from) {
    super();
    this.from = from;
  }
  eq(other) { return other.from === this.from; }
  toDOM(view) {
    const bar = document.createElement('span');
    bar.className = 'cm-md-table-tools';
    bar.setAttribute('contenteditable', 'false');
    const button = (label, title, action) => {
      const b = bar.appendChild(document.createElement('button'));
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      // マウスでは mousedown で押す（エディタのカーソルを動かさないため）。キーボードで押されたときは click で押す
      b.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.button === 0) action(view, view.posAtDOM(bar));
      });
      b.addEventListener('click', (event) => {
        event.preventDefault();
        if (event.detail === 0) action(view, view.posAtDOM(bar));
      });
    };
    button(t('+ Row'), t('Add a row at the end'), addRow);
    button(t('+ Column'), t('Add a column at the right'), addColumn);
    return bar;
  }
  ignoreEvent() { return true; }
}

/**
 * 1 つの表の装飾。表の中身、カーソルのある行、列の幅が同じなら作り直さずに使い回す。
 * cells はセルの箱など、spaces は続く空白（強調などの装飾より内側に置く）
 * @returns {{ cells: import('@codemirror/state').RangeSet<Decoration>, spaces: import('@codemirror/state').RangeSet<Decoration> }}
 */
function tableDecorations(state, table, widths, activeLines, pads) {
  const decorations = [];
  const spaces = [];
  const last = table.rows.length - 1;
  table.rows.forEach((row, index) => {
    const active = activeLines.has(row.line.number);
    const lineClasses = ['cm-md-trow', `cm-md-trow-${row.kind}`];
    if (index === last) lineClasses.push('cm-md-trow-last');
    if (row.kind === 'delim' && !active) lineClasses.push('cm-md-tdelim-hidden');
    decorations.push(Decoration.line({ class: lineClasses.join(' ') }).range(row.line.from));
    if (row.kind === 'head') {
      decorations.push(Decoration.widget({ widget: new TableToolsWidget(table.from), side: -1 }).range(row.from));
    }
    const boxWidth = (col) => (widths && col < widths.length ? `${widths[col] + pads[col]}px` : null);
    // 先頭の | より前（行頭の空白）
    for (const pipe of row.pipes) decorations.push((active ? pipeShown : pipeHidden).range(pipe, pipe + 1));
    row.cells.forEach((cell, col) => {
      const extra = col >= table.columns;
      const classes = ['cm-md-tcell'];
      if (extra) classes.push('cm-md-tcell-extra');
      const align = table.aligns[col];
      if (align) classes.push(`cm-md-tcell-${align}`);
      const width = extra ? null : boxWidth(col);
      if (cell.to > cell.from) {
        const style = (width ? `width: ${width};` : '') + leadingStyle(leadingColumns(cell.text, state.tabSize));
        decorations.push(Decoration.mark({ class: classes.join(' '), attributes: style ? { style } : undefined }).range(cell.from, cell.to));
        // 先頭の空白 1 つは、幅を箱の余白にして隠す。文字として残すと、その後ろが折り返す位置になり、
        // 列より長い語で始まるセルの 1 行目が空になるため
        const lead = /^[ \t]/.test(cell.text) ? 1 : 0;
        if (lead) spaces.push(leadingBlank.range(cell.from, cell.from + 1));
        for (const m of cell.text.matchAll(/[ \t]{2,}/g)) {
          const from = Math.max(cell.from + m.index, cell.from + lead);
          const to = cell.from + m.index + m[0].length - 1;
          if (to > from) spaces.push(spaceRun.range(from, to));
        }
      } else {
        decorations.push(Decoration.widget({ widget: new EmptyCellWidget(classes.join(' '), widths ? widths[col] + pads[col] : null), side: 1 }).range(cell.from));
      }
    });
    // ソースで省略されたセルは、行末に空の箱を足して列をそろえる。箱の前には、| の分の隙間を空ける
    // （行末に | があれば、最初の箱の前の隙間はその | が埋める）
    const pipeAtEnd = row.pipes.length > 0 && row.text.slice(row.pipes[row.pipes.length - 1] - row.from + 1).trim() === '';
    for (let col = row.cells.length; col < table.columns; col++) {
      const gap = col > row.cells.length || !pipeAtEnd ? ' cm-md-tcell-gap' : '';
      decorations.push(Decoration.widget({
        widget: new EmptyCellWidget(`cm-md-tcell cm-md-tcell-missing${gap}`, widths ? widths[col] + pads[col] : null),
        side: 1 + col,
      }).range(row.line.to));
    }
  });
  return { cells: Decoration.set(decorations, true), spaces: Decoration.set(spaces) };
}

/** 列ごとの、箱の幅に取っておくセルの前後の空白の幅（px）。列の中で最も広いもの */
function columnPads(table, tabSize) {
  const pads = new Array(table.columns).fill(0);
  for (const row of table.rows) {
    if (row.kind === 'delim') continue;
    row.cells.forEach((cell, col) => {
      if (col < table.columns) pads[col] = Math.max(pads[col], leadingColumns(cell.text, tabSize) + trailingColumns(cell.text, tabSize));
    });
  }
  return pads.map((columns) => columns * metrics.space);
}

// ---------------------------------------------------------------------------
// 列の幅の計測

/** 計測に使う文字の幅（px）。フォントが変わったら測り直す */
const metrics = { font: '', space: 8, segments: new Map() };

/** セルの表示される文字列。強調・リンク・エスケープの記号は幅ごと隠すので除き、インラインコードの ` は幅を残すので残す */
export function visibleText(text) {
  const tree = cellParser.parse(text);
  const hidden = [];
  tree.iterate({
    enter(ref) {
      const { name, from, to } = ref;
      if (name === 'EmphasisMark' || name === 'StrikethroughMark') hidden.push([from, to]);
      else if (name === 'Escape') hidden.push([from, from + 1]);
      else if (name === 'Link') {
        const marks = ref.node.getChildren('LinkMark');
        if (marks.length >= 2) hidden.push([from, marks[0].to], [marks[1].from, to]);
        return undefined;
      } else if (name === 'Autolink') {
        for (const m of ref.node.getChildren('LinkMark')) hidden.push([m.from, m.to]);
      } else if (name === 'Image') {
        return false;
      }
      return undefined;
    },
  });
  hidden.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [from, to] of hidden) {
    if (from < pos) continue;
    out += text.slice(pos, from);
    pos = to;
  }
  return out + text.slice(pos);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * セルの中身を、折り返せない単位に分けて幅を測る。幅 0 の箱で描くと、ブラウザーは折り返せる位置ですべて折り返すので、
 * 見た目の 1 行が 1 つの単位になる。箱をまとめて入れてから読み、レイアウトの計算を 1 回に抑える
 * @param {{ text: string, head: boolean }[]} cells
 */
function measureSegments(host, cells) {
  const todo = [...new Map(cells.map((c) => [segmentKey(c), c])).entries()].filter(([key]) => !metrics.segments.has(key));
  if (todo.length === 0) return;
  const boxes = todo.map(([, { text, head }]) => {
    const box = document.createElement('div');
    box.className = `cm-md-tmeasure-cell${head ? ' cm-md-tmeasure-head' : ''}`;
    box.textContent = text;
    host.appendChild(box);
    return box;
  });
  const range = document.createRange();
  boxes.forEach((box, i) => {
    const node = box.firstChild;
    const segments = [];
    if (node) {
      let current = null;
      let lastTop = -Infinity;
      for (const { segment, index } of graphemeSegmenter.segment(node.data)) {
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        if (/^[ \t]+$/.test(segment)) {
          if (current) {
            current.space += metrics.space * segment.length;
            current.spaces += segment.length;
          }
          continue;
        }
        if (!current || rect.top > lastTop + rect.height / 2) {
          current = { left: rect.left, right: rect.right, space: 0, spaces: 0, graphemes: [] };
          segments.push(current);
          lastTop = rect.top;
        }
        current.right = Math.max(current.right, rect.right);
        current.graphemes.push(rect.width);
      }
    }
    metrics.segments.set(todo[i][0], segments.map((s) => ({ w: s.right - s.left, space: s.space, spaces: s.spaces, graphemes: s.graphemes })));
  });
  for (const box of boxes) box.remove();
}

const segmentKey = ({ text, head }) => (head ? 'H' : 'D') + text;

function measureHost(view) {
  let host = view.dom.querySelector(':scope > .cm-md-tmeasure');
  if (!host) {
    host = document.createElement('div');
    host.className = 'cm-md-tmeasure';
    host.setAttribute('aria-hidden', 'true');
    view.dom.appendChild(host);
  }
  // フォントや文字の大きさが変わったら、測った幅を捨てる
  const probe = host.appendChild(document.createElement('span'));
  probe.className = 'cm-md-tmeasure-space';
  probe.textContent = ' '.repeat(10);
  const probeStyle = getComputedStyle(probe);
  const font = `${probeStyle.font} ${probeStyle.letterSpacing} ${probeStyle.fontFeatureSettings} ${probeStyle.wordBreak} ${document.body.className}`;
  if (font !== metrics.font) {
    metrics.font = font;
    metrics.segments.clear();
    metrics.space = probe.getBoundingClientRect().width / 10;
  }
  probe.remove();
  return host;
}

/**
 * 表を置ける幅（px）。セルの中は、editor.wordWrap によらず画面の幅で折り返す
 * （折り返さない設定では本文の幅が長い行に合わせて広がるので、画面に見えている幅を使う）
 */
function availableWidth(view, table) {
  const content = view.contentDOM;
  const style = getComputedStyle(content);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const visible = view.scrollDOM.getBoundingClientRect().right - content.getBoundingClientRect().left;
  const inner = Math.min(content.clientWidth, visible) - padding;
  // 表の行の左の余白は ::before の幅（editor.css）。右の余白は取らず、表が広いときは行の右端まで使う
  const line = content.querySelector('.cm-md-trow');
  const linePad = line ? parseFloat(getComputedStyle(line, '::before').width) || 0 : 0;
  const head = table.rows.find((r) => r.kind === 'head');
  const pipes = head ? head.pipes.length : table.columns + 1;
  // 行頭の引用記号などの幅
  const prefix = head ? columnsOf(view.state.sliceDoc(head.line.from, head.from), view.state.tabSize) * metrics.space : 0;
  return inner - linePad - prefix - pipes * metrics.space;
}

/**
 * セルの中身の単位に、前後の空白のうち隠す先頭の 1 つを除いた空白を足す。
 * 先頭の空白は幅 0 の単位の後ろの空白、末尾の空白は最後の単位の後ろの空白にする。
 * セルが空白で終わるときは、最後に幅 0 の単位を置き、最後の空白も幅に数える。最後の空白が箱からはみ出すと、
 * その前後の位置のカーソルが同じ場所（箱の右端）に描かれるため
 */
function withBlanks(segments, raw) {
  const lead = /^[ \t]*/.exec(raw)[0].length;
  const trail = lead === raw.length ? 0 : /[ \t]*$/.exec(raw)[0].length;
  const out = segments.map((seg) => ({ ...seg }));
  if (lead > 1) out.unshift({ w: 0, space: (lead - 1) * metrics.space, spaces: lead - 1, graphemes: [] });
  if (trail > 0 && out.length) {
    const last = out[out.length - 1];
    last.space += trail * metrics.space;
    last.spaces += trail;
  }
  if ((trail > 0 || lead > 1) && out.length) out.push({ w: 0, space: 0, spaces: 0, graphemes: [] });
  return out;
}

function computeWidths(view, table) {
  const host = measureHost(view);
  // 区切りの行（|---|）も、- が列より長ければ折り返すので、行の数を数えるのに含める
  const rows = table.rows;
  const cells = rows.map((row) => row.cells.slice(0, table.columns).map((cell) => ({ text: visibleText(cell.text.trim()), head: row.kind === 'head', raw: cell.text })));
  measureSegments(host, cells.flat());
  const pads = columnPads(table, view.state.tabSize);
  // 箱の中で文字に使える幅は、列の幅と、前後の余白のうちセルの左の余白（隠した先頭の空白）を除いた分
  const layoutRows = cells.map((row) => {
    const out = row.map((cell, col) => ({
      segments: withBlanks(metrics.segments.get(segmentKey(cell)), cell.raw),
      extra: pads[col] - leadingColumns(cell.raw, view.state.tabSize) * metrics.space,
    }));
    while (out.length < table.columns) out.push({ segments: [] });
    return out;
  });
  const available = availableWidth(view, table) - pads.reduce((s, p) => s + p, 0);
  return layoutColumns(layoutRows, available, metrics.space);
}

const sameWidths = (a, b) => a && b && a.length === b.length && a.every((w, i) => w === b[i]);

// ---------------------------------------------------------------------------

const tablePlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    /** 表の先頭の位置から、列の幅（中身の幅、px） */
    this.widths = new Map();
    /** 表ごとの装飾。キーは表の位置、中身、カーソルのある行、列の幅 */
    this.cache = new Map();
    this.build();
    this.scheduleMeasure();
  }

  update(update) {
    if (update.docChanged) {
      const mapped = new Map();
      for (const [pos, widths] of this.widths) mapped.set(update.changes.mapPos(pos, 1), widths);
      this.widths = mapped;
    }
    const measured = update.transactions.some((tr) => tr.effects.some((e) => e.is(widthsMeasured)));
    const treeChanged = syntaxTree(update.state) !== syntaxTree(update.startState);
    if (update.docChanged || update.selectionSet || update.focusChanged || measured || treeChanged) this.build();
    if (update.docChanged || update.geometryChanged || update.focusChanged || update.selectionSet || treeChanged) this.scheduleMeasure();
  }

  build() {
    const { view } = this;
    const { state } = view;
    const activeLines = new Set();
    if (view.hasFocus) {
      for (const r of state.selection.ranges) {
        const last = state.doc.lineAt(r.to).number;
        for (let n = state.doc.lineAt(r.from).number; n <= last; n++) activeLines.add(n);
      }
    }
    const sets = [];
    const spaceSets = [];
    const wrappers = [];
    const cache = new Map();
    const structures = new Map();
    this.tables = tablesOf(state).map((node) => {
      // 中身の変わらない表は、前に分けた構造と空白の幅を使う
      const skey = `${node.from}\u0000${state.sliceDoc(node.from, state.doc.lineAt(node.to).to)}\u0000${state.tabSize}\u0000${metrics.space}`;
      let entry = this.structures?.get(skey);
      if (!entry) {
        const structure = tableStructure(state, node);
        entry = { table: structure, pads: columnPads(structure, state.tabSize) };
      }
      structures.set(skey, entry);
      const { table, pads } = entry;
      const widths = this.widths.get(table.from);
      const firstLine = table.rows.length ? table.rows[0].line.number : 0;
      const active = table.rows.filter((row) => activeLines.has(row.line.number)).map((row) => row.line.number - firstLine);
      const key = `${table.from}\u0000${table.source}\u0000${active.join(',')}\u0000${widths ? widths.join(',') : ''}\u0000${metrics.space}`;
      let set = this.cache.get(key);
      if (!set) set = tableDecorations(state, table, widths, activeLines, pads);
      cache.set(key, set);
      sets.push(set.cells);
      spaceSets.push(set.spaces);
      if (table.rows.length) {
        const width = widths ? widths.reduce((s, w, i) => s + w + pads[i], 0) + (table.columns + 1) * metrics.space : null;
        wrappers.push(BlockWrapper.create({
          tagName: 'div',
          attributes: { class: 'cm-md-table-block', style: width ? `--md-table-width: ${width}px` : '' },
        }).range(table.rows[0].line.from, table.to));
      }
      return table;
    });
    this.cache = cache;
    this.structures = structures;
    // 表ごとの装飾は位置の順に並んでいるので、まとめて 1 つの集合にする
    const flatten = (list) => {
      const all = [];
      for (const set of list) for (const cursor = set.iter(); cursor.value; cursor.next()) all.push(cursor.value.range(cursor.from, cursor.to));
      return Decoration.set(all);
    };
    this.decorations = flatten(sets);
    this.spaces = flatten(spaceSets);
    this.wrappers = BlockWrapper.set(wrappers);
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
    const { view } = this;
    if (!view.dom.isConnected) return;
    const { state } = view;
    const heads = view.hasFocus ? state.selection.ranges.map((r) => r.head) : [];
    const before = metrics.space;
    let changed = false;
    const next = new Map();
    for (const table of this.tables) {
      const current = this.widths.get(table.from);
      // カーソルが表の中にある間は幅を変えない
      if (current && heads.some((h) => h >= table.from && h <= table.to)) {
        next.set(table.from, current);
        continue;
      }
      const widths = this.computeCached(table);
      if (!sameWidths(widths, current)) changed = true;
      next.set(table.from, widths);
    }
    if (next.size !== this.widths.size || metrics.space !== before) changed = true;
    this.widths = next;
    if (changed) view.dispatch({ effects: widthsMeasured.of(null) });
  }

  /** 列の幅。表の中身と表を置ける幅が同じなら、前に計算したものを使う */
  computeCached(table) {
    const available = Math.round(availableWidth(this.view, table));
    const key = `${table.source}\u0000${available}\u0000${metrics.font}`;
    this.widthCache ??= new Map();
    let widths = this.widthCache.get(key);
    if (!widths) {
      widths = computeWidths(this.view, table);
      this.widthCache.set(key, widths);
      if (this.widthCache.size > 200) this.widthCache.delete(this.widthCache.keys().next().value);
    }
    return widths;
  }

  destroy() {
    const host = this.view.dom.querySelector(':scope > .cm-md-tmeasure');
    if (host) host.remove();
  }
}, {
  provide: (plugin) => [
    // セルの箱は、強調などのほかの装飾より外側に置く（内側に入ると箱が分かれ、flex の項目が増えてしまう）
    EditorView.outerDecorations.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
    // 続く空白の要素は、強調やインラインコードの要素を分けないよう、最も内側に置く
    Prec.highest(EditorView.decorations.of((view) => view.plugin(plugin)?.spaces ?? Decoration.none)),
    // 表の行をまとめる要素。マウスを載せるとボタンを出すのに使う
    EditorView.blockWrappers.of((view) => view.plugin(plugin)?.wrappers ?? BlockWrapper.set([])),
  ],
});

// ---------------------------------------------------------------------------
// 行と列の追加

/** 表の行の構文木のノード（見出し、区切り、本体の順） */
function tableRowsAt(state, pos) {
  const table = tableAt(state, pos);
  if (!table) return null;
  const rows = [];
  for (let child = table.node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader' || child.name === 'TableRow' || child.name === 'TableDelimiter') {
      rows.push({ from: child.from, to: state.doc.lineAt(child.from).to, delimiter: child.name === 'TableDelimiter' });
    }
  }
  return { table, rows };
}

/** 最後に空の行を足し、その先頭のセルにカーソルを置く。引用やリストの中の表は、行頭の記号を写して足す */
function addRow(view, pos) {
  const found = tableRowsAt(view.state, pos);
  if (!found) return false;
  const { rows } = found;
  const last = rows[rows.length - 1];
  const lastLine = view.state.doc.lineAt(last.from);
  const prefix = view.state.sliceDoc(lastLine.from, last.from);
  const columns = cellSpans(view.state.sliceDoc(rows[0].from, rows[0].to)).spans.length;
  const insert = `\n${prefix}|${'  |'.repeat(columns)}`;
  view.dispatch({
    changes: { from: last.to, insert },
    selection: EditorSelection.cursor(last.to + 1 + prefix.length + 2),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** 右端に列を足し、見出しの新しいセルにカーソルを置く */
function addColumn(view, pos) {
  const found = tableRowsAt(view.state, pos);
  if (!found) return;
  const changes = found.rows.map((row) => {
    const text = view.state.sliceDoc(row.from, row.to).trimEnd();
    const pipeAtEnd = /(^|[^\\])\|$/.test(text);
    return { from: row.from + text.length, insert: (pipeAtEnd ? '' : ' |') + (row.delimiter ? '---|' : '  |') };
  });
  const head = changes[0];
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(head.from + head.insert.length - 2),
    scrollIntoView: true,
  });
  view.focus();
}

// ---------------------------------------------------------------------------
// 表の中のキー操作

/** pos がある表の行とセル */
function cellAt(state, pos) {
  const table = tableAt(state, pos);
  if (!table) return null;
  const structure = tableStructure(state, table.node);
  const rowIndex = structure.rows.findIndex((r) => pos >= r.line.from && pos <= r.line.to);
  if (rowIndex < 0) return null;
  const row = structure.rows[rowIndex];
  const col = row.cells.findIndex((c) => pos >= c.from && pos <= c.to);
  return { structure, rowIndex, row, col };
}

/** 中身の範囲（前後の空白を除く）。空のセルでは、| の後ろの空白 1 つ分だけ進めた位置 */
function contentRange(cell) {
  const lead = cell.text.length - cell.text.trimStart().length;
  const trail = cell.text.length - cell.text.trimEnd().length;
  if (lead === cell.text.length) {
    const pos = Math.min(cell.from + 1, cell.to);
    return { from: pos, to: pos };
  }
  return { from: cell.from + lead, to: cell.to - trail };
}

/**
 * Enter / Shift+Enter で、下 / 上の行の同じ列のセルの中身の末尾に移る。表の端では表から出る
 * （表の行で改行すると表が壊れるため、セルの移動にする）
 */
function moveRow(direction) {
  return (view) => {
    const { state } = view;
    const sel = state.selection.main;
    if (state.selection.ranges.length > 1) return false;
    // セルの中身を選んでいるとき（Tab で移った後など）も、選んだ文字列を消さずにセルを移る
    const here = cellAt(state, sel.head);
    if (here && !sel.empty && state.doc.lineAt(sel.anchor).number !== here.row.line.number) return false;
    if (!here) return false;
    const { structure } = here;
    // 区切りの行やデータの行の最後の | の後ろ（行を打ち終えたところ）では、テキストエディタと同じく改行し、
    // 次の行を打てるようにする。見出しの行では改行すると表が壊れるので、いちばん近いセルの列として動く
    const afterRow = here.col < 0 && sel.head > here.row.from;
    const lastRow = here.rowIndex === structure.rows.length - 1;
    if (direction > 0 && here.row.kind !== 'head' && (afterRow || (here.row.kind === 'delim' && lastRow))) return false;
    const col = here.col >= 0 ? here.col : (sel.head <= here.row.from ? 0 : Math.max(here.row.cells.length - 1, 0));
    let index = here.rowIndex + direction;
    if (structure.rows[index] && structure.rows[index].kind === 'delim') index += direction;
    const target = structure.rows[index];
    if (target) {
      const cell = target.cells[Math.min(col, target.cells.length - 1)];
      const pos = cell ? contentRange(cell).to : target.line.to;
      view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: 'select' });
      return true;
    }
    // 表の端：下なら表の次の行へ（文書の末尾なら行を足す）、上なら表の前の行へ
    const first = structure.rows[0].line;
    const last = structure.rows[structure.rows.length - 1].line;
    if (direction > 0) {
      // 表の直後の行に書いた文字は表の行になるので、空行を挟んだ行に出る（なければ作る）
      const next = last.number < state.doc.lines ? state.doc.line(last.number + 1) : null;
      const after = last.number + 1 < state.doc.lines ? state.doc.line(last.number + 2) : null;
      if (next && !next.text.trim() && after && !after.text.trim()) {
        view.dispatch({ selection: EditorSelection.cursor(after.from), scrollIntoView: true, userEvent: 'select' });
      } else if (next && !next.text.trim()) {
        view.dispatch({ changes: { from: next.to, insert: '\n' }, selection: EditorSelection.cursor(next.to + 1), scrollIntoView: true, userEvent: 'input' });
      } else {
        view.dispatch({ changes: { from: last.to, insert: '\n\n' }, selection: EditorSelection.cursor(last.to + 2), scrollIntoView: true, userEvent: 'input' });
      }
    } else if (first.number > 1) {
      view.dispatch({ selection: EditorSelection.cursor(state.doc.line(first.number - 1).to), scrollIntoView: true, userEvent: 'select' });
    } else {
      view.dispatch({ changes: { from: 0, insert: '\n' }, selection: EditorSelection.cursor(0), scrollIntoView: true });
    }
    return true;
  };
}

/**
 * Tab / Shift+Tab で次 / 前のセルの中身を選ぶ。最後のセルで Tab を押すと行を足す
 */
function moveCell(direction) {
  return (view) => {
    const { state } = view;
    if (state.selection.ranges.length > 1) return false;
    const pos = state.selection.main.head;
    const here = cellAt(state, pos);
    if (!here) return false;
    const cells = here.structure.rows.filter((r) => r.kind !== 'delim').flatMap((r) => r.cells);
    let current = -1;
    cells.forEach((cell, i) => { if (cell.from <= pos) current = i; });
    // 見出しより列の少ない行（打っている途中の行）の最後のセルでは、同じ行に次のセルを作る
    const { row } = here;
    if (direction > 0 && row.kind !== 'delim' && row.cells.length < here.structure.columns &&
        row.cells.length > 0 && pos >= row.cells[row.cells.length - 1].from) {
      const text = row.text.replace(/[ \t]+$/, '');
      const end = row.from + text.length;
      const insert = /(^|[^\\])\|$/.test(text) ? ' ' : ' | ';
      view.dispatch({ changes: { from: end, to: row.line.to, insert }, selection: EditorSelection.cursor(end + insert.length), scrollIntoView: true, userEvent: 'input' });
      return true;
    }
    const next = current + direction;
    if (next < 0) return true;
    if (next >= cells.length) return addRow(view, pos);
    const range = contentRange(cells[next]);
    view.dispatch({ selection: EditorSelection.range(range.from, range.to), scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

/**
 * セルの中で | を打つと \| にする。セルが分かれないように。
 * 列がそろっている行の、両側を | で区切られたセルの中だけで行う（新しい行を打っている途中の | はそのまま）
 */
const escapePipe = EditorView.inputHandler.of((view, from, to, text) => {
  if (!text.includes('|') || view.state.selection.ranges.length > 1) return false;
  const here = cellAt(view.state, from);
  if (!here || here.row.kind === 'delim' || here.col < 0) return false;
  const cell = here.row.cells[here.col];
  if (!cell.closed || here.row.cells.length < here.structure.columns || to > cell.to) return false;
  // エスケープしていない | だけを \| にする（直前が \ のものは、すでにエスケープしている）
  const before = view.state.sliceDoc(from - 1, from);
  const insert = (before + text).replace(/(^|[^\\])\|/g, '$1\\|').slice(before.length);
  if (insert === text) return false;
  view.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length), userEvent: 'input.type' });
  return true;
});

/**
 * セルの末尾（次の | の直前）のカーソルは、前の文字の側に描く（assoc: -1）。後ろの側に描くと、行の上端にある | の
 * 前に描かれ、折り返して 2 行以上になったセルでは、最後の行の末尾ではなくセルの右上に出るため
 */
const cellEndCursor = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr;
  const sel = tr.selection;
  const doc = tr.newDoc;
  // | の直前にあるカーソルだけ、表のセルの末尾かを調べる（そのときだけ新しい状態を作る）
  const candidate = (r) => r.empty && r.assoc !== -1 && r.head < doc.length && doc.sliceString(r.head, r.head + 1) === '|';
  if (!sel.ranges.some(candidate)) return tr;
  const { state } = tr;
  let changed = false;
  const ranges = sel.ranges.map((r) => {
    if (!candidate(r)) return r;
    const here = cellAt(state, r.head);
    if (!here || here.col < 0) return r;
    const cell = here.row.cells[here.col];
    if (cell.to !== r.head || cell.to === cell.from) return r;
    changed = true;
    return EditorSelection.cursor(r.head, -1, r.bidiLevel ?? undefined, r.goalColumn);
  });
  if (!changed) return tr;
  return [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }];
});

/** Home / End（Shift で選択）：セルの中身の先頭 / 末尾へ。行の端の | の外に出て、そこで打った文字が新しい列にならないように */
function cellBoundary(forward, extend) {
  return (view) => {
    const { state } = view;
    if (state.selection.ranges.length > 1) return false;
    const sel = state.selection.main;
    const here = cellAt(state, sel.head);
    if (!here || here.row.kind === 'delim' || !here.row.cells.length) return false;
    const cell = here.row.cells[here.col >= 0 ? here.col : (sel.head <= here.row.from ? 0 : here.row.cells.length - 1)];
    const range = contentRange(cell);
    const target = forward ? range.to : range.from;
    view.dispatch({
      selection: extend ? EditorSelection.range(sel.anchor, target) : EditorSelection.cursor(target, forward ? -1 : 1),
      scrollIntoView: true,
      userEvent: 'select',
    });
    return true;
  };
}

/**
 * キーやクリックで動いたカーソルを、表のセルの中に置く。
 * - 行頭の | の前と最後の | の後ろは、いちばん近いセルの中身の端へ（そこで打つと新しい列になるため）。
 *   ← → で行の端を越えたときは、隣の行へ
 * - キーで区切りの行（|---|）に入ったときは、動いてきた向きの次の行へ（そこで打つと表全体が崩れるため）。
 *   揃え位置を変えられるよう、クリックでは入れる
 * - | の直後（隠した空白の前）は、その空白の後ろへ（同じ場所に描かれ、→ を押しても動かないように見えるため）。
 *   ← で来たときは前のセルの末尾へ
 */
const keepInCells = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection || !tr.isUserEvent('select')) return tr;
  const { ranges } = tr.selection;
  if (ranges.length !== 1 || !ranges[0].empty) return tr;
  const pos = ranges[0].head;
  const { state } = tr;
  // 表の行は | を含む。含まない行では表を探さない
  if (!state.doc.lineAt(pos).text.includes('|')) return tr;
  const here = cellAt(state, pos);
  if (!here) return tr;
  const from = tr.startState.selection.main.head;
  const backward = pos < from;
  const pointer = tr.isUserEvent('select.pointer');
  const sameLine = state.doc.lineAt(from).number === here.row.line.number;
  const { structure, row } = here;
  const rows = structure.rows;
  /** index の行（区切りの行なら direction の向きにもう 1 行）の、列 col のセルの位置。表の外なら null */
  const cellIn = (index, direction, col, end) => {
    if (rows[index] && rows[index].kind === 'delim') index += direction;
    const cells = rows[index] ? rows[index].cells : null;
    if (!cells || !cells.length) return null;
    const range = contentRange(cells[col === Infinity ? cells.length - 1 : Math.min(col, cells.length - 1)]);
    return end ? range.to : range.from;
  };
  // 行の先頭で ← ：前の行の最後のセルへ（表の外なら、前の行の末尾へ）
  const previousRow = () => cellIn(here.rowIndex - 1, -1, Infinity, true) ??
    (row.line.number > 1 ? row.line.from - 1 : contentRange(row.cells[0]).from);
  let target = pos;
  if (row.kind === 'delim') {
    // クリックでは、区切りの行のセルの中なら入れる（揃え位置を変えるため）。行の左右の余白なら、近い行のセルへ
    if (pointer && here.col >= 0) return tr;
    if (pointer) {
      const after = !row.cells.length || pos >= row.cells[0].from;
      return [tr, { selection: EditorSelection.cursor(cellIn(here.rowIndex + 1, 1, after ? Infinity : 0, after) ?? cellIn(here.rowIndex - 1, -1, after ? Infinity : 0, after) ?? pos), sequential: true }];
    }
    const direction = backward ? -1 : 1;
    target = cellIn(here.rowIndex + direction, direction, Math.max(here.col, 0), true) ??
      (backward ? (row.line.number > 1 ? state.doc.line(row.line.number - 1).to : pos) : cellIn(here.rowIndex - 1, -1, 0, true) ?? pos);
  } else if (here.col < 0) {
    if (!row.cells.length) return tr;
    const after = pos >= row.cells[0].from;
    if (!pointer && sameLine && after && !backward) {
      // 行の最後で → ：次の行へ
      target = cellIn(here.rowIndex + 1, 1, 0, false) ?? (row.line.number < state.doc.lines ? row.line.to + 1 : contentRange(row.cells[row.cells.length - 1]).to);
    } else if (!pointer && sameLine && !after && backward) {
      target = previousRow();
    } else {
      target = after ? contentRange(row.cells[row.cells.length - 1]).to : contentRange(row.cells[0]).from;
    }
  } else {
    const cell = row.cells[here.col];
    if (pos === cell.from && /^[ \t]/.test(cell.text)) {
      const prev = row.cells[here.col - 1];
      if (!backward || pointer) target = cell.from + 1;
      else target = prev ? prev.to : previousRow();
    }
  }
  if (target === pos) return tr;
  return [tr, { selection: EditorSelection.cursor(target, backward ? -1 : 1), sequential: true }];
});

/** セルの中で、削除や置き換えで消してよい範囲。先頭の空白 1 つ（隠している）と、中身の後ろの空白 1 つはセルの形として残す */
function editableRange(cell) {
  return {
    from: cell.from + (/^[ \t]/.test(cell.text) ? 1 : 0),
    to: cell.to - (cell.text.length >= 2 && /[ \t]$/.test(cell.text) ? 1 : 0),
  };
}

/**
 * 1 つのカーソル（選択範囲）による変更を、表のセルの中にとどめる。直さなくてよければ null
 * - セルの中のカーソルからの削除は、そのセルの中だけ（セルの先頭の Backspace や末尾の Delete で | や改行を消さない）
 * - 表の 1 行の中でセルをまたぐ選択範囲の削除や打ち換えは、各セルの中身だけを消し、| は残す
 */
function confineToCells(state, range, change, isDelete) {
  const here = cellAt(state, range.from);
  if (!here || here.row.kind === 'delim') return null;
  if (range.empty) {
    // カーソルでの入力は直さない（行を打っている途中の、閉じていないセルにも打てるように）
    if (here.col < 0 || !isDelete) return null;
    const { from, to } = editableRange(here.row.cells[here.col]);
    if (change.from >= from && change.to <= to) return null;
    const clamped = { from: Math.max(change.from, from), to: Math.min(change.to, to), insert: change.insert };
    return clamped.to > clamped.from || clamped.insert ? [clamped] : [];
  }
  if (range.to > here.row.line.to) return null;
  const cells = here.row.cells.filter((c) => c.to >= range.from && c.from <= range.to);
  const pipes = here.row.pipes.filter((p) => p >= range.from && p < range.to);
  if (!pipes.length || !cells.length) return null;
  const parts = cells.map((c) => {
    const { from, to } = editableRange(c);
    return { from: Math.max(range.from, from), to: Math.min(range.to, to), insert: '' };
  }).filter((p) => p.to >= p.from);
  if (!parts.length) return null;
  parts[0].insert = change.insert;
  return parts.filter((p) => p.to > p.from || p.insert);
}

/**
 * 表のセルの中から始めた削除や、セルをまたぐ選択範囲の打ち換えを、セルの中にとどめる（confineToCells）。
 * 複数のカーソルでも、カーソルごとに直す。選択範囲を消すときは、| を残して各セルの中身を消す。
 * 行をつなげる Backspace の後で、カーソルが表の行の最後の | の後ろに来たときは、最後のセルの中身の末尾に移す
 * （そこで打った文字が新しい列になるため）
 */
const editInCells = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('delete') || tr.isUserEvent('input.type'))) return tr;
  const start = tr.startState;
  const { ranges } = start.selection;
  const nearTable = ranges.some((r) => start.doc.lineAt(r.from).text.includes('|') || start.doc.lineAt(r.to).text.includes('|'));
  if (!nearTable) return afterJoin(tr);
  const original = [];
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => original.push({ from, to, insert: inserted.toString() }));
  let fixed = false;
  const result = [];
  /** 選択範囲ごとの、打ち換えた後のカーソルの位置（元の文書の位置。打った文字の後ろ） */
  const ends = new Map();
  for (const change of original) {
    const range = ranges.find((r) => r.from <= change.to && r.to >= change.from);
    const confined = range && confineToCells(start, range, change, tr.isUserEvent('delete'));
    if (confined) {
      fixed = true;
      result.push(...confined);
      if (!range.empty && confined.length) ends.set(range, confined[0].to);
    } else {
      result.push(change);
      if (range && !range.empty) ends.set(range, change.to);
    }
  }
  if (fixed) {
    const changes = start.changes(result.sort((a, b) => a.from - b.from));
    const selection = EditorSelection.create(
      ranges.map((r) => EditorSelection.cursor(r.empty ? changes.mapPos(r.head, -1) : changes.mapPos(ends.get(r) ?? r.from, 1))),
      start.selection.mainIndex,
    );
    return { changes, selection, userEvent: tr.annotation(Transaction.userEvent), scrollIntoView: true };
  }
  return afterJoin(tr);
});

/** 行をつなげた Backspace の後で、カーソルが表の行の最後の | の後ろに来たら、最後のセルの中身の末尾に移す */
function afterJoin(tr) {
  if (!tr.isUserEvent('delete.backward') || tr.state.selection.ranges.length > 1) return tr;
  const head = tr.state.selection.main.head;
  const line = tr.state.doc.lineAt(head);
  if (head !== line.to || line.number === tr.startState.doc.lineAt(tr.startState.selection.main.head).number || !line.text.includes('|')) return tr;
  const here = cellAt(tr.state, head);
  if (!here || here.col >= 0 || here.row.kind === 'delim' || !here.row.cells.length) return tr;
  return [tr, { selection: EditorSelection.cursor(contentRange(here.row.cells[here.row.cells.length - 1]).to, -1), sequential: true }];
}

/**
 * セルの中への貼り付けでは、改行を空白に、| を \| にする。そのままでは行が分かれたり列が増えたりするため
 */
const pasteInCell = EditorState.transactionFilter.of((tr) => {
  if (!tr.isUserEvent('input.paste') || !tr.docChanged || tr.startState.selection.ranges.length > 1) return tr;
  const state = tr.startState;
  const range = state.selection.main;
  if (!state.doc.lineAt(range.from).text.includes('|')) return tr;
  const here = cellAt(state, range.from);
  if (!here || here.row.kind === 'delim' || here.col < 0 || range.to > here.row.cells[here.col].to) return tr;
  let text = '';
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => { text += inserted.toString(); });
  // 続く「||」は 1 回目の置き換えで 2 つ目が残るので、2 回置き換える
  const escape = (t) => t.replace(/(^|[^\\])\|/g, '$1\\|');
  const fixed = escape(escape(text.replace(/\r?\n/g, ' ')));
  if (fixed === text) return tr;
  return { changes: { from: range.from, to: range.to, insert: fixed }, selection: EditorSelection.cursor(range.from + fixed.length), userEvent: 'input.paste', scrollIntoView: true };
});

/** 文書の先頭にある表の見出しの行で ↑：表の前に空の行を作ってそこに移る（キーでは表の前に出られないため） */
function lineAboveTopTable(view) {
  const { state } = view;
  if (state.selection.ranges.length > 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (line.number !== 1 || !line.text.includes('|')) return false;
  const here = cellAt(state, pos);
  if (!here || here.rowIndex !== 0) return false;
  // 折り返したセルの 2 つ目以降の見た目の行では、セルの中を上に動く
  const c = view.coordsAtPos(pos, -1);
  const block = view.lineBlockAt(pos);
  if (c && c.top - view.documentTop - block.top > view.defaultLineHeight) return false;
  view.dispatch({ changes: { from: 0, insert: state.lineBreak }, selection: EditorSelection.cursor(0), scrollIntoView: true, userEvent: 'input' });
  return true;
}

/** 複数のカーソルのどれかが表の行にあるときの Enter は、何もしない（改行すると表の行が分かれるため） */
function multiCursorEnter(view) {
  const { ranges } = view.state.selection;
  return ranges.length > 1 && ranges.some((r) => view.state.doc.lineAt(r.head).text.includes('|') && cellAt(view.state, r.head));
}

/**
 * 表と後ろの段落の間の空行を Backspace で消さない（空行の先頭でも、段落の先頭でも）。消すと、段落が表の行になるため。
 * 代わりに、表の最後のセルの末尾に移る
 */
function keepBlankAfterTable(view) {
  const { state } = view;
  if (state.selection.ranges.length > 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  let line = state.doc.lineAt(pos);
  if (pos !== line.from || line.number < 3) return false;
  if (line.text.trim()) {
    // 段落の先頭：上の行が空行なら、その空行について調べる
    line = state.doc.line(line.number - 1);
    if (line.text.trim()) return false;
  } else {
    if (line.number === state.doc.lines || !state.doc.line(line.number + 1).text.trim()) return false;
  }
  const prev = state.doc.line(line.number - 1);
  const here = prev.text.includes('|') && cellAt(state, prev.to);
  if (!here || here.rowIndex !== here.structure.rows.length - 1 || !here.row.cells.length) return false;
  const target = contentRange(here.row.cells[here.row.cells.length - 1]).to;
  view.dispatch({ selection: EditorSelection.cursor(target, -1), scrollIntoView: true, userEvent: 'select' });
  return true;
}

export function tableCells() {
  return [
    tablePlugin,
    escapePipe,
    cellEndCursor,
    // Markdown のリストの継続（Enter）より先に効かせる
    Prec.highest(keymap.of([
      { key: 'Tab', run: moveCell(1) },
      { key: 'Shift-Tab', run: moveCell(-1) },
      { key: 'Enter', run: (view) => moveRow(1)(view) || multiCursorEnter(view) },
      { key: 'ArrowUp', run: lineAboveTopTable },
      { key: 'Shift-Enter', run: moveRow(-1) },
      { key: 'Home', run: cellBoundary(false, false), shift: cellBoundary(false, true) },
      { key: 'End', run: cellBoundary(true, false), shift: cellBoundary(true, true) },
      { mac: 'Cmd-ArrowLeft', run: cellBoundary(false, false), shift: cellBoundary(false, true) },
      { mac: 'Cmd-ArrowRight', run: cellBoundary(true, false), shift: cellBoundary(true, true) },
      { key: 'Backspace', run: keepBlankAfterTable },
    ])),
    keepInCells,
    editInCells,
    pasteInCell,
  ];
}

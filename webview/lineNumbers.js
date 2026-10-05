// 行番号。VSCode の設定 editor.lineNumbers（markdown に対する値）に合わせて出す。
// 見出しの行は文字が大きく行が高いので、番号の行の高さを見出しの 1 行目に合わせる（editor.css）。

import { Compartment, RangeSetBuilder, StateField } from '@codemirror/state';
import { GutterMarker, ViewPlugin, gutterLineClass, highlightActiveLineGutter, lineNumberWidgetMarker, lineNumbers } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { isBareHeading } from './livePreview.js';
import { t } from './strings.js';

const compartment = new Compartment();

/**
 * editor.lineNumbers の値から行番号の拡張を作る。
 * 'relative' は CodeMirror の行番号の作りでは選択の移動に合わせて描き直せないので、'on' と同じにする。
 */
function extensionFor(mode) {
  if (mode === 'off') return [];
  const formatNumber = mode === 'interval'
    ? (n) => (n === 1 || n % 10 === 0 ? String(n) : '')
    : (n) => String(n);
  return [
    lineNumbers({ formatNumber }),
    // HTML にした表は、何も指定しないと行番号が出ない。表の行ごとに、その行のソースの行番号を出す
    lineNumberWidgetMarker.of((view, _widget, block) => {
      const first = view.state.doc.lineAt(block.from).number;
      const last = view.state.doc.lineAt(block.to).number;
      return new TableRowNumbers(block.from, first, last, formatNumber);
    }),
    tableRowNumberPosition,
    highlightActiveLineGutter(),
    headingGutterClass,
  ];
}

/**
 * 表の行番号。見出しの行には表の先頭の行の番号を、データの行にはその行の番号を出す
 * （2 行目の区切りの行 |---| は見出しの行の高さに含めているので、番号は出さない）。
 * 番号の位置は、表の行の実際の位置に合わせて tableRowNumberPosition が書き込む。
 */
class TableRowNumbers extends GutterMarker {
  constructor(from, first, last, formatNumber) {
    super();
    this.from = from;
    this.first = first;
    this.last = last;
    this.labels = [first];
    for (let n = first + 2; n <= last; n++) this.labels.push(n);
    this.labels = this.labels.map(formatNumber);
  }
  eq(other) {
    return other.from === this.from && other.last === this.last && other.labels.join() === this.labels.join();
  }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-md-row-numbers';
    box.dataset.from = String(this.from);
    box.title = t('Lines {0}–{1}', this.first, this.last);
    this.labels.forEach((label, i) => {
      const span = box.appendChild(document.createElement('span'));
      span.textContent = label;
      // 位置を測るまでの仮の位置。見出しは 2 行分の中ほど、データの行は 1 行ずつ
      span.style.top = `calc(var(--md-line) * ${i === 0 ? 0.5 : i + 1})`;
    });
    return box;
  }
}

/** 表の行の位置を測り、行番号をその行の 1 行目にそろえる。見出しの行は高さの中ほどにそろえる */
const tableRowNumberPosition = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    // セルの中で折り返したり、編集中に入力欄が伸びたりすると表の行の高さが変わる
    this.resize = new ResizeObserver(() => this.schedule());
    this.observed = new Set();
    this.schedule();
  }
  update(update) {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule();
  }
  schedule() {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        // 文書から消えた表は監視をやめる
        for (const wrap of this.observed) {
          if (!wrap.isConnected) {
            this.resize.unobserve(wrap);
            this.observed.delete(wrap);
          }
        }
        const line = view.defaultLineHeight;
        return [...view.contentDOM.querySelectorAll('.cm-md-table-wrap')].map((wrap) => {
          if (!this.observed.has(wrap)) {
            this.observed.add(wrap);
            this.resize.observe(wrap);
          }
          const top = wrap.getBoundingClientRect().top;
          const rows = [...wrap.querySelectorAll('.cm-md-table tr')].map((tr, i) => {
            const r = tr.getBoundingClientRect();
            return i === 0 ? r.top - top + (r.height - line) / 2 : r.top - top;
          });
          return { from: view.posAtDOM(wrap), rows };
        });
      },
      write: (tables, view) => {
        for (const { from, rows } of tables) {
          const box = view.dom.querySelector(`.cm-md-row-numbers[data-from="${from}"]`);
          if (!box) continue;
          rows.forEach((top, i) => {
            if (box.children[i]) box.children[i].style.top = `${top}px`;
          });
        }
      },
    });
  }
  destroy() {
    this.resize.disconnect();
  }
});

export function lineNumberGutter(mode) {
  return compartment.of(extensionFor(mode));
}

export function reconfigureLineNumbers(mode) {
  return compartment.reconfigure(extensionFor(mode));
}

class HeadingGutter extends GutterMarker {
  constructor(level) {
    super();
    this.elementClass = `cm-md-gutter-heading cm-md-gutter-h${level}`;
  }
  eq(other) { return other.elementClass === this.elementClass; }
}
const headingMarkers = [1, 2, 3, 4, 5, 6].map((level) => new HeadingGutter(level));

function headingLines(state) {
  const builder = new RangeSetBuilder();
  syntaxTree(state).iterate({
    enter(node) {
      const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
      if (match && isBareHeading(state.doc, node.node)) return false;
      if (match) {
        builder.add(state.doc.lineAt(node.from).from, state.doc.lineAt(node.from).from, headingMarkers[match[1] - 1]);
        return false;
      }
      // 見出しはブロックの直下にしかないので、段落やコードブロックの中には入らない
      return node.name === 'Document' || node.name === 'Blockquote' || node.name.endsWith('List') || node.name === 'ListItem';
    },
  });
  return builder.finish();
}

const headingGutterClass = StateField.define({
  create(state) {
    ensureSyntaxTree(state, state.doc.length, 200);
    return headingLines(state);
  },
  update(value, tr) {
    return tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? headingLines(tr.state) : value;
  },
  provide: (field) => gutterLineClass.from(field),
});

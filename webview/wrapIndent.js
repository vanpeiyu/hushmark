// 折り返した行の字下げ。箇条書きや引用の長い行を折り返したとき、2 行目以降を本文の先頭の桁にそろえる。
// VSCode の editor.wrappingIndent に合わせ、'none' のときは字下げしない（それ以外は 'same' と同じにする）。
//
// 行頭の記号（字下げの空白、引用の >、リストの記号、タスクの [ ]）の幅を数え、
// 行の左の余白をその幅だけ広げ、1 行目だけ text-indent で同じ幅だけ戻す。

import { Compartment, RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { columnsOf } from './textWidth.js';

const compartment = new Compartment();

/** 行頭の記号。引用の > は何重でもよく、その後にリストの記号とタスクの [ ] が続く */
const PREFIX = /^[ \t]*(?:>[ \t]?[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
const LEADING_SPACE = /^[ \t]*/;

/** その行の折り返しの字下げ（桁数）。コードブロックの中では行頭の空白だけを数える */
export function hangingWidth(text, inCode, tabSize) {
  const match = (inCode ? LEADING_SPACE : PREFIX).exec(text);
  // 記号だけの行（「- 」で終わる行など）は折り返さないので字下げしない
  if (!match || match[0].length === 0 || match[0].length === text.length) return 0;
  return columnsOf(match[0], tabSize);
}

const decorationCache = new Map();
function hanging(width) {
  let deco = decorationCache.get(width);
  if (!deco) {
    deco = Decoration.line({
      attributes: { style: `padding-left: calc(var(--md-line-pad) + ${width}ch); text-indent: -${width}ch` },
    });
    decorationCache.set(width, deco);
  }
  return deco;
}

function isCodeLine(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
  }
  return false;
}

function build(view) {
  const { state } = view;
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      const width = hangingWidth(line.text, isCodeLine(state, line.from), state.tabSize);
      if (width > 0) builder.add(line.from, line.from, hanging(width));
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const plugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged || update.state.tabSize !== update.startState.tabSize ||
        syntaxTree(update.state) !== syntaxTree(update.startState)) {
      this.decorations = build(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

function extensionFor(mode) {
  return mode === 'none' ? [] : plugin;
}

export function wrapIndent(mode) {
  return compartment.of(extensionFor(mode));
}

export function reconfigureWrapIndent(mode) {
  return compartment.reconfigure(extensionFor(mode));
}

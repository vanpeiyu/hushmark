// 行番号。VSCode の設定 editor.lineNumbers（markdown に対する値）に合わせて出す。
// 見出しの行は文字が大きく行が高いので、番号の行の高さを見出しの 1 行目に合わせる（editor.css）。

import { Compartment, RangeSetBuilder, StateField } from '@codemirror/state';
import { GutterMarker, gutterLineClass, highlightActiveLineGutter, lineNumbers } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { isBareHeading } from './livePreview.js';

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
    highlightActiveLineGutter(),
    headingGutterClass,
  ];
}

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

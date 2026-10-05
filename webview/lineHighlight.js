// カーソルのある行の背景。VSCode の editor.renderLineHighlight と editor.renderLineHighlightOnlyWhenFocus に合わせる。
// 背景は行の左右の端（箱や線をそろえる基準線）まで描くので、本文の行頭がどこかの目印にもなる（editor.css）。
//
// CodeMirror の highlightActiveLine は使わない。自前の配色（background-color）を、引用やコードブロックの
// 背景より強い指定で付けるので、カーソルが入ると箱の背景が置き換わってしまうため。

import { Compartment, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';

const compartment = new Compartment();
const activeLine = Decoration.line({ class: 'cm-md-active-line' });

const plugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(update) {
    if (update.docChanged || update.selectionSet) this.decorations = build(update.view);
  }
}, { decorations: (v) => v.decorations });

function build(view) {
  const builder = new RangeSetBuilder();
  let last = -1;
  for (const range of view.state.selection.ranges) {
    const line = view.lineBlockAt(range.head);
    if (line.from > last) {
      builder.add(line.from, line.from, activeLine);
      last = line.from;
    }
  }
  return builder.finish();
}

/** 'line' と 'all' のときに行の背景を付ける（'gutter' と 'none' では付けない） */
function extensionFor({ renderLineHighlight, renderLineHighlightOnlyWhenFocus }) {
  if (renderLineHighlight !== 'line' && renderLineHighlight !== 'all') return [];
  return [
    plugin,
    renderLineHighlightOnlyWhenFocus ? EditorView.editorAttributes.of({ class: 'cm-md-highlight-when-focused' }) : [],
  ];
}

export function lineHighlight(options) {
  return compartment.of(extensionFor(options));
}

export function reconfigureLineHighlight(options) {
  return compartment.reconfigure(extensionFor(options));
}

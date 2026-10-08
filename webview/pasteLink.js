// 文字列を選んで URL を貼り付けると、選んだ文字列をリンクにする（[文字列](URL)）。
// VSCode の Markdown のテキストエディタ（markdown.editor.pasteUrlAsFormattedLink.enabled の既定）と同じ動き。

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

const URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;
/** この中ではリンクにしない */
const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'URL', 'Link', 'Autolink']);

/** 貼り付ける文字列が URL なら、選んだ範囲をリンクにする変更を返す。リンクにしないときは null */
export function linkPaste(state, text) {
  const url = text.trim();
  if (!URL_PATTERN.test(url)) return null;
  const ranges = state.selection.ranges;
  if (ranges.some((r) => r.empty || state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number)) return null;
  const tree = syntaxTree(state);
  for (const r of ranges) {
    const selected = state.sliceDoc(r.from, r.to);
    // URL を選んで URL を貼り付けたときは、ふつうに置き換える
    if (URL_PATTERN.test(selected.trim())) return null;
    for (let node = tree.resolveInner(r.from, 1); node; node = node.parent) {
      if (CODE_NODES.has(node.name)) return null;
    }
  }
  // 括弧を含む URL は、リンク先の終わりを誤らないよう <> で囲む
  const target = /[()\s]/.test(url) ? `<${url}>` : url;
  return state.changeByRange((r) => {
    const insert = `[${state.sliceDoc(r.from, r.to)}](${target})`;
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) };
  });
}

export const pasteLink = EditorView.domEventHandlers({
  paste(event, view) {
    if (view.state.readOnly) return false;
    const spec = linkPaste(view.state, event.clipboardData?.getData('text/plain') ?? '');
    if (!spec) return false;
    event.preventDefault();
    view.dispatch(spec, { userEvent: 'input.paste', scrollIntoView: true });
    return true;
  },
});

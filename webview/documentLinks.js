// 他の拡張機能が提供するドキュメントリンク（vscode.executeLinkProvider。Issue の番号をリンクにするものなど）。
// 拡張機能本体が文書の変更の後に問い合わせて送ってくる（{ type: 'links' }）。Markdown のリンクとして描いているもの
// （livePreview.js）と重なるものは除き、残りを Ctrl+クリック（multiCursorModifier によっては Alt+クリック）で開けるようにする。

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { linkAttributes } from './inline.js';

const setLinks = StateEffect.define();
/** Markdown のリンクの構文のノード。この中のリンクは livePreview.js が描く */
const MARKDOWN_LINKS = new Set(['Link', 'Image', 'Autolink', 'URL', 'LinkReference']);

const linksField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLinks)) return effect.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function documentLinks() {
  return linksField;
}

/** 拡張機能本体から届いたリンク（行と列は 0 始まり）を装飾にする */
export function applyLinks(view, items) {
  const { state } = view;
  const { doc } = state;
  const pos = ({ line, col }) => {
    const l = doc.line(Math.min(Math.max(line + 1, 1), doc.lines));
    return l.from + Math.min(Math.max(col, 0), l.length);
  };
  const tree = syntaxTree(state);
  const inMarkdownLink = (from) => {
    for (let node = tree.resolveInner(from, 1); node; node = node.parent) if (MARKDOWN_LINKS.has(node.name)) return true;
    return false;
  };
  const ranges = items
    .map((item) => ({ from: pos(item.start), to: pos(item.end), target: item.target }))
    .filter((r) => r.to > r.from && r.target && !inMarkdownLink(r.from))
    .map((r) => Decoration.mark({ class: 'cm-md-doclink', attributes: linkAttributes(r.target) }).range(r.from, r.to));
  view.dispatch({ effects: setLinks.of(Decoration.set(ranges, true)) });
}

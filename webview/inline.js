// リンクの扱い。本文と表のセルで共通に使う。

import { Facet } from '@codemirror/state';
import { openLinkHint } from './platform.js';

/** リンクを開く処理。main.js から VSCode 側に渡す関数を登録する。 */
export const openLinkHandler = Facet.define({
  combine: (values) => values[0] || (() => {}),
});

export function linkAttributes(href) {
  return { 'data-href': href, title: `${href}\n${openLinkHint()}` };
}

/** リンクの参照定義のラベルの比べ方。CommonMark と同じく、前後の空白、空白の連続、大文字と小文字の違いを無視する */
export function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

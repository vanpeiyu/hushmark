// エディタと表のセルで共通に使う Markdown の設定。

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { cjkFriendlyEmphasis } from './cjkEmphasis.js';

/** GFM（markdownLanguage）に足す拡張 */
export const markdownExtensions = [cjkFriendlyEmphasis];

/** 本文のエディタの Markdown。codeLanguages はコードブロックの言語ごとの構文定義 */
export function markdownSupport(codeLanguages) {
  return markdown({ base: markdownLanguage, codeLanguages, extensions: markdownExtensions });
}

/**
 * 表のセルの Markdown。GFM の表のセルにはインライン要素しか書けないので、ブロックの構文を外す
 * （外さないと「1. 」で始まるセルがリストに、「# 」で始まるセルが見出しになる）。
 */
const BLOCK_PARSERS = [
  'LinkReference', 'IndentedCode', 'FencedCode', 'Blockquote', 'HorizontalRule',
  'BulletList', 'OrderedList', 'ATXHeading', 'HTMLBlock', 'SetextHeading', 'Table',
];
const cellExtensions = [...markdownExtensions, { remove: BLOCK_PARSERS }];

export function cellMarkdownSupport() {
  return markdown({ base: markdownLanguage, extensions: cellExtensions });
}

/** 表のセルを HTML で描くときのパーサー */
export const cellParser = markdownLanguage.parser.configure(cellExtensions);

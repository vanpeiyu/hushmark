import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownSupport } from '../webview/markdownSetup.js';
import { findAnchor, headingAnchors, slugify } from '../webview/anchors.js';
import { parsedState } from './parsedState.mjs';

const anchorsOf = (doc) => headingAnchors(parsedState({ doc, extensions: [markdownSupport()] })).map((a) => a.anchor);

test('slugify: GitHub と同じく、小文字にして記号を消し、空白をハイフンにする', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('foo_bar-baz'), 'foo_bar-baz');
  assert.equal(slugify('表の編集（セル）'), '表の編集セル');
  assert.equal(slugify('A  B'), 'a--b');
});

test('headingAnchors: 強調・コード・リンクの記号を除き、重なるアンカーに番号を付ける', () => {
  const doc = '# **Bold** `code`\n\n## [Link](https://example.com) here\n\nSetext\n======\n\n# Dup\n\n# Dup\n\n# \\#escaped';
  assert.deepEqual(anchorsOf(doc), ['bold-code', 'link-here', 'setext', 'dup', 'dup-1', 'escaped']);
});

test('findAnchor: URL のエンコードと大文字を許す', () => {
  const state = parsedState({ doc: 'text\n\n## 日本語の見出し\n', extensions: [markdownSupport()] });
  assert.equal(findAnchor(state, encodeURIComponent('日本語の見出し')), 6);
  assert.equal(findAnchor(state, '日本語の見出し'), 6);
  assert.equal(findAnchor(state, 'none'), null);
  assert.equal(findAnchor(state, '%E0%A4%A'), null);
});

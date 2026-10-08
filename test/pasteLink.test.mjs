import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection } from '@codemirror/state';
import { markdownSupport } from '../webview/markdownSetup.js';
import { linkPaste } from '../webview/pasteLink.js';
import { parsedState } from './parsedState.mjs';

/** doc の中の selected を選んで text を貼り付けた結果。リンクにしないときは null */
function paste(doc, selected, text) {
  const from = doc.indexOf(selected);
  const state = parsedState({ doc, selection: EditorSelection.single(from, from + selected.length), extensions: [markdownSupport()] });
  const spec = linkPaste(state, text);
  return spec ? state.update(spec).state.doc.toString() : null;
}

test('linkPaste: 選んだ文字列を URL のリンクにする', () => {
  assert.equal(paste('see docs here', 'docs', 'https://example.com/a'), 'see [docs](https://example.com/a) here');
  assert.equal(paste('see docs here', 'docs', '  https://example.com/a\n'), 'see [docs](https://example.com/a) here');
  assert.equal(paste('wiki', 'wiki', 'https://en.wikipedia.org/wiki/Foo_(bar)'), '[wiki](<https://en.wikipedia.org/wiki/Foo_(bar)>)');
});

test('linkPaste: URL でないもの、選択がないもの、コードの中ではリンクにしない', () => {
  assert.equal(paste('see docs here', 'docs', 'plain text'), null);
  assert.equal(paste('see docs here', '', 'https://example.com'), null);
  assert.equal(paste('a `code` b', 'code', 'https://example.com'), null);
  assert.equal(paste('```\ncode\n```', 'code', 'https://example.com'), null);
  assert.equal(paste('go https://old.example.com now', 'https://old.example.com', 'https://example.com'), null);
});

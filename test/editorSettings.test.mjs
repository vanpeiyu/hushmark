import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIndentation, whitespaceRanges } from '../webview/editorSettings.js';

const shown = (text, mode, selected) => whitespaceRanges(text, mode, selected).map((r) => r.from);

test('whitespaceRanges: editor.renderWhitespace の値ごとに、表示する空白を選ぶ', () => {
  const text = '  a b  c\t ';
  assert.deepEqual(shown(text, 'all'), [0, 1, 3, 5, 6, 8, 9]);
  // boundary は、語の間の 1 つだけの空白を除く
  assert.deepEqual(shown(text, 'boundary'), [0, 1, 5, 6, 8, 9]);
  assert.deepEqual(shown(text, 'trailing'), [8, 9]);
  assert.deepEqual(shown(text, 'selection', (i) => i >= 3 && i < 7), [3, 5, 6]);
  assert.ok(whitespaceRanges(text, 'all')[5].tab);
});

test('detectIndentation: 文書の字下げが空白かタブか、空白なら何桁かを推し量る', () => {
  assert.deepEqual(detectIndentation('- a\n  - b\n    - c\n'), { insertSpaces: true, tabSize: 2 });
  assert.deepEqual(detectIndentation('- a\n\t- b\n\t\t- c\n'), { insertSpaces: false });
  assert.equal(detectIndentation('a\nb\n'), null);
});

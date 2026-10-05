import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnsOf, displayWidth, posAtColumn } from '../webview/textWidth.js';

test('displayWidth: 全角は 2、半角は 1', () => {
  assert.equal(displayWidth('りんご'), 6);
  assert.equal(displayWidth('abc'), 3);
});

test('columnsOf: 全角は 2 桁、タブは tabSize の桁まで進める', () => {
  assert.equal(columnsOf('abc', 4), 3);
  assert.equal(columnsOf('**太字**', 4), 8);
  assert.equal(columnsOf('a\tb', 4), 5);
  assert.equal(columnsOf('\t\t', 2), 4);
});

test('posAtColumn: 桁の位置を返し、全角の途中なら前にそろえ、行より長ければ行末にする', () => {
  // 文書の 10 から始まる行
  assert.equal(posAtColumn('**太字**の後', 10, 8, 4), 16);
  assert.equal(posAtColumn('**太字**の後', 10, 3, 4), 12);
  assert.equal(posAtColumn('**太字**の後', 10, 99, 4), 18);
  assert.equal(posAtColumn('', 10, 5, 4), 10);
  // タブの途中の桁なら、タブの前
  assert.equal(posAtColumn('a\tb', 0, 2, 4), 1);
});

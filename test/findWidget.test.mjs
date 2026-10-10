import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preserveCase } from '../webview/findWidget.js';

test('preserveCase: 置換の文字列の大文字と小文字を、一致した文字列に合わせる', () => {
  assert.equal(preserveCase('APPLE', 'orange'), 'ORANGE');
  assert.equal(preserveCase('apple', 'Orange'), 'orange');
  assert.equal(preserveCase('Apple', 'orange'), 'Orange');
  // 大文字と小文字が混ざっているときと、文字がないときはそのまま
  assert.equal(preserveCase('iPhone', 'android'), 'android');
  assert.equal(preserveCase('りんご', 'Orange'), 'Orange');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBoundary, wordSegments } from '../webview/wordSegments.js';

test('wordSegments: 日本語の文を語に分け、句読点と空白は語に含めない', () => {
  const text = '今日は良い天気です。Hello world';
  const words = wordSegments(text, ['ja']).map((w) => text.slice(w.from, w.to));
  assert.ok(words.includes('天気'), words.join('/'));
  assert.ok(!words.includes('。'));
  assert.ok(words.includes('Hello') && words.includes('world'));
});

test('nextBoundary: 語の終わり（右）と語の初め（左）に止まる', () => {
  const text = '良い天気です';
  const words = wordSegments(text, ['ja']);
  const right = nextBoundary(text, 0, true, ['ja']);
  assert.equal(right, words[0].to);
  assert.equal(nextBoundary(text, text.length, false, ['ja']), words[words.length - 1].from);
});

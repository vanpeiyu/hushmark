import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHref } from '../src/links.js';

test('normalizeHref: 山括弧、エスケープ、文字参照を外す', () => {
  assert.equal(normalizeHref('<https://example.com/a b>'), 'https://example.com/a b');
  assert.equal(normalizeHref('https://example.com/?a=1&amp;b=2'), 'https://example.com/?a=1&b=2');
  assert.equal(normalizeHref('docs/a\_b.md'), 'docs/a_b.md');
  assert.equal(normalizeHref('&#65;&#x42;.md'), 'AB.md');
});

test('normalizeHref: www. には https://、メールアドレスには mailto: を付ける', () => {
  assert.equal(normalizeHref('www.example.com'), 'https://www.example.com');
  assert.equal(normalizeHref('<user@example.com>'), 'mailto:user@example.com');
  // すでにスキームがあるもの、相対パスはそのまま
  assert.equal(normalizeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(normalizeHref('./docs/readme.md'), './docs/readme.md');
});

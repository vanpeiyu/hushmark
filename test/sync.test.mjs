import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, EditorState, Text } from '@codemirror/state';
import { diffText, toLineChanges } from '../webview/sync.js';
import { rebaseChanges } from '../src/textMerge.js';

/** 行・列の置換リストを、変更前の文字列にまとめて適用する（WorkspaceEdit と同じく範囲はすべて変更前が基準） */
function applyLineChanges(text, changes) {
  const lines = text.split('\n');
  const offset = (line, ch) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + ch;
  const ranges = changes.map((c) => ({ from: offset(c.fromLine, c.fromCh), to: offset(c.toLine, c.toCh), insert: c.insert }));
  ranges.sort((a, b) => b.from - a.from);
  for (const r of ranges) text = text.slice(0, r.from) + r.insert + text.slice(r.to);
  return text;
}

test('toLineChanges: 1 つのトランザクションの複数の変更を変更前の行・列で返す', () => {
  const before = 'line one\nline two\n```js\ncode\n```';
  const doc = Text.of(before.split('\n'));
  const changes = ChangeSet.of([
    { from: 0, to: 4, insert: 'LINE' },
    { from: 9, insert: '**' },
    { from: before.length, insert: '\n\nafter the code block' },
  ], doc.length);
  const expected = changes.apply(doc).toString();
  assert.equal(applyLineChanges(before, toLineChanges(changes, doc)), expected);
});

test('toLineChanges: 複数行にまたがる削除と改行を含む挿入', () => {
  const state = EditorState.create({ doc: 'a\nb\nc\nd' });
  const tr = state.update({ changes: { from: 1, to: 5, insert: 'X\nY' } });
  assert.deepEqual(toLineChanges(tr.changes, state.doc), [
    { fromLine: 0, fromCh: 1, toLine: 2, toCh: 1, insert: 'X\nY' },
  ]);
  assert.equal(applyLineChanges('a\nb\nc\nd', toLineChanges(tr.changes, state.doc)), tr.state.doc.toString());
});

test('diffText: 共通の先頭と末尾を除いた最小の置換', () => {
  assert.deepEqual(diffText('hello world', 'hello brave world'), { from: 6, to: 6, insert: 'brave ' });
  assert.deepEqual(diffText('abc', 'abc'), null);
  assert.deepEqual(diffText('abcdef', 'abef'), { from: 2, to: 4, insert: '' });
});

test('diffText: サロゲートペアの途中で切らない', () => {
  const change = diffText('a😀b', 'a😁b');
  assert.deepEqual(change, { from: 1, to: 3, insert: '😁' });
});


test('rebaseChanges: 外からの変更より後ろの編集は、その分ずらす', () => {
  // 元が ab、外からの変更で Xab になった間に、Webview で b を B にした
  const changes = rebaseChanges('ab', 'Xab', [{ fromLine: 0, fromCh: 1, toLine: 0, toCh: 2, insert: 'B' }]);
  assert.equal(applyLineChanges('Xab', changes), 'XaB');
});

test('rebaseChanges: 行をまたぐ外からの変更でも、行・列を直す', () => {
  const base = '# A\n\ntext\nend';
  const current = '# A\nadded line\n\ntext\nend';
  // Webview で text の後ろに ! を足した
  const changes = rebaseChanges(base, current, [{ fromLine: 2, fromCh: 4, toLine: 2, toCh: 4, insert: '!' }]);
  assert.equal(applyLineChanges(current, changes), '# A\nadded line\n\ntext!\nend');
  // 外からの変更より前の編集はそのまま
  const before = rebaseChanges(base, current, [{ fromLine: 0, fromCh: 3, toLine: 0, toCh: 3, insert: 'B' }]);
  assert.equal(applyLineChanges(current, before), '# AB\nadded line\n\ntext\nend');
});

test('rebaseChanges: 外からの変更と重なる編集は null（捨てて同期し直す）', () => {
  assert.equal(rebaseChanges('abcdef', 'abXYef', [{ fromLine: 0, fromCh: 3, toLine: 0, toCh: 3, insert: 'Z' }]), null);
  // 食い違いがなければ、そのまま返す
  const same = [{ fromLine: 0, fromCh: 0, toLine: 0, toCh: 0, insert: 'x' }];
  assert.equal(rebaseChanges('a', 'a', same), same);
});

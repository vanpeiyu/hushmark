import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownSupport } from '../webview/markdownSetup.js';
import { livePreview, setFocus } from '../webview/livePreview.js';
import { parsedState } from './parsedState.mjs';

// カーソルを動かしたときに一部だけ作り直した装飾が、全体を作り直したものと同じになるかを確かめる

const DOC = [
  '# Title', '', 'Para with **bold**, *em*, `code`, ~~del~~ and [link](https://example.com) and [ref].', 'Second line\\', '',
  'Setext', '======', '', '- item **one**', '  - nested `x`', '- [ ] task', '- [x] done', '', '1. first', '2. second', '',
  '> quote line', '> > nested', '> more', '', '---', '', '```js', 'const a = 1;', '```', '', '    indented code', '',
  '| a | b |', '|---|---|', '| 1 | **2** |', '', 'Trailing  ', 'line', '', '[ref]: https://example.com/ref', '', '## End ##', '',
].join('\n');

/** 装飾を比べられる形にする */
function snapshot(state) {
  const out = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue;
    for (const c = set.iter(); c.value; c.next()) {
      const spec = c.value.spec;
      out.push(`${c.from}-${c.to} ${spec.class || ''} ${spec.widget ? spec.widget.constructor.name : ''} ${JSON.stringify(spec.attributes || {})} ${spec.block ? 'block' : ''}`);
    }
  }
  return out.sort();
}

test('カーソルの移動で一部だけ作り直した装飾は、全体を作り直したものと同じ', () => {
  let state = parsedState({ doc: DOC, extensions: [markdownSupport(), livePreview()] });
  state = state.update({ effects: setFocus.of(true) }).state;
  const positions = [];
  for (let pos = 0; pos <= state.doc.length; pos += 3) positions.push(pos);
  // 遠くへの移動と、選択範囲（複数行）も混ぜる
  const moves = [...positions, ...positions.slice().reverse().filter((_, i) => i % 5 === 0)]
    .map((pos, i) => (i % 7 === 0 ? EditorSelection.single(pos, Math.min(state.doc.length, pos + 40)) : EditorSelection.single(pos)));
  for (const selection of moves) {
    state = state.update({ selection }).state;
    const fresh = parsedState({ doc: DOC, selection, extensions: [markdownSupport(), livePreview()] });
    const expected = snapshot(fresh.update({ effects: setFocus.of(true) }).state);
    assert.deepEqual(snapshot(state), expected, `selection ${selection.main.from}-${selection.main.to}`);
  }
});

/** 決まった種から作る乱数（テストの結果を毎回同じにする） */
function random(seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// 構造を変える入力（コードブロックを開く、見出しにする、表の行、参照定義、下線など）を混ぜる
const SNIPPETS = ['a', ' ', '\n', '**', '`', '```', '\n```\n', '# ', '- ', '> ', '| x |', '\n|---|\n', '===\n', '[ref]: https://e.com\n', '---\n', '[ref]', '\\', '~~', '- [ ] '];

test('文書を変えたときに一部だけ作り直した装飾は、全体を作り直したものと同じ', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rand = random(seed);
    let state = parsedState({ doc: DOC, extensions: [markdownSupport(), livePreview()] });
    state = state.update({ effects: setFocus.of(true) }).state;
    for (let step = 0; step < 60; step++) {
      const len = state.doc.length;
      const from = Math.floor(rand() * (len + 1));
      const change = rand() < 0.7
        ? { from, insert: SNIPPETS[Math.floor(rand() * SNIPPETS.length)] }
        : { from, to: Math.min(len, from + 1 + Math.floor(rand() * 6)) };
      state = state.update({ changes: change, selection: { anchor: Math.min(from + (change.insert || '').length, len) } }).state;
      // エディタと同じく、構文木を後から最後まで作り、その木を次のトランザクションで状態に入れる
      if (!ensureSyntaxTree(state, state.doc.length, 60000)) throw new Error('解析が終わらない');
      state = state.update({}).state;
      const fresh = parsedState({ doc: state.doc.toString(), selection: state.selection, extensions: [markdownSupport(), livePreview()] });
      assert.deepEqual(snapshot(state), snapshot(fresh.update({ effects: setFocus.of(true) }).state), `seed ${seed} step ${step} ${JSON.stringify(change)}`);
    }
  }
});

test('変更した範囲の外でブロックが変わるとき（閉じていないコードブロックを閉じる）も、全体を作り直したものと同じ', () => {
  const doc = 'a\n\n```\ncode\n\nb **x**\n\n# h\n';
  let state = parsedState({ doc, extensions: [markdownSupport(), livePreview()] });
  state = state.update({ effects: setFocus.of(true) }).state;
  state = state.update({ changes: { from: doc.indexOf('\n\nb') + 1, insert: '```\n' } }).state;
  if (!ensureSyntaxTree(state, state.doc.length, 60000)) throw new Error('解析が終わらない');
  state = state.update({}).state;
  const fresh = parsedState({ doc: state.doc.toString(), selection: state.selection, extensions: [markdownSupport(), livePreview()] });
  assert.deepEqual(snapshot(state), snapshot(fresh.update({ effects: setFocus.of(true) }).state));
});

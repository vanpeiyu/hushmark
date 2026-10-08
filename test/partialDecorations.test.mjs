import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
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

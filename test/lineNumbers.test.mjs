import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gutterLineClass } from '@codemirror/view';
import { markdownSupport } from '../webview/markdownSetup.js';
import { lineNumberGutter } from '../webview/lineNumbers.js';
import { parsedState } from './parsedState.mjs';

function headingGutterLines(doc, mode = 'on') {
  const state = parsedState({ doc, extensions: [markdownSupport(), lineNumberGutter(mode)] });
  const lines = [];
  for (const set of state.facet(gutterLineClass)) {
    set.between(0, doc.length, (from, _to, marker) => {
      if (marker.elementClass.includes('cm-md-gutter')) lines.push(`${state.doc.lineAt(from).number}:${marker.elementClass}`);
    });
  }
  return lines;
}

test('見出しの行の行番号に、見出しの大きさのクラスを付ける', () => {
  const doc = '# A\n\ntext\n\n> ## quoted\n\nSetext\n---\n\n```\n# not heading\n```';
  assert.deepEqual(headingGutterLines(doc), [
    '1:cm-md-gutter-heading cm-md-gutter-h1',
    '5:cm-md-gutter-heading cm-md-gutter-h2',
    '7:cm-md-gutter-heading cm-md-gutter-h2',
  ]);
});

test('editor.lineNumbers が off なら行番号を出さない', () => {
  assert.deepEqual(headingGutterLines('# A', 'off'), []);
});

test('「##」だけの行は、行番号でも見出しとして扱わない', () => {
  assert.deepEqual(headingGutterLines('##\n\n## \n\n## A'), [
    '3:cm-md-gutter-heading cm-md-gutter-h2',
    '5:cm-md-gutter-heading cm-md-gutter-h2',
  ]);
});

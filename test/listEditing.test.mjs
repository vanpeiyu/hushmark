import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection } from '@codemirror/state';
import { markdownSupport } from '../webview/markdownSetup.js';
import { listCommands } from '../webview/listEditing.js';
import { parsedState } from './parsedState.mjs';

/** 文書の | の位置にカーソルを置いてコマンドを実行し、結果の文書とカーソルを | で表す */
function run(command, text) {
  const at = text.indexOf('|');
  let state = parsedState({ doc: text.replace('|', ''), selection: EditorSelection.cursor(at), extensions: [markdownSupport([])] });
  const handled = command({ state, dispatch: (tr) => { state = tr.state; } });
  const head = state.selection.main.head;
  const doc = state.doc.toString();
  return handled ? doc.slice(0, head) + '|' + doc.slice(head) : null;
}
const { insertNewline, insertLineBreakInItem, indentItem, joinNextItem } = listCommands;

test('insertNewline: 空の項目では、項目の数によらず 1 回でリストを抜け、空行を入れる', () => {
  assert.equal(run(insertNewline, '- a\n- |'), '- a\n\n|');
  assert.equal(run(insertNewline, '- a\n- b\n- |'), '- a\n- b\n\n|');
  assert.equal(run(insertNewline, '1. a\n2. |'), '1. a\n\n|');
  assert.equal(run(insertNewline, '- [ ] a\n- [ ] |'), '- [ ] a\n\n|');
  assert.equal(run(insertNewline, '> - a\n> - |'), '> - a\n>\n> |');
});

test('insertNewline: 入れ子の空の項目では、子の数によらず 1 段浅くする', () => {
  assert.equal(run(insertNewline, '- a\n  - child\n  - |'), '- a\n  - child\n- |');
});

test('insertNewline: 内容の先頭では上に空の項目を入れ、チェックと番号を保つ', () => {
  assert.equal(run(insertNewline, '- [x] |abc'), '- [ ] \n- [x] |abc');
  assert.equal(run(insertNewline, '- |abc'), '- \n- |abc');
  assert.equal(run(insertNewline, '1. |abc\n2. def'), '1. \n2. |abc\n3. def');
});

test('insertNewline: 子を持つ項目の末尾では、最初の子の位置に項目を作る', () => {
  assert.equal(run(insertNewline, '- a|\n  - child\n- b'), '- a\n  - |\n  - child\n- b');
  assert.equal(run(insertNewline, '1. a|\n   1. x\n   2. y'), '1. a\n   1. |\n   2. x\n   3. y');
});

test('insertNewline: 項目の途中では CodeMirror と同じく項目を分ける', () => {
  assert.equal(run(insertNewline, '- ab|cd'), '- ab\n- |cd');
  assert.equal(run(insertNewline, '- [x] a|'), '- [x] a\n- [ ] |');
});

test('insertLineBreakInItem: 内容の桁まで字下げした継続の行を作る', () => {
  assert.equal(run(insertLineBreakInItem, '- abc|'), '- abc\n  |');
  assert.equal(run(insertLineBreakInItem, '> 1. abc|'), '> 1. abc\n>    |');
  assert.equal(run(insertLineBreakInItem, 'abc|'), null);
});

test('indentItem: 最初の項目は字下げせず、番号付きの項目は新しい入れ子で 1 から振る', () => {
  assert.equal(run(indentItem, '- a|\n- b'), '- a|\n- b');
  // 字下げの単位（ここでは 2 桁）で字下げする。上の項目の内容の桁に届かなければ、その桁まで
  assert.equal(run(indentItem, '- a\n- b|'), '- a\n  - b|');
  assert.equal(run(indentItem, '1. a\n2. b|'), '1. a\n   1. b|');
  assert.equal(run(indentItem, '1. a\n2. b\n3. c|\n4. d'), '1. a\n2. b\n   1. c|\n3. d');
  assert.equal(run(indentItem, 'para|'), null);
});

test('joinNextItem: 項目の末尾の Delete で、次の項目の記号を消して内容をつなげる', () => {
  assert.equal(run(joinNextItem, '- a|\n- [ ] b'), '- a|b');
  assert.equal(run(joinNextItem, '1. a|\n2. b\n3. c'), '1. a|b\n2. c');
  assert.equal(run(joinNextItem, '- a|\npara'), null);
});

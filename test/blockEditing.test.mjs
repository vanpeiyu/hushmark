import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection } from '@codemirror/state';
import { markdownSupport } from '../webview/markdownSetup.js';
import { blockCommands } from '../webview/blockEditing.js';
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
const { insertNewline, insertLineBreakInItem, indentItem, insertTab, joinNextItem, deleteHeadingMark } = blockCommands;

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

test('insertNewline: 見出しの文字の先頭では見出しを保ち、上に空の行を入れる', () => {
  assert.equal(run(insertNewline, 'para\n## |Heading'), 'para\n\n## |Heading');
  // 途中では扱わない（CodeMirror の Enter に任せる）
  assert.equal(run(insertNewline, '## Head|ing'), null);
});

test('insertNewline: 空の引用の行で引用を抜け、入れ子なら 1 段浅くする', () => {
  assert.equal(run(insertNewline, '> quote\n> |'), '> quote\n\n|');
  assert.equal(run(insertNewline, '> quote\n>|'), '> quote\n\n|');
  assert.equal(run(insertNewline, '> > deep\n> > |'), '> > deep\n> |');
  assert.equal(run(insertNewline, '> quote|'), '> quote\n> |');
});

test('insertNewline: setext 見出しの末尾では、下線の後ろに新しい行を作る', () => {
  assert.equal(run(insertNewline, 'Title|\n---\nbody'), 'Title\n---\n|\nbody');
  assert.equal(run(insertNewline, 'Ti|tle\n---'), null);
});

test('deleteHeadingMark: 見出しの文字の先頭の Backspace で「## 」をまとめて消す', () => {
  assert.equal(run(deleteHeadingMark, '## |Heading'), '|Heading');
  assert.equal(run(deleteHeadingMark, '## |'), '|');
  assert.equal(run(deleteHeadingMark, '## H|eading'), null);
});

test('insertTab: リストの項目以外では、カーソルの位置に次のタブ位置までの空白を入れる', () => {
  assert.equal(run(insertTab, '## Hea|ding'), '## Hea  |ding');
  assert.equal(run(insertTab, '|para'), '    |para');
});

test('insertNewline: リストの項目や引用の中でコードブロックを開くと、次の行を内容の位置にそろえる', () => {
  assert.equal(run(insertNewline, '- ```|'), '- ```\n  |\n  ```');
  assert.equal(run(insertNewline, '1. ```js|'), '1. ```js\n   |\n   ```');
  assert.equal(run(insertNewline, '> ```|'), '> ```\n> |\n> ```');
  assert.equal(run(insertNewline, '> ```\n> code|\n> ```'), '> ```\n> code\n> |\n> ```');
});

test('insertNewline: 閉じていないコードブロックを開いた行の末尾では、閉じのフェンスも入れる', () => {
  assert.equal(run(insertNewline, 'para\n\n```py|\n\n# Head'), 'para\n\n```py\n|\n```\n\n# Head');
  assert.equal(run(insertNewline, '~~~|'), '~~~\n|\n~~~');
  // すでに閉じていれば、閉じのフェンスは足さない
  assert.equal(run(insertNewline, '```|\ncode\n```'), null);
});

test('insertNewline: 項目の続きの行では、次の項目を作る', () => {
  assert.equal(run(insertNewline, '- item\n  cont|\n- b'), '- item\n  cont\n- |\n- b');
  assert.equal(run(insertNewline, '1. item\n   cont|\n2. b'), '1. item\n   cont\n2. |\n3. b');
});

test('insertLineBreakInItem: 引用の中では > を続ける', () => {
  assert.equal(run(insertLineBreakInItem, '> quote| text'), '> quote\n> | text');
});

test('deleteItemMarkup: 最初の項目では記号をまとめて消し、続きの行では前の行とつなげる', () => {
  const { deleteItemMarkup } = blockCommands;
  assert.equal(run(deleteItemMarkup, '- [ ] |a\n- b'), '|a\n- b');
  assert.equal(run(deleteItemMarkup, '1. |a\n2. b'), '|a\n1. b');
  // 2 つ目以降の項目は CodeMirror に任せる（記号を空白にして、前の項目の続きの行にする）
  assert.equal(run(deleteItemMarkup, '- ba\n- |nana'), null);
  assert.equal(run(deleteItemMarkup, '- ba\n  |nana'), '- ba|nana');
  assert.equal(run(deleteItemMarkup, '- [ ] a\n      |\n- [ ] c'), '- [ ] a|\n- [ ] c');
  assert.equal(run(deleteItemMarkup, 'para\n|text'), null);
});

test('insertNewline: 閉じのフェンスを打って Enter を押すと、自動で入れた閉じのフェンスを消して外に出る', () => {
  assert.equal(run(insertNewline, '```\ncode\n```|\n```'), '```\ncode\n```\n|');
  assert.equal(run(insertNewline, '- ```\n  code\n  ```|\n  ```'), '- ```\n  code\n  ```\n  |');
  assert.equal(run(insertNewline, '> ```\n> code\n> ```|\n> ```'), '> ```\n> code\n> ```\n> |');
});

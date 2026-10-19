import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection } from '@codemirror/state';
import { markdownSupport } from '../webview/markdownSetup.js';
import { toggleInline } from '../webview/inlineFormat.js';
import { parsedState } from './parsedState.mjs';

/** [ と ] の間を選び（| ならカーソル）、marker で切り替えた結果を同じ書き方で返す */
function run(marker, text) {
  const cursor = text.indexOf('|');
  const from = cursor >= 0 ? cursor : text.indexOf('[');
  const to = cursor >= 0 ? cursor : text.indexOf(']') - 1;
  const doc = text.replace(/[|[\]]/g, '');
  let state = parsedState({ doc, selection: EditorSelection.range(from, to), extensions: [markdownSupport([])] });
  toggleInline(marker)({ state, dispatch: (tr) => { state = tr.state; } });
  const { from: f, to: t } = state.selection.main;
  const out = state.doc.toString();
  return f === t ? out.slice(0, f) + '|' + out.slice(f) : out.slice(0, f) + '[' + out.slice(f, t) + ']' + out.slice(t);
}

test('toggleInline: 選択範囲を囲み、太字の中身か全体を選んでいれば外す', () => {
  assert.equal(run('**', 'abc [word] def'), 'abc **[word]** def');
  assert.equal(run('**', 'abc **[word]** def'), 'abc [word] def');
  assert.equal(run('**', 'abc [**word**] def'), 'abc [word] def');
  // 太字の中身を選んで斜体にすると、太字かつ斜体になる（太字の記号の内側の * を斜体の記号と取り違えない）
  assert.equal(run('*', 'abc **[word]** def'), 'abc ***[word]*** def');
  assert.equal(run('*', 'abc *[word]* def'), 'abc [word] def');
});

test('toggleInline: 選択がないとき', () => {
  assert.equal(run('**', 'abc |'), 'abc **|**');
  // 2 回押すと元に戻る
  assert.equal(run('**', 'abc **|**'), 'abc |');
  // 太字の中身の末尾では、閉じの記号の後ろに出る
  assert.equal(run('**', 'abc **xy|**'), 'abc **xy**|');
  // 太字の中では外す
  assert.equal(run('**', 'abc **wo|rd** def'), 'abc wo|rd def');
  // 語の途中では語を囲む
  assert.equal(run('**', 'abc wo|rd def'), 'abc **wo|rd** def');
  assert.equal(run('**', '日本|語'), '日本**|**語');
});

test('adjustWordDeletion: 隠した記号の片方だけを消さない', async () => {
  const { adjustWordDeletion } = await import('../webview/inlineFormat.js');
  const { lineMarkup } = await import('../webview/blockEditing.js');
  const { nextBoundary } = await import('../webview/wordSegments.js');
  const wordAt = (text, pos, forward) => nextBoundary(text, pos, forward);
  const del = (doc, from, to, forward) => {
    const state = parsedState({ doc, extensions: [markdownSupport([])] });
    return state.update({ changes: adjustWordDeletion(state, from, to, forward, wordAt, lineMarkup) }).state.doc.toString();
  };
  // リンクの後ろから：閉じの記号だけでなく、リンクの文字の最後の語を消す
  // 中身の端に空白を残すと強調として成り立たないので、語の前の空白も消す
  assert.equal(del('see [two words](u)', 15, 18, false), 'see [two](u)');
  assert.equal(del('a **b c**', 7, 9, false), 'a **b**');
  // 中身がなくなるなら要素ごと
  assert.equal(del('a **b**', 6, 7, false), 'a ');
  // 後ろへの削除で開きの記号にかかるとき：中身の最初の語を消し、中身がなくなるなら要素ごと
  assert.equal(del('x **bold** y', 1, 4, true), 'x y');
  assert.equal(del('x **two words** y', 1, 4, true), 'x**words** y');
  // 項目の内容の先頭から：行頭の記号をまとめて消す
  assert.equal(del('- [ ] two', 4, 6, false), 'two');
  // 項目の末尾から：次の項目の記号も消す
  assert.equal(del('- a\n- b', 3, 4, true), '- ab');
});

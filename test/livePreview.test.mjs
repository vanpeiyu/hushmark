import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdownSupport } from '../webview/markdownSetup.js';
import { livePreview, setFocus } from '../webview/livePreview.js';
import { tableAt, toggleRawTable } from '../webview/tableWidget.js';
import { parsedState } from './parsedState.mjs';

function decorate(doc, cursor) {
  let state = parsedState({ doc, extensions: [markdownSupport(), livePreview()] });
  if (cursor !== undefined) {
    state = state.update({ selection: EditorSelection.cursor(cursor), effects: setFocus.of(true) }).state;
  }
  const out = [];
  for (const set of state.facet(EditorView.decorations)) {
    set.between(0, doc.length, (from, to, deco) => {
      const spec = deco.spec;
      out.push({
        from, to,
        kind: spec.widget ? spec.widget.constructor.name : (spec.class ? 'class' : 'hidden'),
        cls: spec.class,
        attributes: spec.attributes,
        block: !!spec.block,
      });
    });
  }
  // 装飾の集合をまたぐと位置の順にならないので並べ直す
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

const isConcealed = (d) => d.kind === 'class' && d.cls.split(' ').includes('cm-md-conceal');
/** 隠している記号（幅を残すものと消すものの両方） */
const hiddenTexts = (doc, decos) => decos.filter((d) => d.kind === 'hidden' || isConcealed(d)).map((d) => doc.slice(d.from, d.to));
/** 幅ごと消している記号 */
const collapsedTexts = (doc, decos) => decos.filter((d) => d.kind === 'hidden').map((d) => doc.slice(d.from, d.to));
const classTexts = (doc, decos, cls) => decos.filter((d) => d.kind === 'class' && d.cls.split(' ').includes(cls)).map((d) => doc.slice(d.from, d.to));

test('フォーカスがないときは見出しと強調の記号を隠す', () => {
  const doc = '# Title\n\n**bold** and `code`';
  assert.deepEqual(hiddenTexts(doc, decorate(doc)), ['#', '**', '**', '`', '`']);
});

test('カーソルのある行の記号は隠さず、ほかの行は隠す', () => {
  const doc = '# Title\n\n**bold**';
  const decos = decorate(doc, 3);
  assert.deepEqual(hiddenTexts(doc, decos), ['**', '**']);
  assert.deepEqual(classTexts(doc, decos, 'cm-md-mark'), ['#']);
});

test('インライン要素の記号は、その要素にカーソルがあるときだけ表示する', () => {
  const doc = 'a `code` と *em* と [link](https://x) の文。';
  // 同じ行でも、要素の外（文末）にカーソルがあれば隠したまま
  assert.deepEqual(hiddenTexts(doc, decorate(doc, doc.length)), ['`', '`', '*', '*', '[', '](https://x)']);
  // `code` の中にカーソルがあれば、その要素の記号だけ表示する
  assert.deepEqual(hiddenTexts(doc, decorate(doc, doc.indexOf('ode'))), ['*', '*', '[', '](https://x)']);
});

test('カーソルのない表はブロックのウィジェットに置き換える', () => {
  const doc = 'intro\n\n| a | b |\n|---|---|\n| 1 |  |\n\nafter';
  const table = decorate(doc, 0).find((d) => d.kind === 'TableWidget');
  assert.ok(table && table.block);
  assert.equal(doc.slice(table.from, table.to), '| a | b |\n|---|---|\n| 1 |  |');
});

test('カーソルが表に入っても、表は HTML のまま', () => {
  const doc = 'intro\n\n| a | b |\n|---|---|\n| 1 |  |\n\nafter';
  const decos = decorate(doc, doc.indexOf('| 1'));
  assert.ok(decos.some((d) => d.kind === 'TableWidget'));
});

test('「ソース」を選んだ表は、カーソルがある間だけソースを等幅で表示する', () => {
  const doc = 'intro\n\n| a | b |\n|---|---|\n| 1 |  |\n\nafter';
  const tableFrom = doc.indexOf('| a');
  const extensions = [markdownSupport(), livePreview()];
  let state = parsedState({ doc, extensions });
  state = state.update({
    selection: EditorSelection.cursor(tableFrom),
    effects: [setFocus.of(true), toggleRawTable.of(tableFrom)],
  }).state;
  const kinds = () => {
    const out = [];
    for (const set of state.facet(EditorView.decorations)) {
      set.between(0, doc.length, (_f, _t, deco) => out.push(deco.spec.widget ? deco.spec.widget.constructor.name : deco.spec.class));
    }
    return out;
  };
  assert.equal(kinds().filter((k) => k === 'cm-md-table-src').length, 3);
  assert.ok(!kinds().includes('TableWidget'));

  // 表から出たら HTML に戻り、もう一度入っても HTML のまま
  state = state.update({ selection: EditorSelection.cursor(doc.length) }).state;
  state = state.update({ selection: EditorSelection.cursor(tableFrom) }).state;
  assert.ok(kinds().includes('TableWidget'));
});

test('末尾のコードブロックはカーソルがなければフェンスを隠し、あれば表示する', () => {
  const doc = 'text\n\n```js\nconst a = 1;\n```';
  assert.deepEqual(hiddenTexts(doc, decorate(doc, 0)), ['```', '```']);
  assert.deepEqual(hiddenTexts(doc, decorate(doc, doc.length)), []);
});

test('言語名のある ``` は詰め、言語名のない ``` は幅を残す', () => {
  const doc = '```js\na\n```\n\n```\nb\n```';
  const decos = decorate(doc);
  assert.deepEqual(collapsedTexts(doc, decos), ['```']);
  assert.equal(decos.find((d) => d.kind === 'hidden').from, 0);
  assert.deepEqual(decos.filter(isConcealed).map((d) => doc.slice(d.from, d.to)), ['```', '```', '```']);
});

test('タスクはチェックボックスに、箇条書きは記号に置き換える', () => {
  const doc = '- [x] done\n- item\n\ntext';
  const decos = decorate(doc, doc.length);
  assert.equal(decos.filter((d) => d.kind === 'CheckboxWidget').length, 1);
  // 箇条書きの記号は文字を透明にして、その上に • を重ねる（幅を変えない）
  assert.deepEqual(classTexts(doc, decos, 'cm-md-bullet'), ['-']);
  // タスクの「- 」は幅を残して隠す
  assert.deepEqual(hiddenTexts(doc, decos), ['-']);
});

test('フロントマターの中は Markdown として装飾しない', () => {
  const doc = '---\ntitle: x\n---\n# H';
  const decos = decorate(doc);
  assert.deepEqual(hiddenTexts(doc, decos), ['#']);
  assert.equal(decos.filter((d) => d.cls === 'cm-md-frontmatter').length, 3);
});

test('箱を持たないインライン要素の記号は幅ごと隠し、ほかの記号は幅を残す', () => {
  const doc = '**bold** ~~del~~ \\* `c` [t](https://x) <https://y>\n\n> quote\n\n---\n\n```\ncode\n```';
  const decos = decorate(doc);
  assert.deepEqual(collapsedTexts(doc, decos), ['**', '**', '~~', '~~', '\\', '[', '](https://x)', '<', '>']);
  assert.deepEqual(decos.filter(isConcealed).map((d) => doc.slice(d.from, d.to)), ['`', '`', '>', '---', '```', '```']);
});

test('強調や取り消し線は記号の間にだけかけ、インラインコードの背景は ` の幅も含める', () => {
  const doc = '**bold** ~~del~~ `code`';
  const decos = decorate(doc);
  assert.deepEqual(classTexts(doc, decos, 'cm-md-strong'), ['bold']);
  assert.deepEqual(classTexts(doc, decos, 'cm-md-strike'), ['del']);
  assert.deepEqual(classTexts(doc, decos, 'cm-md-inline-code'), ['`code`']);
});

test('見出しの「# 」は、その幅と行の余白の分だけ左にずらしてぶら下げる', () => {
  const doc = '### Title\n\ntext';
  const decos = decorate(doc);
  const unfocused = decos.find((d) => d.kind === 'class' && d.cls.includes('cm-md-heading-mark'));
  assert.equal(doc.slice(unfocused.from, unfocused.to), '###');
  assert.equal(unfocused.attributes.style, 'margin-left: calc(-3ch - var(--md-line-pad) - var(--md-heading-space))');
  // 後ろの空白は「#」と分け、見出しの大きさのままにする（変換中の文字がここに入るため）
  assert.deepEqual(classTexts(doc, decos, 'cm-md-heading-space'), [' ']);
  assert.ok(unfocused.cls.includes('cm-md-conceal'));
  // カーソルがあれば記号を出し、行に印を付けて飾り（◆ など）を消す
  const focused = decorate(doc, 5);
  assert.ok(focused.find((d) => d.kind === 'class' && d.cls.includes('cm-md-heading-mark')).cls.includes('cm-md-mark'));
  assert.ok(focused.some((d) => d.kind === 'class' && d.cls.includes('cm-md-heading-active')));
});

test('タスクのチェックボックスは [ ] と同じ幅にする', () => {
  const doc = '- [ ] todo';
  const box = decorate(doc).find((d) => d.kind === 'CheckboxWidget');
  assert.equal(doc.slice(box.from, box.to), '[ ]');
});

test('日本語の文で、約物の内側にある ** や ~~ も強調にする', () => {
  const cases = [
    ['これは **注意（readme.md 参照）。**の件です', 'cm-md-strong', '注意（readme.md 参照）。'],
    ['これは**「重要」**です', 'cm-md-strong', '「重要」'],
    ['これは*「斜体」*です', 'cm-md-em', '「斜体」'],
    ['これは~~「取り消し」~~です', 'cm-md-strike', '「取り消し」'],
    // 外側が数字や英字でも、内側が日本語の約物なら強調にする
    ['**重要。**2つ目', 'cm-md-strong', '重要。'],
    ['上限は100**「件」**です', 'cm-md-strong', '「件」'],
    ['**「注意」**3点', 'cm-md-strong', '「注意」'],
    ['**完了。**OK', 'cm-md-strong', '完了。'],
  ];
  for (const [doc, cls, text] of cases) assert.deepEqual(classTexts(doc, decorate(doc), cls), [text], doc);
});

test('英語の文の強調の規則は変えない', () => {
  // 単語の中の _ は強調にしない。前後が英字の ** は強調にする
  assert.deepEqual(classTexts('snake_case_name', decorate('snake_case_name'), 'cm-md-em'), []);
  assert.deepEqual(classTexts('a**b**c', decorate('a**b**c'), 'cm-md-strong'), ['b']);
  // 外側が英字で内側が約物のときは、CommonMark どおり強調にしない
  assert.deepEqual(classTexts('a**"b"**c', decorate('a**"b"**c'), 'cm-md-strong'), []);
});

test('「##」だけの行は見出しの見た目にせず、「## 」から見出しにする', () => {
  for (const doc of ['##', 'text\n\n##']) {
    const decos = decorate(doc, doc.length);
    assert.ok(!decos.some((d) => d.kind === 'class' && d.cls.includes('cm-md-heading')), doc);
    assert.deepEqual(hiddenTexts(doc, decos), [], doc);
  }
  for (const doc of ['## ', '## 見出し']) {
    const decos = decorate(doc, doc.length);
    assert.ok(decos.some((d) => d.kind === 'class' && d.cls.includes('cm-md-h2')), doc);
  }
});

test('参照リンクは、文書の中に定義があるときだけリンクにする', () => {
  // 定義がなければ CommonMark でもただの文字。記号も隠さない
  let doc = '[foo] の文';
  let decos = decorate(doc, doc.length);
  assert.deepEqual(classTexts(doc, decos, 'cm-md-link'), []);
  assert.deepEqual(hiddenTexts(doc, decos), []);
  // 定義があればリンクにする。ラベルは大文字と小文字、空白の違いを無視して比べる
  doc = '[foo] と [Text][ B  ar ] の文\n\n[FOO]: https://x.example\n[b ar]: <https://y.example>';
  decos = decorate(doc, doc.length);
  assert.deepEqual(classTexts(doc, decos, 'cm-md-link'), ['foo', 'Text']);
  assert.deepEqual(hiddenTexts(doc, decos), ['[', ']', '[', '][ B  ar ]']);
  assert.equal(decos.find((d) => d.cls === 'cm-md-link' && doc.slice(d.from, d.to) === 'Text').attributes['data-href'], 'https://y.example');
  // 定義のない [ ] の中の強調はそのまま描く
  doc = '[**x**] の文';
  assert.deepEqual(classTexts(doc, decorate(doc, doc.length), 'cm-md-strong'), ['x']);
});

test('見出しの「#」の後ろの空白は、文字があってもなくても同じ並びにする', () => {
  // 空白を広く描いて行の余白を取るので、並びを分ける印は付けない
  for (const doc of ['## 見出し', '## ']) {
    const decos = decorate(doc, doc.length);
    assert.deepEqual(classTexts(doc, decos, 'cm-md-heading-space'), [' '], doc);
    assert.ok(!decos.some((d) => d.kind === 'class' && /-pad\b|space-shown/.test(d.cls)), doc);
  }
});

test('tableAt: 引用・リスト・字下げの中の表も、行頭の位置から見つける', () => {
  for (const doc of ['|a|b|\n|-|-|\n|1|2|', '  |a|b|\n  |-|-|\n  |1|2|', '> |a|b|\n> |-|-|\n> |1|2|', '- |a|b|\n  |-|-|\n  |1|2|']) {
    const state = parsedState({ doc, extensions: [markdownSupport()] });
    const table = tableAt(state, 0);
    assert.ok(table, doc);
    assert.deepEqual([table.from, table.to], [0, doc.length], doc);
  }
});

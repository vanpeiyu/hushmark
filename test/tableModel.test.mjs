import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTableModel, cellChange, escapePipes, nowrapColumns, parseAlignments, splitRow } from '../webview/tableModel.js';

test('escapePipes: 素の | だけをエスケープする', () => {
  assert.equal(escapePipes('a|b'), String.raw`a\|b`);
  assert.equal(escapePipes(String.raw`a\|b`), String.raw`a\|b`);
  assert.equal(escapePipes('||'), String.raw`\|\|`);
  assert.equal(escapePipes('末尾\\'), '末尾\\');
});

test('buildTableModel: ソースに無いセルには missing と行末のパイプの有無を付ける', () => {
  const model = buildTableModel([
    { text: '| h1 | h2 |', from: 0 },
    { text: '|---|---|', from: 12 },
    { text: '| only |', from: 22 },
    { text: 'x', from: 31 },
  ]);
  assert.deepEqual(
    [model.rows[1][1], model.rows[2][1]].map(({ missing, pipeAtEnd, from }) => ({ missing, pipeAtEnd, from })),
    [{ missing: true, pipeAtEnd: true, from: 30 }, { missing: true, pipeAtEnd: false, from: 32 }],
  );
});

test('splitRow: 前後のパイプ、空のセル、エスケープしたパイプ', () => {
  const row = String.raw`| a | | b \| c |`;
  const cells = splitRow(row, 100);
  assert.deepEqual(cells.map((c) => c.text), ['a', '', String.raw`b \| c`]);
  assert.equal(row.slice(cells[0].from - 100, cells[0].to - 100), 'a');
  assert.equal(cells[1].from, cells[1].to);
  assert.equal(row.slice(cells[2].from - 100, cells[2].to - 100), String.raw`b \| c`);
});

test('splitRow: 前後のパイプがない行', () => {
  assert.deepEqual(splitRow('a | b').map((c) => c.text), ['a', 'b']);
});

test('parseAlignments', () => {
  assert.deepEqual(parseAlignments('|:--|:-:|--:|---|'), ['left', 'center', 'right', null]);
});

test('buildTableModel: 列数を見出しにそろえる', () => {
  const model = buildTableModel([
    { text: '| h1 | h2 |', from: 0 },
    { text: '|---|---|', from: 12 },
    { text: '| only |', from: 22 },
    { text: '| x | y | extra |', from: 31 },
  ]);
  assert.deepEqual(model.rows.map((r) => r.map((c) => c.text)), [['h1', 'h2'], ['only', ''], ['x', 'y']]);
});

test('nowrapColumns: 短いセルしかない列だけ折り返さない', () => {
  const model = buildTableModel([
    { text: '| 項目 | 備考 |', from: 0 },
    { text: '|---|---|', from: 0 },
    { text: '| りんご | セルの中で折り返す長い備考です |', from: 0 },
  ]);
  assert.deepEqual(nowrapColumns(model), [true, false]);
});

/** 表のソースの行を組み立て、cellChange の結果を当てた後のソースを返す（テスト用） */
function writeCell(lines, row, col, text) {
  const source = lines.join('\n');
  let offset = 0;
  const model = buildTableModel(lines.map((line) => {
    const entry = { text: line, from: offset };
    offset += line.length + 1;
    return entry;
  }));
  const cell = model.rows[row][col];
  const change = cellChange(model, row, col, text, source.slice(cell.to, cell.to + 1));
  return change ? source.slice(0, change.from) + change.insert + source.slice(change.to) : source;
}

test('cellChange: 省略されたセルに書くと、手前の省略されたセルも補う', () => {
  const lines = ['| h1 | h2 | h3 |', '|---|---|---|', '| a |'];
  assert.equal(writeCell(lines, 1, 2, 'X').split('\n')[2], '| a |  | X |');
  assert.equal(writeCell(lines, 1, 1, 'Y').split('\n')[2], '| a | Y |');
  // 行末に | が無い行
  assert.equal(writeCell(['| h1 | h2 | h3 |', '|---|---|---|', '| a'], 1, 2, 'X').split('\n')[2], '| a |  | X |');
});

test('cellChange: 中身が \\ で終わり、すぐ後ろが | なら空白を挟み、区切りを残す', () => {
  const written = writeCell(['|h|i|', '|---|---|', '|a|b|'], 1, 0, 'a\\');
  assert.equal(written.split('\n')[2], '|a\\ |b|');
  assert.deepEqual(splitRow(written.split('\n')[2]).map((c) => c.text), ['a\\', 'b']);
  // \\ で終わる（\ が偶数個）ときは区切りを消さないので、空白を挟まない
  assert.equal(writeCell(['|h|i|', '|---|---|', '|a|b|'], 1, 0, 'a\\\\').split('\n')[2], '|a\\\\|b|');
});

test('cellChange: 前後の空白は書き込まない（入力のたびに空白が増えない）', () => {
  const lines = ['| h |', '|---|', '| a |'];
  assert.equal(writeCell(lines, 1, 0, 'a '), lines.join('\n'));
  assert.equal(writeCell(lines, 1, 0, ' a b ').split('\n')[2], '| a b |');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutColumns, naturalWidth, wrapSegments } from '../webview/tableLayout.js';
import { displayWidth } from '../webview/textWidth.js';

// テストでは 1 桁 = 1 とし、セルの中身をブラウザーの日本語の折り返しに近い規則で単位に分ける
// （英数字の連続は 1 語、全角は 1 文字ずつ、句読点や閉じ括弧は前の文字に付ける）
const NO_START = new Set([...'、。，．）」』】〉》〕］｝！？：；・…‥ゝゞヽヾ々,.)]}!?:;%']);
const NO_END = new Set([...'（「『【〈《〔［｛([{']);
const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function segmentsOf(text) {
  const out = [];
  for (const { segment: g } of seg.segment(text.trim())) {
    const w = displayWidth(g);
    const last = out[out.length - 1];
    if (g === ' ') { if (last) last.space += 1; continue; }
    const glue = last && last.space === 0 && ((w === 1 && last.narrow) || NO_START.has(g) || NO_END.has(last.text.slice(-1)));
    if (glue) { last.text += g; last.w += w; last.graphemes.push(w); last.narrow = last.narrow && w === 1; }
    else out.push({ text: g, w, space: 0, graphemes: [w], narrow: w === 1 });
  }
  return out;
}
const layout = (rows, W) => {
  const n = rows[0].length;
  return layoutColumns(rows.map((r) => r.map((t) => ({ segments: segmentsOf(t ?? '') }))), W - (3 * n + 1), 1);
};

test('wrapSegments: 単位を詰めて折り返し、単位より狭い列では文字の間で折る', () => {
  assert.equal(wrapSegments(segmentsOf('HTML の表に任せる'), 8).lines, 3);
  assert.equal(wrapSegments(segmentsOf('code --install-extension hushmark-0.4.0.vsix'), 24).lines, 2);
  assert.equal(wrapSegments(segmentsOf('abcdefghij'), 4).lines, 3);
  assert.equal(naturalWidth(segmentsOf('a b  c')), 6);
});

test('収まる表は、どの列も最大の幅にする', () => {
  assert.deepEqual(layout([['スタイル', '見出し'], ['soft', '帯と色']], 88), [8, 6]);
});

test('収まらない表は、高さと短いセルの折り返しが少ない配分にする', () => {
  // 回答から作った規則（サンプルの C02）。中くらいの列を折り返さず、長い列から幅を回す
  assert.deepEqual(layout([
    ['項目', '現状', '提案', '理由'],
    ['列の幅', 'HTML の表に任せる', '各セルの中身を測って配分する', '行ごとに別の要素になるので、ブラウザーが列をそろえないため。長いセルがあっても、短い列は折り返さないようにする'],
    ['選択', 'セルをまたげない', 'ソースの順の範囲で選ぶ', 'テキストエディタと同じ動作にするため'],
    ['IME', 'セル用のエディタで入力', '本文と同じ', '本文と同じ仕組みで入力できるので、変換中の文字の扱いがそろう'],
  ], 88), [6, 17, 14, 38]);
});

test('余った幅は、配っても折り返す位置が変わらない列には配らない', () => {
  // サンプルの C06。コマンドの列は「code --install-extension」で折り返すしかないので、余りは説明の列へ
  assert.deepEqual(layout([
    ['コマンド', '説明'],
    ['npm run build', 'webview/ を media/dist/ にまとめ、同梱したパッケージのライセンス文を書き出す'],
    ['npm run test:e2e -- all', 'E2E テストを、編集・表・検索・同期の full と、readonly と restore の順に実行する'],
    ['npm run package', '.vsix を作る'],
    ['code --install-extension hushmark-0.4.0.vsix', '手元の VS Code に .vsix をインストールする'],
  ], 88), [24, 57]);
});

test('長さが同じラベルの列は、同じ幅にする', () => {
  const widths = layout([
    ['機能', '0.3', '0.4', 'Web 版', '説明'],
    ['複数カーソル', '[未対応]', '[対応中]', '[未対応]', 'Ctrl+D と Alt+クリックで、カーソルを足す。表の中でも本文と同じく動く'],
    ['折りたたみ', '[未対応]', '[予定]', '[予定]', '見出し、リスト、コードブロックを折りたたむ。Markdown の拡張機能が返す範囲を使う'],
    ['診断の波線', '[未対応]', '[対応中]', '[対応中]', 'cSpell や markdownlint の診断を、本文に波線で表示する'],
  ], 70);
  assert.equal(widths[1], widths[2]);
  assert.equal(widths[2], widths[3]);
});

test('列が多い表でも、決まった時間で配分を返す', () => {
  const cell = (i) => `項目 ${i} の説明です。少し長めの文にして、どの列も折り返すようにする`;
  const rows = [Array.from({ length: 10 }, (_, i) => `列${i}`), ...Array.from({ length: 30 }, (_, r) => Array.from({ length: 10 }, (_, i) => cell(r + i)))];
  const start = performance.now();
  const widths = layout(rows, 120);
  assert.equal(widths.length, 10);
  assert.ok(widths.reduce((s, w) => s + w, 0) <= 120 - 31);
  assert.ok(performance.now() - start < 2000, `${performance.now() - start} ms`);
});

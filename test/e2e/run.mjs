// 実際の VSCode 上で、編集・取り消し・表・外部変更の同期を確かめる（Linux の CI で実行するもの）。
// 使い方: npm run test:e2e -- full
// ショートカットの Ctrl は、macOS では Cmd で押す（MOD）。
// 開いたファイルは途中で何度も書き換える。

import { ALT, MOD, SHIFT, click, isMac, press, sleep, type } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { openSession } from './session.mjs';

const {
  file, remote, cdp, mainCtx, web, check, finish, toPage, clickPos, clickSelector, clickTableTool,
  webDoc, readFile, writeFile, loadDoc, checkInSync,
} = await openSession();

const original = await webDoc();
check('初期表示: ファイルと表示が一致', original === readFile().replace(/\r\n/g, '\n'));

// 縦の位置はソースの行に合わせる。見出しの行は本文の行の整数倍、表はソースの行数分の高さにする
const heights = JSON.parse(await web(`JSON.stringify((() => {
  const line = __hushmarkView.defaultLineHeight;
  const headings = [...document.querySelectorAll('.cm-md-heading')].map((e) => e.getBoundingClientRect().height / line);
  const table = document.querySelector('.cm-md-table-wrap').getBoundingClientRect().height / line;
  return { line, headings, table };
})())`));
check('見出しの行の高さは本文の行の整数倍', heights.headings.length > 0 &&
  heights.headings.every((h) => Math.abs(h - Math.round(h)) < 0.02), heights);
check('表の高さはソースの行数分（4 行）', Math.abs(heights.table - 4) < 0.02, heights);

// 1. 段落の末尾に追記して、取り消し・やり直し
const line3End = await web('__hushmarkView.state.doc.line(3).to');
await clickPos(line3End);
// 行末をクリックしても、行の中の `code` や *斜体* の記号は出さない（行の幅が変わらない）
const visibleMarks = () => web("[...document.querySelectorAll('.cm-md-mark')].map((e) => e.textContent).join(' ')");
check('行末をクリック: 行の中のインライン要素の記号は出さない', (await visibleMarks()) === '', await visibleMarks());
const codePos = await web("__hushmarkView.state.doc.toString().indexOf('code`')");
await clickPos(codePos + 2);
check('`code` の中をクリック: その要素の記号だけ出す', (await visibleMarks()) === '` `', await visibleMarks());

// 記号を出しても隠しても、文字の位置は動かない（隠す記号は透明にして幅を残し、見出しの「# 」は左にぶら下げる）
const leftOf = (pos) => web(`Math.round(__hushmarkView.coordsAtPos(${pos}).left)`);
const afterCode = await web("__hushmarkView.state.doc.toString().indexOf('と [リンク]')");
const headingText = 2; // 「# 見出し1」の「見」
const shownCode = await leftOf(afterCode);
await clickPos(line3End);
const hiddenCode = await leftOf(afterCode);
const hiddenHeading = await leftOf(headingText);
check('`code` の記号を隠しても、後ろの文字は動かない', shownCode === hiddenCode, { shownCode, hiddenCode });
await clickPos(headingText + 1);
const shownHeading = await leftOf(headingText);
check('見出しの「# 」を出しても、見出しの文字は動かない', shownHeading === hiddenHeading, { shownHeading, hiddenHeading });
await clickPos(line3End);
await type(cdp, '追記');
await sleep(100);
await type(cdp, 'した');
let doc = await checkInSync('追記');
check('追記: 段落の末尾に入った', doc.split('\n')[2].endsWith('があります。追記した'), doc.split('\n')[2]);

await press(cdp, 'z', MOD);
await sleep(200);
doc = await checkInSync('Ctrl+Z');
check('Ctrl+Z: 追記が消えた', doc === original, doc.split('\n')[2]);

await press(cdp, 'y', MOD);
await sleep(200);
doc = await checkInSync('Ctrl+Y');
check('Ctrl+Y: 追記が戻った', doc.split('\n')[2].endsWith('追記した'), doc.split('\n')[2]);

await press(cdp, 'z', MOD | SHIFT);
await press(cdp, 'z', MOD);
await sleep(200);
doc = await checkInSync('もう一度 Ctrl+Z');
check('もう一度 Ctrl+Z: 元に戻った', doc === original);

// カーソルのある行に背景を付ける（editor.renderLineHighlight の既定は line）
await clickPos(line3End);
const highlighted = () => web("JSON.stringify([...document.querySelectorAll('.cm-md-active-line')].filter((e) => getComputedStyle(e).backgroundImage !== 'none').map((e) => e.textContent.slice(0, 6)))").then(JSON.parse);
const activeLines = await highlighted();
check('カーソルのある行に背景を付ける', activeLines.length === 1 && activeLines[0].startsWith('本文に'), activeLines);

// VSCode の 2 つ打ちのキー（Ctrl+K M = 言語モードの選択）の 2 つ目のキーを、文字として入力しない
await clickPos(line3End);
await press(cdp, 'k', MOD);
await press(cdp, 'm');
await sleep(500);
const quickPickOpen = () => cdp.evaluateIn(mainCtx, "(() => { const w = document.querySelector('.quick-input-widget'); return !!w && getComputedStyle(w).display !== 'none'; })()");
check('Ctrl+K M: 2 つ目のキーの文字は入らない', (await webDoc()) === original, (await webDoc()).split('\n')[2]);
check('Ctrl+K M: VSCode の操作（言語モードの選択）は動く', await quickPickOpen());
await press(cdp, 'Escape');
await sleep(300);
await clickPos(line3End);
await type(cdp, 'm');
await sleep(150);
doc = await webDoc();
check('Ctrl+K M の後: 次のキーからはふつうに入力できる', doc.split('\n')[2].endsWith('があります。m'), doc.split('\n')[2]);
await press(cdp, 'Backspace');
await sleep(150);
doc = await checkInSync('Ctrl+K M の後');

// 2. 表: 触ったセルだけが小さなエディタになり、表そのものは HTML のまま
const tableState = () => web(`(() => {
  const input = document.querySelector('.cm-md-cell-input');
  const cell = input && input.closest('th, td');
  return {
    tables: document.querySelectorAll('.cm-md-table').length,
    source: document.querySelectorAll('.cm-md-table-src').length,
    inputs: document.querySelectorAll('.cm-md-cell-input').length,
    value: input ? input.mdCellView.state.doc.toString() : null,
    row: cell ? Number(cell.dataset.row) : null,
    col: cell ? Number(cell.dataset.col) : null,
    focused: !!input && input.contains(document.activeElement),
    strong: document.querySelectorAll('.cm-md-table strong').length,
  };
})()`);

check('表: カーソルがなければ HTML の表', (await tableState()).tables === 1);
await clickSelector('.cm-md-table td', 1); // 「120」
let ts = await tableState();
check('表: クリックしたセルだけが入力欄になる', ts.tables === 1 && ts.source === 0 && ts.inputs === 1 && ts.value === '120' && ts.focused, ts);
check('表のセルの編集中は、本文の行の背景を出さない', (await highlighted()).length === 0, await highlighted());
const cellCaretColor = await web("getComputedStyle(document.querySelector('.cm-md-cell-input .cm-line')).caretColor");
check('表のセルの編集中は、カーソルが見える（透明でない）', !/rgba\(0, 0, 0, 0\)|transparent/.test(cellCaretColor), cellCaretColor);
// クリックした位置にカーソルが入るので、末尾に動かしてから打つ
await press(cdp, 'End');
await type(cdp, '0');
doc = await checkInSync('表のセル編集');
check('表のセル編集: 文書に反映された', doc.includes('| りんご | 1200 |'), doc.split('\n')[8]);
ts = await tableState();
check('表のセル編集: 保存の後も同じセルを編集中', ts.inputs === 1 && ts.value === '1200' && ts.focused, ts);

await press(cdp, 'Tab');
ts = await tableState();
check('Tab: 次のセルはソース（**旬**）のまま入力欄に出る', ts.value === '**旬**' && ts.col === 2, ts);
await type(cdp, '旬!');
doc = await checkInSync('Tab で次のセル');
check('Tab: 次のセルの内容を選択して置き換えた', doc.split('\n')[8] === '| りんご | 1200 | 旬! |', doc.split('\n')[8]);

await press(cdp, 'Tab', SHIFT);
await type(cdp, '99');
doc = await checkInSync('Shift+Tab');
check('Shift+Tab: 前のセルに戻った', doc.split('\n')[8] === '| りんご | 99 | 旬! |', doc.split('\n')[8]);

for (let i = 0; i < 5; i++) await press(cdp, 'Tab');
await type(cdp, 'ぶどう');
doc = await checkInSync('最後のセルで Tab');
check('最後のセルで Tab: 行が増えて先頭のセルに入った', doc.split('\n')[10] === '| ぶどう |  |  |', doc.split('\n').slice(8, 12));

await sleep(600); // 取り消しの単位を分ける
await type(cdp, '|x');
doc = await checkInSync('セルに | を打つ');
check('セルに | を打つ: \\| にエスケープされる', doc.split('\n')[10] === '| ぶどう\\|x |  |  |', doc.split('\n')[10]);

await press(cdp, 'z', MOD);
await sleep(200);
doc = await checkInSync('セルの中で Ctrl+Z');
ts = await tableState();
check('セルの中で Ctrl+Z: 取り消せて、入力欄も戻る', doc.split('\n')[10] === '| ぶどう |  |  |' && ts.value === 'ぶどう' && ts.focused, { line: doc.split('\n')[10], ts });
// セルの途中で打って取り消すと、カーソルは取り消したところに戻る（セルの先頭に戻らない）
const undoCellCaret = () => web("document.querySelector('.cm-md-cell-input').mdCellView.state.selection.main.head");
await press(cdp, 'Home');
await press(cdp, 'ArrowRight');
await sleep(600); // 取り消しの単位を分ける
await type(cdp, 'x');
await sleep(300);
await press(cdp, 'z', MOD);
await sleep(300);
const undoCaret = await undoCellCaret();
check('セルの途中で打って Ctrl+Z: カーソルは取り消したところ', undoCaret === 1 && (await tableState()).value === 'ぶどう', undoCaret);
await press(cdp, 'End');

await press(cdp, 'Escape');
await sleep(150);
ts = await tableState();
check('Escape: 編集をやめて表の下の行に出る', ts.inputs === 0 && (await web('__hushmarkView.hasFocus && __hushmarkView.state.doc.lineAt(__hushmarkView.state.selection.main.head).number')) === 12, ts);

await press(cdp, 'ArrowUp');
await sleep(200);
ts = await tableState();
check('下の行から ↑: 表の最後の行のセルを編集する', ts.inputs === 1 && ts.row === 3 && ts.col === 0 && ts.focused, ts);
await press(cdp, 'Escape');

await clickTableTool(1); // ＋列
await type(cdp, '新列');
doc = await checkInSync('＋列');
check('＋列: 右端に列が増えて見出しを編集できる', doc.split('\n')[6] === '| 項目 | 値 | 備考 | 新列 |' && doc.split('\n')[7] === '|:--|--:|---|---|', doc.split('\n').slice(6, 8));
await press(cdp, 'Escape');

await clickTableTool(2); // ソース
ts = await tableState();
check('ソース: 表全体をソースで表示する', ts.tables === 0 && ts.source === 5, ts);

// 3. ファイル末尾のコードブロックの後ろに書く。末尾付近で打っても位置がずれない
await clickPos(await web('__hushmarkView.state.doc.length'));
check('末尾: 表はカーソルが離れると HTML に戻る', (await tableState()).tables === 1);
await type(cdp, 'コードの後');
await press(cdp, 'Enter');
for (const word of ['一', '二', '三']) {
  await type(cdp, word);
  await press(cdp, 'Enter');
}
await press(cdp, 'Backspace');
await press(cdp, 'ArrowUp');
await press(cdp, 'End');
await type(cdp, '中');
doc = await checkInSync('末尾の入力');
// 三 の後の空行を Backspace で消し、上の行（二）の末尾に戻って打つ
check('末尾の入力: 打った位置のとおり', doc.endsWith('```\nコードの後\n一\n二中\n三'), doc.slice(-40));

// 4. チェックボックスのクリック
await clickSelector('.cm-md-checkbox', 0);
doc = await checkInSync('チェックボックス');
check('チェックボックス: [ ] が [x] になった', doc.includes('- [x] 未完了タスク'));

// 5. 検索（Ctrl+F / Ctrl+H）は VSCode のエディタの検索ウィジェットと同じ操作
const findState = async () => JSON.parse(await web(`JSON.stringify({
  open: !!document.querySelector('.cm-md-find'),
  value: document.querySelector('.cm-md-find-input')?.value ?? null,
  focused: !!document.activeElement?.closest('.cm-md-find'),
  count: document.querySelector('.cm-md-find-count')?.textContent ?? null,
  selected: __hushmarkView.state.sliceDoc(__hushmarkView.state.selection.main.from, __hushmarkView.state.selection.main.to),
  replaceShown: !!document.querySelector('.cm-md-find-replace-row:not([hidden])'),
  caseOn: document.querySelector('.cm-md-find-toggle')?.getAttribute('aria-pressed') === 'true',
  tableCurrent: document.querySelectorAll('.cm-md-cell-match-current').length,
})`));
const selectText = (text) => web(`(() => { const v = __hushmarkView; const f = v.state.doc.toString().indexOf(${JSON.stringify(text)}); v.focus(); v.dispatch({ selection: { anchor: f, head: f + ${text.length} } }); })()`);

await clickPos(0);
await selectText('みかん');
await press(cdp, 'f', MOD);
await sleep(300);
let fs1 = await findState();
check('Ctrl+F: 選択中の文字列を検索語にして、入力欄にフォーカスする', fs1.open && fs1.value === 'みかん' && fs1.focused && fs1.count === '1 / 1', fs1);
check('Ctrl+F: 表の中の一致はセルに色を付ける', fs1.tableCurrent === 1, fs1);

await press(cdp, 'a', MOD);
await type(cdp, 'ん');
await sleep(300);
const total = (await webDoc()).split('ん').length - 1;
fs1 = await findState();
check('検索語を打つ: 最初の一致に移り、件数を出す', fs1.selected === 'ん' && fs1.count.endsWith(`/ ${total}`), { fs1, total });
const firstIndex = Number(fs1.count.split(' / ')[0]);
await press(cdp, 'Enter');
await sleep(150);
fs1 = await findState();
check('Enter: 次の一致に移る', Number(fs1.count.split(' / ')[0]) === (firstIndex % total) + 1, fs1);
await press(cdp, 'Enter', SHIFT);
await sleep(150);
fs1 = await findState();
check('Shift+Enter: 前の一致に戻る', Number(fs1.count.split(' / ')[0]) === firstIndex, fs1);

// 検索の条件の切り替えは、macOS では Cmd+Option+C など（VSCode と同じ）
const TOGGLE = isMac ? MOD | ALT : ALT;
await press(cdp, 'c', TOGGLE);
await sleep(100);
check('Alt+C: 大文字と小文字の区別を切り替える', (await findState()).caseOn);
await press(cdp, 'c', TOGGLE);

await press(cdp, 'a', MOD);
await type(cdp, 'みかん');
// 置換は、macOS では Cmd+Option+F（Cmd+H はアプリを隠す操作）
if (isMac) await press(cdp, 'f', MOD | ALT);
else await press(cdp, 'h', MOD);
await sleep(150);
fs1 = await findState();
check('Ctrl+H: 置換の欄が出る', fs1.replaceShown && fs1.focused, fs1);
await type(cdp, 'ミカン');
await press(cdp, 'Enter'); // 置換の欄で Enter は 1 件置換
await sleep(300);
doc = await checkInSync('置換');
check('置換の欄で Enter: 一致を置き換える', doc.includes('ミカン') && !doc.includes('みかん'), doc.split('\n').filter((l) => l.includes('カン')));

await press(cdp, 'Escape');
await sleep(150);
fs1 = await findState();
check('Esc: 検索を閉じてエディタにフォーカスを戻す', !fs1.open && (await web('__hushmarkView.hasFocus')), fs1);

// 5b. Ctrl+Shift+F は VSCode のフォルダー内の検索。選択中の文字列を検索語にする
await selectText('りんご');
await press(cdp, 'f', MOD | SHIFT);
let searchView = null;
for (let i = 0; i < 30; i++) {
  await sleep(200);
  searchView = JSON.parse(await cdp.evaluateIn(mainCtx, `JSON.stringify({
    value: document.querySelector('.search-view .search-widget textarea')?.value ?? null,
    focused: !!document.activeElement?.closest('.search-view'),
    rows: [...document.querySelectorAll('.search-view .monaco-list-row')].filter((r) => r.textContent.includes('りんご')).length,
  })`));
  if (searchView.rows > 0) break;
}
check('Ctrl+Shift+F: 選択中の文字列で検索し、検索ビューにフォーカスする', searchView.value === 'りんご' && searchView.focused && searchView.rows > 0, searchView);

// 検索結果をダブルクリックして開くと、エディタにフォーカスが入る（キーを打てる）
const row = JSON.parse(await cdp.evaluateIn(mainCtx, `JSON.stringify((() => { const row = [...document.querySelectorAll('.search-view .monaco-list-row')].find((r) => r.textContent.includes('りんご')); const b = row.getBoundingClientRect(); return { x: b.left + 80, y: b.top + b.height / 2 }; })())`));
for (const [t, c] of [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]]) {
  await cdp.send('Input.dispatchMouseEvent', { type: t, x: row.x, y: row.y, button: 'left', clickCount: c });
}
await sleep(800);
check('検索結果をダブルクリック: エディタにフォーカスが入る', await web('__hushmarkView.hasFocus'), await web('document.activeElement.className'));

// 6. 外部でファイルを書き換えると表示に反映される
await sleep(300);
const disk = readFile();
writeFile(disk.replace('# 見出し1', '# 外部で変えた見出し'));
let reflected = false;
for (let i = 0; i < 30 && !reflected; i++) {
  await sleep(200);
  reflected = (await webDoc()).startsWith('# 外部で変えた見出し');
}
check('外部変更: 表示に反映された', reflected);

// 6-2. 未保存の変更があるときに外でファイルを書き換えると、読み込まずに通知し、「Revert File」で読み込む
const diskToast = () => cdp.evaluateIn(mainCtx, `(() => {
  const toast = [...document.querySelectorAll('.notifications-toasts .notification-toast')].find((t) => t.textContent.includes('was changed on disk'));
  const button = toast && [...toast.querySelectorAll('.monaco-button')].find((b) => b.textContent.trim() === 'Revert File');
  if (!button) return null;
  const r = button.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
const isDirty = () => cdp.evaluateIn(mainCtx, "!!document.querySelector('.tab.active.dirty')");
async function waitUntil(read, timeoutMs = 6000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(200)) {
    const value = await read();
    if (value) return value;
  }
  return null;
}

// 自分の保存の直後に入力して未保存の変更がある状態になっても、自分の保存では通知しない
await clickPos(await web('__hushmarkView.state.doc.line(1).to'));
await type(cdp, 'A');
await press(cdp, 's', MOD);
await type(cdp, 'B');
await sleep(2000);
check('外部変更（未保存）: 自分の保存では通知しない', !(await diskToast()));
// B は保存に含まれることがあるので、未保存の変更を確実に作る
await type(cdp, 'C');
await sleep(300);
check('外部変更（未保存）: 未保存の変更がある', await isDirty());

const unsavedDoc = await webDoc();
const changedOnDisk = readFile().replace(/^# [^\r\n]*/, '# ディスクで変えた見出し');
writeFile(changedOnDisk);
let toastButton = await waitUntil(diskToast);
check('外部変更（未保存）: 通知する', toastButton);
// 通知はスライドして出てくるので、止まってから押す
await sleep(1000);
toastButton = await diskToast();
check('外部変更（未保存）: 表示は未保存の内容のまま', (await webDoc()) === unsavedDoc);
if (toastButton) {
  await click(cdp, toastButton.x, toastButton.y);
  const reverted = await waitUntil(async () => (await webDoc()) === changedOnDisk.replace(/\r\n/g, '\n'));
  check('外部変更（未保存）: Revert File でディスクの内容を読み込む', reverted, (await webDoc()).slice(0, 80));
  check('外部変更（未保存）: 読み込んだ後は未保存の変更がない', !(await isDirty()));
}


// 7. 改行なしでコードブロックが終わるファイルでも、その後ろに書ける
const endsWithFence = ['# 末尾', '', '```js', 'x', '```'];
writeFile(endsWithFence.join('\r\n'));
reflected = false;
for (let i = 0; i < 30 && !reflected; i++) {
  await sleep(200);
  reflected = (await webDoc()) === endsWithFence.join('\n');
}
check('末尾が ``` のファイル: 読み込めた', reflected);
await clickPos(await web('__hushmarkView.state.doc.length'));
await press(cdp, 'Enter');
await type(cdp, '後ろに書ける');
doc = await checkInSync('末尾が ``` のファイル');
check('末尾が ``` のファイル: コードブロックの後ろに書けた', doc.endsWith('```\n後ろに書ける'), doc);
check('末尾が ``` のファイル: 書いた行はコードブロックの外', await web("[...document.querySelectorAll('.cm-line')].pop().className.includes('cm-md-codeblock') === false"));

// 8. IME の変換中の入力（見出しの行と、太字の中）
const imeDoc = ['# 見出し', '', '**太字**の後', '', '| a | b |', '|---|---|', '| 1 | 2 |'];
await loadDoc(imeDoc);

async function compose(steps, commit) {
  for (const text of steps) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await sleep(80);
  }
  await cdp.send('Input.insertText', { text: commit });
  await sleep(150);
}

await clickPos(await web('__hushmarkView.state.doc.line(1).to'));
await compose(['に', 'にほ', 'にほん'], '日本');
// 記号が隠れた行では「字」と「**」の境目をクリックすると ** の後ろに入る。行を表示させてから位置を指す
const insideBold = await web("__hushmarkView.state.doc.toString().indexOf('字**') + 1");
await clickPos(insideBold);
await clickPos(insideBold);
await compose(['か', 'かな'], '仮名');
await clickSelector('.cm-md-table td', 1);
await press(cdp, 'End');
await compose(['さ', 'さん'], '三');
doc = await checkInSync('IME');
check('IME: 見出しの行に確定した文字が入った', doc.split('\n')[0] === '# 見出し日本', doc.split('\n')[0]);
check('IME: 太字の中に確定した文字が入った', doc.split('\n')[2] === '**太字仮名**の後', doc.split('\n')[2]);
check('IME: 表のセルに確定した文字が入った', doc.split('\n')[6] === '| 1 | 2三 |', doc.split('\n')[6]);

// 9. 中身が長いセルの編集。列の幅は編集の前のまま、セルの中で折り返し、記号はカーソルが触れたときだけ出す
const longCell = 'セルの中で折り返す**長い備考**です。折り返すと行の高さが本文の行の倍数で伸び、[行番号](https://example.com)もその行の 1 行目にそろうかを確かめます。';
const longDoc = ['# 長いセル', '', '| 項目 | 備考 |', '|---|---|', `| みかん | ${longCell} |`, '', '後'];
// IME の確かめで編集していたセルから出る。表が文書の末尾なので改行が足される。その書き込みを待ってから書き換える
await press(cdp, 'Escape');
await checkInSync('表から出る');
await loadDoc(longDoc);

/** 表のセルの中の文字 text の左端をクリックする */
async function clickCellText(text) {
  const c = JSON.parse(await web(`JSON.stringify((() => {
    for (const td of document.querySelectorAll('.cm-md-table td')) {
      const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.data.indexOf(${JSON.stringify(text)});
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const r = range.getBoundingClientRect();
        return { x: r.left + 2, y: (r.top + r.bottom) / 2 };
      }
    }
  })())`));
  const p = await toPage(c);
  await click(cdp, p.x, p.y);
  await sleep(250);
}
const tableLayout = () => web(`JSON.stringify((() => {
  const table = document.querySelector('.cm-md-table');
  const editor = document.querySelector('.cm-md-cell-input');
  const v = editor && editor.mdCellView;
  return {
    widths: [...table.rows[0].cells].map((c) => Math.round(c.getBoundingClientRect().width)),
    height: Math.round(table.getBoundingClientRect().height),
    fixed: table.style.tableLayout === 'fixed',
    marks: editor ? [...editor.querySelectorAll('.cm-md-mark')].map((e) => e.textContent) : null,
    caret: v ? v.state.sliceDoc(v.state.selection.main.head, v.state.selection.main.head + 2) : null,
  };
})())`).then(JSON.parse);
const beforeEdit = await tableLayout();
await clickCellText('伸び');
let duringEdit = await tableLayout();
check('長いセル: クリックした位置にカーソルが入る', duringEdit.caret === '伸び', duringEdit);
check('長いセル: 編集を始めても列の幅と表の高さが変わらない',
  duringEdit.widths.join() === beforeEdit.widths.join() && duringEdit.height === beforeEdit.height, { beforeEdit, duringEdit });
check('長いセル: カーソルが触れていない太字とリンクの記号は出さない', duringEdit.marks && duringEdit.marks.length === 0, duringEdit);
await clickCellText('備考');
duringEdit = await tableLayout();
check('長いセル: カーソルが触れた太字の記号だけ出す', duringEdit.marks && duringEdit.marks.join(' ') === '** **', duringEdit);
await type(cdp, 'とても長くなった');
doc = await checkInSync('長いセル');
duringEdit = await tableLayout();
check('長いセル: 打っても列の幅は編集の前のまま', duringEdit.fixed && duringEdit.widths.join() === beforeEdit.widths.join(), { beforeEdit, duringEdit });
check('長いセル: 打った文字が文書に入った', doc.split('\n')[4].includes('**長いとても長くなった備考**'), doc.split('\n')[4]);
await press(cdp, 'Escape');
await sleep(200);
check('長いセル: セルから出たら列の幅の固定をやめる', (await tableLayout()).fixed === false);

// 最初の行の途中で ↑ を押すと、まずセルの先頭に動く。もう一度押すと上のセルに移る
await clickCellText('折り返す');
await press(cdp, 'ArrowUp');
await sleep(150);
const caretAt = () => web("(() => { const e = document.querySelector('.cm-md-cell-input'); return e ? e.mdCellView.state.selection.main.head : null; })()");
ts = await tableState();
check('長いセル: 最初の行で ↑ を押すとセルの先頭に動く', ts.row === 1 && (await caretAt()) === 0, { ts, caret: await caretAt() });
await press(cdp, 'ArrowUp');
await sleep(150);
ts = await tableState();
check('長いセル: セルの先頭で ↑ を押すと上のセルに移る', ts.row === 0 && ts.col === 1, ts);
// 「伸び」の位置から ↓ を押していくと、最後の行で一度セルの末尾に止まる（折り返しの行数は画面の幅による）
await clickCellText('伸び');
const cellLength = () => web("(() => { const e = document.querySelector('.cm-md-cell-input'); return e ? e.mdCellView.state.doc.length : -1; })()");
for (let i = 0; i < 4 && (await caretAt()) !== (await cellLength()); i++) {
  await press(cdp, 'ArrowDown');
  await sleep(150);
}
check('長いセル: 最後の行で ↓ を押すとセルの末尾に動く',
  (await tableState()).row === 1 && (await caretAt()) === (await web("document.querySelector('.cm-md-cell-input').mdCellView.state.doc.length")),
  { ts: await tableState(), caret: await caretAt() });
await press(cdp, 'Escape');

// 10. 行頭で「## 」と打ってから変換すると、変換中から見出しの大きさで出て、確定しても位置が動かない
const headingDoc = ['本文', '', ''];
await loadDoc(headingDoc);
await clickPos(await web('__hushmarkView.state.doc.length'));
const lastLineIsHeading = () => web("[...document.querySelectorAll('.cm-line')].pop().className.includes('cm-md-heading')");
await type(cdp, '##');
await sleep(200);
check('「##」まで打った時点では、見出しの見た目にしない', (await lastLineIsHeading()) === false);
await type(cdp, ' ');
await sleep(200);
check('「## 」と空白まで打つと、見出しの見た目になる', (await lastLineIsHeading()) === true);
await cdp.send('Input.imeSetComposition', { text: 'みだし', selectionStart: 3, selectionEnd: 3 });
await sleep(200);
const composing = JSON.parse(await web(`JSON.stringify((() => {
  const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('みだし'));
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf('み');
    if (i < 0) continue;
    const style = getComputedStyle(n.parentElement);
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, i + 1);
    return { size: style.fontSize, weight: style.fontWeight, left: Math.round(range.getBoundingClientRect().left),
      heading: getComputedStyle(line).fontSize, headingClass: line.className.includes('cm-md-h2') };
  }
})())`));
await cdp.send('Input.insertText', { text: '見出し' });
await sleep(300);
const committedLeft = await web(`(() => { const v = __hushmarkView; const pos = v.state.doc.toString().indexOf('見出し'); return Math.round(v.coordsAtPos(pos).left); })()`);
check('「## 」の後の変換: 変換中から見出しの大きさと太さで出る',
  composing.headingClass && composing.size === composing.heading && Number(composing.weight) >= 700, composing);
check('「## 」の後の変換: 確定しても文字の位置が動かない', composing.left === committedLeft, { composing, committedLeft });
doc = await checkInSync('「## 」の後の変換');
check('「## 」の後の変換: 見出しが文書に入った', doc.endsWith('\n## 見出し'), doc);

// 11. 表のセルの中でも、本文と同じショートカットが効く
const shortcutDoc = ['| 果物 | 値 |', '|---|---|', '| りんご | 1 |', '', '後'];
await loadDoc(shortcutDoc);
await clickCellText('りんご');
ts = await tableState();
check('セルのショートカット: クリックしたセルを編集している', ts.inputs === 1 && ts.value === 'りんご' && ts.focused, ts);
await press(cdp, 'a', MOD);
await press(cdp, 'b', MOD);
await sleep(200);
doc = await checkInSync('セルで Ctrl+B');
check('セルで Ctrl+A → Ctrl+B: セルの中身を太字にする', doc.split('\n')[2] === '| **りんご** | 1 |', doc.split('\n')[2]);
await press(cdp, 'f', MOD);
await sleep(300);
const cellFind = JSON.parse(await web(`JSON.stringify({
  open: !!document.querySelector('.cm-md-find'),
  value: document.querySelector('.cm-md-find-input')?.value ?? null,
  focused: !!document.activeElement?.closest('.cm-md-find'),
})`));
check('セルで Ctrl+F: セルで選んでいる文字列で検索を開く', cellFind.open && cellFind.value === 'りんご' && cellFind.focused, cellFind);
await press(cdp, 'Escape');
await sleep(200);

// 12. 長い表の中の文字列を検索すると、選んだ一致のセルが画面に見える（表の端へのスクロールにしない）
const rows = Array.from({ length: 80 }, (_, i) => `| R${String(i + 1).padStart(2, '0')} | 行 ${i + 1} |`);
const longTableDoc = ['# 長い表', '', '| 名前 | 内容 |', '|---|---|', ...rows, '', '後'];
await loadDoc(longTableDoc);
await clickPos(0);
await web('__hushmarkView.scrollDOM.scrollTop = 0');
await press(cdp, 'f', MOD);
await sleep(200);
await type(cdp, 'R40');
await sleep(500);
const currentCellVisible = () => web(`JSON.stringify((() => {
  const el = document.querySelector('.cm-md-cell-match-current');
  const box = __hushmarkView.scrollDOM.getBoundingClientRect();
  const r = el && el.getBoundingClientRect();
  return { cell: el ? el.textContent : null, visible: !!r && r.top >= box.top && r.bottom <= box.bottom };
})())`).then(JSON.parse);
let found = await currentCellVisible();
check('長い表の検索: 選んだ一致のセルが見える', found.cell === 'R40' && found.visible, found);
await press(cdp, 'Escape');
await sleep(200);

// 13. ↑ / ↓ は行頭からの桁数を保って動く。移動先の行で記号が出ても、見た目の位置ではなく同じ桁に着く
const columnDoc = ['**太字**の後の文です', 'abcdefghijklmnop'];
await loadDoc(columnDoc);
const line2 = await web('__hushmarkView.state.doc.line(2).from');
await clickPos(line2 + 8);
await press(cdp, 'ArrowUp');
await sleep(150);
const headAfterUp = await web('__hushmarkView.state.selection.main.head');
check('↑: 行頭からの桁数（8 桁）を保って、**太字** の直後に着く', headAfterUp === 6, headAfterUp);
await press(cdp, 'ArrowDown');
await sleep(150);
const headAfterDown = await web('__hushmarkView.state.selection.main.head');
check('↓: 元の桁に戻る', headAfterDown === line2 + 8, { headAfterDown, expected: line2 + 8 });

// 14. Alt+Z で折り返しを切り替える（最初は editor.wordWrap に従う。markdown の既定は on）
const wrapped = () => web("__hushmarkView.contentDOM.classList.contains('cm-lineWrapping')");
const wrapBefore = await wrapped();
await press(cdp, 'z', ALT);
await sleep(200);
const wrapToggled = await wrapped();
await press(cdp, 'z', ALT);
await sleep(200);
const wrapRestored = await wrapped();
check('Alt+Z: 折り返しを切り替え、もう一度押すと戻る',
  wrapBefore === true && wrapToggled === false && wrapRestored === true, { wrapBefore, wrapToggled, wrapRestored });
check('Alt+Z: 文字は入力しない', (await webDoc()) === columnDoc.join('\n'), await webDoc());

// 15. 見出しの「#」と空白の前後で、描かれるカーソルが文書の位置どおりに動く
const caretHeadingDoc = ['本文', '', '## 見出し', '', '後'];
await loadDoc(caretHeadingDoc);
const headingFrom = await web('__hushmarkView.state.doc.line(3).from');
await clickPos(headingFrom + 3); // 「見」の前
await clickPos(headingFrom + 3);
const cursorLeft = () => web("(() => { const c = document.querySelector('.cm-cursor-primary'); return c ? Math.round(c.getBoundingClientRect().left) : null; })()");
const beforeText = await cursorLeft();
await press(cdp, 'ArrowLeft');
await sleep(150);
const afterMarks = await cursorLeft();
await press(cdp, 'ArrowLeft');
await sleep(150);
const betweenMarks = await cursorLeft();
// 空白の幅は、フォントと行の余白（--md-line-pad）で変わるので、描かれた空白の幅と比べる
const spaceWidth = await web("Math.round(document.querySelector('.cm-md-heading-space').getBoundingClientRect().width)");
check('見出しの空白の前後: 描かれるカーソルが空白の幅だけ動く', Math.abs(beforeText - afterMarks - spaceWidth) <= 2 && spaceWidth > 0 &&
  afterMarks > betweenMarks, { beforeText, afterMarks, betweenMarks, spaceWidth });

// 16. 表のセルの端で ← / → を押すと、隣のセルに移る
const arrowTableDoc = ['| 果物 | 値 |', '|---|---|', '| りんご | 12 |', '', '後'];
await loadDoc(arrowTableDoc);
await clickCellText('りんご');
await press(cdp, 'End');
await press(cdp, 'ArrowRight');
await sleep(150);
ts = await tableState();
let cellCaret = await web("document.querySelector('.cm-md-cell-input').mdCellView.state.selection.main.head");
check('セルの末尾で →: 次のセルの先頭に移る', ts.row === 1 && ts.col === 1 && cellCaret === 0, { ts, cellCaret });
await press(cdp, 'ArrowLeft');
await sleep(150);
ts = await tableState();
cellCaret = await web("document.querySelector('.cm-md-cell-input').mdCellView.state.selection.main.head");
check('セルの先頭で ←: 前のセルの末尾に移る', ts.row === 1 && ts.col === 0 && cellCaret === 3, { ts, cellCaret });
await press(cdp, 'ArrowLeft');
await sleep(150);
ts = await tableState();
check('セルの途中の ←: セルの中で動く', ts.row === 1 && ts.col === 0, ts);
await press(cdp, 'Escape');

// 17. 表: ソースで省略されたセルへの入力、セルの中の裸の URL
const sparseDoc = ['| h1 | h2 | h3 |', '|---|---|---|', '| https://example.com |', '', '後'];
await loadDoc(sparseDoc);
const bareUrl = await web("[...document.querySelectorAll('.cm-md-table td .cm-md-link')].map((e) => e.textContent).join()");
check('表のセルの裸の URL をリンクとして描く', bareUrl === 'https://example.com', bareUrl);
await clickSelector('.cm-md-table td', 2); // 3 列目（ソースでは省略されている）
await type(cdp, 'X');
doc = await checkInSync('省略されたセル');
check('省略されたセルに打つと、手前の省略されたセルも補って 3 列目に入る', doc.split('\n')[2] === '| https://example.com |  | X |', doc.split('\n')[2]);
await press(cdp, 'Escape');
await sleep(200);

// 18. 引用の中の表でも「ソース」で表全体のソースを出せる
const quotedDoc = ['前', '', '> | a | b |', '> |---|---|', '> | 1 | 2 |', '', '後'];
await loadDoc(quotedDoc);
await clickTableTool(2); // ソース
ts = await tableState();
check('引用の中の表: 「ソース」で表全体をソースで表示する', ts.tables === 0 && ts.source === 3, ts);

// 19. ↑ / ↓ で保った桁は、ほかの操作でカーソルが動いたら捨てる
const stickyDoc = ['abcdefghij', 'x', 'abcdefghij'];
await loadDoc(stickyDoc);
await clickPos(8); // 1 行目の 8 桁目
await press(cdp, 'ArrowDown'); // 1 文字の行の末尾へ
await press(cdp, 'Home');
await press(cdp, 'ArrowRight'); // 2 行目の 1 桁目を選び直す
await press(cdp, 'ArrowDown');
await sleep(150);
const stickyHead = await web('__hushmarkView.state.selection.main.head');
const line3From = await web('__hushmarkView.state.doc.line(3).from');
check('↑↓ の桁: 左右で動いた後は、選び直した桁（1 桁目）を使う', stickyHead === line3From + 1, { stickyHead, expected: line3From + 1 });

// 20. チェックボックスを右クリックしても、チェックは切り替えない
const taskDoc = ['- [ ] task', '', '後'];
await loadDoc(taskDoc);
await clickPos(await web('__hushmarkView.state.doc.length'));
const box = await toPage(JSON.parse(await web("JSON.stringify((() => { const r = document.querySelector('.cm-md-checkbox').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())")));
for (const type of ['mousePressed', 'mouseReleased']) {
  await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', clickCount: 1 });
}
await press(cdp, 'Escape'); // 開いたメニューを閉じる
await sleep(300);
check('チェックボックスを右クリックしても切り替えない', (await webDoc()) === taskDoc.join('\n'), await webDoc());

// 21. 表のセルの文字参照は元の文字にする。定義のない名前はそのまま出す
const entityDoc = ['| a | b |', '|---|---|', '| &copy; &#169; &#x41; | &notit; &amp; |', '', '後'];
await loadDoc(entityDoc);
const entityCells = JSON.parse(await web("JSON.stringify([...document.querySelectorAll('.cm-md-table td')].map((e) => e.textContent))"));
check('表のセルの文字参照を元の文字にする', entityCells.join('|') === '© © A|&notit; &', entityCells);

// 22. 文書内のリンク（#見出し）を Ctrl+クリックすると、その見出しに移る
const anchorDoc = ['[後の見出しへ](#後の見出しその2)', '', ...Array.from({ length: 80 }, (_, i) => `行 ${i + 1}`), '', '## 後の見出し（その2）', '', '後'];
await loadDoc(anchorDoc);
await clickPos(await web('__hushmarkView.state.doc.length'));
await web('__hushmarkView.scrollDOM.scrollTop = 0');
await sleep(200);
const linkAt = await toPage(JSON.parse(await web("JSON.stringify((() => { const r = document.querySelector('.cm-md-link').getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; })())")));
for (const type of ['mousePressed', 'mouseReleased']) {
  await cdp.send('Input.dispatchMouseEvent', { type, x: linkAt.x, y: linkAt.y, button: 'left', clickCount: 1, modifiers: MOD });
}
await sleep(800);
const anchorTarget = JSON.parse(await web(`JSON.stringify((() => {
  const v = __hushmarkView;
  const line = v.state.doc.lineAt(v.state.selection.main.head);
  const top = v.coordsAtPos(line.from).top - v.scrollDOM.getBoundingClientRect().top;
  return { text: line.text, top, height: v.scrollDOM.clientHeight };
})())`));
check('#見出し のリンク: 見出しにカーソルが移り、画面に出る', anchorTarget.text === '## 後の見出し（その2）' &&
  anchorTarget.top >= 0 && anchorTarget.top < anchorTarget.height, anchorTarget);

// 23. 表の上のボタンは表の右端にそろえ、表が狭いときは左にはみ出さない
const toolsLayout = () => web(`JSON.stringify((() => {
  const box = (s) => document.querySelector(s).getBoundingClientRect();
  return { tools: box('.cm-md-table-tools'), table: box('.cm-md-table'), content: box('.cm-content') };
})())`).then(JSON.parse);
await loadDoc(['| a | b |', '|---|---|', '| 1 | 2 |', '', '後']);
const narrow = await toolsLayout();
check('狭い表: ボタンが本文の左端からはみ出さない', narrow.tools.left >= narrow.content.left, narrow);
await loadDoc([`| ${'長い見出し'.repeat(6)} | b |`, '|---|---|', '| 1 | 2 |', '', '後']);
const wide = await toolsLayout();
check('広い表: ボタンを表の右端にそろえる', Math.abs(wide.tools.right - wide.table.right) < 2, wide);

// 24. 画像のリンクにマウスを載せると、画像を浮かせて表示する。読めない画像では何も出さない
if (!remote) {
  // 4×3 の赤い PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAF0lEQVR4AWP8z8DwnwEJMDGgASYGNAAAYWsCBNgUK1IAAAAASUVORK5CYII=';
  fs.writeFileSync(path.join(path.dirname(file), 'pic.png'), Buffer.from(png, 'base64'));
  await loadDoc(['![red](pic.png) と ![none](missing.png)', '', '後']);
  const hoverImage = async (index) => {
    const at = await toPage(JSON.parse(await web(`JSON.stringify((() => { const r = document.querySelectorAll('.cm-md-image')[${index}].getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2 }; })())`)));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await sleep(1000);
    return JSON.parse(await web("JSON.stringify([...document.querySelectorAll('.cm-md-image-preview img')].map((i) => i.naturalWidth))"));
  };
  const shown = await hoverImage(0);
  check('画像のリンクにマウスを載せると、画像を表示する', shown.length === 1 && shown[0] === 4, shown);
  const missing = await hoverImage(1);
  check('読めない画像では何も表示しない', missing.length === 0, missing);
  // 表のセルの中の画像も同じ
  await loadDoc(['| 色 | 画像 |', '|---|---|', '| 赤 | ![red](pic.png) |', '', '後']);
  const cellImage = await web("document.querySelector('.cm-md-table .cm-md-image')?.textContent");
  check('表のセルの画像は、代替テキストを出す', cellImage === 'red', cellImage);
  const shownInCell = await hoverImage(0);
  check('表のセルの画像にマウスを載せると、画像を表示する', shownInCell.length === 1 && shownInCell[0] === 4, shownInCell);
}

// 25. 文字列を選んで URL を貼り付けると、リンクにする
await loadDoc(['see docs here', '', '後']);
await web(`(() => {
  const v = __hushmarkView;
  const from = v.state.doc.toString().indexOf('docs');
  v.focus();
  v.dispatch({ selection: { anchor: from, head: from + 4 } });
  const data = new DataTransfer();
  data.setData('text/plain', 'https://example.com/docs');
  v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
})()`);
doc = await checkInSync('URL の貼り付け');
check('文字列を選んで URL を貼り付けると、リンクにする', doc.startsWith('see [docs](https://example.com/docs) here'), doc);

// 28. ほかのツールで離れた 2 か所が変わっても、その間にあるカーソルは動かない
const distantDoc = Array.from({ length: 12 }, (_, i) => `行 ${i + 1} の文`);
await loadDoc(distantDoc);
const caretBefore = await web('__hushmarkView.state.doc.line(6).from + 3');
await clickPos(caretBefore);
const changedDistant = [...distantDoc];
changedDistant[0] = '最初の行を変えた';
changedDistant[11] = '最後の行を変えた';
await loadDoc(changedDistant);
const caretAfter = JSON.parse(await web('JSON.stringify((() => { const v = __hushmarkView; const h = v.state.selection.main.head; const l = v.state.doc.lineAt(h); return { line: l.number, col: h - l.from }; })())'));
check('離れた 2 か所が外で変わっても、間のカーソルは動かない', caretAfter.line === 6 && caretAfter.col === 3, caretAfter);

// 29. 表のセルの中の参照リンクは、文書の定義があればリンクにする。定義が変われば描き直す
const refTable = (def) => ['| 名前 | リンク |', '|---|---|', '| a | [ref] と [none] |', '', '後', ...(def ? ['', `[ref]: ${def}`] : [])];
const cellLinks = () => web("JSON.stringify([...document.querySelectorAll('.cm-md-table td .cm-md-link')].map((e) => [e.textContent, e.getAttribute('data-href')]))").then(JSON.parse);
await loadDoc(refTable('https://example.com/one'));
let links = await cellLinks();
check('表のセルの参照リンク: 定義のあるものだけリンクにする', links.length === 1 && links[0][0] === 'ref' && links[0][1] === 'https://example.com/one', links);
await loadDoc(refTable('https://example.com/two'));
links = await cellLinks();
check('表のセルの参照リンク: 定義が変わると描き直す', links.length === 1 && links[0][1] === 'https://example.com/two', links);
await loadDoc(refTable(null));
links = await cellLinks();
check('表のセルの参照リンク: 定義を消すとただの文字に戻す', links.length === 0, links);

// 30. 絵文字を含む行へ ↑ で移っても、桁（絵文字は 2 桁）を保つ
await loadDoc(['😀😀abc', 'abcdefgh', '', '後']);
const emojiLine2 = await web('__hushmarkView.state.doc.line(2).from');
await clickPos(emojiLine2 + 6); // 2 行目の 6 桁目（f の前）
await press(cdp, 'ArrowUp');
await sleep(150);
const emojiHead = await web('__hushmarkView.state.selection.main.head');
// 1 行目の 6 桁目は「😀😀ab」の後ろ（UTF-16 で 6 文字目）
check('絵文字を含む行へ ↑: 絵文字を 2 桁と数えて桁を保つ', emojiHead === 6, emojiHead);

finish();

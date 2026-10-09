// 実際の VSCode 上で、編集・取り消し・表・外部変更の同期を確かめる（Linux の CI で実行するもの）。
// 使い方: npm run test:e2e -- full
// ショートカットの Ctrl は、macOS では Cmd で押す（MOD）。
// 開いたファイルは途中で何度も書き換える。

import { ALT, CTRL, META, MOD, SHIFT, click, isMac, press, sleep, type } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSession } from './session.mjs';

const {
  file, remote, cdp, mainCtx, web, check, finish, toPage, clickPos, clickSelector, clickTableTool,
  webDoc, readFile, writeFile, loadDoc, checkInSync,
} = await openSession();

const original = await webDoc();
check('初期表示: ファイルと表示が一致', original === readFile().replace(/\r\n/g, '\n'));

// 既定（hushmark.previewColorScheme が theme）では、背景と文字に VSCode のテーマの色を使う
const themeColors = JSON.parse(await web(`JSON.stringify((() => {
  const css = (el, name) => getComputedStyle(el).getPropertyValue(name).trim().toLowerCase();
  return { bg: css(document.body, '--md-bg'), fg: css(document.body, '--md-fg'),
    themeBg: css(document.documentElement, '--vscode-editor-background'), themeFg: css(document.documentElement, '--vscode-editor-foreground') };
})())`));
check('配色: 背景と文字はテーマの色', themeColors.bg === themeColors.themeBg && themeColors.fg === themeColors.themeFg, themeColors);

// 縦の位置はソースの行に合わせる。見出しの行は本文の行の整数倍、表はソースの行数分の高さにする
const heights = JSON.parse(await web(`JSON.stringify((() => {
  const line = __hushmarkView.defaultLineHeight;
  const headings = [...document.querySelectorAll('.cm-md-heading')].map((e) => e.getBoundingClientRect().height / line);
  const table = document.querySelector('.cm-md-table-block').getBoundingClientRect().height / line;
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

// 2. 表: ソースの行のまま、セルを箱にして列をそろえる。セルの文字は本文と同じく編集する
const tableState = () => web(`(() => {
  const v = __hushmarkView;
  const head = v.state.selection.main.head;
  const rows = [...document.querySelectorAll('.cm-md-trow')];
  // 列ごとのセルの箱の左端。そろっていれば、どの行でも同じ
  const lefts = rows.filter((r) => !r.classList.contains('cm-md-trow-delim'))
    .map((r) => [...r.querySelectorAll(':scope > .cm-md-tcell')].map((c) => Math.round(c.getBoundingClientRect().left)));
  return {
    rows: rows.length,
    aligned: lefts.every((l) => l.every((x, i) => x === lefts[0][i])),
    widths: rows.length ? [...rows[0].querySelectorAll(':scope > .cm-md-tcell')].map((c) => Math.round(c.getBoundingClientRect().width)) : [],
    shownPipes: document.querySelectorAll('.cm-md-tpipe-shown').length,
    line: v.state.doc.lineAt(head).number,
    selected: v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to),
    focused: v.hasFocus,
  };
})()`);

let ts = await tableState();
check('表: 4 行をそれぞれ表の行にし、列をそろえる', ts.rows === 4 && ts.aligned && ts.shownPipes === 0, ts);
const widthsBefore = ts.widths;
const cellPos = (text, offset = 0) => web(`__hushmarkView.state.doc.toString().indexOf(${JSON.stringify(text)}) + ${offset}`);
await clickPos(await cellPos('120', 3));
ts = await tableState();
check('表: クリックした行だけ | を出す', ts.line === 9 && ts.shownPipes === 4 && ts.focused, ts);
check('表: | を出しても列の位置は動かない', ts.aligned && ts.widths.join() === widthsBefore.join(), { ts, widthsBefore });
await type(cdp, '0');
doc = await checkInSync('表のセル編集');
check('表のセル編集: 文書に反映された', doc.includes('| りんご | 1200 |'), doc.split('\n')[8]);
ts = await tableState();
check('表のセル編集: 打っている間は列の幅を変えない', ts.widths.join() === widthsBefore.join(), { ts, widthsBefore });

await press(cdp, 'Tab');
ts = await tableState();
check('Tab: 次のセルの中身（**旬**）を選ぶ', ts.selected === '**旬**', ts);
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
check('セルの中で Ctrl+Z: 取り消せる', doc.split('\n')[10] === '| ぶどう |  |  |', doc.split('\n')[10]);

await press(cdp, 'Enter', SHIFT);
ts = await tableState();
check('Shift+Enter: 上の行の同じ列のセルに移る', ts.line === 10 && (await web('__hushmarkView.state.selection.main.head')) === (await cellPos('みかん', 3)), ts);
await press(cdp, 'Enter');
await press(cdp, 'Enter');
ts = await tableState();
doc = await webDoc();
check('Enter: 表の最後の行では、表の下の行に出る（表は壊さない）', ts.line === 12 && doc.split('\n')[10] === '| ぶどう |  |  |', { ts, line: doc.split('\n')[10] });

await press(cdp, 'ArrowUp');
await sleep(150);
ts = await tableState();
check('下の行から ↑: 表の最後の行に入る', ts.line === 11, ts);

await clickTableTool(1); // ＋列
await type(cdp, '新列');
doc = await checkInSync('＋列');
check('＋列: 右端に列が増えて見出しに打てる', doc.split('\n')[6] === '| 項目 | 値 | 備考 | 新列 |' && doc.split('\n')[7] === '|:--|--:|---|---|', doc.split('\n').slice(6, 8));

await clickTableTool(0); // ＋行
await type(cdp, '末尾');
doc = await checkInSync('＋行');
check('＋行: 最後に行が増えて先頭のセルに打てる', doc.split('\n')[11] === '| 末尾 |  |  |  |', doc.split('\n').slice(10, 12));

// 3. ファイル末尾のコードブロックの後ろに書く。末尾付近で打っても位置がずれない
await clickPos(await web('__hushmarkView.state.doc.length'));
check('末尾: 表から出ると | を隠す', (await tableState()).shownPipes === 0);
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
  tableCurrent: document.querySelectorAll('.cm-md-trow .cm-searchMatch-selected').length,
})`));
const selectText = (text) => web(`(() => { const v = __hushmarkView; const f = v.state.doc.toString().indexOf(${JSON.stringify(text)}); v.focus(); v.dispatch({ selection: { anchor: f, head: f + ${text.length} } }); })()`);

await clickPos(0);
await selectText('みかん');
await press(cdp, 'f', MOD);
await sleep(300);
let fs1 = await findState();
check('Ctrl+F: 選択中の文字列を検索語にして、入力欄にフォーカスする', fs1.open && fs1.value === 'みかん' && fs1.focused && fs1.count === '1 / 1', fs1);
check('Ctrl+F: 表の中の一致にも色を付ける', fs1.tableCurrent === 1, fs1);

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
await clickPos(await web("__hushmarkView.state.doc.toString().indexOf('| 2 |') + 3"));
await compose(['さ', 'さん'], '三');
doc = await checkInSync('IME');
check('IME: 見出しの行に確定した文字が入った', doc.split('\n')[0] === '# 見出し日本', doc.split('\n')[0]);
check('IME: 太字の中に確定した文字が入った', doc.split('\n')[2] === '**太字仮名**の後', doc.split('\n')[2]);
check('IME: 表のセルに確定した文字が入った', doc.split('\n')[6] === '| 1 | 2三 |', doc.split('\n')[6]);

// 9. 中身が長いセルの編集。列の幅は編集の前のまま、セルの中で折り返し、記号はカーソルが触れたときだけ出す
const longCell = 'セルの中で折り返す**長い備考**です。折り返すと行の高さが本文の行の倍数で伸び、[行番号](https://example.com)もその行の 1 行目にそろうかを確かめます。';
const longDoc = ['# 長いセル', '', '| 項目 | 備考 |', '|---|---|', `| みかん | ${longCell} |`, '', '後'];
await clickPos(0);
await checkInSync('表から出る');
await loadDoc(longDoc);

/** 文書の中の文字 text の左端をクリックする */
const clickCellText = async (text) => clickPos(await cellPos(text));
const tableLayout = () => web(`JSON.stringify((() => {
  const v = __hushmarkView;
  const block = document.querySelector('.cm-md-table-block');
  const row = [...document.querySelectorAll('.cm-md-trow-body')][0];
  return {
    widths: [...document.querySelector('.cm-md-trow-head').querySelectorAll(':scope > .cm-md-tcell')].map((c) => Math.round(c.getBoundingClientRect().width)),
    height: Math.round(block.getBoundingClientRect().height),
    rowLines: Math.round(row.getBoundingClientRect().height / v.defaultLineHeight),
    marks: [...row.querySelectorAll('.cm-md-mark')].map((e) => e.textContent),
    caret: v.state.sliceDoc(v.state.selection.main.head, v.state.selection.main.head + 2),
    line: v.state.doc.lineAt(v.state.selection.main.head).number,
  };
})())`).then(JSON.parse);
const beforeEdit = await tableLayout();
check('長いセル: セルの中で折り返し、行の高さが本文の行の倍数で伸びる', beforeEdit.rowLines >= 2, beforeEdit);
await clickCellText('伸び');
let duringEdit = await tableLayout();
check('長いセル: クリックした位置にカーソルが入る', duringEdit.caret === '伸び', duringEdit);
check('長いセル: カーソルが入っても列の幅は変わらない', duringEdit.widths.join() === beforeEdit.widths.join(), { beforeEdit, duringEdit });
check('長いセル: カーソルが触れていない太字とリンクの記号は出さない', duringEdit.marks.length === 0, duringEdit);
await clickCellText('備考**');
duringEdit = await tableLayout();
check('長いセル: カーソルが触れた太字の記号だけ出す', duringEdit.marks.join(' ') === '** **', duringEdit);
await type(cdp, 'とても長くなった');
doc = await checkInSync('長いセル');
duringEdit = await tableLayout();
check('長いセル: 打っても列の幅は編集の前のまま', duringEdit.widths.join() === beforeEdit.widths.join(), { beforeEdit, duringEdit });
check('長いセル: 打った文字が文書に入った', doc.split('\n')[4].includes('**長いとても長くなった備考**'), doc.split('\n')[4]);

// 折り返したセルの中では、↑ / ↓ は見た目の行の間を動く。最初の見た目の行で ↑ を押すと上の行に移る
await clickCellText('折り返す');
await press(cdp, 'ArrowDown');
await sleep(150);
duringEdit = await tableLayout();
check('長いセル: ↓ はセルの中の次の見た目の行に動く', duringEdit.line === 5, duringEdit);
await clickCellText('折り返す');
await press(cdp, 'ArrowUp');
await sleep(150);
duringEdit = await tableLayout();
check('長いセル: 最初の見た目の行で ↑ を押すと上の行（区切りの行）に移る', duringEdit.line === 4, duringEdit);

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
await selectText('りんご');
await press(cdp, 'b', MOD);
await sleep(200);
doc = await checkInSync('セルで Ctrl+B');
check('セルで Ctrl+B: 選んだ文字列を太字にする', doc.split('\n')[2] === '| **りんご** | 1 |', doc.split('\n')[2]);
await selectText('りんご');
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

// 11b. Hushmark の操作のキーは、VSCode のキーボード ショートカットで変えられる（keybindings.json に書く）
if (!remote) {
  const keybindingsFile = path.join(path.dirname(file), '..', 'ud', 'User', 'keybindings.json');
  fs.writeFileSync(keybindingsFile, JSON.stringify([{ key: 'ctrl+alt+u', mac: 'cmd+alt+u', command: 'hushmark.italic', when: 'hushmark.editorFocus' }]));
  await sleep(1500); // VSCode がキーの設定を読み直すのを待つ
  await loadDoc(['語を斜体に', '', '後']);
  await selectText('斜体');
  await press(cdp, 'u', MOD | ALT);
  await sleep(300);
  doc = await checkInSync('割り当てを変えたキー');
  check('キーボード ショートカットで割り当てたキーで、Hushmark の操作を行う', doc.split('\n')[0] === '語を*斜体*に', doc.split('\n')[0]);
  fs.writeFileSync(keybindingsFile, '[]');
}

// 11c. エディタの外（エクスプローラーなど）にフォーカスがあるときは、Ctrl+B は VSCode の操作（サイドバーの開閉）のまま
await loadDoc(['太字にしない', '', '後']);
await selectText('太字');
const sidebarVisible = () => cdp.evaluateIn(mainCtx, "!!document.querySelector('.part.sidebar') && getComputedStyle(document.querySelector('.part.sidebar')).display !== 'none' && document.querySelector('.part.sidebar').getBoundingClientRect().width > 0");
const sidebarBefore = await sidebarVisible();
await cdp.evaluateIn(mainCtx, "document.querySelector('.part.statusbar').setAttribute('tabindex', '-1'), document.querySelector('.part.statusbar').focus()");
await sleep(300);
await press(cdp, 'b', MOD);
await sleep(500);
const sidebarAfter = await sidebarVisible();
check('エディタの外にフォーカスがあるときの Ctrl+B: 文書は変えず、サイドバーを開閉する', (await webDoc()) === '太字にしない\n\n後' && sidebarAfter !== sidebarBefore, { sidebarBefore, sidebarAfter });
// サイドバーを閉じると VSCode はフォーカスをエディタに戻すので、もう一度エディタの外に移してから元に戻す
await cdp.evaluateIn(mainCtx, "document.querySelector('.part.statusbar').focus()");
await sleep(300);
await press(cdp, 'b', MOD);
await sleep(500);
check('サイドバーを元に戻しても、文書は変わらない', (await webDoc()) === '太字にしない\n\n後' && (await sidebarVisible()) === sidebarBefore);
await clickPos(0);

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
  const el = document.querySelector('.cm-md-trow .cm-searchMatch-selected');
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

// 16. 表のセルの端で → を押していくと、| をまたいで次のセルに入る（テキストエディタと同じくソースの順に動く）
const arrowTableDoc = ['| 果物 | 値 |', '|---|---|', '| りんご | 12 |', '', '後'];
await loadDoc(arrowTableDoc);
await clickPos(await cellPos('りんご', 3));
for (let i = 0; i < 3; i++) await press(cdp, 'ArrowRight');
await sleep(150);
check('セルの末尾から → を 3 回: 次のセルの先頭（空白と | をまたぐ）', (await web('__hushmarkView.state.selection.main.head')) === (await cellPos('12')));
// 最後の | の後ろで Enter を押すと、テキストエディタと同じく改行する（表の行を打ち足せる）
await clickPos(await web('__hushmarkView.state.doc.line(3).to'));
await press(cdp, 'Enter');
await type(cdp, '| みかん | 3 |');
doc = await checkInSync('表の行末で Enter');
check('表の行末で Enter: 改行して次の行を打てる', doc.split('\n')[3] === '| みかん | 3 |' && doc.split('\n')[2] === '| りんご | 12 |', doc.split('\n').slice(2, 5));

// 17. 表: ソースで省略されたセルは空の箱で列をそろえる。セルの中の裸の URL
const sparseDoc = ['| h1 | h2 | h3 |', '|---|---|---|', '| https://example.com |', '', '後'];
await loadDoc(sparseDoc);
const bareUrl = await web("[...document.querySelectorAll('.cm-md-trow .cm-md-link')].map((e) => e.textContent).join()");
check('表のセルの裸の URL をリンクとして描く', bareUrl === 'https://example.com', bareUrl);
check('ソースで省略されたセルは、空の箱で列をそろえる', (await web("document.querySelectorAll('.cm-md-tcell-missing').length")) === 2 && (await tableState()).aligned);

// 18. 引用の中の表も、表の行として描く
const quotedDoc = ['前', '', '> | a | b |', '> |---|---|', '> | 1 | 2 |', '', '後'];
await loadDoc(quotedDoc);
ts = await tableState();
check('引用の中の表: 表の行にして列をそろえる', ts.rows === 3 && ts.aligned, ts);

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
  const right = Math.max(...[...document.querySelector('.cm-md-trow-head').children].map((e) => e.getBoundingClientRect().right));
  return { tools: box('.cm-md-table-tools'), table: { right }, content: box('.cm-content') };
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
  const cellImage = await web("document.querySelector('.cm-md-trow .cm-md-image')?.textContent");
  check('表のセルの画像は、本文と同じくソースのまま出す', cellImage === '![red](pic.png)', cellImage);
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
const cellLinks = () => web("JSON.stringify([...document.querySelectorAll('.cm-md-trow .cm-md-link')].map((e) => [e.textContent, e.getAttribute('data-href')]))").then(JSON.parse);
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

// 32. Ctrl+Shift+O で見出しの一覧を出し、選んだ見出しに移る。選ばずに閉じたら元の位置に戻る
await loadDoc(['# 最初', '', ...Array.from({ length: 60 }, (_, i) => `行 ${i + 1}`), '', '## 二つ目の見出し', '', '後']);
await clickPos(0);
const pickState = () => cdp.evaluateIn(mainCtx, `JSON.stringify((() => {
  const w = document.querySelector('.quick-input-widget');
  const open = !!w && getComputedStyle(w).display !== 'none';
  return { open, items: open ? [...w.querySelectorAll('.monaco-list-row')].map((r) => r.textContent) : [] };
})())`).then(JSON.parse);
await press(cdp, 'o', MOD | SHIFT);
await sleep(800);
const picked = await pickState();
check('Ctrl+Shift+O: 見出しの一覧を出す', picked.open && picked.items.length === 2 && picked.items[1].includes('二つ目の見出し'), picked);
await press(cdp, 'Escape');
await sleep(500);
check('見出しの一覧を選ばずに閉じると、カーソルは元の位置', (await web('__hushmarkView.state.selection.main.head')) === 0);
await press(cdp, 'o', MOD | SHIFT);
await sleep(800);
await type(cdp, '二つ目');
await sleep(500);
await press(cdp, 'Enter');
await sleep(800);
const headingLine = await web('__hushmarkView.state.doc.lineAt(__hushmarkView.state.selection.main.head).text');
check('見出しの一覧で選ぶと、その見出しに移る', headingLine === '## 二つ目の見出し', headingLine);
check('見出しに移った後は、エディタにフォーカスがある', await web('__hushmarkView.hasFocus'));

// 33. 画像を貼り付けると、文書と同じフォルダーに保存して画像のリンクを入れる。エクスプローラーから
// ドロップしたファイルには、相対パスのリンクを入れる
if (!remote) {
  const dir = path.dirname(file);
  fs.rmSync(path.join(dir, 'shot.png'), { force: true });
  await loadDoc(['貼る: ', '', '後']);
  await web(`(() => {
    const v = __hushmarkView;
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.line(1).to } });
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'shot.png', { type: 'image/png' }));
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await sleep(800);
  doc = await checkInSync('画像の貼り付け');
  check('画像を貼り付けると、保存して画像のリンクを入れる', doc.startsWith('貼る: ![shot](shot.png)') &&
    fs.existsSync(path.join(dir, 'shot.png')), doc.split('\n')[0]);

  fs.mkdirSync(path.join(dir, 'sub dir'), { recursive: true });
  const dropped = pathToFileURL(path.join(dir, 'sub dir', 'other.md')).href;
  await loadDoc(['落とす', '', '後']);
  await web(`(() => {
    const v = __hushmarkView;
    const c = v.coordsAtPos(v.state.doc.line(1).to);
    const data = new DataTransfer();
    data.setData('text/uri-list', ${JSON.stringify(dropped)});
    v.contentDOM.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: c.right + 2, clientY: (c.top + c.bottom) / 2, bubbles: true, cancelable: true }));
  })()`);
  await sleep(800);
  doc = await checkInSync('ファイルのドロップ');
  check('ドロップしたファイルに、相対パスのリンクを入れる', doc.startsWith('落とす[other.md](<sub dir/other.md>)'), doc.split('\n')[0]);
}
// 32. VSCode のテキストエディタと同じ編集の操作（コマンドとして VSCode を経由する）
const lines = () => webDoc().then((d) => d.split('\n'));
const headIs = () => web('JSON.stringify(__hushmarkView.state.selection.ranges.map((r) => [r.anchor, r.head]))').then(JSON.parse);
const at = (text, offset = 0) => web(`__hushmarkView.state.doc.toString().indexOf(${JSON.stringify(text)}) + ${offset}`);
await loadDoc(['一', '二', '三', '', '後']);
await clickPos(await at('二'));
await press(cdp, 'ArrowDown', ALT);
await sleep(300);
check('Alt+↓: 行を下へ移動する', (await lines()).slice(0, 3).join() === '一,三,二', await lines());
await press(cdp, 'ArrowUp', ALT);
await sleep(300);
await press(cdp, 'ArrowDown', isMac ? SHIFT | ALT : (process.platform === 'linux' ? CTRL | SHIFT | ALT : SHIFT | ALT));
await sleep(300);
check('行を下へコピー', (await lines()).slice(0, 4).join() === '一,二,二,三', await lines());
await press(cdp, 'k', MOD | SHIFT);
await sleep(300);
check('Ctrl+Shift+K: 行を削除する', (await lines()).slice(0, 3).join() === '一,二,三', await lines());
// 行を削除すると、VSCode と同じくカーソルは次の行（三）に移る
await press(cdp, '/', MOD);
await sleep(300);
check('Ctrl+/: 行を <!-- --> で囲む', (await lines())[2] === '<!-- 三 -->', await lines());
await press(cdp, '/', MOD);
await sleep(300);
await press(cdp, 'Enter', MOD);
// キーは VSCode のコマンドを経由するので、打つ前に操作が届くのを待つ（往復は 10〜40 ms）
await sleep(300);
await type(cdp, '新');
await sleep(300);
doc = await checkInSync('行の操作');
check('Ctrl+Enter: 下に行を足してカーソルを移す', doc.split('\n').slice(0, 4).join() === '一,二,三,新', doc.split('\n'));

// 複数カーソル: Ctrl+D で次の一致を足し、打つとどちらも置き換わる
await loadDoc(['りんご と りんご', '', '後']);
await selectText('りんご');
await press(cdp, 'd', MOD);
await sleep(300);
check('Ctrl+D: 次の一致を選択に足す', (await headIs()).length === 2, await headIs());
check('2 つ目の選択範囲を描く', (await web("document.querySelectorAll('.cm-md-secondary-selection').length")) === 1);
await type(cdp, 'みかん');
doc = await checkInSync('複数カーソルでの入力');
check('複数カーソルで打つと、すべての位置に入る', doc.split('\n')[0] === 'みかん と みかん', doc.split('\n')[0]);

// Alt+クリックでカーソルを足す
await clickPos(await at('みかん'));
const second = await toPage(JSON.parse(await web(`JSON.stringify((() => { const c = __hushmarkView.coordsAtPos(${await at('と みかん', 2)}); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; })())`)));
for (const t of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type: t, x: second.x, y: second.y, button: 'left', clickCount: 1, modifiers: ALT });
await sleep(300);
check('Alt+クリック: カーソルを足す', (await headIs()).length === 2, await headIs());
await press(cdp, 'Escape');

// 選択範囲の拡大と縮小
await loadDoc(['本文の **太字の語** です', '', '後']);
await clickPos(await at('の語'));
await press(cdp, 'ArrowRight', isMac ? CTRL | SHIFT | META : SHIFT | ALT);
await sleep(200);
const expanded = await web('(() => { const s = __hushmarkView.state.selection.main; return __hushmarkView.state.sliceDoc(s.from, s.to); })()');
await press(cdp, 'ArrowRight', isMac ? CTRL | SHIFT | META : SHIFT | ALT);
await sleep(200);
await press(cdp, 'ArrowLeft', isMac ? CTRL | SHIFT | META : SHIFT | ALT);
await sleep(200);
const shrunk = await web('(() => { const s = __hushmarkView.state.selection.main; return __hushmarkView.state.sliceDoc(s.from, s.to); })()');
check('Shift+Alt+→ / ←: 構文に沿って選択範囲を広げ、縮めると前の範囲に戻る', expanded.length > 0 && shrunk === expanded, { expanded, shrunk });

// 折りたたみ: 見出しの節を畳む
await loadDoc(['# 見出し', '', '節の本文', '', '## 次の見出し', '', '後']);
await clickPos(await at('見出し'));
await press(cdp, '[', isMac ? META | ALT : CTRL | SHIFT);
await sleep(300);
const hiddenLine = await web("[...document.querySelectorAll('.cm-line')].some((l) => l.textContent.includes('節の本文'))");
check('Ctrl+Shift+[: 見出しの節を折りたたむ', hiddenLine === false && (await web("document.querySelectorAll('.cm-md-fold-placeholder').length")) === 1);
await press(cdp, ']', isMac ? META | ALT : CTRL | SHIFT);
await sleep(300);
check('Ctrl+Shift+]: 展開する', (await web("[...document.querySelectorAll('.cm-line')].some((l) => l.textContent.includes('節の本文'))")) === true);

// 33. 選択範囲を記号で囲み、括弧は自動で閉じる（VSCode の Markdown の言語設定と同じ）
await loadDoc(['語を囲む', '', '後']);
await selectText('囲む');
await type(cdp, '*');
await sleep(200);
check('選択して * を打つ: 選択範囲を * で囲む', (await lines())[0] === '語を*囲む*', await lines());
await clickPos(await web('__hushmarkView.state.doc.line(1).to'));
await type(cdp, '(');
await sleep(200);
check('( を打つ: ) を自動で閉じる', (await lines())[0] === '語を*囲む*()', await lines());
await press(cdp, 'z', MOD);
await press(cdp, 'z', MOD);
await sleep(300);
await checkInSync('囲む操作の取り消し');

// 34. ステータスバーに行と列を出し、Ctrl+G で行に移る
await loadDoc(['一行目', '二行目の文', '三行目', '', '後']);
await clickPos(await at('の文', 1));
await sleep(400);
const statusText = () => cdp.evaluateIn(mainCtx, "[...document.querySelectorAll('.statusbar-item')].map((e) => e.textContent.trim()).find((t) => /^Ln \\d+, Col \\d+/.test(t)) || null");
check('ステータスバーに行と列を出す', (await statusText()) === 'Ln 2, Col 5', await statusText());
await selectText('二行目');
await sleep(400);
check('ステータスバーに選択した文字数を出す', (await statusText()) === 'Ln 2, Col 4 (3 selected)', await statusText());
await press(cdp, 'g', CTRL);
await sleep(600);
await type(cdp, '3');
await press(cdp, 'Enter');
await sleep(500);
check('Ctrl+G: 入力した行に移る', (await web('__hushmarkView.state.doc.lineAt(__hushmarkView.state.selection.main.head).number')) === 3);

// 35. テキストエディタとの切り替えで、カーソルの位置を引き継ぐ
await clickPos(await at('の文', 1));
await sleep(300);
await cdp.evaluateIn(mainCtx, `document.querySelector('.editor-actions a.action-label[aria-label^="Open in Text Editor"]')?.click()`);
await sleep(2500);
const textEditorStatus = await cdp.evaluateIn(mainCtx, "document.querySelector('#status\\\\.editor\\\\.selection')?.textContent.trim() ?? null");
check('テキストエディタで開き直すと、カーソルの位置を引き継ぐ', /^Ln 2, Col 5/.test(textEditorStatus || ''), textEditorStatus);
await cdp.evaluateIn(mainCtx, `document.querySelector('.editor-actions a.action-label[aria-label^="Open in Live Editor"]')?.click()`);
await sleep(3000);
const reopened = await cdp.findContext('!!window.__hushmarkView && __hushmarkView.dom.getBoundingClientRect().width > 0', 15000);
const backHead = await cdp.evaluateIn(reopened, '(() => { const v = __hushmarkView; const h = v.state.selection.main.head; const l = v.state.doc.lineAt(h); return [l.number, h - l.from]; })()');
check('このエディタで開き直すと、テキストエディタのカーソルの位置を引き継ぐ', JSON.stringify(backHead) === '[2,4]', backHead);

// 36. 他の拡張機能の機能（test/e2e/fixture が代わりをする）。Remote-SSH では手元に読み込まれないので確かめない
if (!remote) {
  await loadDoc(['This is teh text.', '', 'Alpha and Alpha. See ISSUE-123.', '', 'trailing ', '', '後']);
  for (let i = 0; i < 20 && (await web("document.querySelectorAll('.cm-md-diag').length")) === 0; i++) await sleep(500);
  check('診断: 他の拡張機能の警告に波線を引く', (await web("[...document.querySelectorAll('.cm-md-diag-warning')].map((e) => e.textContent).join()")) === 'teh');
  await clickPos(0);
  await press(cdp, 'F8');
  await sleep(400);
  check('F8: 次の診断に移り、メッセージを出す', (await web("document.querySelector('.cm-md-diag-tooltip')?.textContent")) === "Did you mean 'the'? fixture(typo)" &&
    (await web('__hushmarkView.state.selection.main.head')) === (await at('teh')));

  // クイックフィックス（Ctrl+.）で選んだものを行う
  await press(cdp, '.', MOD);
  await sleep(800);
  await press(cdp, 'Enter');
  await sleep(500);
  doc = await checkInSync('クイックフィックス');
  check('Ctrl+.: 他の拡張機能のクイックフィックスを選んで行う', doc.split('\n')[0] === 'This is the text.', doc.split('\n')[0]);

  // ドキュメントリンク
  for (let i = 0; i < 10 && (await web("document.querySelectorAll('.cm-md-doclink').length")) === 0; i++) await sleep(300);
  check('他の拡張機能のドキュメントリンクを、Ctrl+クリックで開けるようにする',
    (await web("document.querySelector('.cm-md-doclink')?.getAttribute('data-href')")) === 'https://example.com/issues/123');

  // リネーム（F2）
  await clickPos(await at('Alpha', 1));
  await press(cdp, 'F2');
  await sleep(800);
  await press(cdp, 'a', MOD);
  await type(cdp, 'Beta');
  await press(cdp, 'Enter');
  await sleep(600);
  doc = await checkInSync('リネーム');
  check('F2: 他の拡張機能のリネームで書き換える', doc.split('\n')[2] === 'Beta and Beta. See ISSUE-123.', doc.split('\n')[2]);

  // ドキュメントの書式設定
  await clickPos(0);
  await press(cdp, process.platform === 'linux' ? 'i' : 'f', process.platform === 'linux' ? CTRL | SHIFT : SHIFT | ALT);
  await sleep(800);
  doc = await checkInSync('書式設定');
  check('ドキュメントの書式設定: 他の拡張機能の書式設定を当てる', doc.split('\n')[4] === 'trailing', JSON.stringify(doc.split('\n')[4]));

  // 補完: 補完が始まる文字（@）を打つと、他の拡張機能の候補を出す
  await clickPos(await web('__hushmarkView.state.doc.line(1).to'));
  await type(cdp, ' @');
  await sleep(200);
  await type(cdp, 'fix');
  for (let i = 0; i < 10 && (await web("document.querySelectorAll('.cm-tooltip-autocomplete li').length")) === 0; i++) await sleep(300);
  check('補完: 他の拡張機能の候補を一覧に出す', (await web("[...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((e) => e.textContent).join()")).includes('fixture-item'));
  await press(cdp, 'Enter');
  await sleep(300);
  doc = await checkInSync('補完');
  // 候補が範囲を指定していないので、VSCode の既定のとおり、カーソルの前の単語（fix）だけを置き換える
  check('補完: 選んだ候補を入れる', doc.split('\n')[0] === 'This is the text. @fixture-item', doc.split('\n')[0]);

  // 画像の貼り付けの保存先（markdown.copyFiles.destination）
  const settingsFile = path.join(path.dirname(file), '..', 'ud', 'User', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, ''));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, 'markdown.copyFiles.destination': { '**/*.md': 'assets/${documentBaseName}/${fileName}' } }, null, 2));
  await sleep(1500);
  await loadDoc(['貼る: ', '', '後']);
  await web(`(() => {
    const v = __hushmarkView;
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.line(1).to } });
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'pic.png', { type: 'image/png' }));
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await sleep(800);
  doc = await checkInSync('保存先の設定');
  const base = path.basename(file).replace(/\.[^.]*$/, '');
  check('markdown.copyFiles.destination: 設定した場所に保存してリンクを入れる',
    doc.startsWith(`貼る: ![pic](assets/${base}/pic.png)`) && fs.existsSync(path.join(path.dirname(file), 'assets', base, 'pic.png')), doc.split('\n')[0]);
  // 保存時の書式設定（editor.formatOnSave）。VSCode の保存の処理が、このエディタで編集した文書にも書式設定を当てる
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, 'editor.formatOnSave': true }, null, 2));
  await sleep(1500);
  await loadDoc(['保存で整える ', '', '後']);
  await clickPos(await web('__hushmarkView.state.doc.line(3).to'));
  await type(cdp, '!');
  doc = await checkInSync('保存時の書式設定');
  check('editor.formatOnSave: 保存すると他の拡張機能の書式設定を当てる', readFile().replace(/\r\n/g, '\n').split('\n')[0] === '保存で整える', JSON.stringify(readFile().split(/\r?\n/)[0]));
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

finish();

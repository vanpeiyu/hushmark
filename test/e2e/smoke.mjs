// 主な操作が動くかを短く確かめる（macOS と Windows の CI で実行するもの。細かい確認は run.mjs で Linux だけで行う）。
// OS ごとに違うキー操作（macOS の Cmd・Cmd+Option）と、保存したときの改行コードを中心に見る。
// 使い方: npm run test:e2e -- smoke

import { ALT, MOD, isMac, press, sleep, type } from './cdp.mjs';
import { openSession } from './session.mjs';

const { web, cdp, check, finish, clickPos, clickSelector, webDoc, readFile, checkInSync } = await openSession();

const original = await webDoc();
check('開く: ファイルと表示が一致', original === readFile().replace(/\r\n/g, '\n'));
check('開く: カーソルのない見出しの「#」を隠す', await web("!!document.querySelector('.cm-md-heading-mark.cm-md-conceal')"));

// 編集と保存、取り消し
const line3End = await web('__hushmarkView.state.doc.line(3).to');
await clickPos(line3End);
await type(cdp, '追記');
let doc = await checkInSync('追記');
check('追記: 段落の末尾に入った', doc.split('\n')[2].endsWith('追記'), doc.split('\n')[2]);
await press(cdp, 'z', MOD);
await sleep(200);
doc = await checkInSync('取り消し');
check('取り消し: 元に戻った', doc === original);

// 表のセル
await clickSelector('.cm-md-table td', 1); // 「120」
await press(cdp, 'End');
await type(cdp, '0');
doc = await checkInSync('表のセル');
check('表のセル: 文書に反映された', doc.includes('| りんご | 1200 |'), doc.split('\n')[8]);
await press(cdp, 'Escape');
await sleep(200);

// 検索。開くキー、条件の切り替え、置換の欄を出すキーは OS で違う
const findState = async () => JSON.parse(await web(`JSON.stringify({
  open: !!document.querySelector('.cm-md-find'),
  value: document.querySelector('.cm-md-find-input')?.value ?? null,
  caseOn: document.querySelector('.cm-md-find-toggle')?.getAttribute('aria-pressed') === 'true',
  replaceShown: !!document.querySelector('.cm-md-find-replace-row:not([hidden])'),
  caseTitle: document.querySelector('.cm-md-find-toggle')?.title ?? null,
})`));
await web("(() => { const v = __hushmarkView; const f = v.state.doc.toString().indexOf('みかん'); v.focus(); v.dispatch({ selection: { anchor: f, head: f + 3 } }); })()");
await press(cdp, 'f', MOD);
await sleep(300);
let find = await findState();
check('検索を開く: 選択中の文字列を検索語にする', find.open && find.value === 'みかん', find);
check('検索: ボタンの説明は OS のキーで書く', find.caseTitle && find.caseTitle.includes(isMac ? '⌥⌘C' : 'Alt+C'), find);
await press(cdp, 'c', isMac ? MOD | ALT : ALT);
await sleep(150);
check('検索: 大文字と小文字の区別を切り替える', (await findState()).caseOn);
await press(cdp, ...(isMac ? ['f', MOD | ALT] : ['h', MOD]));
await sleep(150);
check('検索: 置換の欄を出す', (await findState()).replaceShown);
await press(cdp, 'Escape');
await sleep(150);
check('検索: 閉じる', !(await findState()).open);

// リンクの説明は OS のキーで書く
const linkTitle = await web("document.querySelector('.cm-md-link')?.title ?? null");
check('リンク: 開く操作の説明は OS のキーで書く', linkTitle && linkTitle.endsWith(`${isMac ? 'Cmd' : 'Ctrl'}+Click to open`), linkTitle);

// 折り返しの切り替え
const wrapped = () => web("__hushmarkView.contentDOM.classList.contains('cm-lineWrapping')");
const before = await wrapped();
await press(cdp, 'z', ALT);
await sleep(200);
check('Alt+Z: 折り返しを切り替える', (await wrapped()) !== before);
await press(cdp, 'z', ALT);

finish();

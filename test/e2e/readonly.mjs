// 読み取り専用のファイルを開いたとき、入力・表のセル・チェックボックスで文書が変わらないことを確かめる。
// VSCode と同じく、ファイルの属性による読み取り専用は files.readonlyFromPermissions が有効なときだけ効く。
// 使い方: npm run test:e2e -- readonly（files.readonlyFromPermissions を有効にし、ファイルを読み取り専用にして開く）

import fs from 'node:fs';
import path from 'node:path';
import { sleep, type } from './cdp.mjs';
import { openSession } from './session.mjs';

const { cdp, file, web, check, finish, clickAt } = await openSession();

// 拡張機能本体が読み取り専用を調べて知らせるまで待つ
for (let i = 0; i < 30 && !(await web('__hushmarkView.state.readOnly')); i++) await sleep(200);
check('読み取り専用のファイルでは、エディタを読み取り専用にする', await web('__hushmarkView.state.readOnly'));

const original = await web('__hushmarkView.state.doc.toString()');
const disk = fs.readFileSync(file, 'utf8');

await clickAt('__hushmarkView.coordsAtPos(__hushmarkView.state.doc.line(3).to)');
await clickAt('__hushmarkView.coordsAtPos(__hushmarkView.state.doc.line(3).to)');
await type(cdp, '追記');
await sleep(300);
check('入力しても文書は変わらない', (await web('__hushmarkView.state.doc.toString()')) === original);

await clickAt("document.querySelectorAll('.cm-md-table td')[1].getBoundingClientRect()");
await type(cdp, '0');
await sleep(300);
check('表のセルに入力しても文書は変わらない', (await web('__hushmarkView.state.doc.toString()')) === original);

await clickAt("document.querySelector('.cm-md-checkbox').getBoundingClientRect()");
await sleep(300);
check('チェックボックスを押しても文書は変わらない', (await web('__hushmarkView.state.doc.toString()')) === original);
check('ファイルも変わらない', fs.readFileSync(file, 'utf8') === disk);

// files.readonlyFromPermissions を切ると、開いたままのエディタも編集できるようになる。
// 設定のファイルは、作業フォルダの ud/User にある（vscode.mjs）
const settingsFile = path.join(path.dirname(file), '..', 'ud', 'User', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, ''));
fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, 'files.readonlyFromPermissions': false }, null, 2));
for (let i = 0; i < 30 && (await web('__hushmarkView.state.readOnly')); i++) await sleep(200);
check('設定を変えると、読み取り専用を解除する', !(await web('__hushmarkView.state.readOnly')));

finish();

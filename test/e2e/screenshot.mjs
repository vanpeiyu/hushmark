// 起動中の E2E 用 VSCode の画面を保存する。見た目を確かめるとき用。
// 使い方（npm run test:e2e -- <テスト> --keep で、テストの後も VSCode を開いたままにしておく。
// E2E_PORT には、そのときに表示されるポートを入れる）:
//   node test/e2e/screenshot.mjs <保存先.png>                 そのまま保存する
//   node test/e2e/screenshot.mjs <保存先.png> 2               2 番目の td を編集した状態で保存する
//   node test/e2e/screenshot.mjs <保存先.png> "select:本文..code"  「本文」から「code」の終わりまでを選択して保存する

import fs from 'node:fs';
import { sleep } from './cdp.mjs';
import { openSession } from './session.mjs';

const [out, action] = process.argv.slice(2);
if (!out) throw new Error('保存先を指定する');

const { cdp, web, clickSelector } = await openSession(null);
await sleep(1500);

if (action && action.startsWith('select:')) {
  const [start, end] = action.slice('select:'.length).split('..');
  await web(`(() => {
    const v = __hushmarkView;
    const text = v.state.doc.toString();
    const from = text.indexOf(${JSON.stringify(start)});
    const to = text.indexOf(${JSON.stringify(end)}, from) + ${JSON.stringify(end)}.length;
    v.focus();
    v.dispatch({ selection: { anchor: from, head: to } });
  })()`);
  await sleep(300);
} else if (action !== undefined) {
  await clickSelector('.cm-md-table td', Number(action));
  await sleep(400);
}
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(data, 'base64'));
cdp.close();

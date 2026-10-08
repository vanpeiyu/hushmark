// ウィンドウを再読み込みしても、カーソルとスクロールの位置が元に戻ることを確かめる。
// 使い方: npm run test:e2e -- restore

import { liveEditorContext, press, sleep, type } from './cdp.mjs';
import { openSession } from './session.mjs';

const { cdp, web, check, finish, loadDoc, clickPos } = await openSession();

const lines = Array.from({ length: 300 }, (_, i) => `行 ${i + 1}`);
await loadDoc(lines);
const target = await web('__hushmarkView.state.doc.line(200).from + 2');
await clickPos(target);
// 位置の保存は少し遅らせて行う
await sleep(800);

// コマンドパレットから Developer: Reload Window を実行する（VSCode が Webview の状態を保存してから読み込み直す）
await press(cdp, 'F1');
await sleep(500);
await type(cdp, 'Developer: Reload Window');
await sleep(800);
await press(cdp, 'Enter');
await sleep(4000);
await cdp.findContext("!!document.querySelector('.monaco-workbench')", 60000);
const webCtx = await liveEditorContext(cdp);
let restored = null;
for (let i = 0; i < 30; i++) {
  restored = JSON.parse(await cdp.evaluateIn(webCtx, `JSON.stringify((() => {
    const v = __hushmarkView;
    const head = v.state.selection.main.head;
    const top = v.coordsAtPos(head)?.top - v.scrollDOM.getBoundingClientRect().top;
    return { head, top, height: v.scrollDOM.clientHeight };
  })())`));
  if (restored.head === target) break;
  await sleep(200);
}
check('再読み込み後: カーソルが元の位置に戻る', restored.head === target, { restored, target });
check('再読み込み後: カーソルのある行が画面に出る', restored.top >= 0 && restored.top < restored.height, restored);

finish();

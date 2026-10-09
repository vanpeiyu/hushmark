// E2E テストのスクリプトに共通の部分。起動中の VSCode につなぎ、Hushmark の Webview を操作する道具と、
// 結果の集計を用意する。スクリプトは test/e2e/index.mjs が、開いたファイルのパスを引数にして実行する。

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MOD, click, connect, liveEditorContext, press, sleep } from './cdp.mjs';

/** @param {string | null} file 開いているファイルのパス。ファイルを読み書きしないスクリプトでは null */
export async function openSession(file = process.argv[2]) {
  if (file === undefined) throw new Error('開いているファイルのパスを指定する');
  // Remote-SSH で開いたときは E2E_REMOTE に ssh のホスト名が入る。file は接続先のパス
  const remote = process.env.E2E_REMOTE;

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || detail === undefined ? '' : `\n     ${JSON.stringify(detail)}`}`);
  };

  const cdp = await connect();
  const mainCtx = await cdp.findContext("!!document.querySelector('.monaco-workbench')");
  const webCtx = await liveEditorContext(cdp);
  const frameCtx = await cdp.findContext("!!document.getElementById('active-frame')");
  const web = (expr) => cdp.evaluateIn(webCtx, expr);

  /** Webview 内の座標をページ全体の座標に直す */
  async function toPage({ x, y }) {
    const outer = await cdp.evaluateIn(mainCtx, `(() => { const r = [...document.querySelectorAll('iframe.webview')].find((f) => f.getBoundingClientRect().width > 0).getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    const inner = await cdp.evaluateIn(frameCtx, `(() => { const r = document.getElementById('active-frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    return { x: outer.x + inner.x + x, y: outer.y + inner.y + y };
  }

  /** Webview 内の式（getBoundingClientRect などの矩形）の左寄りをクリックする */
  async function clickAt(expression) {
    const c = JSON.parse(await web(`JSON.stringify((() => { const r = ${expression}; return { x: r.left + Math.min(4, r.width / 2), y: (r.top + r.bottom) / 2 }; })())`));
    const p = await toPage(c);
    await click(cdp, p.x, p.y);
    await sleep(200);
  }

  /** 文書の位置をクリックする */
  async function clickPos(pos) {
    // 画面の外の位置はクリックできないので、先にその行までスクロールする
    await web(`(() => { const v = __hushmarkView; const top = v.lineBlockAt(${pos}).top; const s = v.scrollDOM; if (top < s.scrollTop || top > s.scrollTop + s.clientHeight - 60) s.scrollTop = Math.max(0, top - 100); })()`);
    await sleep(100);
    const c = await web(`(() => { const c = __hushmarkView.coordsAtPos(${pos}); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; })()`);
    const p = await toPage(c);
    await click(cdp, p.x, p.y);
    await sleep(150);
  }

  /** セレクタに合う index 番目の要素の中央をクリックする */
  async function clickSelector(selector, index = 0) {
    await web(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].scrollIntoView({ block: 'center' })`);
    await sleep(100);
    const c = await web(`(() => { const r = document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const p = await toPage(c);
    await click(cdp, p.x, p.y);
    await sleep(150);
  }

  /** 表の上のボタンを押す。ボタンは表にマウスを載せている間だけ押せるので、表から順にマウスを動かす */
  async function clickTableTool(index) {
    await web(`document.querySelector('.cm-md-table-block').scrollIntoView({ block: 'center' })`);
    await sleep(100);
    const center = (selector, i) => web(`(() => { const r = document.querySelectorAll(${JSON.stringify(selector)})[${i}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const table = await toPage(await center('.cm-md-trow-head', 0));
    const button = await toPage(await center('.cm-md-table-tools button', index));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: table.x, y: table.y });
    await sleep(250);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    await sleep(100);
    await click(cdp, button.x, button.y);
    await sleep(150);
  }

  const webDoc = () => web('__hushmarkView.state.doc.toString()');
  const readFile = () => (remote
    ? execFileSync('ssh', [remote, `cat '${file}'`], { encoding: 'utf8' })
    : fs.readFileSync(file, 'utf8'));
  const writeFile = (text) => (remote
    ? execFileSync('ssh', [remote, `cat > '${file}'`], { input: text })
    : fs.writeFileSync(file, text));

  /** ファイルを外で書き換え（改行は CRLF）、エディタに届くまで待つ */
  async function loadDoc(lines) {
    writeFile(lines.join('\r\n'));
    for (let i = 0; i < 30 && (await webDoc()) !== lines.join('\n'); i++) await sleep(200);
    await sleep(300);
  }

  async function save() {
    await press(cdp, 's', MOD);
    await sleep(600);
    return readFile();
  }

  /** 保存したファイルと Webview の内容が一致し、改行が CRLF のままかを確かめる */
  async function checkInSync(name) {
    await sleep(200);
    const disk = await save();
    const doc = await webDoc();
    const lfOnly = disk.replace(/\r\n/g, '').includes('\n');
    check(`${name}: ファイルと表示が一致`, disk.replace(/\r\n/g, '\n') === doc, { disk: disk.slice(-200), doc: doc.slice(-200) });
    check(`${name}: 改行は CRLF のまま`, !lfOnly);
    return doc;
  }

  /** 結果を出して終わる。失敗があれば終了コード 1 */
  function finish() {
    cdp.close();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }

  return {
    file, remote, cdp, mainCtx, web, check, finish,
    toPage, clickAt, clickPos, clickSelector, clickTableTool,
    webDoc, readFile, writeFile, loadDoc, save, checkInSync,
  };
}

// README の GIF（docs/images/demo.gif）を録る。E2E テストと同じく VSCode を起動して DevTools プロトコルで操作し、
// 操作ごとに画面を撮ってつなぐ（コマ撮り）。撮る速さに左右されないので、遅いマシンでも同じ GIF になる。
// 使い方: npm run demo（Docker の Linux のコンテナで、仮想のディスプレイを使って録る）
//         node test/demo/record.mjs [--out <path>]（画面のあるマシンで直接録る）

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
import omggif from 'omggif';

const { applyPalette, quantize } = gifenc;
import { connect, liveEditorContext, press, sleep, type } from '../e2e/cdp.mjs';
import { extensionRoot, launch } from '../e2e/vscode.mjs';

const { values: options } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(extensionRoot, 'docs/images/demo.gif') },
    // 撮った画面を PNG でも書き出す（確かめるとき）
    frames: { type: 'string' },
  },
});

const DOCUMENT = `# Trip Notes

Markdown markers show up **only where your cursor is**.
Everything else stays clean, like a *preview*.

## Packing list

- [x] Passport
- [ ] Charger
- Snacks for the \`train\`

## Budget

| Item | Cost |
|:--|--:|
| Hotel | 240 |
| Train | 85 |

> Write Markdown and see the result in the same place.

`;

/** ページ（ワークベンチ）の大きさ。撮るのはエディタの部分だけ */
const PAGE = { width: 760, height: 860 };

const vscode = await launch({
  workDir: path.join(extensionRoot, '.e2e'),
  document: { name: 'notes.md', text: DOCUMENT },
  settings: {
    'workbench.colorTheme': 'Default Light Modern',
    'workbench.activityBar.location': 'hidden',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.statusBar.visible': false,
    'workbench.layoutControl.enabled': false,
    'window.commandCenter': false,
    'editor.fontSize': 15,
    'editor.lineNumbers': 'off',
    'hushmark.previewColor': 'blue',
    'hushmark.debugLog': false,
  },
});

const cdp = await connect(vscode.port);
await cdp.send('Emulation.setDeviceMetricsOverride', { ...PAGE, deviceScaleFactor: 1, mobile: false });
const mainCtx = await cdp.findContext("!!document.querySelector('.monaco-workbench')");
const main = (expr) => cdp.evaluateIn(mainCtx, expr);
await sleep(3000);
const webCtx = await liveEditorContext(cdp);
// サイドバーを閉じて、エディタを広く撮る
await press(cdp, 'F1');
await sleep(500);
await type(cdp, 'View: Close Primary Side Bar');
await sleep(800);
await press(cdp, 'Enter');
await sleep(1000);
const web = (expr) => cdp.evaluateIn(webCtx, expr);
const frameCtx = await cdp.findContext("!!document.getElementById('active-frame')");

// カーソルを点滅させない（撮るたびに出たり消えたりしないように）
await web(`document.head.insertAdjacentHTML('beforeend', '<style>.cm-cursorLayer { animation: none !important; }</style>')`);

// マウスのポインター。スクリーンショットには写らないので、ワークベンチの上に描く
await main(`(() => {
  const p = document.createElement('div');
  p.id = 'demo-pointer';
  // ワークベンチは Trusted Types で innerHTML を禁じているので、要素を組み立てる
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const arrow = document.createElementNS(ns, 'path');
  for (const [k, v] of [['width', 22], ['height', 26], ['viewBox', '0 0 22 26']]) svg.setAttribute(k, v);
  for (const [k, v] of [['d', 'M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.5 15 L17 15 Z'], ['fill', '#000'], ['stroke', '#fff'], ['stroke-width', 1.5], ['stroke-linejoin', 'round']]) arrow.setAttribute(k, v);
  svg.appendChild(arrow);
  p.appendChild(svg);
  Object.assign(p.style, { position: 'fixed', left: '-40px', top: '-40px', zIndex: 100000, pointerEvents: 'none' });
  document.body.appendChild(p);
})()`);

/** 撮る範囲（エディタの部分） */
const clip = JSON.parse(await main(`JSON.stringify((() => { const r = document.querySelector('.part.editor').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })())`));

/** 撮った画面（PNG のまま持ち、最後にまとめて GIF にする） */
const frames = [];
async function shot(delay) {
  await sleep(60);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  frames.push({ png: Buffer.from(data, 'base64'), delay });
}

/** Webview の中の座標をページの座標に直す */
async function toPage({ x, y }) {
  const outer = await main(`(() => { const r = [...document.querySelectorAll('iframe.webview')].find((f) => f.getBoundingClientRect().width > 0).getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  const inner = await cdp.evaluateIn(frameCtx, `(() => { const r = document.getElementById('active-frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  return { x: outer.x + inner.x + x, y: outer.y + inner.y + y };
}

let pointer = { x: PAGE.width * 0.7, y: PAGE.height * 0.85 };
const placePointer = ({ x, y }) => main(`Object.assign(document.getElementById('demo-pointer').style, { left: '${x - 2}px', top: '${y - 2}px' })`);

/** ポインターを動かしてクリックする */
async function clickAt(target, { modifiers = 0 } = {}) {
  const steps = 8;
  const from = pointer;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    await placePointer({ x: from.x + (target.x - from.x) * ease, y: from.y + (target.y - from.y) * ease });
    await shot(40);
  }
  pointer = target;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1, modifiers });
  }
  await sleep(150);
}

/** 文書の中の文字列（after 文字目）をクリックする */
async function clickText(text, after = 0) {
  const c = JSON.parse(await web(`JSON.stringify((() => { const v = __hushmarkView; const c = v.coordsAtPos(v.state.doc.toString().indexOf(${JSON.stringify(text)}) + ${after}); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; })())`));
  await clickAt(await toPage(c));
}

/** 要素の中央をクリックする */
async function clickElement(selector, index = 0) {
  const c = JSON.parse(await web(`JSON.stringify((() => { const r = document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
  await clickAt(await toPage(c));
}

/** 1 文字ずつ打つ */
async function typeSlowly(text) {
  for (const ch of text) {
    await type(cdp, ch);
    await shot(70);
  }
}

// ---- 操作 ----
// 最初は文書の末尾（空の行）にカーソルを置き、記号をすべて隠した状態を見せる
await web('(() => { const v = __hushmarkView; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); })()');
await shot(1800);

// 太字の中をクリックすると、その太字の記号だけが出る
await clickText('only where', 3);
await shot(1600);

// 見出しをクリックすると、# が左の余白に出る
await clickText('Packing list', 4);
await shot(1400);

// チェックボックスをクリックして切り替える
await clickElement('.cm-md-checkbox', 1);
await shot(1200);

// 箇条書きの末尾で Enter を押し、続けて打つ
await clickText('`train`', 7);
await shot(500);
await press(cdp, 'Enter');
await shot(300);
await typeSlowly('Sunscreen *SPF 50*');
await shot(700);
await press(cdp, 'ArrowDown');
await shot(1400);

// 表のセルをクリックして編集する
await clickElement('.cm-md-table td', 3);
await shot(500);
await press(cdp, 'End');
await press(cdp, 'Backspace');
await shot(150);
await press(cdp, 'Backspace');
await shot(150);
await typeSlowly('92');
await shot(500);
await press(cdp, 'Escape');
await shot(1400);

// 見出しを打つ
await web('(() => { const v = __hushmarkView; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); })()');
await shot(300);
await typeSlowly('## Ready to go!');
await press(cdp, 'Enter');
await shot(2500);

await vscode.close();
cdp.close();

// ---- GIF にする ----
// 色は全体で 1 つのパレットにする。いくつかの画面から色を集めて作る
const decode = (png) => PNG.sync.read(png);
const { width, height } = decode(frames[0].png);
const samples = [0, Math.floor(frames.length / 2), frames.length - 1].map((i) => decode(frames[i].png).data);
const sampleData = new Uint8Array(samples.reduce((n, s) => n + s.length, 0));
samples.reduce((offset, s) => { sampleData.set(s, offset); return offset + s.length; }, 0);
const palette = quantize(sampleData, 256);
while (palette.length < 256) palette.push([0, 0, 0]);

const out = Buffer.alloc(width * height * frames.length + 1024 * 1024);
const writer = new omggif.GifWriter(out, width, height, {
  palette: palette.map(([r, g, b]) => (r << 16) | (g << 8) | b),
  loop: 0,
});

// 前の画面から変わった範囲だけを書く。変わらない画面は前の画面の表示時間に足す
let previous = null;
let pending = null;
const flush = () => {
  if (!pending) return;
  writer.addFrame(pending.x, pending.y, pending.w, pending.h, pending.pixels, { delay: Math.round(pending.delay / 10), disposal: 1 });
  pending = null;
};
for (const frame of frames) {
  const indexed = applyPalette(decode(frame.png).data, palette);
  let box = null;
  if (!previous) {
    box = { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (indexed[i] === previous[i]) continue;
        if (!box) box = { x0: x, y0: y, x1: x, y1: y };
        else {
          box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x);
          box.y0 = Math.min(box.y0, y); box.y1 = Math.max(box.y1, y);
        }
      }
    }
  }
  if (!box) {
    if (pending) pending.delay += frame.delay;
    continue;
  }
  flush();
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) pixels.set(indexed.subarray((box.y0 + y) * width + box.x0, (box.y0 + y) * width + box.x0 + w), y * w);
  pending = { x: box.x0, y: box.y0, w, h, pixels, delay: frame.delay };
  previous = indexed;
}
flush();

if (options.frames) {
  fs.mkdirSync(options.frames, { recursive: true });
  frames.forEach((frame, i) => fs.writeFileSync(path.join(options.frames, `${String(i).padStart(3, '0')}.png`), frame.png));
}
fs.mkdirSync(path.dirname(options.out), { recursive: true });
fs.writeFileSync(options.out, out.subarray(0, writer.end()));
console.log(`${options.out}: ${width}x${height}, ${frames.length} frames, ${Math.round(writer.end() / 1024)} KB`);

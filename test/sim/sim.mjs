// Webview（media/dist/main.js）を VSCode なしで Playwright の Chromium（画面なし）に読み込み、実際のキーイベントで
// 操作して、文書とカーソルの位置を観察する。編集の細かい挙動を試すときに、スクリプトから使う（CONTRIBUTING.md）。
// 拡張機能本体は動かさないので、Webview から送るメッセージは記録するだけで、返事はしない。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 読み込むプロジェクト。変更の前後を比べるときは、HUSHMARK_DIR に別の作業ツリー（ビルド済み）を指定する
const PROJ = process.env.HUSHMARK_DIR || path.resolve(HERE, '../..');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = url.startsWith('/proj/') ? path.join(PROJ, url.slice(6)) : path.join(HERE, url === '/' ? 'index.html' : url.slice(1));
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** 拡張機能本体が送る設定の既定値（VSCode の既定の設定のとき） */
export const DEFAULT_OPTIONS = {
  lineNumbers: 'on', fontSize: 14, lineHeight: 0, wrappingIndent: 'same', tabSize: 4, wordWrap: 'on',
  renderLineHighlight: 'line', renderLineHighlightOnlyWhenFocus: false, multiCursorModifier: 'alt',
  autoClosingBrackets: 'languageDefined', autoSurround: 'languageDefined', folding: true, showFoldingControls: 'mouseover',
  cursorStyle: 'line', cursorBlinking: 'solid', cursorWidth: 0, cursorSmoothCaretAnimation: 'off',
  fontWeight: 'normal', fontLigatures: false, letterSpacing: 0, selectionHighlight: true, emptySelectionClipboard: true,
  insertSpaces: true, detectIndentation: true, cursorSurroundingLines: 0, renderWhitespace: 'selection',
  renderControlCharacters: true, invisibleCharacters: false, mouseWheelZoom: false, links: true, hoverEnabled: true,
  hoverDelay: 300, scrollBeyondLastLine: true, smoothScrolling: false, paddingTop: 0, paddingBottom: 0,
  verticalScrollbarSize: 14, horizontalScrollbarSize: 12, wordSegmenterLocales: [], wordBreak: 'normal',
  hideCursorInOverviewRuler: false, overviewRulerBorder: true, stickyScrollEnabled: true, stickyScrollMaxLineCount: 5,
  style: { look: 'soft', color: 'green', colorScheme: 'light', customColor: '#3366cc', colorCustomizations: {}, headingSize: 'medium', rightMargin: true, fontFamily: '' },
};

/**
 * エディタを開く。text は初期の文書、cursor は初期のカーソル位置（文書の先頭からの文字数。省略すると末尾）。
 * 戻り値の editor のメソッドで操作と観察をする
 */
export async function open(text, { cursor, options = {}, width = 900, height = 700 } = {}) {
  const server = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__messages.some((m) => m.type === 'ready'));
  await page.evaluate(({ text, options }) => {
    window.postMessage({ type: 'init', text, syncId: 1, options, strings: {} }, '*');
  }, { text, options: { ...DEFAULT_OPTIONS, ...options, style: { ...DEFAULT_OPTIONS.style, ...(options.style || {}) } } });
  await page.waitForFunction(() => !!window.__hushmarkView);
  await page.evaluate((cursor) => {
    const v = window.__hushmarkView;
    const at = cursor == null ? v.state.doc.length : cursor;
    v.dispatch({ selection: { anchor: at } });
    v.focus();
  }, cursor);
  await page.waitForTimeout(100);

  const editor = {
    page, errors,
    /** 文字を 1 文字ずつキー入力する（実際のキーボードの keydown/keypress/input が起きる） */
    async type(str, delay = 10) { await page.keyboard.type(str, { delay }); await settle(); },
    /** キーを押す。例: 'Enter', 'Backspace', 'Tab', 'Shift+Tab', 'ArrowUp', 'Home', 'End', 'Control+z', 'Control+b' */
    async press(key, times = 1) { for (let i = 0; i < times; i++) await page.keyboard.press(key); await settle(); },
    /** IME で確定した文字列を入れる（keydown を伴わない入力）。日本語入力の確定に使う */
    async ime(str) { await page.keyboard.insertText(str); await settle(); },
    /** 文書の位置 pos にカーソルを置く。head を指定すると、pos から head までを選ぶ */
    async setCursor(pos, head) {
      await page.evaluate(({ pos, head }) => { const v = window.__hushmarkView; v.dispatch({ selection: { anchor: pos, head: head ?? pos } }); v.focus(); }, { pos, head });
      await settle();
    },
    /** line 行目（1 始まり）の col 文字目（0 始まり）にカーソルを置く */
    async setCursorLC(line, col) {
      await page.evaluate(({ line, col }) => { const v = window.__hushmarkView; const l = v.state.doc.line(line); v.dispatch({ selection: { anchor: l.from + col } }); v.focus(); }, { line, col });
      await settle();
    },
    /** 画面上の座標をクリックする */
    async click(x, y, opts) { await page.mouse.click(x, y, opts); await settle(); },
    /** 文書の内容 */
    doc: () => page.evaluate(() => window.__hushmarkView.state.doc.toString()),
    /**
     * 観察。記号を隠した箇所では、文書の上の位置と描かれたカーソルの位置が食い違うことがあるので、両方を返す
     * - doc、selection、head / line / col（行は 1 始まり、列は 0 始まり）、textBefore / textAfter（カーソルの行の前後）
     * - drawnCursors：描かれたカーソル（.cm-cursor）の矩形。coordsAtHead：CodeMirror が計算したカーソルの座標
     * - positions：カーソルの行の各位置の座標（before / after は位置の左右どちらに寄せたか）
     * - lineHTML：カーソルの行の DOM（装飾の確認用）
     */
    inspect: () => page.evaluate(() => {
      const v = window.__hushmarkView;
      const { state } = v;
      const sel = state.selection.main;
      const line = state.doc.lineAt(sel.head);
      const r = (x) => x && { left: Math.round(x.left * 10) / 10, top: Math.round(x.top * 10) / 10, right: Math.round((x.right ?? x.left) * 10) / 10, bottom: Math.round(x.bottom * 10) / 10 };
      const cursors = [...document.querySelectorAll('.cm-cursor')].map((c) => r(c.getBoundingClientRect()));
      const positions = [];
      for (let p = line.from; p <= line.to; p++) positions.push({ pos: p, col: p - line.from, ch: state.doc.sliceString(p, p + 1), before: r(v.coordsAtPos(p, -1)), after: r(v.coordsAtPos(p, 1)) });
      const lineEl = v.domAtPos(line.from).node;
      const lineDom = (lineEl.nodeType === 1 ? lineEl : lineEl.parentElement).closest('.cm-line, .cm-widgetBuffer, [class]');
      return {
        doc: state.doc.toString(),
        selection: state.selection.ranges.map((x) => ({ anchor: x.anchor, head: x.head })),
        head: sel.head, line: line.number, col: sel.head - line.from,
        lineText: line.text,
        textBefore: line.text.slice(0, sel.head - line.from), textAfter: line.text.slice(sel.head - line.from),
        drawnCursors: cursors,
        coordsAtHead: r(v.coordsAtPos(sel.head, sel.assoc || 1)),
        lineHTML: lineDom ? lineDom.outerHTML.slice(0, 3000) : null,
        positions,
        focused: v.hasFocus,
        activeElement: document.activeElement && (document.activeElement.className || document.activeElement.tagName),
      };
    }),
    /** 画面を PNG で保存する。clip（{ x, y, width, height }）で範囲を絞れる */
    async screenshot(file, clip) { await page.screenshot({ path: file, clip }); return file; },
    /** Webview から拡張機能本体に送ったメッセージ（openLink など）。Webview にメッセージを送るときは page.evaluate で window.postMessage を呼ぶ */
    messages: () => page.evaluate(() => window.__messages),
    async close() { await browser.close(); server.close(); },
  };
  async function settle() { await page.waitForTimeout(60); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); }
  return editor;
}

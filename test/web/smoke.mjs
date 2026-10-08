// Web 版の VSCode（vscode.dev と同じ作り）で、拡張機能が動くかを確かめる。
// 使い方: npm run test:web
// @vscode/test-web でブラウザー版の VSCode のサーバーを起動し、Playwright の Chromium で開く。
// 作業フォルダ（.e2e/web）は @vscode/test-web が読み取り専用で VSCode に見せる。保存した内容はブラウザーの中に
// 残り、ファイルには書き込まれないので、保存できたかはタブの未保存の印で確かめる。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const work = path.join(root, '.e2e', 'web');
const file = path.join(work, 'sample.md');
const port = 3123;

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, '.vscode'), { recursive: true });
fs.copyFileSync(path.join(root, 'test/e2e/sample.md'), file);
fs.writeFileSync(path.join(work, '.vscode/settings.json'), JSON.stringify({
  'workbench.editorAssociations': { '*.md': 'hushmark.editor' },
}));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'ok' : 'NG'}   ${name}`);
  if (!ok && detail !== undefined) console.log(`     ${JSON.stringify(detail)}`);
}

const server = spawn(process.execPath, [
  path.join(root, 'node_modules/@vscode/test-web/out/server/index.js'),
  '--browser=none', `--port=${port}`, `--extensionDevelopmentPath=${root}`, '--quality=stable', work,
], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (data) => { if (String(data).includes(`${port}`)) resolve(); });
  server.on('exit', (code) => reject(new Error(`サーバーが終了した（${code}）`)));
});

const browser = await chromium.launch();
let failed = true;
try {
  const page = await browser.newPage();
  // 失敗したときに調べられるよう、ブラウザーのエラーを残す
  const consoleLog = globalThis.consoleLog = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleLog.push(m.text()); });
  page.on('pageerror', (e) => consoleLog.push(String(e)));
  await page.goto(`http://localhost:${port}/`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 120000 });

  // エクスプローラーから開く（Web 版の Quick Open はファイルを検索できない）。workbench.editorAssociations で Hushmark が開く
  await page.locator('.explorer-folders-view .monaco-list-row', { hasText: 'sample.md' }).click();

  /** Webview の中のエディタのフレーム（Webview は iframe の中の iframe にある） */
  async function editorFrame() {
    for (let i = 0; i < 120; i++) {
      for (const frame of page.frames()) {
        if (await frame.locator('.cm-editor').count().catch(() => 0)) return frame;
      }
      await page.waitForTimeout(500);
    }
    throw new Error('Webview のエディタが見つからない');
  }
  const frame = await editorFrame();
  const webDoc = () => frame.evaluate(() => window.__hushmarkView.state.doc.toString());
  check('開く: ファイルと表示が一致', (await webDoc()) === fs.readFileSync(file, 'utf8'));
  check('見出しを装飾する', (await frame.locator('.cm-md-heading').count()) > 0);
  check('表を表の形で表示する', (await frame.locator('.cm-md-table').count()) === 1);

  // 1 行目の末尾に追記して保存する
  await frame.evaluate(() => {
    const v = window.__hushmarkView;
    v.focus();
    v.dispatch({ selection: { anchor: v.state.doc.line(1).to } });
  });
  await page.keyboard.type('追記');
  await page.waitForTimeout(500);
  const dirty = () => page.locator('.tab.active.dirty').count();
  check('追記: 表示に入り、文書が未保存になる', (await webDoc()).startsWith('# 見出し1追記\n') && (await dirty()) === 1);
  await page.keyboard.press('Control+S');
  for (let i = 0; i < 20 && (await dirty()) > 0; i++) await page.waitForTimeout(250);
  check('Ctrl+S: 保存して未保存の印が消える', (await dirty()) === 0);

  failed = results.some((r) => !r.ok);
  if (failed) fs.writeFileSync(path.join(work, 'console.log'), consoleLog.join('\n'));
} catch (error) {
  check('途中で止まらずに最後まで動く', false, String(error));
  const page = browser.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(work, 'console.log'), (globalThis.consoleLog || []).join('\n'));
} finally {
  await browser.close();
  server.kill();
}
console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
process.exit(failed ? 1 : 0);

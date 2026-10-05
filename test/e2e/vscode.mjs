// E2E テスト用の VSCode の起動と終了。
// VSCode は @vscode/test-electron でバージョンを固定してダウンロードし（.vscode-test）、
// 普段の設定とは別のプロファイル（作業フォルダの ud）で起動する。手元にインストールした VSCode は使わない。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionRoot = path.resolve(here, '..', '..');

/** テストに使う VSCode のバージョン。上げるときは E2E がすべて通ることを確かめる */
export const VSCODE_VERSION = '1.140.0';

/** 表示言語ごとの言語パック（Marketplace の ID） */
const LANGUAGE_PACKS = { ja: 'MS-CEINTL.vscode-language-pack-ja' };

/** Remote-SSH で試すときの、接続先の作業フォルダ */
const REMOTE_DIR = '/tmp/hushmark-e2e';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {string} options.workDir 作業フォルダ。起動のたびに丸ごと消して作り直す
 * @param {string} [options.version] VSCode のバージョン（'stable' も可）
 * @param {boolean} [options.readOnly] sample.md を読み取り専用にしてから開く
 * @param {object} [options.settings] 追加するユーザー設定
 * @param {string} [options.vsix] 開発中のフォルダではなく、この .vsix をインストールして試す
 * @param {string} [options.locale] VSCode の表示言語（例 'ja'）。言語パックをインストールして使う
 * @param {string} [options.remote] Remote-SSH の接続先（ssh のホスト名）。接続先の /tmp/hushmark-e2e/sample.md を開く。
 *   拡張は接続先にインストールしたものを使う
 * @returns {Promise<{ sample: string, port: number, close: () => Promise<void> }>} sample は開いたファイルのパス
 *   （remote のときは接続先のパス）
 */
export async function launch({ workDir, version = VSCODE_VERSION, readOnly = false, settings = {}, vsix, locale, remote }) {
  const userDataDir = path.join(workDir, 'ud');
  const extensionsDir = path.join(workDir, 'ext');
  // VSCode はプロファイルのフォルダにソケットを作る。ソケットのパスの上限（macOS では 103 バイト）を超えると起動しない
  if (process.platform !== 'win32' && Buffer.byteLength(path.join(userDataDir, '1.99-main.sock')) > 103) {
    throw new Error(`作業フォルダのパスが長すぎます。VSCode が起動できないので、短いパスにしてください: ${workDir}`);
  }
  await resetWorkDir(workDir);

  const executable = await downloadVSCode(version);

  const userDir = path.join(userDataDir, 'User');
  const docs = path.join(workDir, 'docs');
  for (const dir of [userDir, docs, extensionsDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({
    'workbench.editorAssociations': { '*.md': 'hushmark.editor' },
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'telemetry.telemetryLevel': 'off',
    'window.restoreWindows': 'none',
    'chat.disableAIFeatures': true,
    // 作業フォルダはこのリポジトリの中にあるので、git の通知が出ないよう git を使わない
    'git.enabled': false,
    'hushmark.debugLog': true,
    ...(remote ? { 'remote.SSH.remotePlatform': { [remote]: 'linux' } } : {}),
    ...settings,
  }, null, 2));

  // 改行を CRLF にして、保存しても改行コードが変わらないことを確かめる
  const sample = path.join(docs, 'sample.md');
  fs.writeFileSync(sample, fs.readFileSync(path.join(here, 'sample.md'), 'utf8').replace(/\r?\n/g, '\r\n'));
  if (readOnly) fs.chmodSync(sample, 0o444);

  const installExtension = (id) => {
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
    execFileSync(cli, [...cliArgs, `--extensions-dir=${extensionsDir}`, '--install-extension', id], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  };
  if (vsix) installExtension(path.resolve(vsix));
  if (locale) installExtension(LANGUAGE_PACKS[locale] ?? `MS-CEINTL.vscode-language-pack-${locale}`);

  let target = [docs, sample];
  if (remote) {
    installExtension('ms-vscode-remote.remote-ssh');
    execFileSync('ssh', [remote, `mkdir -p '${REMOTE_DIR}'`]);
    execFileSync('scp', ['-q', sample, `${remote}:${REMOTE_DIR}/sample.md`]);
    // --folder-uri と --file-uri を一緒に渡すと、VSCode 1.140 は起動せずに終わる
    target = ['--remote', `ssh-remote+${remote}`, REMOTE_DIR, `${REMOTE_DIR}/sample.md`];
  }

  const args = [
    // 後ろに隠れていても描画を止めない
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    // CI の Linux では GPU も鍵の保管場所もない
    '--disable-gpu',
    '--password-store=basic',
    // Chromium のサンドボックスを使えないコンテナの中で実行するとき（Dockerfile）
    ...(process.env.E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    `--user-data-dir=${userDataDir}`,
    // 最近開いたものの一覧などは、プロファイルとは別の共有の保存場所（既定は ~/.vscode-shared）に置かれる。
    // 普段の VSCode と共有しないよう、作業フォルダの中を使う
    `--shared-data-dir=${path.join(workDir, 'shared')}`,
    `--extensions-dir=${extensionsDir}`,
    // 空いているポートを使う。VSCode が実際のポートを DevToolsActivePort に書き出す
    '--remote-debugging-port=0',
    '--new-window',
    ...(locale ? [`--locale=${locale}`] : []),
    ...(vsix || remote ? [] : [`--extensionDevelopmentPath=${extensionRoot}`]),
    ...target,
  ];
  const start = async () => {
    if (process.platform === 'darwin' && !locale) {
      // open -g で、作業中のウィンドウからフォーカスを奪わずに起動する。
      // ただし open を経由すると --locale が VSCode に届かないので、表示言語を指定するときは直接起動する
      execFileSync('open', ['-g', '-n', '-a', appBundle(executable), '--args', ...args]);
      return waitFor(() => mainPid(userDataDir), 'VSCode のプロセス');
    }
    // 起動に失敗したときに原因を調べられるよう、出力を作業フォルダの vscode.log に残す
    const log = fs.openSync(path.join(workDir, 'vscode.log'), 'w');
    const child = spawn(executable, args, { detached: process.platform !== 'win32', stdio: ['ignore', log, log] });
    fs.closeSync(log);
    child.unref();
    return child.pid;
  };

  let pid = await start();
  // 次の起動のときに、残っていれば閉じる（--keep で開いたままにしたときなど）
  fs.writeFileSync(path.join(workDir, 'vscode.pid'), String(pid));
  await waitFor(() => readPort(userDataDir), 'DevTools のポート');
  if (locale) {
    // VSCode は、入れた言語パックを起動の途中で登録する（ud/languagepacks.json）。初回の起動ではまだその言語を
    // 使えないので、登録を待ってから起動し直す。登録のファイルができた直後に止めると、次の起動でも使えないことが
    // あったので、少し待ってから止める（失敗する頻度は測っていない）
    await waitFor(() => fs.existsSync(path.join(userDataDir, 'languagepacks.json')), '言語パックの登録');
    await sleep(5000);
    await kill(pid);
    fs.rmSync(path.join(userDataDir, 'DevToolsActivePort'), { force: true });
    pid = await start();
    fs.writeFileSync(path.join(workDir, 'vscode.pid'), String(pid));
  }

  const port = await waitFor(() => readPort(userDataDir), 'DevTools のポート');
  return { sample: remote ? `${REMOTE_DIR}/sample.md` : sample, port, close: () => kill(pid) };
}

/** VSCode を .vscode-test にダウンロードし、実行ファイルのパスを返す（あればダウンロードしない） */
export function downloadVSCode(version = VSCODE_VERSION) {
  return downloadAndUnzipVSCode({ version, cachePath: path.join(extensionRoot, '.vscode-test') });
}

/**
 * 作業フォルダを消して作り直す。このモジュールが作ったフォルダ（目印のファイルがある）か
 * 空のフォルダでなければ止める。リポジトリなど、別の用途のフォルダを誤って指定しても消さないため
 */
async function resetWorkDir(workDir) {
  const marker = path.join(workDir, '.hushmark-e2e');
  if (fs.existsSync(workDir)) {
    if (!fs.existsSync(marker) && fs.readdirSync(workDir).length > 0) {
      throw new Error(`作業フォルダは E2E テストが作ったフォルダではありません（${marker} がありません）。消さずに止めます: ${workDir}`);
    }
    const pidFile = path.join(workDir, 'vscode.pid');
    if (fs.existsSync(pidFile)) await kill(Number(fs.readFileSync(pidFile, 'utf8')));
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(marker, 'E2E テスト（test/e2e）が作った作業フォルダ。次に起動するときに丸ごと消して作り直す\n');
}

/** .../Visual Studio Code.app/Contents/MacOS/Code から .app のパスを得る */
function appBundle(executable) {
  return path.resolve(executable, '..', '..', '..');
}

/** そのプロファイルで動いている VSCode の本体のプロセス（いちばん古いもの） */
function mainPid(userDataDir) {
  try {
    return Number(execFileSync('pgrep', ['-o', '-f', '--', `--user-data-dir=${userDataDir}`], { encoding: 'utf8' }).trim()) || null;
  } catch {
    return null;
  }
}

function readPort(userDataDir) {
  try {
    return Number(fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null;
  } catch {
    return null;
  }
}

async function waitFor(read, what, timeoutMs = 60000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(300)) {
    const value = read();
    if (value) return value;
  }
  throw new Error(`${what}が見つかりません`);
}

/** VSCode の本体のプロセスと、その子のプロセスを閉じる */
async function kill(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* すでに終わっている */ }
    return;
  }
  // macOS の open で起動したものはプロセスグループが別なので、グループと本体の両方に送る
  for (const target of [-pid, pid]) {
    try { process.kill(target, 'SIGKILL'); } catch { /* すでに終わっている */ }
  }
  for (const deadline = Date.now() + 10000; isAlive(pid) && Date.now() < deadline;) await sleep(200);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

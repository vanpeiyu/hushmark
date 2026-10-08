// E2E テストを実行する。テストごとに VSCode を起動し、テストのスクリプトを実行して閉じる。
// 使い方: npm run test:e2e -- <テスト> [オプション]（npm run test:e2e はビルドしてからこれを実行する）
//   テスト:
//     full      編集・表・検索・同期などを細かく確かめる（run.mjs。Linux の CI で実行する）
//     smoke     主な操作と OS ごとのキー操作を短く確かめる（smoke.mjs。macOS と Windows の CI で実行する）
//     readonly  読み取り専用のファイルで編集できないことを確かめる（readonly.mjs）
//     restore   ウィンドウを再読み込みしても、カーソルとスクロールの位置が戻ることを確かめる（restore.mjs）
//     all       full と readonly と restore
//   オプション:
//     --keep           最後のテストの後も VSCode を閉じない（screenshot.mjs などで続けて調べるとき）
//     --vsix <path>    開発中のフォルダではなく、この .vsix をインストールして試す
//     --remote <host>  Remote-SSH で ssh のホスト <host> につなぎ、接続先の /tmp/hushmark-e2e/sample.md で試す。
//                      拡張は接続先にインストールしたものを使う（full と smoke だけ）
//     --locale <lang>  VSCode の表示言語（例 ja。言語パックをインストールする）
//     --version <v>    VSCode のバージョン（既定は vscode.mjs の VSCODE_VERSION。'stable' も可）
//     --work-dir <dir> 作業フォルダ（既定はこのフォルダの .e2e）

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { extensionRoot, launch } from './vscode.mjs';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    keep: { type: 'boolean', default: false },
    vsix: { type: 'string' },
    remote: { type: 'string' },
    version: { type: 'string' },
    locale: { type: 'string' },
    'work-dir': { type: 'string', default: path.join(extensionRoot, '.e2e') },
  },
});

const SUITES = {
  full: { script: 'run.mjs' },
  smoke: { script: 'smoke.mjs' },
  readonly: { script: 'readonly.mjs', readOnly: true, settings: { 'files.readonlyFromPermissions': true } },
  restore: { script: 'restore.mjs' },
};
const names = positionals[0] === 'all' ? ['full', 'readonly', 'restore'] : positionals;
if (names.length !== 1 && positionals[0] !== 'all') throw new Error(`テストを 1 つ指定する: ${Object.keys(SUITES).join(' | ')} | all`);
for (const name of names) if (!SUITES[name]) throw new Error(`知らないテスト: ${name}`);
if (options.remote && names.includes('readonly')) throw new Error('readonly は --remote では実行できない');

const failed = [];
for (const [i, name] of names.entries()) {
  const suite = SUITES[name];
  console.log(`\n== ${name}`);
  const vscode = await launch({
    workDir: path.resolve(options['work-dir']),
    version: options.version,
    readOnly: suite.readOnly,
    settings: suite.settings,
    vsix: options.vsix,
    locale: options.locale,
    remote: options.remote,
  });
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, suite.script), vscode.sample], {
    stdio: 'inherit',
    env: { ...process.env, E2E_PORT: String(vscode.port), ...(options.remote ? { E2E_REMOTE: options.remote } : {}) },
  });
  if (result.status !== 0) failed.push(name);
  if (options.keep && i === names.length - 1) {
    console.log(`\nVSCode は開いたままです（E2E_PORT=${vscode.port}）。次に起動したときに閉じます。`);
  } else {
    await vscode.close();
  }
}

if (failed.length > 0) {
  console.log(`\n失敗したテスト: ${failed.join(', ')}`);
  process.exit(1);
}

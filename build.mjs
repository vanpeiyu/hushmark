// Webview 側のスクリプトを media/dist に、Web 版の VSCode 用の拡張機能本体を dist/web にまとめる。
// 言語ごとの構文定義（@codemirror/language-data）は必要になったときに読み込むよう分割する。
// まとめたパッケージのライセンス文は media/dist/THIRD_PARTY_LICENSES.txt に書き出す（MIT などは、
// 配布物に著作権表示とライセンス文を含めることを条件にしている）。
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const outdir = 'media/dist';

/** まとめたパッケージ（node_modules の下のもの）のライセンス文を、1 つのファイルに書き出す */
const thirdPartyLicenses = {
  name: 'third-party-licenses',
  setup(build) {
    build.onEnd(({ metafile }) => {
      if (!metafile) return;
      const packages = new Set();
      for (const input of Object.keys(metafile.inputs)) {
        const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
        if (match) packages.add(match[1]);
      }
      const sections = [...packages].sort().map((name) => {
        const dir = path.join('node_modules', name);
        const { version, license } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const file = fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
        if (!file) throw new Error(`ライセンスのファイルがない: ${name}`);
        return `${name} ${version} (${license})\n\n${fs.readFileSync(path.join(dir, file), 'utf8').trim()}\n`;
      });
      fs.writeFileSync(path.join(outdir, 'THIRD_PARTY_LICENSES.txt'),
        `Hushmark には、次のパッケージが含まれています。\n\n${sections.join(`\n${'-'.repeat(72)}\n\n`)}`);
    });
  },
};

const options = {
  entryPoints: ['webview/main.js'],
  outdir,
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  target: 'es2022',
  logLevel: 'info',
  metafile: true,
  plugins: [thirdPartyLicenses],
};

/**
 * Web 版の VSCode（vscode.dev など）で動かす拡張機能本体（package.json の browser）。
 * デスクトップ版は src/extension.js をそのまま読み込む。fs はデスクトップ版でだけ使い、Web 版では
 * 読み込みに失敗したものとして扱う（src/extension.js の isReadOnly）
 */
const webExtensionOptions = {
  entryPoints: ['src/extension.js'],
  outfile: 'dist/web/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  external: ['vscode', 'fs'],
  minify: true,
  target: 'es2022',
  logLevel: 'info',
};

// 分割したファイルは内容のハッシュで名前が変わるので、古いものが残らないよう毎回消す
fs.rmSync(options.outdir, { recursive: true, force: true });

if (process.argv.includes('--watch')) {
  for (const o of [options, webExtensionOptions]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(options), esbuild.build(webExtensionOptions)]);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMMAND_KEYS, passKeyBindings, toCodeMirrorKey } from '../webview/commandKeys.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const nls = JSON.parse(fs.readFileSync(new URL('../package.nls.json', import.meta.url), 'utf8'));
const nlsJa = JSON.parse(fs.readFileSync(new URL('../package.nls.ja.json', import.meta.url), 'utf8'));

test('package.json のキーの割り当ては、Webview が VSCode に渡すキーの表と同じ', () => {
  const fromPackage = pkg.contributes.keybindings
    .filter((k) => COMMAND_KEYS.some((c) => `hushmark.${c.action}` === k.command))
    .map(({ command, key, mac, linux, win, when }) => JSON.stringify({ command, key, mac, linux, win, when }));
  const fromTable = COMMAND_KEYS.flatMap(({ action, keys }) => keys.map((k) => JSON.stringify({
    command: `hushmark.${action}`, key: k.key, mac: k.mac, linux: k.linux, win: k.win, when: 'hushmark.editorFocus',
  })));
  assert.deepEqual(fromPackage.sort(), fromTable.sort());
});

test('Webview の操作のコマンドは、どれも名前があり、コマンドパレットに出る条件を持つ', () => {
  for (const { action } of COMMAND_KEYS) {
    const command = `hushmark.${action}`;
    const entry = pkg.contributes.commands.find((c) => c.command === command);
    assert.ok(entry, command);
    const key = entry.title.replace(/^%|%$/g, '');
    assert.ok(nls[key] && nlsJa[key], `${command} の名前`);
    assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === command), `${command} のコマンドパレット`);
  }
});

test('toCodeMirrorKey: VSCode のキーの書き方を CodeMirror の書き方にする', () => {
  assert.equal(toCodeMirrorKey('ctrl+shift+alt+up'), 'Ctrl-Shift-Alt-ArrowUp');
  assert.equal(toCodeMirrorKey('cmd+enter'), 'Meta-Enter');
  assert.equal(toCodeMirrorKey('ctrl+]'), 'Ctrl-]');
  assert.equal(toCodeMirrorKey('ctrl+k ctrl+0'), null);
  // 2 つ打ちのキーは Webview では受けない（Ctrl+K は main.js が VSCode に渡す）
  assert.ok(!passKeyBindings().some((b) => b.key === null));
});

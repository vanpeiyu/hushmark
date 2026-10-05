// OS ごとのキー操作の違い。VSCode のエディタと同じキーにそろえる。
// Webview は Remote-SSH でも手元で動くので、手元の OS で決まる。

import { t } from './strings.js';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** VSCode と CodeMirror の Mod（macOS では Cmd、それ以外では Ctrl）が押されているか */
export function hasMod(event) {
  return isMac ? event.metaKey : event.ctrlKey;
}

/**
 * ショートカットの表記。'Mod+Alt+F' のように書き、macOS では VSCode と同じ記号（⌥⌘F）にする
 */
export function shortcutLabel(keys) {
  if (!isMac) return keys.replace(/Mod/g, 'Ctrl');
  const parts = keys.split('+');
  const key = parts.pop();
  const symbols = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
  const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
  return order.filter((m) => parts.includes(m)).map((m) => symbols[m]).join('') + key;
}

/** リンクを開く操作の説明 */
export function openLinkHint() {
  return t('{0}+Click to open', isMac ? 'Cmd' : 'Ctrl');
}

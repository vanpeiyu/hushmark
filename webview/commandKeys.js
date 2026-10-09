// Webview の中で行う操作と、その既定のキー。DOM に依存しないのでテストから直接呼べる。
//
// 操作は VSCode のコマンド（hushmark.<action>）として package.json に登録し、キーは package.json の keybindings で
// 割り当てる。利用者は VSCode のキーボード ショートカットでキーを変えられる。Webview はこの表のキーを自分では処理せず
// VSCode に渡し、VSCode がコマンドを実行すると、拡張機能本体から { type: 'run', action } で呼ばれる。
//
// キーは VSCode の既定のキー（editor.action.* と同じもの）に合わせる。Linux の値は VSCode 1.140 の既定の
// キーボード ショートカットから写した。package.json の keybindings がこの表と同じであることは、単体テストで確かめる。
// key は Windows と Linux、mac は macOS、linux / win はそれぞれの OS だけで違うときのキー。

/** @type {{ action: string, keys: { key: string, mac?: string, linux?: string, win?: string }[] }[]} */
export const COMMAND_KEYS = [
  { action: 'bold', keys: [{ key: 'ctrl+b', mac: 'cmd+b' }] },
  { action: 'italic', keys: [{ key: 'ctrl+i', mac: 'cmd+i' }] },
  { action: 'toggleWordWrap', keys: [{ key: 'alt+z', mac: 'alt+z' }] },
  { action: 'find', keys: [{ key: 'ctrl+f', mac: 'cmd+f' }] },
  { action: 'replace', keys: [{ key: 'ctrl+h', mac: 'cmd+alt+f' }] },
  { action: 'findInFiles', keys: [{ key: 'ctrl+shift+f', mac: 'cmd+shift+f' }] },
  { action: 'replaceInFiles', keys: [{ key: 'ctrl+shift+h', mac: 'cmd+shift+h' }] },

  { action: 'moveLinesUp', keys: [{ key: 'alt+up', mac: 'alt+up' }] },
  { action: 'moveLinesDown', keys: [{ key: 'alt+down', mac: 'alt+down' }] },
  { action: 'copyLinesUp', keys: [{ key: 'shift+alt+up', linux: 'ctrl+shift+alt+up', mac: 'shift+alt+up' }] },
  { action: 'copyLinesDown', keys: [{ key: 'shift+alt+down', linux: 'ctrl+shift+alt+down', mac: 'shift+alt+down' }] },
  { action: 'deleteLines', keys: [{ key: 'ctrl+shift+k', mac: 'shift+cmd+k' }] },
  { action: 'insertLineAfter', keys: [{ key: 'ctrl+enter', mac: 'cmd+enter' }] },
  { action: 'insertLineBefore', keys: [{ key: 'ctrl+shift+enter', mac: 'shift+cmd+enter' }] },
  { action: 'expandLineSelection', keys: [{ key: 'ctrl+l', mac: 'cmd+l' }] },
  { action: 'indentLines', keys: [{ key: 'ctrl+]', mac: 'cmd+]' }] },
  { action: 'outdentLines', keys: [{ key: 'ctrl+[', mac: 'cmd+[' }] },
  { action: 'commentLine', keys: [{ key: 'ctrl+/', mac: 'cmd+/' }] },
  { action: 'blockComment', keys: [{ key: 'shift+alt+a', linux: 'ctrl+shift+a', mac: 'shift+alt+a' }] },

  // Linux の VSCode は Ctrl+Shift+↑ / ↓ にも割り当てているが、Hushmark では 1 つにする（OS ごとに数の違う割り当ては書けないため）
  { action: 'insertCursorAbove', keys: [{ key: 'ctrl+alt+up', linux: 'shift+alt+up', mac: 'cmd+alt+up' }] },
  { action: 'insertCursorBelow', keys: [{ key: 'ctrl+alt+down', linux: 'shift+alt+down', mac: 'cmd+alt+down' }] },
  { action: 'insertCursorAtEndOfEachLineSelected', keys: [{ key: 'shift+alt+i', mac: 'shift+alt+i' }] },
  { action: 'addSelectionToNextFindMatch', keys: [{ key: 'ctrl+d', mac: 'cmd+d' }] },
  { action: 'selectHighlights', keys: [{ key: 'ctrl+shift+l', mac: 'shift+cmd+l' }] },
  { action: 'cursorUndo', keys: [{ key: 'ctrl+u', mac: 'cmd+u' }] },
  { action: 'smartSelectExpand', keys: [{ key: 'shift+alt+right', mac: 'ctrl+shift+cmd+right' }] },
  { action: 'smartSelectShrink', keys: [{ key: 'shift+alt+left', mac: 'ctrl+shift+cmd+left' }] },

  { action: 'fold', keys: [{ key: 'ctrl+shift+[', mac: 'cmd+alt+[' }] },
  { action: 'unfold', keys: [{ key: 'ctrl+shift+]', mac: 'cmd+alt+]' }] },
  { action: 'foldAll', keys: [{ key: 'ctrl+k ctrl+0', mac: 'cmd+k cmd+0' }] },
  { action: 'unfoldAll', keys: [{ key: 'ctrl+k ctrl+j', mac: 'cmd+k cmd+j' }] },
];

const KEY_NAMES = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', enter: 'Enter' };
const MODIFIERS = { ctrl: 'Ctrl', cmd: 'Meta', alt: 'Alt', shift: 'Shift' };

/** VSCode のキーの書き方（ctrl+shift+up）を CodeMirror の書き方（Ctrl-Shift-ArrowUp）にする。2 つ打ちのキーは null */
export function toCodeMirrorKey(key) {
  if (!key || key.includes(' ')) return null;
  return key.split('+').map((part) => MODIFIERS[part] || KEY_NAMES[part] || part).join('-');
}

/** Webview で処理せずに VSCode に渡すキー（CodeMirror の keymap の形）。OS ごとのキーは、CodeMirror の mac / win / linux で指定する */
export function passKeyBindings() {
  const bindings = [];
  for (const { keys } of COMMAND_KEYS) {
    for (const k of keys) {
      const binding = { key: toCodeMirrorKey(k.key) };
      for (const os of ['mac', 'win', 'linux']) {
        if (os in k) binding[os] = toCodeMirrorKey(k[os]);
      }
      if (!binding.key) continue;
      bindings.push(binding);
    }
  }
  return bindings;
}

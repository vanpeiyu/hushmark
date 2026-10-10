// VSCode（--remote-debugging-port 付きで起動したもの）を DevTools プロトコルで操作する小さな道具。
// 実際のマウスやキーボードは使わないので、操作中も他の作業を邪魔しない。

/** port の既定は、test/e2e/index.mjs が起動した VSCode のポート（E2E_PORT） */
export async function connect(port = Number(process.env.E2E_PORT)) {
  if (!port) throw new Error('E2E_PORT に DevTools のポートを指定する');
  // 起動直後はページがまだないので、しばらく待つ
  let page;
  for (const deadline = Date.now() + 30000; !page && Date.now() < deadline; ) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      // ウィンドウのタイトルは OS によって形が違うので、ワークベンチのページを URL で探す
      page = targets.find((t) => t.type === 'page' && t.url.includes('/workbench/workbench'));
    } catch {}
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error('VSCode のページが見つからない');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  /** 実行コンテキスト。Webview は別プロセスの iframe なので、子ターゲットのセッションごとに持つ */
  const contexts = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    const session = msg.sessionId || '';
    if (msg.method === 'Runtime.executionContextCreated') {
      contexts.set(`${session}:${msg.params.context.id}`, { session, id: msg.params.context.id });
    } else if (msg.method === 'Runtime.executionContextDestroyed') {
      contexts.delete(`${session}:${msg.params.executionContextId}`);
    } else if (msg.method === 'Target.attachedToTarget') {
      const child = msg.params.sessionId;
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child).catch(() => {});
      send('Runtime.enable', {}, child).catch(() => {});
      send('Emulation.setFocusEmulationEnabled', { enabled: true }, child).catch(() => {});
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
  await send('Runtime.enable');
  // ウィンドウが後ろにあっても、フォーカスがあるものとして振る舞わせる
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const evaluateIn = async (key, expression) => {
    const { session, id } = contexts.get(key) || {};
    if (id === undefined) throw new Error(`コンテキストがない: ${key}`);
    const result = await send('Runtime.evaluate', { expression, contextId: id, returnByValue: true, awaitPromise: true }, session || undefined);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };

  /** 条件の式が真になる実行コンテキストを探す */
  const findContext = async (expression, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const key of contexts.keys()) {
        try {
          if (await evaluateIn(key, expression)) return key;
        } catch { /* 破棄されたコンテキストなど */ }
      }
      await sleep(200);
    }
    throw new Error(`コンテキストが見つからない: ${expression}`);
  };

  return { send, evaluateIn, findContext, contexts, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hushmark の Webview の実行コンテキストを返す。
 * 開発中の拡張の登録が間に合わず、テキストエディタで開くことがある。そのときはタイトルバーのボタンで開き直す。
 */
export async function liveEditorContext(cdp) {
  try {
    // 同じファイルを開いたタブが 2 つあると、隠れている側の Webview も見つかる。画面に出ている側を選ぶ
    return await cdp.findContext('!!window.__hushmarkView && __hushmarkView.dom.getBoundingClientRect().width > 0', 5000);
  } catch {
    const mainCtx = await cdp.findContext("!!document.querySelector('.monaco-workbench')");
    // ボタンが無ければ、ライブエディタで開いてはいるが読み込み中なので待つ
    await cdp.evaluateIn(mainCtx, `document.querySelector('.editor-actions a.action-label[aria-label^="Open in Live Editor"]')?.click()`);
    return cdp.findContext('!!window.__hushmarkView', 60000);
  }
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  End: { code: 'End', keyCode: 35 },
  Home: { code: 'Home', keyCode: 36 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Escape: { code: 'Escape', keyCode: 27 },
  F1: { code: 'F1', keyCode: 112 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '/': { code: 'Slash', keyCode: 191 },
};

/** 修飾キーのビット */
export const ALT = 1;
export const CTRL = 2;
export const META = 4;
export const SHIFT = 8;
export const isMac = process.platform === 'darwin';
/** ショートカットの修飾キー（CodeMirror と VSCode の Mod）。macOS では Cmd、それ以外では Ctrl */
export const MOD = isMac ? META : CTRL;

/**
 * macOS の Chromium は、送ったキーのイベントからは入力欄の編集の操作（Cmd+A の全選択など）を行わないので、
 * 操作の名前を添える
 */
const MAC_COMMANDS = { a: 'selectAll' };

export async function press(cdp, key, modifiers = 0) {
  const known = KEYS[key];
  const info = known || { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
  const keyName = known ? key : (modifiers & SHIFT ? key.toUpperCase() : key);
  const base = { key: keyName, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers };
  const text = modifiers & (CTRL | META) ? undefined : (known ? known.text : keyName);
  const commands = isMac && modifiers === META && MAC_COMMANDS[key] ? [MAC_COMMANDS[key]] : undefined;
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text, unmodifiedText: text, commands });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function type(cdp, text) {
  await cdp.send('Input.insertText', { text });
}

export async function click(cdp, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

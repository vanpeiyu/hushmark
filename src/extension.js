'use strict';

const vscode = require('vscode');
const { rebaseChanges } = require('./textMerge');
const { markdownPath, normalizeHref, relativePath } = require('./links');
const { watchDiskChanges } = require('./diskChanges');

const VIEW_TYPE = 'hushmark.editor';

let output = null;

/** 設定 hushmark.debugLog が有効なときだけ、同期の様子を出力パネルに書く */
function log(...args) {
  if (!vscode.workspace.getConfiguration('hushmark').get('debugLog')) return;
  if (!output) output = vscode.window.createOutputChannel('Hushmark');
  output.appendLine(`${new Date().toISOString().slice(11, 23)} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
}

function activate(context) {
  const provider = new LiveEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('hushmark.open', (uri) => provider.openFromTextEditor(uri)),
    vscode.commands.registerCommand('hushmark.openSource', (uri) => provider.openInTextEditor(uri)),
    vscode.commands.registerCommand('hushmark.gotoLine', () => provider.gotoLine()),
    vscode.commands.registerCommand('hushmark.quickFix', () => provider.quickFix()),
    vscode.commands.registerCommand('hushmark.formatDocument', () => provider.formatDocument()),
    vscode.commands.registerCommand('hushmark.rename', () => provider.rename()),
    vscode.commands.registerCommand('hushmark.goToHeading', () => provider.goToHeading()),
    ...webviewCommands(context).map((command) =>
      vscode.commands.registerCommand(command, () => provider.runInWebview(command.slice('hushmark.'.length)))),
  );
}

function deactivate() {}

function activeTabUri() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab && tab.input && tab.input.uri instanceof vscode.Uri) return tab.input.uri;
  return vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
}

/**
 * Webview の中の操作を呼ぶコマンド。package.json の commands のうち、拡張機能本体で行うもの（EXTENSION_COMMANDS）
 * 以外は、hushmark.<action> の action を Webview で行う（webview/commandKeys.js）。
 * キーは VSCode のキーボード ショートカットで割り当てるので、利用者が変えられる。Webview はこれらのキーを自分では処理せず、
 * VSCode に渡す。VSCode がコマンドを実行し、ここからフォーカスのある Webview に操作を指示する
 */
const EXTENSION_COMMANDS = new Set([
  'hushmark.open', 'hushmark.openSource', 'hushmark.goToHeading', 'hushmark.gotoLine',
  'hushmark.quickFix', 'hushmark.formatDocument', 'hushmark.rename',
]);
const webviewCommands = (context) => context.extension.packageJSON.contributes.commands
  .map((c) => c.command)
  .filter((command) => command.startsWith('hushmark.') && !EXTENSION_COMMANDS.has(command));

/** Webview にフォーカスがあるか。キーの割り当ての条件（when）に使う */
const FOCUS_CONTEXT = 'hushmark.editorFocus';

class LiveEditorProvider {
  constructor(context) {
    this.context = context;
    /** 開いている Webview（文書の URI ごと）。ほかの文書のリンク（other.md#見出し）の見出しに移すのに使う */
    this.webviews = new Map();
    /** 開こうとしている文書の、移す先の見出し。Webview の準備ができたときに渡す */
    this.pendingAnchors = new Map();
    /** テキストエディタから開き直す文書の、引き継ぐ選択範囲。Webview の準備ができたときに渡す */
    this.pendingSelections = new Map();
    // ステータスバー。テキストエディタと同じく、カーソルの行と列、選択した文字数を出す。文書の文字数も出す
    this.positionItem = vscode.window.createStatusBarItem('hushmark.position', vscode.StatusBarAlignment.Right, 100);
    this.positionItem.name = vscode.l10n.t('Hushmark Cursor Position');
    this.positionItem.command = 'hushmark.gotoLine';
    this.positionItem.tooltip = vscode.l10n.t('Go to Line');
    this.charsItem = vscode.window.createStatusBarItem('hushmark.characters', vscode.StatusBarAlignment.Right, 100.1);
    this.charsItem.name = vscode.l10n.t('Hushmark Character Count');
    context.subscriptions.push(this.positionItem, this.charsItem);
  }

  /** 前面の Webview（なければ undefined） */
  activeEntry() {
    const entries = [...this.webviews.values()].flatMap((set) => [...set]);
    return entries.find((e) => e.focused) || entries.find((e) => e.panel.active);
  }

  /** Webview に問い合わせて、答えを受け取る（届かなければ null） */
  request(entry, message, timeout = 3000) {
    const id = this.nextRequestId = (this.nextRequestId || 0) + 1;
    return new Promise((resolve) => {
      entry.requests ??= new Map();
      entry.requests.set(id, resolve);
      entry.panel.webview.postMessage({ ...message, id });
      setTimeout(() => { if (entry.requests.delete(id)) resolve(null); }, timeout);
    });
  }

  updateStatus() {
    const entries = [...this.webviews.values()].flatMap((set) => [...set]);
    const entry = entries.find((e) => e.panel.active);
    const cursor = entry && entry.cursor;
    if (!cursor) {
      this.positionItem.hide();
      this.charsItem.hide();
      return;
    }
    let text = vscode.l10n.t('Ln {0}, Col {1}', cursor.line, cursor.col);
    if (cursor.selections > 1) text += ` ${vscode.l10n.t('({0} selections)', cursor.selections)}`;
    else if (cursor.selected > 0) text += ` ${vscode.l10n.t('({0} selected)', cursor.selected)}`;
    this.positionItem.text = text;
    this.charsItem.text = vscode.l10n.t('{0} characters', cursor.chars.toLocaleString());
    this.positionItem.show();
    this.charsItem.show();
  }

  /** 行に移動（Ctrl+G）。テキストエディタと同じく、行番号か「行:列」を受け付ける */
  async gotoLine() {
    const entry = this.activeEntry();
    if (!entry || !entry.cursor) return;
    const { line, col, lines } = entry.cursor;
    const input = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Current Line: {0}, Character: {1}. Type a line number between 1 and {2} to navigate to.', line, col, lines),
      validateInput: (value) => (value.trim() === '' || /^\s*\d+\s*(?:[:,]\s*\d+\s*)?$/.test(value) ? null : vscode.l10n.t('Type a line number, or a line number and a character number separated by a colon.')),
    });
    if (!input || !input.trim()) return;
    const [target, character] = input.split(/[:,]/).map((v) => Number(v.trim()));
    entry.panel.webview.postMessage({ type: 'revealLine', line: target, col: character || 1 });
  }

  /** 前面の Webview の文書と、その主な選択範囲（VSCode の Range） */
  async activeSelection() {
    const entry = this.activeEntry();
    if (!entry) return null;
    const reply = await this.request(entry, { type: 'requestSelection' }, 1000);
    if (!reply) return null;
    const { ranges, main } = reply.selection;
    const r = ranges[main] || ranges[0];
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === entry.uri);
    if (!document) return null;
    const anchor = new vscode.Position(r.anchor.line, r.anchor.col);
    const head = new vscode.Position(r.head.line, r.head.col);
    return { entry, document, range: new vscode.Range(anchor, head), position: head };
  }

  /**
   * クイックフィックス（Ctrl+.）。他の拡張機能（cSpell、markdownlint など）のコードアクションを一覧にし、選んだものを行う
   */
  async quickFix() {
    const target = await this.activeSelection();
    if (!target) return;
    const actions = (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', target.document.uri, target.range)) || [];
    if (actions.length === 0) {
      vscode.window.setStatusBarMessage(vscode.l10n.t('No code actions available'), 3000);
      return;
    }
    const items = actions
      .map((action) => ({ label: action.title, action, picked: !!action.isPreferred }))
      .sort((a, b) => Number(b.picked) - Number(a.picked));
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Select a code action') });
    if (!chosen) return;
    const { action } = chosen;
    // CodeAction は edit と command を持ち、古い形の Command は command と arguments を持つ
    if (action.edit) await vscode.workspace.applyEdit(action.edit);
    const command = typeof action.command === 'string' ? action : action.command;
    if (command && command.command) await vscode.commands.executeCommand(command.command, ...(command.arguments || []));
  }

  /** ドキュメントの書式設定。他の拡張機能（Prettier など）の書式設定の結果を当てる */
  async formatDocument() {
    const entry = this.activeEntry();
    const document = entry && vscode.workspace.textDocuments.find((d) => d.uri.toString() === entry.uri);
    if (!document) return;
    const editor = vscode.workspace.getConfiguration('editor', document);
    const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, {
      tabSize: editor.get('tabSize', 4),
      insertSpaces: editor.get('insertSpaces', true),
    });
    if (!edits) {
      vscode.window.showInformationMessage(vscode.l10n.t("There is no formatter for '{0}' files installed.", document.languageId));
      return;
    }
    if (edits.length === 0) return;
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, edits);
    await vscode.workspace.applyEdit(edit);
  }

  /** シンボルのリネーム（F2）。Markdown の見出しの名前（リンクも書き換える）など、他の拡張機能のリネームを使う */
  async rename() {
    const target = await this.activeSelection();
    if (!target) return;
    const { document, position } = target;
    let prepared;
    try {
      prepared = await vscode.commands.executeCommand('vscode.prepareRename', document.uri, position);
    } catch (error) {
      vscode.window.showInformationMessage(String(error && error.message ? error.message : error));
      return;
    }
    const range = prepared && (prepared.range || prepared);
    const placeholder = prepared && prepared.placeholder ? prepared.placeholder : (range instanceof vscode.Range ? document.getText(range) : '');
    const newName = await vscode.window.showInputBox({
      value: placeholder,
      prompt: vscode.l10n.t('Type the new name, then press Enter to rename.'),
    });
    if (!newName || newName === placeholder) return;
    const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, position, newName);
    if (edit) await vscode.workspace.applyEdit(edit);
  }

  /** テキストエディタで開き直す。カーソル、選択範囲、スクロールの位置を引き継ぐ */
  async openInTextEditor(uri) {
    const target = uri instanceof vscode.Uri ? uri : activeTabUri();
    if (!target) return;
    const entry = [...(this.webviews.get(target.toString()) || [])].find((e) => e.panel.active) ||
      [...(this.webviews.get(target.toString()) || [])][0];
    const reply = entry ? await this.request(entry, { type: 'requestSelection' }, 1000) : null;
    await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    const editor = vscode.window.activeTextEditor;
    if (!reply || !editor || editor.document.uri.toString() !== target.toString()) return;
    const { ranges, main, top } = reply.selection;
    const toSelection = (r) => new vscode.Selection(r.anchor.line, r.anchor.col, r.head.line, r.head.col);
    const ordered = [ranges[main], ...ranges.filter((_, i) => i !== main)].filter(Boolean);
    editor.selections = ordered.map(toSelection);
    editor.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
  }

  /** このエディタで開き直す。テキストエディタで開いていたなら、カーソル、選択範囲、スクロールの位置を引き継ぐ */
  async openFromTextEditor(uri) {
    const target = uri instanceof vscode.Uri ? uri : activeTabUri();
    if (!target) return;
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.toString() === target.toString()) {
      const point = (p) => ({ line: p.line, col: p.character });
      this.pendingSelections.set(target.toString(), {
        ranges: editor.selections.map((sel) => ({ anchor: point(sel.anchor), head: point(sel.active) })),
        main: 0,
        top: editor.visibleRanges.length ? editor.visibleRanges[0].start.line : 0,
      });
      setTimeout(() => this.pendingSelections.delete(target.toString()), 10000);
    }
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  }

  /**
   * 見出しの一覧を出し、選んだ見出しに移る（テキストエディタの Go to Symbol in Editor に当たる）。
   * 一覧で見出しを選んでいる間はその見出しを画面に出し、選ばずに閉じたら元の位置に戻す
   */
  async goToHeading() {
    const entry = [...this.webviews.values()].flatMap((set) => [...set]).find((e) => e.panel.active);
    if (!entry) return;
    const webview = entry.panel.webview;
    const id = this.nextRequestId = (this.nextRequestId || 0) + 1;
    const headings = await new Promise((resolve) => {
      entry.pending = { id, resolve };
      webview.postMessage({ type: 'requestHeadings', id });
      setTimeout(() => resolve(null), 3000);
    });
    if (!headings) return;
    const minLevel = Math.min(...headings.map((h) => h.level));
    const pick = vscode.window.createQuickPick();
    pick.items = headings.map((h) => ({
      label: `${'\u2003'.repeat(h.level - minLevel)}${h.text}`,
      description: `H${h.level}`,
      heading: h,
    }));
    pick.matchOnDescription = false;
    let accepted = false;
    pick.onDidChangeActive(([item]) => {
      if (item) webview.postMessage({ type: 'revealPos', pos: item.heading.pos, focus: false });
    });
    pick.onDidAccept(() => {
      const [item] = pick.selectedItems;
      if (!item) return;
      accepted = true;
      webview.postMessage({ type: 'revealPos', pos: item.heading.pos, focus: true });
      pick.hide();
    });
    pick.onDidHide(() => {
      if (!accepted) webview.postMessage({ type: 'restoreView' });
      pick.dispose();
    });
    pick.show();
  }

  /** フォーカスのある Webview（なければ前面の Webview）で操作を行う */
  runInWebview(action) {
    const entry = this.activeEntry();
    if (entry) entry.panel.webview.postMessage({ type: 'run', action });
  }

  /** Webview のどれかにフォーカスがあるかを、キーの割り当ての条件に反映する */
  updateFocusContext() {
    const focused = [...this.webviews.values()].some((set) => [...set].some((e) => e.focused));
    if (focused !== this.focusContext) {
      this.focusContext = focused;
      vscode.commands.executeCommand('setContext', FOCUS_CONTEXT, focused);
    }
  }

  /** 文書を開き、Hushmark で開いたときは見出しに移す */
  async openWithAnchor(target, fragment) {
    const key = target.toString();
    this.pendingAnchors.set(key, fragment);
    // テキストエディタで開いたときなど、Webview が受け取らないものは捨てる
    setTimeout(() => { if (this.pendingAnchors.get(key) === fragment) this.pendingAnchors.delete(key); }, 5000);
    await vscode.commands.executeCommand('vscode.open', target);
    const opened = [...(this.webviews.get(key) || [])].find((entry) => entry.panel.active);
    if (opened && this.pendingAnchors.get(key) === fragment) {
      this.pendingAnchors.delete(key);
      opened.panel.webview.postMessage({ type: 'revealAnchor', fragment });
    }
  }

  resolveCustomTextEditor(document, panel) {
    const webview = panel.webview;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    webview.html = renderHtml(webview, media);

    const session = new SyncSession(document, webview);
    const key = document.uri.toString();
    const entry = { panel, uri: key };
    if (!this.webviews.has(key)) this.webviews.set(key, new Set());
    this.webviews.get(key).add(entry);
    const isThisDocument = (doc) => doc.uri.toString() === document.uri.toString();
    const sendReadOnly = () => isReadOnly(document).then((readOnly) => webview.postMessage({ type: 'readOnly', readOnly }));
    const sendDiagnostics = () => webview.postMessage({ type: 'diagnostics', items: diagnosticsOf(document.uri) });
    // 他の拡張機能のドキュメントリンク。文書が変わるたびに問い合わせると重いので、変更が落ち着いてから送る
    let linksTimer = null;
    const sendLinks = (delay = 500) => {
      clearTimeout(linksTimer);
      linksTimer = setTimeout(async () => webview.postMessage({ type: 'links', items: await documentLinksOf(document.uri) }), delay);
    };
    const subscriptions = [
      webview.onDidReceiveMessage((message) => {
        switch (message.type) {
          case 'ready':
            session.start();
            sendReadOnly();
            sendDiagnostics();
            sendLinks(0);
            if (this.pendingAnchors.has(key)) {
              webview.postMessage({ type: 'revealAnchor', fragment: this.pendingAnchors.get(key) });
              this.pendingAnchors.delete(key);
            }
            if (this.pendingSelections.has(key)) {
              webview.postMessage({ type: 'setSelection', selection: this.pendingSelections.get(key) });
              this.pendingSelections.delete(key);
            }
            break;
          case 'complete':
            completionItems(document, message).then((items) => webview.postMessage({ type: 'completions', id: message.id, items }));
            break;
          case 'cursor':
            entry.cursor = message;
            this.updateStatus();
            break;
          case 'selection':
            if (entry.requests && entry.requests.has(message.id)) {
              entry.requests.get(message.id)(message);
              entry.requests.delete(message.id);
            }
            break;
          case 'edit': session.enqueue(message); break;
          case 'openLink': openLink(message.href, document.uri, webview, this); break;
          case 'headings':
            if (entry.pending && entry.pending.id === message.id) entry.pending.resolve(Array.isArray(message.items) ? message.items : []);
            break;
          case 'log': log('[webview]', message.text); break;
          case 'findInFiles': findInFiles(message); break;
          case 'focus':
            entry.focused = !!message.focused;
            this.updateFocusContext();
            break;
          case 'resolveImage':
            resolveImage(message.href, document.uri).then((src) => webview.postMessage({ type: 'image', id: message.id, src }));
            break;
          case 'pasteImages':
            pasteImages(message.images, document.uri).then((text) => webview.postMessage({ type: 'insertResult', id: message.id, text }));
            break;
          case 'linkFiles':
            webview.postMessage({ type: 'insertResult', id: message.id, text: linkFiles(message.uris, document.uri) });
            break;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!isThisDocument(event.document)) return;
        session.onDocumentChanged();
        sendLinks();
      }),
      // 保存の直前に打った文字が保存から漏れないよう、届いている編集を適用し終えるまで待つ
      vscode.workspace.onWillSaveTextDocument((event) => {
        if (isThisDocument(event.document)) event.waitUntil(session.whenIdle());
      }),
      vscode.languages.onDidChangeDiagnostics((event) => {
        if (event.uris.some((uri) => uri.toString() === document.uri.toString())) sendDiagnostics();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const affects = (sections) => sections.some((section) => event.affectsConfiguration(section, document));
        if (affects(OPTION_SETTINGS)) webview.postMessage({ type: 'options', options: editorOptions(document) });
        if (affects(READONLY_SETTINGS)) sendReadOnly();
      }),
    ];
    const unwatch = watchDiskChanges(document, panel, log);
    subscriptions.push(panel.onDidChangeViewState(() => this.updateStatus()));
    panel.onDidDispose(() => {
      clearTimeout(linksTimer);
      this.webviews.get(key).delete(entry);
      if (this.webviews.get(key).size === 0) this.webviews.delete(key);
      this.updateFocusContext();
      this.updateStatus();
      subscriptions.forEach((s) => s.dispose());
      unwatch();
    });
  }
}

/**
 * 補完の候補（他の拡張機能の補完）を、Webview に送れる形にする。行と列は 0 始まり。
 * スニペットの書式（${1:name} など）は、置き換える文字列だけにする
 */
async function completionItems(document, { line, col, trigger, explicit }) {
  const position = new vscode.Position(line, col);
  let list;
  try {
    list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position, trigger || undefined, 100);
  } catch {
    return [];
  }
  const items = Array.isArray(list) ? list : (list && list.items) || [];
  const kinds = ['text', 'method', 'function', 'constructor', 'property', 'variable', 'class', 'interface', 'namespace', 'property',
    'property', 'constant', 'enum', 'keyword', 'text', 'text', 'text', 'text', 'text', 'text', 'enum', 'constant', 'class', 'keyword', 'variable'];
  const point = (p) => ({ line: p.line, col: p.character });
  const text = (value) => (value === undefined ? '' : typeof value === 'string' ? value : value.value || '');
  const snippetText = (value) => value.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}|\$\d+/g, '').replace(/\\([$}\\])/g, '$1');
  // 自動で出すときは、文書中の単語の候補（種類が Text）を除く。VSCode の Markdown のテキストエディタでも、
  // 単語の候補は明示的に呼んだときだけ出る
  return items.filter((item) => explicit || item.kind !== vscode.CompletionItemKind.Text).slice(0, 200).map((item) => {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    const insert = item.insertText === undefined ? label
      : typeof item.insertText === 'string' ? item.insertText : snippetText(item.insertText.value);
    const range = item.range && (item.range.replacing || item.range);
    return {
      label,
      detail: item.detail || '',
      documentation: text(item.documentation),
      kind: kinds[item.kind] || 'text',
      insertText: insert,
      preselect: !!item.preselect,
      range: range && range.start ? { start: point(range.start), end: point(range.end) } : null,
    };
  });
}

/** 他の拡張機能のドキュメントリンクを、Webview に送れる形にする。行と列は 0 始まり */
async function documentLinksOf(uri) {
  let links;
  try {
    links = await vscode.commands.executeCommand('vscode.executeLinkProvider', uri, 100);
  } catch {
    return [];
  }
  const point = (p) => ({ line: p.line, col: p.character });
  return (links || []).filter((link) => link.target).map((link) => ({
    start: point(link.range.start),
    end: point(link.range.end),
    target: link.target.toString(true),
  }));
}

/** 文書の診断（他の拡張機能のエラーや警告）を、Webview に送れる形にする。行と列は 0 始まり */
function diagnosticsOf(uri) {
  const severities = ['error', 'warning', 'info', 'hint'];
  const point = (p) => ({ line: p.line, col: p.character });
  return vscode.languages.getDiagnostics(uri).map((d) => ({
    start: point(d.range.start),
    end: point(d.range.end),
    severity: severities[d.severity] || 'info',
    message: d.message,
    source: d.source || '',
    code: d.code === undefined || d.code === null ? '' : String(typeof d.code === 'object' ? d.code.value : d.code),
  }));
}

/**
 * 1 つの Webview と TextDocument の同期。
 *
 * Webview からは編集ごとに「変更前の文書に対する行・列の置換」と「変更後の全文」が届く。
 * 置換は届いた順に 1 つずつ WorkspaceEdit で適用し、全文は食い違いの検出に使う。
 * 文書の内容が Webview の持つ内容と違ったとき（別のエディタでの編集、git checkout など）だけ、
 * 全文を Webview に送り直す。ファイル全体の置き換えはしない。
 *
 * 外からの変更が Webview に届く前に打たれた編集は、Webview の持つ全文（base）と今の文書の差の分だけ
 * 位置をずらしてから当てる（textMerge.js の rebaseChanges）。差と重なる編集は当てずに捨て、
 * 全文を送り直して食い違いを解消する。内容を壊すより、打鍵を 1 つ失うほうを選ぶ。
 *
 * Webview が編集の前に持っていた全文は、直前の編集の全文か、その後に Webview が受け取った送り直しの全文。
 * Webview は送り直しを受け取らないことがある（自分の編集の適用を待っている間）ので、送り直しに番号を付け、
 * Webview は最後に受け取った番号を編集に添える。
 */
class SyncSession {
  constructor(document, webview) {
    this.document = document;
    this.webview = webview;
    this.queue = [];
    this.running = false;
    this.idle = Promise.resolve();
    /** 適用し終えた編集の通し番号 */
    this.appliedSeq = 0;
    /** Webview に送った（または Webview から届いた）最後の全文（改行は LF）。送り直すかどうかの判断に使う */
    this.webviewText = null;
    /** Webview が直前の編集の後に持っている全文 */
    this.lastEditText = null;
    /** 直前の編集に添えられていた送り直しの番号 */
    this.lastSyncId = 0;
    /** 送った全文（番号ごと）。Webview がどの全文を受け取ったかを、編集に添えられた番号から引く */
    this.sentTexts = new Map();
    this.nextSyncId = 1;
    this.warnedFailure = false;
  }

  start() {
    this.queue = [];
    this.appliedSeq = 0;
    this.sentTexts.clear();
    this.webviewText = documentText(this.document);
    const syncId = this.remember(this.webviewText);
    this.lastSyncId = syncId;
    this.lastEditText = this.webviewText;
    this.webview.postMessage({ type: 'init', text: this.webviewText, syncId, options: editorOptions(this.document), strings: webviewStrings() });
  }

  remember(text) {
    const id = this.nextSyncId++;
    this.sentTexts.set(id, text);
    // Webview が受け取らないまま送り直しが続いても、古いものから捨てて大きくなりすぎないようにする
    // （捨てた番号の編集が届いたら、base が分からないので捨てて送り直す）
    while (this.sentTexts.size > 20) this.sentTexts.delete(this.sentTexts.keys().next().value);
    return id;
  }

  enqueue(message) {
    this.queue.push(message);
    if (!this.running) this.idle = this.run();
  }

  async run() {
    this.running = true;
    try {
      while (this.queue.length > 0) await this.apply(this.queue.shift());
    } finally {
      this.running = false;
    }
    this.verify();
  }

  async apply(message) {
    // この編集の前に Webview が持っていた全文
    const base = message.syncId === this.lastSyncId ? this.lastEditText : this.sentTexts.get(message.syncId);
    this.lastSyncId = message.syncId;
    this.lastEditText = message.text;
    this.webviewText = message.text;
    this.appliedSeq = message.seq;
    // 受け取られた送り直しより古いものは、もう引かれない
    for (const id of this.sentTexts.keys()) if (id < message.syncId) this.sentTexts.delete(id);

    const changes = base === undefined ? null : rebaseChanges(base, documentText(this.document), message.changes);
    if (!changes) {
      // 外からの変更と重なった。当てずに捨て、run の最後の verify で全文を送り直す
      log('edit dropped (conflicts with an external change)', { seq: message.seq });
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const c of changes) {
      edit.replace(this.document.uri, new vscode.Range(c.fromLine, c.fromCh, c.toLine, c.toCh), c.insert);
    }
    let applied = false;
    try {
      applied = await vscode.workspace.applyEdit(edit);
    } catch (error) {
      log('applyEdit threw', String(error));
    }
    log('edit', { seq: message.seq, changes, applied });
    if (!applied && !this.warnedFailure) {
      // 後続の編集は、当たらなかった分を含む全文を base にしてずらすので、食い違っても位置はずれない。
      // run の最後の verify で、文書の実際の内容を Webview に送り直す
      this.warnedFailure = true;
      vscode.window.showWarningMessage(vscode.l10n.t('Hushmark: Could not apply an edit to the document. Showing the document content again ({0})', this.document.uri.fsPath));
    }
  }

  onDocumentChanged() {
    // 自分の編集による変更は、適用を終えた後の verify でまとめて確かめる
    if (!this.running) this.verify();
  }

  verify() {
    const text = documentText(this.document);
    if (text === this.webviewText) return;
    log('sync to webview', { ackSeq: this.appliedSeq, docLength: text.length, webviewLength: this.webviewText && this.webviewText.length });
    this.webviewText = text;
    const syncId = this.remember(text);
    this.webview.postMessage({ type: 'sync', text, syncId, ackSeq: this.appliedSeq });
  }

  whenIdle() {
    return this.idle;
  }
}

/** 読み取り専用かどうかを決める設定（isReadOnly） */
const READONLY_SETTINGS = ['files.readonlyInclude', 'files.readonlyExclude', 'files.readonlyFromPermissions'];

/**
 * 書き込めない文書か。VSCode のテキストエディタと同じ基準で決める。
 * - 書き込めないファイルシステムのもの（git の過去の版など）は、いつも書き込めない
 * - 設定 files.readonlyInclude に合い、files.readonlyExclude に合わないもの
 * - ファイルの属性が読み取り専用（VSCode の中では「ロック」）のものは、files.readonlyFromPermissions が
 *   有効なときだけ。既定では VSCode も編集でき、保存のときに上書きするかを尋ねる
 * 書き込めない文書では、Webview は利用者の操作による変更を受け付けない
 */
async function isReadOnly(document) {
  const uri = document.uri;
  if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) return true;
  const files = vscode.workspace.getConfiguration('files', document);
  const matches = (globs) => Object.entries(globs || {})
    .some(([pattern, on]) => on && vscode.languages.match({ pattern }, document) > 0);
  if (matches(files.get('readonlyInclude')) && !matches(files.get('readonlyExclude'))) return true;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.permissions || 0) & vscode.FilePermission.Readonly) return true;
  } catch {
    // まだ保存していない文書など、属性を読めないものは書き込めるものとして扱う
    return false;
  }
  if (uri.scheme !== 'file' || files.get('readonlyFromPermissions') !== true) return false;
  // ファイルの属性による読み取り専用は、API の stat には出てこないので、書き込めるかを直接確かめる
  // （拡張機能はファイルのある側で動くので、Remote-SSH でも手元のファイルとして調べられる）。
  // Web 版の VSCode では fs がないので、書き込めるものとして扱う
  let fs;
  try {
    fs = require('fs');
  } catch {
    return false;
  }
  try {
    await fs.promises.access(uri.fsPath, fs.constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

/** Webview に渡す設定（editorOptions） */
const OPTION_SETTINGS = [
  'hushmark',
  'editor.lineNumbers', 'editor.fontFamily', 'editor.fontSize', 'editor.lineHeight', 'editor.wrappingIndent', 'editor.tabSize',
  'editor.wordWrap', 'editor.renderLineHighlight', 'editor.renderLineHighlightOnlyWhenFocus',
  'editor.multiCursorModifier', 'editor.autoClosingBrackets', 'editor.autoSurround', 'editor.folding', 'editor.showFoldingControls',
  'editor.cursorStyle', 'editor.cursorBlinking', 'editor.cursorWidth', 'editor.cursorSmoothCaretAnimation',
  'editor.fontWeight', 'editor.fontLigatures', 'editor.letterSpacing',
  'editor.selectionHighlight', 'editor.emptySelectionClipboard', 'editor.insertSpaces', 'editor.detectIndentation',
  'editor.cursorSurroundingLines', 'editor.renderWhitespace', 'editor.renderControlCharacters', 'editor.unicodeHighlight',
  'editor.mouseWheelZoom', 'editor.links', 'editor.hover', 'editor.scrollBeyondLastLine', 'editor.smoothScrolling',
  'editor.padding', 'editor.scrollbar',
];

/** テキストエディタの設定のうち、Webview でも合わせるもの */
function editorOptions(document) {
  const editor = vscode.workspace.getConfiguration('editor', document);
  const hushmark = vscode.workspace.getConfiguration('hushmark', document);
  return {
    lineNumbers: editor.get('lineNumbers', 'on'),
    fontSize: editor.get('fontSize', 14),
    lineHeight: editor.get('lineHeight', 0),
    wrappingIndent: editor.get('wrappingIndent', 'same'),
    tabSize: editor.get('tabSize', 4),
    wordWrap: editor.get('wordWrap', 'off'),
    renderLineHighlight: editor.get('renderLineHighlight', 'line'),
    renderLineHighlightOnlyWhenFocus: editor.get('renderLineHighlightOnlyWhenFocus', false),
    multiCursorModifier: editor.get('multiCursorModifier', 'alt'),
    autoClosingBrackets: editor.get('autoClosingBrackets', 'languageDefined'),
    autoSurround: editor.get('autoSurround', 'languageDefined'),
    folding: editor.get('folding', true),
    showFoldingControls: editor.get('showFoldingControls', 'mouseover'),
    cursorStyle: editor.get('cursorStyle', 'line'),
    cursorBlinking: editor.get('cursorBlinking', 'blink'),
    cursorWidth: Number(editor.get('cursorWidth', 0)) || 0,
    cursorSmoothCaretAnimation: editor.get('cursorSmoothCaretAnimation', 'off'),
    fontWeight: String(editor.get('fontWeight', 'normal')),
    fontLigatures: editor.get('fontLigatures', false),
    letterSpacing: Number(editor.get('letterSpacing', 0)) || 0,
    selectionHighlight: editor.get('selectionHighlight', true),
    emptySelectionClipboard: editor.get('emptySelectionClipboard', true),
    insertSpaces: editor.get('insertSpaces', true),
    detectIndentation: editor.get('detectIndentation', true),
    cursorSurroundingLines: Number(editor.get('cursorSurroundingLines', 0)) || 0,
    renderWhitespace: editor.get('renderWhitespace', 'selection'),
    renderControlCharacters: editor.get('renderControlCharacters', true),
    invisibleCharacters: editor.get('unicodeHighlight.invisibleCharacters', false),
    mouseWheelZoom: editor.get('mouseWheelZoom', false),
    links: editor.get('links', true),
    hoverEnabled: editor.get('hover.enabled', true),
    hoverDelay: Number(editor.get('hover.delay', 300)),
    scrollBeyondLastLine: editor.get('scrollBeyondLastLine', true),
    smoothScrolling: editor.get('smoothScrolling', false),
    paddingTop: Number(editor.get('padding.top', 0)) || 0,
    paddingBottom: Number(editor.get('padding.bottom', 0)) || 0,
    verticalScrollbarSize: Number(editor.get('scrollbar.verticalScrollbarSize', 14)),
    horizontalScrollbarSize: Number(editor.get('scrollbar.horizontalScrollbarSize', 12)),
    // "[markdown]" の中の editor.fontFamily も、テキストエディタと同じく効かせる（document を渡して読む）
    style: { ...styleOptions(hushmark), fontFamily: safeFontFamily(editor.get('fontFamily')) },
  };
}

/** 見た目の設定 */
function styleOptions(config) {
  return {
    look: oneOf(config.get('previewStyle'), STYLES, 'soft'),
    color: oneOf(config.get('previewColor'), COLORS, 'green'),
    colorScheme: oneOf(config.get('previewColorScheme'), COLOR_SCHEMES, 'theme'),
    customColor: /^#[0-9a-f]{6}$/i.test(config.get('previewCustomColor') || '') ? config.get('previewCustomColor') : '#3366cc',
    colorCustomizations: plainObject(config.get('colorCustomizations')),
    headingSize: oneOf(config.get('headingSize'), HEADING_SIZES, 'medium'),
    rightMargin: config.get('rightMargin', true) !== false,
  };
}

/** 選択肢（package.json の enum と同じ） */
const STYLES = ['soft', 'minimal', 'reference'];
const COLORS = ['green', 'cyan', 'blue', 'purple', 'pink', 'orange', 'sepia', 'mono', 'custom'];
const COLOR_SCHEMES = ['theme', 'auto', 'light', 'dark'];
const HEADING_SIZES = ['body', 'medium', 'large'];

/** 選択肢にない値は既定にする */
function oneOf(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

/** Webview に送れる、文字列と入れ子のオブジェクトだけからなる値にする（色の値は Webview で確かめる） */
function plainObject(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) out[key] = plainObject(item);
  }
  return out;
}

/** CSS の値として埋め込むので、宣言やタグを閉じられる文字は落とす */
function safeFontFamily(value) {
  return String(value || '').replace(/[<>{};]/g, '').trim();
}

/**
 * Webview の画面に出す文言（webview/strings.js）。英語を元にし、VSCode の表示言語に合わせた翻訳
 * （l10n/bundle.l10n.*.json）を Webview に渡す。{0} などは Webview で置き換えるので、ここでは引数を渡さない
 */
const WEBVIEW_STRINGS = [
  'Find', 'Replace', 'All', 'Toggle Replace', 'Match Case', 'Match Whole Word', 'Use Regular Expression',
  'Previous Match', 'Next Match', 'Close', 'Replace All', 'No results', 'Invalid regular expression',
  '+ Row', '+ Column', 'Add a row at the end', 'Add a column at the right',
  '{0}+Click to open',
];

function webviewStrings() {
  return Object.fromEntries(WEBVIEW_STRINGS.map((text) => [text, vscode.l10n.t(text)]));
}

/** Webview 側は改行を LF で扱うので、比較と送信は LF にそろえる */
function documentText(document) {
  const text = document.getText();
  return document.eol === vscode.EndOfLine.CRLF ? text.replace(/\r\n/g, '\n') : text;
}

/** 貼り付けた画像の種類ごとの拡張子 */
const IMAGE_MIME_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
};

/**
 * 貼り付けた（ドロップした）画像を文書と同じフォルダーに保存し、画像のリンクの Markdown を返す。
 * VSCode の Markdown のテキストエディタの既定と同じく、名前は image.png（あれば image-1.png など）にする。
 * 保存先のない文書（まだ保存していない文書）や、保存できなかったときは null
 */
async function pasteImages(images, documentUri) {
  if (!Array.isArray(images) || documentUri.scheme === 'untitled') return null;
  const markdown = vscode.workspace.getConfiguration('markdown', documentUri);
  // VSCode の Markdown のテキストエディタと同じく、markdown.editor.filePaste.enabled が never なら保存しない
  if (markdown.get('editor.filePaste.enabled', 'smart') === 'never') return null;
  const overwrite = markdown.get('copyFiles.overwriteBehavior', 'nameIncrementally') === 'overwrite';
  const dir = vscode.Uri.joinPath(documentUri, '..');
  const links = [];
  try {
    for (const { data, type, name } of images) {
      const ext = IMAGE_MIME_EXTENSIONS[type];
      if (!ext || typeof data !== 'string') continue;
      const base = (typeof name === 'string' && name.replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|]/g, '').trim()) || 'image';
      const first = copyDestination(documentUri, `${base}.${ext}`);
      let target = first;
      for (let n = 1; !overwrite && (await exists(target)); n++) {
        target = vscode.Uri.joinPath(first, '..', first.path.split('/').pop().replace(/(\.[^.]*)?$/, (e) => `-${n}${e}`));
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
      await vscode.workspace.fs.writeFile(target, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      const alt = target.path.split('/').pop().replace(/\.[^.]*$/, '');
      links.push(`![${alt}](${markdownPath(relativePath(dir.path, target.path))})`);
    }
  } catch (error) {
    log('paste image failed', String(error));
    vscode.window.showWarningMessage(vscode.l10n.t('Could not save the pasted image: {0}', String(error.message || error)));
  }
  return links.length ? links.join(' ') : null;
}

/**
 * 貼り付けたファイルを保存する場所。VSCode の markdown.copyFiles.destination に合わせる。
 * 設定は「文書のパスに合う glob → 保存先」の対応で、保存先には ${documentDirName} などの変数を使える。
 * / で始まらない保存先は文書のフォルダーから、/ で終わる保存先はフォルダーとして、元の名前で保存する。
 * どの glob にも合わなければ、文書と同じフォルダーに保存する
 */
function copyDestination(documentUri, fileName) {
  const destinations = vscode.workspace.getConfiguration('markdown', documentUri).get('copyFiles.destination') || {};
  const folder = vscode.workspace.getWorkspaceFolder(documentUri);
  const docPath = documentUri.path;
  const relative = folder ? docPath.slice(folder.uri.path.replace(/\/$/, '').length + 1) : docPath;
  const docDir = docPath.replace(/\/[^/]*$/, '');
  const docFile = docPath.split('/').pop();
  const ext = (name) => (/\.([^.]*)$/.exec(name) || [, ''])[1];
  const now = new Date();
  const vars = {
    documentDirName: docDir,
    documentRelativeDirName: relative.replace(/\/?[^/]*$/, ''),
    documentFileName: docFile,
    documentBaseName: docFile.replace(/\.[^.]*$/, ''),
    documentExtName: ext(docFile),
    documentFilePath: docPath,
    documentRelativeFilePath: relative,
    documentWorkspaceFolder: folder ? folder.uri.path : docDir,
    fileName,
    fileExtName: ext(fileName),
    unixTime: String(now.getTime()),
    isoTime: now.toISOString(),
  };
  for (const [glob, destination] of Object.entries(destinations)) {
    if (typeof destination !== 'string' || !(globMatches(glob, relative) || globMatches(glob, docPath))) continue;
    let resolved = destination.replace(/\$\{(\w+)\}/g, (all, name) => (name in vars ? vars[name] : all));
    if (resolved.endsWith('/')) resolved += fileName;
    const base = resolved.startsWith('/') ? documentUri.with({ path: '/' }) : vscode.Uri.joinPath(documentUri, '..');
    return vscode.Uri.joinPath(base, resolved.replace(/^\//, ''));
  }
  return vscode.Uri.joinPath(documentUri, '..', fileName);
}

/** glob（**、*、?、{a,b}）がパスに合うか */
function globMatches(glob, path) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else if (ch === '{') source += '(?:';
    else if (ch === '}') source += ')';
    else if (ch === ',') source += '|';
    else source += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(path);
}

async function exists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** エクスプローラーからドロップしたファイルへのリンクの Markdown。画像は画像のリンクにする */
function linkFiles(uris, documentUri) {
  if (!Array.isArray(uris)) return null;
  // VSCode の Markdown のテキストエディタと同じく、markdown.editor.drop.enabled が never ならリンクを入れない
  if (vscode.workspace.getConfiguration('markdown', documentUri).get('editor.drop.enabled', 'smart') === 'never') return null;
  const dir = vscode.Uri.joinPath(documentUri, '..');
  const links = [];
  for (const raw of uris) {
    let uri;
    try {
      uri = vscode.Uri.parse(String(raw).trim(), true);
    } catch {
      continue;
    }
    const sameRoot = uri.scheme === dir.scheme && uri.authority === dir.authority;
    const target = markdownPath(sameRoot ? relativePath(dir.path, uri.path) : uri.toString());
    const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    links.push(ext && IMAGE_TYPES[ext.toLowerCase()] ? `![${name.replace(/\.[^.]*$/, '')}](${target})` : `[${name}](${target})`);
  }
  return links.length ? links.join(' ') : null;
}

/** Ctrl+Shift+F / Ctrl+Shift+H。テキストエディタと同じく、選択中の文字列を検索語にして開く */
async function findInFiles({ query, replace }) {
  const command = replace ? 'workbench.action.replaceInFiles' : 'workbench.action.findInFiles';
  await vscode.commands.executeCommand(command, query ? { query, triggerSearch: true } : undefined);
}

/** リンク先のファイルのパス（URL のエンコードのまま）を、文書からの相対パスか絶対パスとして URI にする */
function fileTarget(rawFile, documentUri) {
  const filePart = decodeURIComponent(rawFile);
  if (!/^([a-z]:)?[\\/]/i.test(filePart)) return vscode.Uri.joinPath(documentUri, '..', filePart);
  if (documentUri.scheme === 'file') return vscode.Uri.file(filePart);
  // Remote-SSH などでは、文書と同じリモートの絶対パスとして開く
  return documentUri.with({ path: filePart.replace(/\\/g, '/'), query: '', fragment: '' });
}

/** 画像の種類（拡張子ごと） */
const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};
/** 浮かせて表示する画像の大きさの上限 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 画像のリンク先を、Webview の img に渡せる形にする。https と data: はそのまま使う。ファイルは workspace.fs で
 * 読んで data: URL にする（Remote-SSH や Web 版の VSCode でも、Webview から直接は読めない場所にあるため）。
 * 表示できないもの（画像でないファイル、大きすぎるもの、読めないもの）は null
 */
async function resolveImage(rawHref, documentUri) {
  if (typeof rawHref !== 'string') return null;
  const href = normalizeHref(rawHref);
  if (/^https:/i.test(href) || /^data:image\//i.test(href)) return href;
  if (href === '' || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href))) return null;
  try {
    const target = fileTarget(href.split(/[?#]/)[0], documentUri);
    const type = IMAGE_TYPES[(target.path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()];
    if (!type) return null;
    const stat = await vscode.workspace.fs.stat(target);
    if (stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = await vscode.workspace.fs.readFile(target);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(binary)}`;
  } catch (error) {
    log('image not loaded', href, String(error));
    return null;
  }
}

/**
 * リンクを開く。#見出し は同じ Webview で見出しに移し、other.md#見出し は文書を開いてから見出しに移す
 * （Hushmark で開いたときだけ。テキストエディタは文書の先頭を表示する）
 */
async function openLink(rawHref, documentUri, webview, provider) {
  if (typeof rawHref !== 'string') return;
  const href = normalizeHref(rawHref);
  if (href === '' || href === '#') return;
  if (href.startsWith('#')) {
    webview.postMessage({ type: 'revealAnchor', fragment: href.slice(1) });
    return;
  }
  try {
    // 他の拡張機能のドキュメントリンクは file: の URI のことがある。外部のアプリではなく VSCode で開く
    if (/^file:/i.test(href)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const [rawFile, ...rest] = href.split('#');
    const fragment = rest.join('#');
    const target = fileTarget(rawFile, documentUri);
    if (fragment && /\.(md|markdown)$/i.test(target.path)) await provider.openWithAnchor(target, fragment);
    else await vscode.commands.executeCommand('vscode.open', target);
  } catch (error) {
    vscode.window.showWarningMessage(vscode.l10n.t('Could not open the link: {0}', href));
  }
}

function renderHtml(webview, media) {
  // Web 版の VSCode でも動くよう、Node の crypto ではなく Web Crypto を使う
  const nonce = btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(16))));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dist', 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.css'));
  // 最初の表示から見た目を合わせる（Webview は、設定を受け取ってから配色などを入れる）
  const initial = styleOptions(vscode.workspace.getConfiguration('hushmark'));
  const csp = [
    "default-src 'none'",
    // CodeMirror は実行時に style 要素を差し込むので 'unsafe-inline' が要る
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // 言語ごとの構文定義は分割したチャンクを動的に読み込む
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    // 画像のリンクにマウスを載せたときの表示。ファイルは data: で渡し、Web 上の画像は https だけ読み込む
    `img-src ${webview.cspSource} data: https:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
</head>
<body class="md-style-${initial.look} md-heading-${initial.headingSize}${initial.rightMargin ? '' : ' md-no-right-margin'}">
  <div id="editor"></div>
  <script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

module.exports = { activate, deactivate };

// E2E テスト用の拡張機能。他の拡張機能（cSpell、markdownlint、Prettier など）が Markdown に提供する機能の代わりに、
// 決まった語に対して診断・クイックフィックス・補完・書式設定・リネーム・リンクを返す。test/e2e/vscode.mjs が読み込む。
//
// - 「teh」に警告の診断を出し、クイックフィックスで「the」に直す
// - 「@fix」の後ろで補完すると「fixture-item」を出す
// - 書式設定で、行末の空白を消す
// - 「Alpha」のリネームで、文書の中の Alpha をすべて新しい名前にする
// - 「ISSUE-123」を https://example.com/issues/123 へのリンクにする

const vscode = require('vscode');

exports.activate = (context) => {
  const selector = { language: 'markdown' };
  const collection = vscode.languages.createDiagnosticCollection('fixture');
  const find = (document, word) => {
    const ranges = [];
    const text = document.getText();
    for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) {
      ranges.push(new vscode.Range(document.positionAt(i), document.positionAt(i + word.length)));
    }
    return ranges;
  };
  const validate = (document) => {
    if (document.languageId !== 'markdown') return;
    collection.set(document.uri, find(document, 'teh').map((range) => {
      const d = new vscode.Diagnostic(range, "Did you mean 'the'?", vscode.DiagnosticSeverity.Warning);
      d.source = 'fixture';
      d.code = 'typo';
      return d;
    }));
  };
  vscode.workspace.textDocuments.forEach(validate);
  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument((e) => validate(e.document)),
    vscode.languages.registerCodeActionsProvider(selector, {
      provideCodeActions(document, _range, ctx) {
        return ctx.diagnostics.filter((d) => d.source === 'fixture').map((d) => {
          const action = new vscode.CodeAction("Change to 'the'", vscode.CodeActionKind.QuickFix);
          action.edit = new vscode.WorkspaceEdit();
          action.edit.replace(document.uri, d.range, 'the');
          action.diagnostics = [d];
          return action;
        });
      },
    }),
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems(document, position) {
        const before = document.lineAt(position).text.slice(0, position.character);
        if (!/@fix\w*$/.test(before)) return [];
        const item = new vscode.CompletionItem('fixture-item', vscode.CompletionItemKind.Value);
        item.detail = 'from the fixture';
        return [item];
      },
    }, '@'),
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits(document) {
        const edits = [];
        for (let n = 0; n < document.lineCount; n++) {
          const line = document.lineAt(n);
          const trimmed = line.text.replace(/[ \t]+$/, '');
          // 行末の空白 2 つ（改行）は残す
          if (trimmed.length !== line.text.length && !/ {2}$/.test(line.text)) {
            edits.push(vscode.TextEdit.delete(new vscode.Range(n, trimmed.length, n, line.text.length)));
          }
        }
        return edits;
      },
    }),
    vscode.languages.registerRenameProvider(selector, {
      prepareRename(document, position) {
        const range = document.getWordRangeAtPosition(position, /Alpha/);
        if (!range) throw new Error('Not renameable');
        return { range, placeholder: 'Alpha' };
      },
      provideRenameEdits(document, _position, newName) {
        const edit = new vscode.WorkspaceEdit();
        for (const range of find(document, 'Alpha')) edit.replace(document.uri, range, newName);
        return edit;
      },
    }),
    vscode.languages.registerDocumentLinkProvider(selector, {
      provideDocumentLinks(document) {
        return find(document, 'ISSUE-123').map((range) => new vscode.DocumentLink(range, vscode.Uri.parse('https://example.com/issues/123')));
      },
    }),
  );
};

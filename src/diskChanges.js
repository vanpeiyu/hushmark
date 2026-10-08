'use strict';

const vscode = require('vscode');

/**
 * ディスク上のファイルが外で変更されたとき、文書に未保存の変更があれば通知する。
 *
 * 未保存の変更がない文書は、VSCode が自分でディスクから読み直す（その変更は onDidChangeTextDocument で
 * Webview に届く）。未保存の変更があると VSCode は読み直さず、何も知らせないので、ここで通知し、
 * 「Revert File」でディスクの内容を読み込めるようにする。
 *
 * 未保存の変更があるかどうかは、TextDocument.isDirty では判断しない。保存の途中で入力すると、
 * VSCode の画面では未保存なのに isDirty が false のままになることがあるため。代わりに、ディスクの内容が
 * 最後に保存（または読み込み）した内容（baseline）と違い、少し待っても文書の内容がディスクと一致しない
 * （VSCode が読み直さない）ときに通知する。自分の保存では、ディスクの内容が baseline と同じになる。
 *
 * 1 つの文書を複数のエディタで開くことがあるので、監視は文書ごとに 1 つにする（watchDiskChanges で参照を数える）。
 */
/** URI のファイル名 */
function basename(uri) {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

class DiskChangeWatcher {
  constructor(document, log) {
    this.document = document;
    this.log = log;
    this.refs = 0;
    /** エディタのパネル。元に戻すときに、どれかを前に出してから VSCode のコマンドを実行する */
    this.panels = new Set();
    /** 最後に保存した（または読み込んだ）ディスクの内容（改行は LF）。読むまでは null */
    this.baseline = null;
    this.checking = false;
    this.pending = false;
    this.notifying = false;
    this.timer = null;
    this.disposed = false;
    this.subscriptions = [];
    if (document.uri.scheme === 'untitled') return;

    this.readDisk().then((disk) => {
      if (this.baseline === null) this.baseline = disk;
    });
    this.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (doc.uri.toString() !== document.uri.toString()) return;
        // 保存した後に入力が続いていることがあるので、文書ではなくディスクから読む
        const disk = await this.readDisk();
        if (disk !== null) this.baseline = disk;
      }),
    );
    const dir = vscode.Uri.joinPath(document.uri, '..');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, basename(document.uri)), false, false, true);
    // 書き込みは、変更の通知が続けて何回か届くことがあるので、まとめて 1 回調べる
    const schedule = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.check(), 150);
    };
    watcher.onDidChange(schedule);
    // 別のファイルに書いてから名前を変えて置き換えるツールでは、作成として届く
    watcher.onDidCreate(schedule);
    this.subscriptions.push(watcher);
  }

  async readDisk() {
    try {
      return normalize(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.document.uri)));
    } catch (error) {
      this.log('could not read the file on disk', String(error));
      return null;
    }
  }

  async check() {
    if (this.checking) {
      this.pending = true;
      return;
    }
    this.checking = true;
    try {
      do {
        this.pending = false;
        await this.checkOnce();
      } while (this.pending && !this.disposed);
    } finally {
      this.checking = false;
    }
  }

  async checkOnce() {
    const disk = await this.readDisk();
    if (disk === null || disk === this.baseline) return;
    // 未保存の変更がなければ、VSCode が読み直して文書がディスクの内容と一致する
    // 自分の保存のときは、保存の通知（onDidSaveTextDocument）で baseline がディスクの内容になる
    for (let i = 0; i < 10; i++) {
      if (this.disposed || disk === this.baseline) return;
      if (normalize(this.document.getText()) === disk) {
        this.baseline = disk;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // 同じ内容について通知を繰り返さない
    this.baseline = disk;
    this.log('changed on disk, but not reloaded (unsaved changes)', { diskLength: disk.length });
    if (!this.notifying) this.notify();
  }

  async notify() {
    this.notifying = true;
    const revert = vscode.l10n.t('Revert File');
    const name = basename(this.document.uri);
    try {
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Hushmark: {0} was changed on disk. It has unsaved changes, so the changes on disk were not loaded.', name),
        revert,
      );
      this.log('notification closed', { choice });
      this.notifying = false;
      if (choice === revert) await this.revert();
    } finally {
      this.notifying = false;
    }
  }

  /** 未保存の変更を捨て、ディスクの内容を読み込む（VSCode の「Revert File」と同じ） */
  async revert() {
    const panels = [...this.panels];
    const panel = panels.find((p) => p.active) || panels[0];
    if (!panel) return;
    panel.reveal(panel.viewColumn);
    this.log('revert', { active: panel.active });
    await vscode.commands.executeCommand('workbench.action.files.revert');
    this.log('reverted', { dirty: this.document.isDirty });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
  }
}

/** 改行を LF にそろえ、先頭の BOM を除く */
function normalize(text) {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

const watchers = new Map();

/**
 * 文書の監視を始め、パネルを登録する。返す関数を呼ぶと登録を外し、使うパネルがなくなったら監視を止める
 * @param {vscode.TextDocument} document
 * @param {vscode.WebviewPanel} panel
 * @param {(...args: unknown[]) => void} log
 */
function watchDiskChanges(document, panel, log) {
  const key = document.uri.toString();
  let watcher = watchers.get(key);
  if (!watcher) {
    watcher = new DiskChangeWatcher(document, log);
    watchers.set(key, watcher);
  }
  watcher.refs++;
  watcher.panels.add(panel);
  return () => {
    watcher.panels.delete(panel);
    if (--watcher.refs > 0) return;
    watcher.dispose();
    watchers.delete(key);
  };
}

module.exports = { watchDiskChanges };

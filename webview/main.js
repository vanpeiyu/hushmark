// Webview 側のエントリポイント。CodeMirror を立ち上げ、拡張機能本体と変更をやり取りする。

import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap } from '@codemirror/view';
import { defaultKeymap, history, indentWithTab, redo, undo } from '@codemirror/commands';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { searchKeymap } from '@codemirror/search';
import { findWidget, openFind, openFindWith, openReplace } from './findWidget.js';
import { cellKeymap } from './cellEditor.js';
import { livePreview } from './livePreview.js';
import { lineNumberGutter, reconfigureLineNumbers } from './lineNumbers.js';
import { applyMetrics } from './metrics.js';
import { markdownSupport } from './markdownSetup.js';
import { reconfigureWrapIndent, wrapIndent } from './wrapIndent.js';
import { lineHighlight, reconfigureLineHighlight } from './lineHighlight.js';
import { verticalMove } from './verticalMove.js';
import { diffText, toLineChanges } from './sync.js';
import { hasMod } from './platform.js';
import { setStrings } from './strings.js';
import { imagePreview } from './imagePreview.js';
import { revealAnchor } from './anchors.js';

const vscode = acquireVsCodeApi();

/** 拡張機能本体から届いた変更に付ける印。これが付いた変更は送り返さない。 */
const remote = Annotation.define();

let view = null;

/**
 * 折り返し。最初は VSCode の editor.wordWrap に従い（'off' 以外は折り返す）、Alt+Z でその場で切り替える。
 * VSCode の Alt+Z（折り返しの切り替え）はテキストエディタにしか効かないので、ここで受ける。設定は書き換えない
 */
const wrapping = new Compartment();
let wrapOn = true;
let lastWordWrap = null;
const wrappingOf = (on) => (on ? EditorView.lineWrapping : []);

function toggleWrapping() {
  wrapOn = !wrapOn;
  view.dispatch({ effects: wrapping.reconfigure(wrappingOf(wrapOn)) });
  return true;
}

/** editor.wordWrap が変わったときだけ、その値に合わせる（Alt+Z で切り替えた状態は、設定が変わるまで保つ） */
function wordWrapEffect(wordWrap) {
  if (wordWrap === lastWordWrap) return [];
  lastWordWrap = wordWrap;
  wrapOn = wordWrap !== 'off';
  return [wrapping.reconfigure(wrappingOf(wrapOn))];
}

/**
 * 書き込めない文書（拡張機能本体が調べて知らせる）。利用者の操作による変更は、入力・貼り付け・表のセル・
 * チェックボックス・Ctrl+B などを含めてすべて捨てる。拡張機能本体から届いた変更（remote）は受け付ける
 */
let readOnly = false;
const readOnlyState = new Compartment();
const blockLocalEdits = EditorState.transactionFilter.of((tr) =>
  (readOnly && tr.docChanged && !tr.annotation(remote) ? [] : tr));

/** タブの幅（VSCode の editor.tabSize） */
const tabSize = new Compartment();
const tabSizeOf = (options) => EditorState.tabSize.of(options.tabSize > 0 ? options.tabSize : 4);
/** 送った編集の通し番号。拡張機能本体はどこまで適用したかをこの番号で返す。 */
let sentSeq = 0;
/** 最後に受け取った全文の番号。編集に添えて、拡張機能本体がこの編集の基準の全文を知るのに使う */
let syncId = 0;

// VSCode の Webview は Ctrl+Z / Ctrl+Y / Ctrl+F を横取りして VSCode 側のコマンドにする。
// stopPropagation でその前に止め、エディタ自身の取り消しと検索を使う。
// Ctrl+B（サイドバー開閉）なども同じ理由で止める。
// mac は macOS でのキー（VSCode の macOS 版に合わせる）
const ownKeys = (key, run, mac) => ({ key, mac, run, preventDefault: true, stopPropagation: true });

const editorKeymap = [
  ownKeys('Mod-z', undo),
  ownKeys('Mod-y', redo),
  ownKeys('Mod-Shift-z', redo),
  ownKeys('Mod-f', openFind),
  // macOS の Cmd+H はアプリを隠す操作なので、VSCode の macOS 版と同じく Cmd+Option+F で置換を開く
  ownKeys('Mod-h', openReplace, 'Mod-Alt-f'),
  // フォルダー内の検索は VSCode に任せるが、テキストエディタと同じく選択中の文字列を検索語として渡す
  ownKeys('Mod-Shift-f', searchInFiles(false)),
  ownKeys('Mod-Shift-h', searchInFiles(true)),
  ownKeys('Mod-b', toggleWrap('**')),
  ownKeys('Mod-i', toggleWrap('*')),
  ownKeys('Alt-z', toggleWrapping),
];

/**
 * 表のセルのエディタでも使うショートカット。キーはセルのエディタで呼ばれる（target はセルのエディタ）。
 * 取り消しと、セルの移動のキーは表のウィジェット（tableWidget.js）の側で入れる
 */
const cellKeys = [
  ownKeys('Mod-f', (cell) => openFindWith(view, selectedLine(cell), false)),
  ownKeys('Mod-h', (cell) => openFindWith(view, selectedLine(cell), true), 'Mod-Alt-f'),
  ownKeys('Mod-Shift-f', searchInFiles(false)),
  ownKeys('Mod-Shift-h', searchInFiles(true)),
  ownKeys('Mod-b', toggleWrap('**')),
  ownKeys('Mod-i', toggleWrap('*')),
  ownKeys('Alt-z', toggleWrapping),
];

function createEditor(text, options) {
  lastWordWrap = options.wordWrap;
  wrapOn = options.wordWrap !== 'off';
  const state = EditorState.create({
    doc: text,
    extensions: [
      keymap.of(editorKeymap),
      cellKeymap.of(cellKeys),
      blockLocalEdits,
      readOnlyState.of(EditorState.readOnly.of(readOnly)),
      history(),
      // カーソルは drawSelection で描く。ブラウザが描くカーソルは、要素の境目（見出しの「#」と空白の間など）で
      // 文書の位置と違うところに出ることがあるため。選択範囲は drawSelection の層を隠し、ブラウザの表示に戻す
      // （drawSelection は選択を文字の後ろの層に描くので、背景色を持つインラインコードなどの上で見えなくなる）
      // （editor.css）
      drawSelection(),
      dropCursor(),
      lineNumberGutter(options.lineNumbers),
      wrapIndent(options.wrappingIndent),
      lineHighlight(options),
      tabSize.of(tabSizeOf(options)),
      wrapping.of(wrappingOf(wrapOn)),
      markdownSupport(languages),
      syntaxHighlighting(classHighlighter),
      livePreview({ openLink: (href) => vscode.postMessage({ type: 'openLink', href }) }),
      imagePreview(resolveImage),
      // livePreview の「↑↓ で表に入る」より後、CodeMirror の基本のキーより前に置く
      verticalMove(),
      findWidget(),
      keymap.of([...searchKeymap, indentWithTab, ...defaultKeymap]),
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.updateListener.of(sendLocalChanges),
      EditorView.updateListener.of((update) => { if (update.selectionSet) saveViewState(); }),
    ],
  });
  view = new EditorView({ state, parent: document.getElementById('editor') });
  restoreViewState();
  view.scrollDOM.addEventListener('scroll', saveViewState, { passive: true });
  // E2E テスト（test/e2e）が DevTools プロトコル経由で文書の内容を読むための参照
  window.__hushmarkView = view;
  view.focus();
}

/**
 * 画像のリンク先を、拡張機能本体に img に渡せる URL にしてもらう（imagePreview.js）。ファイルが変わることがあるので
 * 結果は覚えず、問い合わせ中の同じリンク先だけをまとめる
 */
const imageRequests = new Map();
const pendingImages = new Map();
let nextImageId = 1;
function resolveImage(href) {
  if (!pendingImages.has(href)) {
    const id = nextImageId++;
    pendingImages.set(href, new Promise((resolve) => imageRequests.set(id, (src) => {
      pendingImages.delete(href);
      resolve(src);
    })));
    vscode.postMessage({ type: 'resolveImage', id, href });
  }
  return pendingImages.get(href);
}

/**
 * カーソルと、画面の上端の行の位置。VSCode は Webview の状態（setState）を、ウィンドウを再読み込みしたときや
 * VSCode を起動し直したときにも残すので、開き直したときに元の位置に戻せる
 */
let saveTimer = null;
function saveViewState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { anchor, head } = view.state.selection.main;
    const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
    vscode.setState({ anchor, head, top });
  }, 200);
}

function restoreViewState() {
  const saved = vscode.getState();
  if (!saved) return;
  const length = view.state.doc.length;
  const clamp = (pos) => Math.min(Math.max(Number(pos) || 0, 0), length);
  view.dispatch({
    selection: EditorSelection.single(clamp(saved.anchor), clamp(saved.head)),
    effects: EditorView.scrollIntoView(view.state.doc.lineAt(clamp(saved.top)).from, { y: 'start' }),
  });
}

function sendLocalChanges(update) {
  if (!update.docChanged) return;
  for (const tr of update.transactions) {
    if (!tr.docChanged || tr.annotation(remote)) continue;
    sentSeq++;
    vscode.postMessage({
      type: 'edit',
      seq: sentSeq,
      syncId,
      changes: toLineChanges(tr.changes, tr.startState.doc),
      text: tr.state.doc.toString(),
    });
  }
}

/**
 * 拡張機能本体の文書の内容に合わせる。
 * まだ適用されていない編集が残っているうちは、その編集を含まない古い内容なので無視する。
 * 拡張機能本体は編集をすべて適用し終えた後に、改めて内容を確かめて送り直す。
 */
function applyRemote(text, ackSeq, id) {
  if (ackSeq !== sentSeq) {
    vscode.postMessage({ type: 'log', text: `sync ignored: ackSeq=${ackSeq} sentSeq=${sentSeq}` });
    return;
  }
  syncId = id;
  const change = diffText(view.state.doc.toString(), text);
  if (!change) return;
  view.dispatch({
    changes: change,
    annotations: [remote.of(true), Transaction.addToHistory.of(false)],
  });
}

/** VSCode のフォルダー内の検索（置換）を開く。選択中の文字列（1 行以内）があれば検索語にする */
function searchInFiles(replace) {
  return (target) => {
    vscode.postMessage({ type: 'findInFiles', query: selectedLine(target), replace });
    return true;
  };
}

/** 選択中の文字列。2 行以上にわたるときは空にする */
function selectedLine(target) {
  const sel = target.state.selection.main;
  const text = target.state.sliceDoc(sel.from, sel.to);
  return text.includes('\n') ? '' : text;
}

/** 選択範囲を記号で囲む。すでに囲まれていれば外す。 */
function toggleWrap(marker) {
  const len = marker.length;
  return (target) => {
    const { state } = target;
    target.dispatch(state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - len, range.from);
      const after = state.sliceDoc(range.to, range.to + len);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len },
          ],
          range: EditorSelection.range(range.from - len, range.to - len),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + len, range.to + len),
      };
    }));
    return true;
  };
}

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      if (!view) {
        setStrings(message.strings);
        syncId = message.syncId;
        applyMetrics(message.options);
        createEditor(message.text, message.options);
      } else {
        applyRemote(message.text, sentSeq, message.syncId);
      }
      break;
    case 'options':
      applyMetrics(message.options);
      if (view) {
        view.dispatch({ effects: [
          reconfigureLineNumbers(message.options.lineNumbers),
          reconfigureWrapIndent(message.options.wrappingIndent),
          reconfigureLineHighlight(message.options),
          ...wordWrapEffect(message.options.wordWrap),
          tabSize.reconfigure(tabSizeOf(message.options)),
        ] });
        view.requestMeasure();
      }
      break;
    case 'readOnly':
      readOnly = !!message.readOnly;
      if (view) view.dispatch({ effects: readOnlyState.reconfigure(EditorState.readOnly.of(readOnly)) });
      break;
    case 'sync':
      applyRemote(message.text, message.ackSeq, message.syncId);
      break;
    case 'image':
      imageRequests.get(message.id)?.(message.src);
      imageRequests.delete(message.id);
      break;
    case 'revealAnchor':
      if (view) revealAnchor(view, message.fragment);
      break;
  }
});

// VSCode の 2 つ打ちのキー（Ctrl+K Z、macOS では Cmd+K Z など）の 2 つ目のキーを、文字として入力しない。
// Webview のキーは VSCode にも転送され、VSCode は Ctrl+K の後の 2 つ目のキーで操作を実行するが、
// Webview の中ではそのキーが普通に入力されてしまう。Webview からは VSCode のキーの割り当てを調べられないので、
// 既定の割り当てで 2 つ打ちの 1 つ目に使われている Ctrl+K（macOS では Cmd+K）の次のキーだけ、既定の動作を止める。
// macOS の Ctrl+K は行末までの削除なので、2 つ打ちとして扱わない。
// 既定の動作を止めたキーは、CodeMirror も扱わない（VSCode への転送は止まらない）
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);
/** VSCode も、2 つ目のキーを 5 秒待って来なければ待つのをやめる */
const CHORD_TIMEOUT = 5000;
let chordPending = false;
let chordTimer = null;
window.addEventListener('keydown', (event) => {
  if (event.isComposing || MODIFIER_KEYS.has(event.key)) return;
  clearTimeout(chordTimer);
  if (chordPending) {
    chordPending = false;
    event.preventDefault();
    return;
  }
  chordPending = hasMod(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
  if (chordPending) chordTimer = setTimeout(() => { chordPending = false; }, CHORD_TIMEOUT);
}, true);
// VSCode もクリックやフォーカスの移動で 2 つ目のキーを待つのをやめる
window.addEventListener('mousedown', () => { chordPending = false; }, true);
window.addEventListener('blur', () => { chordPending = false; });

// VSCode は、検索結果から開いたときやタブを切り替えたときに Webview にはフォーカスを渡すが、
// その中のエディタには渡さない。そのままではキーを打っても何も起きないので、エディタに渡す
window.addEventListener('focus', () => {
  if (view && (!document.activeElement || document.activeElement === document.body)) view.focus();
});

vscode.postMessage({ type: 'ready' });

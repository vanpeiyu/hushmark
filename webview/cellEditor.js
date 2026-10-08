// 表のセルを編集するエディタ。本文と同じく CodeMirror で、太字やリンクの記号はカーソルが触れたときだけ出す。
// セルの幅の中で折り返すので、長いセルを編集しても表の形が崩れない。
// 文書はセルの中身（1 行）だけを持ち、変更は表のウィジェット（tableWidget.js）が本文の文書に書き込む。

import { Annotation, EditorState, Facet, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { livePreview } from './livePreview.js';
import { pasteLink } from './pasteLink.js';
import { diffText } from './sync.js';
import { cellMarkdownSupport } from './markdownSetup.js';

/**
 * 本文のエディタと同じショートカット（太字、検索など）。main.js が本文のエディタの設定として入れ、
 * 表のウィジェットがセルのエディタに渡す。キーの処理はセルのエディタで呼ばれる
 */
export const cellKeymap = Facet.define({ combine: (values) => values.flat() });

/** 本文の文書からセルに合わせた変更（取り消しなど）。この変更は本文に書き戻さない */
const fromDocument = Annotation.define();

/** セルは 1 行なので、貼り付けなどで入った改行は空白にする */
const singleLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
  const changes = [];
  const text = tr.newDoc.toString();
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) changes.push({ from: i, to: i + 1, insert: ' ' });
  return [tr, { changes, sequential: true }];
});

/**
 * @param {object} options
 * @param {HTMLElement} options.parent セルの要素
 * @param {string} options.text セルの中身（Markdown のソース）
 * @param {(href: string) => void} options.openLink
 * @param {import('@codemirror/view').KeyBinding[]} options.keys セルの移動などのキー
 * @param {() => void} options.onChange 利用者が中身を変えたとき
 * @param {() => void} options.onBlur フォーカスが外れたとき
 * @param {boolean} options.readOnly 書き込めない文書か
 */
export function createCellEditor({ parent, text, openLink, keys, onChange, onBlur, readOnly = false }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        Prec.highest(keymap.of(keys)),
        // カーソルの移動や選択など、CodeMirror の基本のキー（Enter や Tab は keys の側が先に扱う）
        keymap.of(defaultKeymap),
        singleLine,
        // 書き込めない文書では、セルの中身も変えさせない（本文の文書からの変更は受け付ける）
        EditorState.readOnly.of(readOnly),
        EditorState.transactionFilter.of((tr) => (readOnly && tr.docChanged && !tr.annotation(fromDocument) ? [] : tr)),
        EditorView.lineWrapping,
        cellMarkdownSupport(),
        livePreview({ openLink }),
        pasteLink,
        // CodeMirror は更新のたびにエディタの要素の class を書き直すので、後から classList で足さない
        EditorView.editorAttributes.of({ class: 'cm-md-cell-input' }),
        EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromDocument))) onChange();
        }),
      ],
    }),
  });
  // E2E テスト（test/e2e）がセルの中身を読むための参照
  view.dom.mdCellView = view;
  view.contentDOM.addEventListener('blur', onBlur);
  return view;
}

/**
 * 本文の文書の変更（取り消しなど）をセルに合わせる。変わったところだけを置き換え、カーソルはその直後に置く
 * （本文での取り消しと同じ）。セル全体を置き換えると、カーソルがセルの先頭に戻るため
 */
export function setCellText(view, text) {
  const change = diffText(view.state.doc.toString(), text);
  if (!change) return;
  view.dispatch({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
    annotations: fromDocument.of(true),
  });
}

/** | をエスケープしたときなど、利用者の変更を直す。本文には直した後の中身をまとめて書く */
export function replaceCellText(view, text, caret) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: caret },
    annotations: fromDocument.of(true),
  });
}

/** カーソルを置く。'end' | 'all' | 数値（位置）| { x, y }（クリックした位置） */
export function placeCaret(view, caret) {
  const length = view.state.doc.length;
  let selection;
  if (caret === 'all') selection = { anchor: 0, head: length };
  else if (typeof caret === 'number') selection = { anchor: Math.min(caret, length) };
  else if (caret && typeof caret === 'object') selection = { anchor: view.posAtCoords(caret) ?? length };
  else selection = { anchor: length };
  view.dispatch({ selection });
}

/** カーソルが ↑ / ↓ の方向の端の行にあるか（折り返した行の途中なら、まずセルの中を動く） */
export function atVerticalEdge(view, forward) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const next = view.moveVertically(sel, forward);
  if (next.head === sel.head) return true;
  const a = view.coordsAtPos(sel.head);
  const b = view.coordsAtPos(next.head);
  return !a || !b || Math.abs(a.top - b.top) < 2;
}

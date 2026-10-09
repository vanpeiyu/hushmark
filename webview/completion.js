// 補完。他の拡張機能（VSCode の Markdown のパスと見出しの補完、Foam の wikilink など）の補完の候補を、
// 拡張機能本体に問い合わせて（vscode.executeCompletionItemProvider）、CodeMirror の補完の一覧に出す。
//
// 入力のたびに問い合わせると無駄が多いので、自動で出すのは、補完がよく始まる文字（TRIGGERS）を打った直後と、
// その続きの語を打っている間だけにする。Ctrl+Space（hushmark.triggerSuggest）では、いつでも出す。

import { autocompletion, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';

const TRIGGERS = new Set(['(', '[', '#', '/', '.', '<', '@']);
/** 補完が始まる文字と、その後ろに続けて打っている語 */
const TRIGGERED = /([([#/.<@])([^\s()[\]<>]*)$/;

/**
 * 補完が始まる文字の後ろを打っている間は、打つたびに（少し待って）補完を開き直し、候補を取り直す。
 * CodeMirror の自動の開始（activateOnTyping）は、候補がなかった後に続けて打っても取り直さないことがあるため
 * （「@」の時点では候補がなく、「@fix」で候補が出る補完など）。
 * このとき開くのは自動で出す扱いにする（startCompletion は明示的に呼んだ扱いになるので、印を付けておく）
 */
let reopening = false;
let reopenTimer = null;
const reopenWhileTyping = EditorView.updateListener.of((update) => {
  if (!update.transactions.some((tr) => tr.isUserEvent('input.type'))) return;
  const { state } = update;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (!TRIGGERED.test(line.text.slice(0, pos - line.from))) return;
  clearTimeout(reopenTimer);
  reopenTimer = setTimeout(() => {
    reopening = true;
    startCompletion(update.view);
  }, 100);
});

let request = null;

/**
 * @param {(line: number, col: number, trigger: string, explicit: boolean) => Promise<object[] | null>} ask 拡張機能本体に候補を問い合わせる
 */
export function completion(ask) {
  request = ask;
  return [autocompletion({
    override: [source],
    activateOnTyping: false,
    defaultKeymap: true,
    icons: false,
  }), reopenWhileTyping];
}

async function source(context) {
  const { state, pos } = context;
  const explicit = context.explicit && !reopening;
  reopening = false;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  // 補完が始まる文字の後ろの、続けて打っている語（空白や閉じ括弧までの範囲）
  const match = TRIGGERED.exec(before);
  if (!explicit && !match) return null;
  const trigger = match && match[2] === '' && TRIGGERS.has(match[1]) ? match[1] : '';
  const items = await request(line.number - 1, pos - line.from, trigger, explicit);
  // 答えを待つ間に打ち進めていたら、この答えは古いので捨てて取り直す（CodeMirror は、取得中に打った分を取り直さないため）
  const { view } = context;
  if (view && view.state.selection.main.head !== pos && !context.aborted) {
    setTimeout(() => {
      reopening = !explicit;
      startCompletion(view);
    }, 0);
    return null;
  }
  if (!items || items.length === 0 || context.aborted) return null;
  const toPos = ({ line: l, col }) => {
    const target = state.doc.line(Math.min(l + 1, state.doc.lines));
    return target.from + Math.min(col, target.length);
  };
  const options = items.map((item) => {
    const from = item.range ? toPos(item.range.start) : pos;
    const to = item.range ? toPos(item.range.end) : pos;
    return {
      label: item.label,
      detail: item.detail || undefined,
      info: item.documentation || undefined,
      type: item.kind,
      boost: item.preselect ? 1 : 0,
      apply: (view) => {
        // 候補ごとに置き換える範囲が違うことがあるので、その範囲を今の位置まで広げて置き換える
        const head = view.state.selection.main.head;
        view.dispatch({
          changes: { from, to: Math.max(to, head), insert: item.insertText },
          selection: { anchor: from + item.insertText.length },
          userEvent: 'input.complete',
        });
      },
    };
  });
  const from = Math.min(...options.map((_, i) => (items[i].range ? toPos(items[i].range.start) : pos)));
  // validFor は付けない。続けて打つたびに問い合わせ直す（打った文字で候補が変わる補完があるため。VSCode の isIncomplete に当たる）
  return { from, options };
}

export const completionActions = {
  triggerSuggest: startCompletion,
};

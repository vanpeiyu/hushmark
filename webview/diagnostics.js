// 診断（他の拡張機能が出すエラーや警告。cSpell、markdownlint、Markdown のリンクの検証など）の表示。
//
// 診断は拡張機能本体が VSCode から受け取り、行と列で送ってくる（{ type: 'diagnostics' }）。届いた範囲に波線を引き、
// マウスを載せるとメッセージを出す。F8 / Shift+F8（hushmark.nextProblem / prevProblem）で次 / 前の診断に移り、
// そのメッセージを出す。次の診断が届くまでは、入力に合わせて範囲を写す。

import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, hoverTooltip, showTooltip } from '@codemirror/view';

/** 診断を入れ替える。値は { from, to, severity, message, source }[] */
const setDiagnostics = StateEffect.define();
/** F8 で選んだ診断のメッセージを出す / 消す */
const showDiagnostic = StateEffect.define();

const SEVERITIES = ['error', 'warning', 'info', 'hint'];
const marks = Object.fromEntries(SEVERITIES.map((s) => [s, Decoration.mark({ class: `cm-md-diag cm-md-diag-${s}` })]));

const diagnosticsField = StateField.define({
  create: () => ({ list: [], decorations: Decoration.none }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiagnostics)) return build(effect.value);
    }
    if (!tr.docChanged || value.list.length === 0) return value;
    const list = value.list.map((d) => ({ ...d, from: tr.changes.mapPos(d.from, 1), to: tr.changes.mapPos(d.to, -1) }))
      .filter((d) => d.to >= d.from);
    return { list, decorations: value.decorations.map(tr.changes) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function build(list) {
  const sorted = [...list].sort((a, b) => a.from - b.from || a.to - b.to);
  // ヒントは VSCode と同じく波線を引かない（メッセージは出す）
  const decorations = Decoration.set(sorted.filter((d) => d.to > d.from && d.severity !== 'hint')
    .map((d) => marks[d.severity].range(d.from, d.to)), true);
  return { list: sorted, decorations };
}

/** pos を含む診断 */
const diagnosticsAt = (state, pos) => state.field(diagnosticsField).list.filter((d) => d.from <= pos && pos <= Math.max(d.to, d.from + 1));

function tooltipDOM(list) {
  const dom = document.createElement('div');
  dom.className = 'cm-md-diag-tooltip';
  for (const d of list) {
    const row = dom.appendChild(document.createElement('div'));
    row.className = `cm-md-diag-message cm-md-diag-message-${d.severity}`;
    row.textContent = d.message;
    if (d.source || d.code) {
      const source = row.appendChild(document.createElement('span'));
      source.className = 'cm-md-diag-source';
      source.textContent = ` ${d.source || ''}${d.code ? `(${d.code})` : ''}`;
    }
  }
  return { dom };
}

/** 診断のメッセージのホバー。VSCode の editor.hover.delay の時間だけマウスを止めると出す（editorSettings.js が入れる） */
export const diagnosticHover = (delay) => hoverTooltip((view, pos) => {
  const list = diagnosticsAt(view.state, pos);
  if (list.length === 0) return null;
  return {
    pos: Math.min(...list.map((d) => d.from)),
    end: Math.max(...list.map((d) => d.to)),
    above: false,
    create: () => tooltipDOM(list),
  };
}, { hoverTime: delay });

/** F8 で選んだ診断のメッセージ。カーソルが動くか文書が変わると消す */
const shownDiagnostic = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(showDiagnostic)) return effect.value;
    if (value && (tr.docChanged || (tr.selection && !tr.effects.some((e) => e.is(showDiagnostic))))) return null;
    return value;
  },
  provide: (field) => showTooltip.from(field, (d) => (d ? { pos: d.from, above: false, create: () => tooltipDOM([d]) } : null)),
});

/** 次 / 前の診断に移り、メッセージを出す。最後まで行ったら先頭に戻る */
function gotoDiagnostic(direction) {
  return (view) => {
    const { list } = view.state.field(diagnosticsField);
    if (list.length === 0) return false;
    const head = view.state.selection.main.head;
    const target = direction > 0
      ? list.find((d) => d.from > head) || list[0]
      : [...list].reverse().find((d) => d.from < head) || list[list.length - 1];
    view.dispatch({
      selection: EditorSelection.cursor(target.from),
      effects: [showDiagnostic.of(target), EditorView.scrollIntoView(target.from, { y: 'center' })],
      userEvent: 'select',
    });
    return true;
  };
}

export const diagnosticActions = {
  nextProblem: gotoDiagnostic(1),
  prevProblem: gotoDiagnostic(-1),
};

export function diagnostics() {
  return [diagnosticsField, shownDiagnostic];
}

/**
 * 拡張機能本体から届いた診断（行と列は 0 始まり、UTF-16 の単位）を文書の位置にして入れ替える。
 * 文書の行が足りないとき（届く前に行を消したなど）は、末尾に寄せる
 */
export function applyDiagnostics(view, items) {
  const { doc } = view.state;
  const pos = ({ line, col }) => {
    const l = doc.line(Math.min(Math.max(line + 1, 1), doc.lines));
    return l.from + Math.min(Math.max(col, 0), l.length);
  };
  const list = items.map((d) => {
    const from = pos(d.start);
    let to = pos(d.end);
    // 幅のない診断は、その位置の 1 文字に引く
    if (to <= from) to = Math.min(from + 1, doc.lineAt(from).to);
    return { from, to, severity: SEVERITIES.includes(d.severity) ? d.severity : 'info', message: d.message, source: d.source, code: d.code };
  });
  view.dispatch({ effects: setDiagnostics.of(list) });
}

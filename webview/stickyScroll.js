// Sticky Scroll（VSCode の editor.stickyScroll）。表示している位置を含む見出しの階層を、エディタの上端に固定して出す。
// 見出しをクリックすると、その見出しに移る。VSCode の Markdown と同じく、見出し（アウトライン）を使う。
// editor.stickyScroll.enabled と editor.stickyScroll.maxLineCount に合わせる。

import { EditorSelection } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { visibleText } from './tableCells.js';

let config = { enabled: true, max: 5 };
export function setStickyScrollOptions(options) {
  config = {
    enabled: options.stickyScrollEnabled !== false,
    max: Math.max(1, Math.min(10, Number(options.stickyScrollMaxLineCount) || 5)),
  };
}

/** 文書の見出し（位置の順） */
function headingsOf(state) {
  const list = [];
  syntaxTree(state).iterate({
    enter(ref) {
      const match = /^(?:ATX|Setext)Heading(\d)$/.exec(ref.name);
      if (match) {
        const line = state.doc.lineAt(ref.from);
        const text = ref.name.startsWith('ATX')
          ? line.text.replace(/^\s*#{1,6}\s*/, '').replace(/\s+#+\s*$/, '')
          : line.text.trim();
        if (text) list.push({ pos: line.from, level: Number(match[1]), text: visibleText(text), line: line.number });
        return false;
      }
      return ref.name === 'Document' || ref.name === 'Blockquote' || ref.name.endsWith('List') || ref.name === 'ListItem';
    },
  });
  return list;
}

/** pos より前の見出しのうち、pos を含む階層（外側から順）。max を超えたら内側を残す */
export function enclosingHeadings(headings, pos, max) {
  const stack = [];
  for (const h of headings) {
    if (h.pos >= pos) break;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.slice(-max);
}

export const stickyScroll = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-md-sticky';
    this.dom.hidden = true;
    view.dom.appendChild(this.dom);
    this.headings = headingsOf(view.state);
    this.tree = syntaxTree(view.state);
    this.onScroll = () => this.schedule();
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.schedule();
  }

  update(update) {
    if (syntaxTree(update.state) !== this.tree) {
      this.tree = syntaxTree(update.state);
      this.headings = headingsOf(update.state);
    }
    if (update.docChanged || update.geometryChanged || update.viewportChanged || update.transactions.some((tr) => tr.reconfigured)) this.schedule();
  }

  schedule() {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        if (!config.enabled || this.headings.length === 0) return null;
        const lineHeight = view.defaultLineHeight;
        const scrollTop = view.scrollDOM.scrollTop - view.documentPadding.top;
        // 固定した行の下に隠れる行も含めて、上端に見えている行を決める（固定する行の数で 2 回求める）
        let shown = [];
        for (let i = 0; i < 2; i++) {
          const block = view.lineBlockAtHeight(Math.max(0, scrollTop + shown.length * lineHeight));
          shown = scrollTop > 0 ? enclosingHeadings(this.headings, block.from + 1, config.max) : [];
        }
        const scroller = view.scrollDOM.getBoundingClientRect();
        const editor = view.dom.getBoundingClientRect();
        const content = view.contentDOM.getBoundingClientRect();
        const gutters = view.dom.querySelector('.cm-gutters');
        const line = view.contentDOM.querySelector('.cm-line');
        // 見出しの文字は、本文の行の文字と同じ位置から始める（「#」は本文の見出しと同じく左にぶら下げる）
        const textLeft = line
          ? line.getBoundingClientRect().left + parseFloat(getComputedStyle(line).paddingLeft) - scroller.left
          : content.left - scroller.left;
        return {
          shown, top: scroller.top - editor.top, left: scroller.left - editor.left, width: view.scrollDOM.clientWidth, lineHeight,
          gutterWidth: gutters ? gutters.getBoundingClientRect().width : 0, textLeft,
          numbers: !!view.dom.querySelector('.cm-lineNumbers'),
        };
      },
      write: (measure) => this.render(measure),
    });
  }

  render(measure) {
    const dom = this.dom;
    if (!measure || measure.shown.length === 0) {
      dom.hidden = true;
      dom.replaceChildren();
      return;
    }
    const key = `${measure.textLeft}:${measure.gutterWidth}:${measure.shown.map((h) => `${h.pos}:${h.text}`).join('|')}`;
    dom.hidden = false;
    dom.style.top = `${measure.top}px`;
    dom.style.left = `${measure.left}px`;
    dom.style.width = `${measure.width}px`;
    if (dom.dataset.key === key) return;
    dom.dataset.key = key;
    dom.replaceChildren(...measure.shown.map((h) => {
      const row = document.createElement('div');
      row.className = `cm-md-sticky-line cm-md-sticky-h${h.level}`;
      row.style.height = `${measure.lineHeight}px`;
      row.style.paddingLeft = `${measure.textLeft}px`;
      // 行番号の欄には、本文と同じく見出しの行番号を出す
      if (measure.numbers && measure.gutterWidth > 0) {
        const number = row.appendChild(document.createElement('span'));
        number.className = 'cm-md-sticky-number';
        number.style.width = `${measure.gutterWidth}px`;
        number.textContent = String(h.line);
      }
      const mark = row.appendChild(document.createElement('span'));
      mark.className = 'cm-md-sticky-mark';
      mark.textContent = `${'#'.repeat(h.level)} `;
      mark.style.marginLeft = `-${h.level + 1}ch`;
      row.appendChild(document.createTextNode(h.text));
      row.title = h.text;
      row.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.view.dispatch({
          selection: EditorSelection.cursor(h.pos),
          effects: EditorView.scrollIntoView(h.pos, { y: 'start' }),
        });
        this.view.focus();
      });
      return row;
    }));
  }

  destroy() {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.dom.remove();
  }
});

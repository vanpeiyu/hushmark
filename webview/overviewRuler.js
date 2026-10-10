// スクロールバーの目印（VSCode のエディタの overview ruler）。検索の一致、診断（エラーと警告）、カーソルの位置を、
// 文書の中の位置に比例した高さで、スクロールバーの上に描く。マウスの操作は下のスクロールバーに通す。
// VSCode の editor.hideCursorInOverviewRuler と editor.overviewRulerBorder に合わせる。

import { ViewPlugin } from '@codemirror/view';
import { getSearchQuery, searchPanelOpen } from '@codemirror/search';
import { diagnosticsOf } from './diagnostics.js';

/** 検索の一致を描く上限（多すぎると描くのが遅くなる） */
const MATCH_LIMIT = 2000;

let config = { hideCursor: false, border: true };
export function setOverviewRulerOptions(options) {
  config = { hideCursor: options.hideCursorInOverviewRuler === true, border: options.overviewRulerBorder !== false };
}

export const overviewRuler = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cm-md-overview';
    this.canvas.setAttribute('aria-hidden', 'true');
    view.dom.appendChild(this.canvas);
    this.schedule();
  }

  update(update) {
    if (update.docChanged || update.selectionSet || update.geometryChanged || update.viewportChanged ||
        update.transactions.some((tr) => tr.effects.length > 0)) this.schedule();
  }

  schedule() {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const scroller = view.scrollDOM.getBoundingClientRect();
        const editor = view.dom.getBoundingClientRect();
        const width = view.scrollDOM.offsetWidth - view.scrollDOM.clientWidth;
        return { top: scroller.top - editor.top, height: view.scrollDOM.clientHeight, width, contentHeight: view.contentHeight };
      },
      write: (measure, view) => this.draw(measure, view),
    });
  }

  draw({ top, height, width, contentHeight }, view) {
    const canvas = this.canvas;
    if (width <= 0 || height <= 0) {
      canvas.style.display = 'none';
      return;
    }
    canvas.style.display = '';
    const ratio = window.devicePixelRatio || 1;
    canvas.style.top = `${top}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const css = getComputedStyle(view.dom);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const { state } = view;
    const y = (pos) => (view.lineBlockAt(pos).top / Math.max(contentHeight, 1)) * height;
    const mark = (pos, fill, x, w, h = 3) => {
      ctx.fillStyle = fill;
      ctx.fillRect(x, Math.min(Math.max(y(pos) - h / 2, 0), height - h), w, h);
    };
    if (config.border) {
      ctx.fillStyle = color('--vscode-editorOverviewRuler-border', 'rgba(127, 127, 127, 0.3)');
      ctx.fillRect(0, 0, 1, height);
    }
    // 検索の一致（中ほどの列）
    if (searchPanelOpen(state)) {
      const query = getSearchQuery(state);
      if (query.valid && query.search) {
        const fill = color('--vscode-editorOverviewRuler-findMatchForeground', 'rgba(209, 134, 22, 0.49)');
        const cursor = query.getCursor(state);
        let count = 0;
        for (let r = cursor.next(); !r.done && count < MATCH_LIMIT; r = cursor.next(), count++) mark(r.value.from, fill, width / 3, width / 3);
      }
    }
    // 診断（右の列）。警告の上にエラーを描く
    const list = diagnosticsOf(state);
    for (const severity of ['warning', 'error']) {
      const fill = severity === 'error'
        ? color('--vscode-editorOverviewRuler-errorForeground', 'rgba(255, 18, 18, 0.7)')
        : color('--vscode-editorOverviewRuler-warningForeground', 'rgba(191, 136, 3, 1)');
      for (const d of list) if (d.severity === severity) mark(d.from, fill, (width * 2) / 3, width / 3);
    }
    // カーソル（全幅の細い線）
    if (!config.hideCursor) {
      const fill = color('--vscode-editorCursor-foreground', 'rgba(160, 160, 160, 0.8)');
      for (const range of state.selection.ranges) mark(range.head, fill, 0, width, 2);
    }
  }

  destroy() {
    this.canvas.remove();
  }
});

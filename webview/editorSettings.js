// VSCode のエディタの設定のうち、表示や操作の細かい振る舞いを決めるもの。
// - editor.selectionHighlight：選択した文字列と同じ文字列に色を付ける
// - editor.emptySelectionClipboard：何も選ばずにコピー / 切り取りしたとき、行全体を対象にする（CodeMirror の既定と同じ。false のときは何もしない）
// - editor.insertSpaces・editor.detectIndentation：字下げを空白にするかタブにするか
// - editor.cursorSurroundingLines：カーソルの上下に残す行数
// - editor.renderWhitespace・editor.renderControlCharacters・editor.unicodeHighlight.invisibleCharacters：空白と見えない文字の表示
// - editor.mouseWheelZoom：Ctrl+ホイールで文字の大きさを変える（設定は変えず、このエディタの中だけ）
// - editor.links：Ctrl+クリックでリンクを開くか
// - editor.hover.enabled・editor.hover.delay：ホバーを出すか、出すまでの時間（hoverConfig.js）
// スクロール（scrollBeyondLastLine・smoothScrolling・padding・scrollbar）は CSS の変数で決める（metrics.js）

import { Compartment } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, highlightSpecialChars } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { highlightSelectionMatches } from '@codemirror/search';
import { hoverConfig } from './hoverConfig.js';
import { diagnosticHover } from './diagnostics.js';
import { zoomBy } from './metrics.js';

let settings = {};
const compartment = new Compartment();

// ---------------------------------------------------------------------------
// 空白の表示（editor.renderWhitespace）。空白は「·」、タブは「→」を、その文字の幅の上に描く（editor.css）

const spaceMark = Decoration.mark({ class: 'cm-md-ws-space' });
const tabMark = Decoration.mark({ class: 'cm-md-ws-tab' });

/** 行の中の、表示する空白の範囲（行の先頭からのオフセット） */
export function whitespaceRanges(text, mode, selected = () => false) {
  const ranges = [];
  const trailingFrom = text.length - (/[ \t]*$/.exec(text)[0].length);
  for (const match of text.matchAll(/[ \t]+/g)) {
    const from = match.index;
    const to = from + match[0].length;
    const single = match[0] === ' ' && from > 0 && to < text.length;
    let show = false;
    if (mode === 'all') show = true;
    else if (mode === 'boundary') show = !single;
    else if (mode === 'trailing') show = from >= trailingFrom;
    else if (mode === 'selection') show = true;
    if (!show) continue;
    for (let i = from; i < to; i++) {
      if (mode === 'selection' && !selected(i)) continue;
      ranges.push({ from: i, to: i + 1, tab: text[i] === '\t' });
    }
  }
  return ranges;
}

const whitespacePlugin = (mode) => ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged || (mode === 'selection' && update.selectionSet)) this.decorations = this.build(update.view);
  }
  build(view) {
    const { state } = view;
    const marks = [];
    const selection = state.selection.ranges.filter((r) => !r.empty);
    if (mode === 'selection' && selection.length === 0) return Decoration.none;
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = state.doc.lineAt(pos);
        const selected = (i) => selection.some((r) => line.from + i >= r.from && line.from + i < r.to);
        for (const r of whitespaceRanges(line.text, mode, selected)) {
          marks.push((r.tab ? tabMark : spaceMark).range(line.from + r.from, line.from + r.to));
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(marks, true);
  }
}, { decorations: (v) => v.decorations });

// ---------------------------------------------------------------------------
// 見えない文字の表示（editor.renderControlCharacters・editor.unicodeHighlight.invisibleCharacters）

/** 制御文字（改行とタブを除く） */
const CONTROL = '\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f';
/** 幅のない文字や方向の制御など、見えない文字 */
const INVISIBLE = '\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffc';

function specialChars() {
  const parts = [];
  if (settings.renderControlCharacters !== false) parts.push(CONTROL);
  // Markdown では VSCode の既定は false（"[markdown]" の既定値）
  if (settings.invisibleCharacters === true) parts.push(INVISIBLE);
  if (parts.length === 0) return [];
  return highlightSpecialChars({ specialChars: new RegExp(`[${parts.join('')}]`, 'g'), addSpecialChars: null });
}

// ---------------------------------------------------------------------------
// 字下げ（editor.insertSpaces・editor.detectIndentation）

/**
 * 文書の字下げが空白かタブか、空白なら何桁かを、VSCode の editor.detectIndentation と同じく文書から推し量る。
 * 判断できなければ null
 */
export function detectIndentation(text) {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map();
  let previous = 0;
  for (const line of text.split('\n').slice(0, 10000)) {
    if (line.trim() === '') continue;
    const indent = /^[ \t]*/.exec(line)[0];
    if (indent.startsWith('\t')) tabs++;
    else if (indent.length > 0) spaces++;
    const width = indent.includes('\t') ? null : indent.length;
    if (width !== null) {
      const step = Math.abs(width - previous);
      if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) || 0) + 1);
      previous = width;
    }
  }
  if (tabs === 0 && spaces === 0) return null;
  if (tabs > spaces) return { insertSpaces: false };
  const best = [...steps.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { insertSpaces: true, tabSize: best ? best[0] : null };
}

let detected = null;

function indentation() {
  const tabSize = settings.tabSize > 0 ? settings.tabSize : 4;
  const use = settings.detectIndentation !== false && detected ? detected : null;
  const insertSpaces = use ? use.insertSpaces : settings.insertSpaces !== false;
  const size = use && use.tabSize ? use.tabSize : tabSize;
  return indentUnit.of(insertSpaces ? ' '.repeat(size) : '\t');
}

// ---------------------------------------------------------------------------

/** 何も選ばずにコピー / 切り取りしたときに、行全体を対象にしない（editor.emptySelectionClipboard が false のとき） */
const noEmptySelectionCopy = EditorView.domEventHandlers({
  copy: (event, view) => view.state.selection.ranges.every((r) => r.empty) && (event.preventDefault(), true),
  cut: (event, view) => view.state.selection.ranges.every((r) => r.empty) && (event.preventDefault(), true),
});

/** Ctrl+ホイールでの文字の大きさの変更（editor.mouseWheelZoom）。このエディタの中だけで、設定は変えない */
const wheelZoom = EditorView.domEventHandlers({
  wheel(event, view) {
    if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return false;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1 : -1);
    view.requestMeasure();
    return true;
  },
});

function extensions() {
  return [
    settings.selectionHighlight === false ? [] : highlightSelectionMatches({ minSelectionLength: 1, maxMatches: 1000 }),
    settings.renderWhitespace && settings.renderWhitespace !== 'none' ? whitespacePlugin(settings.renderWhitespace) : [],
    specialChars(),
    indentation(),
    settings.emptySelectionClipboard === false ? noEmptySelectionCopy : [],
    settings.mouseWheelZoom ? wheelZoom : [],
    EditorView.scrollMargins.of((view) => {
      const margin = Math.max(0, Number(settings.cursorSurroundingLines) || 0) * view.defaultLineHeight;
      return { top: margin, bottom: margin };
    }),
    hoverConfig.enabled ? diagnosticHover(hoverConfig.delay) : [],
  ];
}

function apply(options) {
  settings = options;
  hoverConfig.enabled = options.hoverEnabled !== false && options.hoverEnabled !== 'off';
  hoverConfig.delay = Number(options.hoverDelay) >= 0 ? Number(options.hoverDelay) : 300;
}

/** @param {object} options 拡張機能本体から届いた設定 @param {string} text 文書（字下げを推し量る） */
export function editorSettings(options, text) {
  apply(options);
  detected = detectIndentation(text);
  return compartment.of(extensions());
}

/** 文書の字下げを推し量り直す（外で書き換えられたとき）。変わらなければ何もしない */
export function redetectIndentation(text) {
  const next = detectIndentation(text);
  if (JSON.stringify(next) === JSON.stringify(detected)) return [];
  detected = next;
  return compartment.reconfigure(extensions());
}

export function reconfigureEditorSettings(options) {
  apply(options);
  return compartment.reconfigure(extensions());
}

/** Ctrl+クリックでリンクを開くか（editor.links） */
export const linksEnabled = () => settings.links !== false;

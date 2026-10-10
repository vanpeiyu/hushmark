// 文字の大きさと行の高さ、ほかの見た目の設定。文字の大きさは VSCode の editor.fontSize に、行の高さは
// editor.lineHeight に合わせる（0 のときは日本語の文章に合う倍率にする）。
//
// 行の高さは整数の px にそろえる。見出しの行の高さを本文の行の整数倍にし（editor.css）、
// 表の行も本文の行に合わせるので、端数があると下の行ほどずれていくため。

import { applyTheme } from './theme.js';

/** editor.lineHeight が 0（自動）のときの倍率。VSCode の自動（約 1.35 倍）は日本語の文章には詰まりすぎる */
const DEFAULT_RATIO = 1.85;

/**
 * VSCode と同じ解釈で行の高さを px にする。
 * 0 は自動、8 未満は文字の大きさに対する倍率、8 以上は px。
 */
export function lineHeightPx(fontSize, lineHeight) {
  if (!(lineHeight > 0)) return Math.round(fontSize * DEFAULT_RATIO);
  if (lineHeight < 8) return Math.round(fontSize * lineHeight);
  return Math.round(lineHeight);
}

/** Ctrl+ホイールで変えた文字の大きさ（px。editor.mouseWheelZoom）と、最後に当てた設定 */
let zoom = 0;
let lastOptions = null;

/** 文字の大きさを 1px 大きく / 小さくする。行の高さも合わせて計算し直す */
export function zoomBy(step) {
  zoom = Math.max(-8, Math.min(24, zoom + step));
  if (lastOptions) applyMetrics(lastOptions);
}

export function applyMetrics(options) {
  lastOptions = options;
  const fontSize = Math.max(6, (options.fontSize > 0 ? options.fontSize : 14) + zoom);
  const root = document.documentElement.style;
  root.setProperty('--md-font-size', `${fontSize}px`);
  root.setProperty('--md-line', `${lineHeightPx(fontSize, options.lineHeight)}px`);
  applyEditorLook(options);
  if (options.style) applyStyle(options.style);
}

const CURSOR_STYLES = ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'];
const CURSOR_BLINKING = ['blink', 'smooth', 'phase', 'expand', 'solid'];

/**
 * VSCode のエディタの見た目の設定。カーソル（editor.cursorStyle・cursorBlinking・cursorWidth・
 * cursorSmoothCaretAnimation）は body の class と変数で、文字（editor.fontWeight・fontLigatures・letterSpacing）は
 * 変数で決める（editor.css）
 */
function applyEditorLook(options) {
  const body = document.body;
  for (const name of [...body.classList]) if (/^md-(cursor|blink|caret)-/.test(name)) body.classList.remove(name);
  body.classList.add(
    `md-cursor-${CURSOR_STYLES.includes(options.cursorStyle) ? options.cursorStyle : 'line'}`,
    `md-blink-${CURSOR_BLINKING.includes(options.cursorBlinking) ? options.cursorBlinking : 'blink'}`,
  );
  if (options.cursorSmoothCaretAnimation === 'on' || options.cursorSmoothCaretAnimation === 'explicit') {
    body.classList.add('md-caret-smooth');
  }
  const style = body.style;
  // editor.cursorWidth は 0 のとき既定（2px）。VSCode と同じく line のときだけ効く
  if (options.cursorWidth > 0) style.setProperty('--md-cursor-width', `${Math.round(options.cursorWidth)}px`);
  else style.removeProperty('--md-cursor-width');
  const weight = String(options.fontWeight || 'normal');
  style.setProperty('--md-font-weight', /^(normal|bold|\d{1,3})$/.test(weight) ? weight : 'normal');
  // editor.fontLigatures: false は合字を使わない、true は使う、文字列は font-feature-settings の値
  const ligatures = options.fontLigatures;
  style.setProperty('--md-font-features', ligatures === true ? '"liga" on, "calt" on'
    : typeof ligatures === 'string' && ligatures.trim() && /^[\w\s"',-]+$/.test(ligatures) ? ligatures : '"liga" off, "calt" off');
  style.setProperty('--md-letter-spacing', `${Number(options.letterSpacing) || 0}px`);
  // スクロール（editor.scrollBeyondLastLine・smoothScrolling・padding・scrollbar）
  style.setProperty('--md-content-bottom', options.scrollBeyondLastLine === false ? `${Math.max(0, Number(options.paddingBottom) || 0)}px` : '50vh');
  if (Number(options.paddingTop) > 0) style.setProperty('--md-content-top', `${Number(options.paddingTop)}px`);
  else style.removeProperty('--md-content-top');
  style.setProperty('--md-scroll-behavior', options.smoothScrolling ? 'smooth' : 'auto');
  style.setProperty('--md-scrollbar-width', `${Math.max(0, Number(options.verticalScrollbarSize) || 14)}px`);
  style.setProperty('--md-scrollbar-height', `${Math.max(0, Number(options.horizontalScrollbarSize) || 12)}px`);
}

/**
 * 見た目の設定（hushmark.*）。body の class と CSS の変数を通して、複数の箇所の見た目が決まる（editor.css）
 * - look: プレビューのスタイル（body.md-style-*）
 * - headingSize: 見出しの大きさ（body.md-heading-*）
 * - rightMargin: 右の余白を出すか（出さないときは body.md-no-right-margin）
 * - fontFamily: フォント（editor.fontFamily。"[markdown]" の中の指定も効く）
 * - color・colorScheme・customColor・colorCustomizations: 配色（theme.js）
 */
function applyStyle(style) {
  const body = document.body;
  // VSCode が body に付ける class（vscode-dark など）は残し、Hushmark の class だけを入れ替える
  for (const name of [...body.classList]) if (/^md-(style|heading)-/.test(name)) body.classList.remove(name);
  body.classList.add(`md-style-${style.look}`, `md-heading-${style.headingSize}`);
  body.classList.toggle('md-no-right-margin', !style.rightMargin);
  if (style.fontFamily) body.style.setProperty('--md-font', style.fontFamily);
  else body.style.removeProperty('--md-font');
  applyTheme(style);
}

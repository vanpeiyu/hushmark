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

export function applyMetrics(options) {
  const fontSize = options.fontSize > 0 ? options.fontSize : 14;
  const root = document.documentElement.style;
  root.setProperty('--md-font-size', `${fontSize}px`);
  root.setProperty('--md-line', `${lineHeightPx(fontSize, options.lineHeight)}px`);
  if (options.style) applyStyle(options.style);
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

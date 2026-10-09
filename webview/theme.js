// 配色（hushmark.previewColor・previewColorScheme・previewCustomColor・colorCustomizations）を、CSS の変数として body に入れる。
//
// hushmark.previewColorScheme が theme（既定）なら、背景と文字に VSCode のテーマの色を使い、ほかの色はその背景色に合わせて作る。
// 選択範囲、カーソル、行の背景、行番号、検索の一致は、テーマの色のまま（editor.css の既定値）。
// auto・light・dark なら、背景も含めて Hushmark の配色を使う。明るい地か暗い地かは、auto ならテーマに合わせる。
//
// VSCode は Webview の body に、テーマの種類を表す class（vscode-light・vscode-dark・vscode-high-contrast・
// vscode-high-contrast-light）を付け、html の style にテーマの色の変数（--vscode-*）を入れる。テーマを切り替えると
// どちらも書き換えるので、それを監視して作り直す。
// ハイコントラストのテーマでは、本人が選んだ見やすさを保つため、Hushmark の配色は使わず VSCode の色を使う
// （editor.css の :where(body) の既定値）。

import { buildPalette, modeOf } from './palette.js';

/** hushmark.colorCustomizations のキーと、上書きする配色の色 */
export const CUSTOMIZABLE_COLORS = {
  background: 'bg',
  foreground: 'fg',
  strongForeground: 'strongFg',
  mutedForeground: 'muted',
  border: 'border',
  strongBorder: 'borderStrong',
  blockBackground: 'blockBg',
  codeBackground: 'codeBg',
  accent: 'accent',
  softAccent: 'accentSoft',
  accentBackground: 'accentBg',
  link: 'link',
  highlight: 'highlight',
  selection: 'selection',
  lineHighlight: 'lineHighlight',
};

let current = null;
let observer = null;

/** 配色の名前（bg、strongFg など）から CSS の変数の名前（--md-bg、--md-strong-fg など） */
const variableName = (name) => `--md-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** @param {{ color: string, colorScheme: string, customColor: string, colorCustomizations: object }} options */
export function applyTheme(options) {
  current = options;
  if (!observer) {
    observer = new MutationObserver(() => current && render(current));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  }
  render(options);
}

/** 最後に作った配色の元。テーマの色の変数が変わっていなければ作り直さない（html の style はほかの値でも変わるため） */
let lastKey = '';

function render({ color, colorScheme, customColor, colorCustomizations }) {
  const body = document.body;
  const classes = body.classList;
  const highContrast = classes.contains('vscode-high-contrast') || classes.contains('vscode-high-contrast-light');
  const base = { bg: themeColor('--vscode-editor-background'), fg: themeColor('--vscode-editor-foreground') };
  const key = JSON.stringify([color, colorScheme, customColor, colorCustomizations, highContrast, base, classes.contains('vscode-dark')]);
  if (key === lastKey) return;
  lastKey = key;
  const themeMode = base.bg ? modeOf(base.bg) : (classes.contains('vscode-dark') ? 'dark' : 'light');
  const useTheme = colorScheme === 'theme' && base.bg && base.fg;
  const palette = highContrast ? {} : buildPalette({
    color,
    customColor,
    mode: colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : themeMode,
    base: useTheme ? base : undefined,
  });
  if (!highContrast) Object.assign(palette, customizations(colorCustomizations, color));

  const names = Object.keys(palette).map(variableName);
  // 前に入れた変数のうち、今回使わないもの（ハイコントラストに切り替えたときなど）を消す
  for (const name of [...body.style]) if (name.startsWith('--md-') && name !== '--md-font' && !names.includes(name)) body.style.removeProperty(name);
  for (const [name, value] of Object.entries(palette)) body.style.setProperty(variableName(name), value);
}

/** hushmark.colorCustomizations のうち、いまの色に当てるもの。"[green]" のようなキーの中は、その色のときだけ当てる */
function customizations(settings, color) {
  const out = {};
  const apply = (entries) => {
    for (const [key, value] of Object.entries(entries || {})) {
      if (CUSTOMIZABLE_COLORS[key] && typeof value === 'string' && CSS.supports('color', value)) {
        out[CUSTOMIZABLE_COLORS[key]] = value;
      }
    }
  };
  apply(settings);
  apply(settings && settings[`[${color}]`]);
  return out;
}

/** VSCode のテーマの色の変数を #rrggbb にする。透明度のある色や読めない値は null */
function themeColor(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) return null;
  const ctx = (themeColor.ctx ??= document.createElement('canvas').getContext('2d'));
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  const normalized = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : null;
}

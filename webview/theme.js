// 配色（hushmark.previewColor・previewColorScheme・previewCustomColor・colorCustomizations）を、CSS の変数として body に入れる。
//
// 明るい地か暗い地かは、hushmark.previewColorScheme が light・dark ならそれに従い、auto なら VSCode のテーマに合わせる。
// VSCode は Webview の body に、テーマの種類を表す class（vscode-light・vscode-dark・vscode-high-contrast・
// vscode-high-contrast-light）を付け、テーマを切り替えると付け替えるので、それを監視して作り直す。
// ハイコントラストのテーマでは、本人が選んだ見やすさを保つため、Hushmark の配色は使わず VSCode の色を使う
// （editor.css の :where(body) の既定値）。

import { buildPalette } from './palette.js';

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
  }
  render(options);
}

function render({ color, colorScheme, customColor, colorCustomizations }) {
  const body = document.body;
  const classes = body.classList;
  const highContrast = classes.contains('vscode-high-contrast') || classes.contains('vscode-high-contrast-light');
  const palette = highContrast ? {} : buildPalette({
    color,
    customColor,
    mode: colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : (classes.contains('vscode-dark') ? 'dark' : 'light'),
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

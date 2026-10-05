// 画面に出す文言。英語を元にし、VSCode の表示言語に合わせた翻訳を、拡張機能本体から受け取る（extension.js の
// WEBVIEW_STRINGS）。翻訳がない文言は英語のまま出す。

let translations = {};

export function setStrings(table) {
  translations = table || {};
}

/** 文言を翻訳し、{0}・{1} を args で置き換える */
export function t(text, ...args) {
  let out = translations[text] ?? text;
  args.forEach((arg, i) => { out = out.replaceAll(`{${i}}`, String(arg)); });
  return out;
}

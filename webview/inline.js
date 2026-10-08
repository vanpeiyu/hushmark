// 表のセルなど、エディタの外で描くインライン Markdown と、リンクを開く処理。

import { Facet } from '@codemirror/state';
import { cellParser } from './markdownSetup.js';
import { openLinkHint } from './platform.js';
import { decodeEntities } from '../src/links.js';

/** リンクを開く処理。main.js から VSCode 側に渡す関数を登録する。 */
export const openLinkHandler = Facet.define({
  combine: (values) => values[0] || (() => {}),
});

export function linkAttributes(href) {
  return { 'data-href': href, title: `${href}\n${openLinkHint()}` };
}

const SKIPPED_NODES = new Set([
  'HeaderMark', 'QuoteMark', 'ListMark', 'EmphasisMark', 'CodeMark',
  'LinkMark', 'StrikethroughMark', 'LinkTitle', 'LinkLabel',
]);
/** この中の URL はリンク先なので描かない。それ以外の URL は GFM の裸の URL なので、リンクとして描く */
const URL_OWNERS = new Set(['Link', 'Image', 'LinkReference', 'Autolink']);
const ELEMENT_FOR = {
  Emphasis: 'em',
  StrongEmphasis: 'strong',
  Strikethrough: 'del',
  InlineCode: 'code',
};

/** リンクの参照定義のラベルの比べ方。CommonMark と同じく、前後の空白、空白の連続、大文字と小文字の違いを無視する */
export function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * インライン Markdown を DOM にして parent に追加する（innerHTML は使わない）。
 * definitions は文書の中のリンクの参照定義（正規化したラベルからリンク先）。参照リンク（[foo]）に使う
 */
export function renderInline(text, parent, definitions = new Map()) {
  const tree = cellParser.parse(text);
  renderRange(tree.topNode, text, parent, 0, text.length, definitions);
}

function renderRange(node, text, parent, from, to, definitions) {
  let pos = from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    if (child.from > pos) parent.appendChild(document.createTextNode(text.slice(pos, child.from)));
    renderNode(child, text, parent, definitions);
    pos = child.to;
  }
  if (to > pos) parent.appendChild(document.createTextNode(text.slice(pos, to)));
}

function renderNode(node, text, parent, definitions) {
  const { name, from, to } = node;
  if (SKIPPED_NODES.has(name)) return;
  if (name === 'URL' && node.parent && URL_OWNERS.has(node.parent.name)) return;

  if (ELEMENT_FOR[name]) {
    renderRange(node, text, parent.appendChild(document.createElement(ELEMENT_FOR[name])), from, to, definitions);
  } else if (name === 'Link' && !node.getChild('URL') && referenceHref(node, text, definitions) === null) {
    // 定義のない参照リンク（[foo] など）は、CommonMark と同じく [ ] ごとただの文字にする
    const marks = node.getChildren('LinkMark');
    const textFrom = marks[0] ? marks[0].to : from;
    const textTo = marks[1] ? marks[1].from : to;
    parent.appendChild(document.createTextNode(text.slice(from, textFrom)));
    renderRange(node, text, parent, textFrom, textTo, definitions);
    parent.appendChild(document.createTextNode(text.slice(textTo, to)));
  } else if (name === 'Link') {
    const marks = node.getChildren('LinkMark');
    const url = node.getChild('URL');
    const a = parent.appendChild(document.createElement('span'));
    a.className = 'cm-md-link';
    setAttributes(a, linkAttributes(url ? text.slice(url.from, url.to) : referenceHref(node, text, definitions)));
    const textFrom = marks[0] ? marks[0].to : from;
    const textTo = marks[1] ? marks[1].from : to;
    renderRange(node, text, a, textFrom, textTo, definitions);
  } else if (name === 'Image' && node.getChild('URL')) {
    // 画像は描かずに代替テキストを出す。本文と同じく、マウスを載せると浮かせて表示し（imagePreview.js）、
    // Ctrl+クリックで開く
    const marks = node.getChildren('LinkMark');
    const url = node.getChild('URL');
    const span = parent.appendChild(document.createElement('span'));
    span.className = 'cm-md-image';
    const href = text.slice(url.from, url.to);
    setAttributes(span, { 'data-image-src': href, 'data-href': href });
    // 記号は「![」「]」「(」「)」の順
    const textFrom = marks[0] ? marks[0].to : from;
    const textTo = marks[1] ? marks[1].from : to;
    renderRange(node, text, span, textFrom, textTo, definitions);
  } else if (name === 'Escape') {
    parent.appendChild(document.createTextNode(text.slice(from + 1, to)));
  } else if (name === 'HardBreak') {
    parent.appendChild(document.createElement('br'));
  } else if (name === 'HTMLTag' && /^<br\s*\/?>$/i.test(text.slice(from, to))) {
    parent.appendChild(document.createElement('br'));
  } else if (name === 'Entity') {
    parent.appendChild(document.createTextNode(decodeEntity(text.slice(from, to))));
  } else if (name === 'TaskMarker') {
    parent.appendChild(document.createTextNode(/x/i.test(text.slice(from, to)) ? '☑' : '☐'));
  } else if (name === 'Autolink' || name === 'URL') {
    const href = text.slice(from, to).replace(/^<|>$/g, '');
    const a = parent.appendChild(document.createElement('span'));
    a.className = 'cm-md-link';
    setAttributes(a, linkAttributes(href));
    a.textContent = href;
  } else {
    renderRange(node, text, parent, from, to, definitions);
  }
}

/** 参照リンク（[foo]、[text][foo]、[foo][]）のリンク先。定義がなければ null */
function referenceHref(node, text, definitions) {
  const label = node.getChild('LinkLabel');
  const marks = node.getChildren('LinkMark');
  const name = label && label.to - label.from > 2
    ? text.slice(label.from + 1, label.to - 1)
    : marks.length >= 2 ? text.slice(marks[0].to, marks[1].from) : '';
  return definitions.get(normalizeLabel(name)) ?? null;
}

/**
 * 文字参照（Lezer の Entity。&name; / &#123; / &#x7b; の形だけ）を元の文字に戻す。
 * 名前付きの文字参照は HTML の定義が 2000 余りあるので、ブラウザの HTML の解析に任せる。
 * 解析した文書は画面に置かず、スクリプトも動かない。定義のない名前は、CommonMark と同じくそのまま出す
 * （HTML は「&notit;」を「&not」と「it;」に分けて「¬it;」にするが、文字参照は 1〜2 文字になるので見分けられる）
 */
function decodeEntity(raw) {
  const decoded = decodeEntities(raw);
  if (decoded !== raw) return decoded;
  const parsed = new DOMParser().parseFromString(raw, 'text/html').body.textContent;
  return [...parsed].length <= 2 ? parsed : raw;
}

function setAttributes(el, attributes) {
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
}

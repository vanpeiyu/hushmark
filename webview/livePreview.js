// ライブプレビューの装飾。文書は Markdown のテキストのまま持ち、
// カーソル（選択範囲）がかかっていない行だけ記号を隠して見た目を整える。
// 表は HTML の表に置き換え、触ったセルだけをソースで編集する（tableWidget.js）。
//
// 記号は消さずに透明にして（concealed）、その文字があった幅を残す。記号を出し入れしても文字の位置が
// 動かず、等幅フォントの桁もソースのとおりにそろう。
// 例外として、次の記号は幅ごと隠す（collapse）。
// - 見出しの「# 」。左の余白にぶら下げるので、見出しの文字は動かない。
// - 強調・取り消し線・エスケープ・リンクの記号。インラインコードと違って箱を持たないので、
//   幅を残すと余分な空白に見える。カーソルがその要素に入ったときだけ、その行の後ろの文字が動く。

import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { linkAttributes, openLinkHandler } from './inline.js';
import { TableWidget, enterTableByKeyboard, isRawTable, rawTables, tableScrollHandler, tableSearchHighlight } from './tableWidget.js';
import { buildTableModel, splitRow } from './tableModel.js';
import { hasMod } from './platform.js';

/** エディタのフォーカスの変化。テストからも使う。 */
export const setFocus = StateEffect.define();

const focusField = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocus)) value = effect.value;
    return value;
  },
});

const hidden = Decoration.replace({});
const concealed = Decoration.mark({ class: 'cm-md-conceal' });

const previewField = StateField.define({
  create(state) {
    ensureSyntaxTree(state, state.doc.length, 200);
    return buildDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured ||
        tr.effects.some((e) => e.is(setFocus)) ||
        tr.state.field(rawTables) !== tr.startState.field(rawTables) ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildDecorations(tr.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function livePreview({ openLink } = {}) {
  return [
    openLinkHandler.of(openLink),
    focusField,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
    rawTables,
    previewField,
    enterTableByKeyboard,
    tableSearchHighlight,
    tableScrollHandler,
    EditorView.domEventHandlers({ mousedown: handleLinkClick }),
    keymap.of([
      { key: 'Tab', run: moveTableCell(1) },
      { key: 'Shift-Tab', run: moveTableCell(-1) },
    ]),
  ];
}

// ---------------------------------------------------------------------------
// 装飾の組み立て

function buildDecorations(state) {
  const doc = state.doc;
  let linkDefinitionsCache = null;
  const definitions = () => (linkDefinitionsCache ??= linkDefinitions(state));
  const active = activeRanges(state);
  const isActive = (from, to) => active.some((r) => from <= r.to && to >= r.from);
  const decorations = [];

  /** 幅ごと消す */
  const collapse = (from, to) => {
    if (to > from) decorations.push(hidden.range(from, to));
  };
  /** 透明にして幅は残す */
  const conceal = (from, to) => {
    if (to > from) decorations.push(concealed.range(from, to));
  };
  const mark = (className, from, to, attributes) => {
    if (to > from) decorations.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  const lineClass = (from, to, className) => {
    const last = doc.lineAt(to).number;
    for (let n = doc.lineAt(from).number; n <= last; n++) {
      decorations.push(Decoration.line({ class: className }).range(doc.line(n).from));
    }
  };
  // インライン要素（強調・コード・リンクなど）の記号は、その要素にカーソルがかかっているときだけ薄く表示し、
  // それ以外では透明にする
  const selection = state.field(focusField) ? state.selection.ranges : [];
  const touches = (element) => selection.some((r) => element.from <= r.to && element.to >= r.from);
  const inlineMark = (from, to, element, hide = conceal) => {
    if (touches(element)) mark('cm-md-mark', from, to);
    else hide(from, to);
  };
  /** 要素の中身（最初と最後の記号の間）。強調の色や取り消し線を、透明にした記号の上に描かないため */
  const inner = (node, markName) => {
    const marks = node.getChildren(markName);
    return marks.length >= 2
      ? { from: marks[0].to, to: marks[marks.length - 1].from }
      : { from: node.from, to: node.to };
  };
  const nextIsSpace = (pos) => doc.sliceString(pos, pos + 1) === ' ';

  const frontmatter = frontmatterRange(doc);
  if (frontmatter) lineClass(frontmatter.from, frontmatter.to, 'cm-md-frontmatter');

  syntaxTree(state).iterate({
    enter(ref) {
      const { name, from, to } = ref;
      if (name === 'Document') return;
      if (frontmatter && from < frontmatter.to) return false;
      const node = ref.node;
      const parentName = node.parent ? node.parent.name : '';

      switch (name) {
        case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3':
        case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6':
          // 「##」だけの行は見出しの見た目にせず、記号をそのまま出す（isBareHeading）
          if (isBareHeading(doc, node)) return false;
          lineClass(from, to, `cm-md-heading cm-md-h${name.slice(-1)}${isActive(from, to) ? ' cm-md-heading-active' : ''}`);
          return;

        case 'SetextHeading1': case 'SetextHeading2': {
          const underline = doc.lineAt(to);
          if (underline.from > from) {
            lineClass(from, underline.from - 1, `cm-md-heading cm-md-h${name.slice(-1)}${isActive(from, to) ? ' cm-md-heading-active' : ''}`);
          }
          return;
        }

        case 'HeaderMark': {
          if (parentName.startsWith('Setext')) {
            // 下線（=== / ---）の行は、高さを変えずに見出しの下の余白として残す
            if (isActive(from, to)) mark('cm-md-mark', from, to);
            else conceal(from, to);
          } else if (from === node.parent.from) {
            // 行頭の「# 」は本文の大きさで、行の左端（箱や線をそろえる基準線）より左の余白にぶら下げる。
            // 左に「# 」の幅と行の余白の分ずらし、見出しの文字の位置は変えない。出しても隠しても見出しの文字は動かない
            //
            // 後ろの空白は「#」と分け、見出しと同じ大きさの文字にする。見出しにまだ文字がないとき、
            // IME で変換中の文字はカーソルの前の要素（この空白）に入るので、本文の大きさの「#」に入れると
            // 変換中だけ文字が小さくなるため。
            //
            // 行の余白は、空白の文字そのものを広く描いて取る（editor.css の word-spacing）。余白を別の場所に
            // 置くと、文書の 1 つの位置が画面の 2 か所（余白の前と後ろ）になり、カーソルを左右どちらから
            // 動かしたかで描かれる場所が変わるため。word-spacing は空白にしか効かないので、変換中の文字は広がらない
            const space = nextIsSpace(to);
            const shown = isActive(from, to) ? 'cm-md-mark' : 'cm-md-conceal';
            mark(`cm-md-heading-mark ${shown}`, from, to, {
              style: `margin-left: calc(-${to - from}ch - var(--md-line-pad)${space ? ' - var(--md-heading-space)' : ''})`,
            });
            if (space) mark('cm-md-heading-space', to, to + 1);
          } else {
            // 行末の閉じ「 ##」
            if (isActive(from, to)) mark('cm-md-mark', from, to);
            else conceal(from, to);
          }
          return;
        }

        case 'Emphasis': { const r = inner(node, 'EmphasisMark'); mark('cm-md-em', r.from, r.to); return; }
        case 'StrongEmphasis': { const r = inner(node, 'EmphasisMark'); mark('cm-md-strong', r.from, r.to); return; }
        case 'Strikethrough': { const r = inner(node, 'StrikethroughMark'); mark('cm-md-strike', r.from, r.to); return; }
        // インラインコードは ` のあった幅も背景に含め、左右の余白にする
        case 'InlineCode': mark('cm-md-inline-code', from, to); return;

        // 強調の記号は幅ごと隠す。幅を残すと、箱を持たない強調では余分な空白に見えるため
        case 'EmphasisMark':
        case 'StrikethroughMark':
          inlineMark(from, to, node.parent, collapse);
          return;

        case 'CodeMark':
          if (parentName === 'InlineCode') inlineMark(from, to, node.parent);
          return;

        case 'HardBreak': {
          // 行末の空白 2 つ以上による改行。空白は見えないので、その幅の上に薄い点を描く（バックスラッシュの改行は見えるので除く）
          const end = Math.min(to, doc.lineAt(from).to);
          if (doc.sliceString(from, end).trim() === '') mark('cm-md-hardbreak', from, end);
          return;
        }

        case 'Escape':
          inlineMark(from, from + 1, node, collapse);
          return;

        case 'FencedCode': {
          // ``` の行は高さを変えずに残し、コードブロックの上下の余白にする
          const open = isActive(from, to);
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          const fences = node.getChildren('CodeMark');
          const closed = fences.length > 1 && last.number > first.number;
          lineClass(first.from, last.to, 'cm-md-codeblock');
          lineClass(first.from, first.from, 'cm-md-codeblock-begin');
          if (closed) lineClass(last.from, last.from, 'cm-md-codeblock-end');
          const info = node.getChild('CodeInfo');
          fences.forEach((fence, i) => {
            if (open) mark('cm-md-mark', fence.from, fence.to);
            // 言語名の前の ``` は詰め、言語名を行頭に出す。この行には言語名しかないので、詰めても動くのは言語名だけ
            else if (i === 0 && info) collapse(fence.from, fence.to);
            else conceal(fence.from, fence.to);
          });
          if (info) mark('cm-md-code-info', info.from, info.to);
          return false;
        }

        case 'CodeBlock':
          lineClass(from, to, 'cm-md-codeblock cm-md-codeblock-indented');
          return false;

        case 'Blockquote':
          // 入れ子の引用は外側だけで枠を描く
          if (parentName === 'Blockquote') return;
          lineClass(from, to, 'cm-md-quote');
          lineClass(from, from, 'cm-md-quote-begin');
          lineClass(to, to, 'cm-md-quote-end');
          return;

        case 'QuoteMark':
          // > は透明にして幅を残す。引用の線は行の左端に描く（editor.css）
          if (isActive(from, to)) mark('cm-md-mark', from, to);
          else conceal(from, to);
          return;

        case 'ListMark': {
          const item = node.parent;
          const isTask = item && item.getChild('Task');
          const bullet = item && item.parent && item.parent.name === 'BulletList';
          if (isActive(from, to)) {
            mark(bullet ? 'cm-md-mark' : 'cm-md-list-number', from, to);
          } else if (isTask) {
            conceal(from, to);
          } else if (bullet) {
            // - の文字は透明にして、同じ幅の上に • を重ねる（• は東アジアの幅が曖昧な文字なので、文字では置き換えない）
            mark('cm-md-bullet', from, to);
          } else {
            mark('cm-md-list-number', from, to);
          }
          return;
        }

        case 'TaskMarker': {
          const checked = /x/i.test(doc.sliceString(from, to));
          if (checked) mark('cm-md-task-done', to, node.parent.to);
          if (isActive(from, to)) mark('cm-md-mark', from, to);
          else decorations.push(Decoration.replace({ widget: new CheckboxWidget(checked, to - from) }).range(from, to));
          return;
        }

        case 'Link': {
          const marks = node.getChildren('LinkMark');
          const url = node.getChild('URL');
          if (marks.length < 2) return;
          const textFrom = marks[0].to;
          const textTo = marks[1].from;
          let href = url ? doc.sliceString(url.from, url.to) : null;
          if (!href) {
            // 参照リンク（[foo]、[text][foo]、[foo][]）は、文書の中に [foo]: URL の定義があるときだけリンクにする。
            // 定義がなければ CommonMark ではただの文字なので、リンクとして描かない
            const label = node.getChild('LinkLabel');
            const name = label && label.to - label.from > 2
              ? doc.sliceString(label.from + 1, label.to - 1)
              : doc.sliceString(textFrom, textTo);
            href = definitions().get(normalizeLabel(name)) ?? null;
            if (href === null) return;
          }
          // (URL) は長いので幅ごと隠す。そのためカーソルが入ると後ろの文字は動くので、[ と ] も幅を残さない
          inlineMark(from, textFrom, node, collapse);
          inlineMark(textTo, to, node, collapse);
          mark('cm-md-link', textFrom, textTo, linkAttributes(href));
          return;
        }

        case 'Image':
          mark('cm-md-image', from, to);
          return false;

        case 'Autolink': {
          const url = node.getChild('URL');
          for (const m of node.getChildren('LinkMark')) inlineMark(m.from, m.to, node, collapse);
          if (url) mark('cm-md-link', url.from, url.to, linkAttributes(doc.sliceString(url.from, url.to)));
          return false;
        }

        case 'URL':
          // Link の中の URL は Link 側で扱う。ここに来るのは GFM の裸の URL
          if (parentName !== 'Link' && parentName !== 'Image' && parentName !== 'LinkReference') {
            mark('cm-md-link', from, to, linkAttributes(doc.sliceString(from, to)));
          }
          return;

        case 'HorizontalRule':
          // 行の高さは変えず、その行の中ほどに線を引く
          if (isActive(from, to)) {
            mark('cm-md-mark', from, to);
          } else {
            conceal(from, to);
            lineClass(from, to, 'cm-md-hr');
          }
          return;

        case 'Table': {
          const first = doc.lineAt(from);
          const last = doc.lineAt(to);
          // ソース表示は「ソース」ボタンで選んだときだけ。カーソルが入っただけでは切り替えない
          if (isRawTable(state, first.from, last.to) && isActive(first.from, last.to)) {
            lineClass(first.from, last.to, 'cm-md-table-src');
            return false;
          }
          const lines = [];
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'TableHeader' || child.name === 'TableRow' || child.name === 'TableDelimiter') {
              lines.push({ text: doc.sliceString(child.from, child.to), from: child.from - first.from });
            }
          }
          const source = doc.sliceString(first.from, last.to);
          decorations.push(Decoration.replace({
            widget: new TableWidget(buildTableModel(lines), source),
            block: true,
          }).range(first.from, last.to));
          return false;
        }
      }
    },
  });

  return Decoration.set(decorations, true);
}

/** リンクの参照定義のラベルの比べ方。CommonMark と同じく、前後の空白、空白の連続、大文字と小文字の違いを無視する */
export function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 文書の中のリンクの参照定義（[foo]: URL）。同じラベルが複数あるときは最初のものを使う */
function linkDefinitions(state) {
  const definitions = new Map();
  syntaxTree(state).iterate({
    enter(ref) {
      if (ref.name === 'LinkReference') {
        const label = ref.node.getChild('LinkLabel');
        const url = ref.node.getChild('URL');
        if (label && url) {
          const key = normalizeLabel(state.doc.sliceString(label.from + 1, label.to - 1));
          if (!definitions.has(key)) definitions.set(key, state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, ''));
        }
        return false;
      }
      // 定義はブロックの直下にしかないので、段落やコードブロックの中には入らない
      return ref.name === 'Document' || ref.name === 'Blockquote' || ref.name.endsWith('List') || ref.name === 'ListItem';
    },
  });
  return definitions;
}

/**
 * 「#」の後ろに何もない ATX 見出し（「##」だけの行）か。
 * CommonMark では空の見出しだが、見出しの見た目にしない。打っている途中で見出しの見た目になると、
 * 空白を打たずに続けて「##見出し」と打ちたくなり、そうすると見出しでなくなって見た目が戻るため。
 * 「## 」まで打てば見出しの見た目になる。
 */
export function isBareHeading(doc, node) {
  const mark = node.firstChild;
  return !!mark && mark.name === 'HeaderMark' && mark.from === node.from && mark.to === node.to &&
    mark.to === doc.lineAt(node.from).to;
}

/** 選択範囲がかかっている行の範囲。エディタにフォーカスがないときはどの行も隠す対象にする。 */
function activeRanges(state) {
  if (!state.field(focusField)) return [];
  return state.selection.ranges.map((r) => ({
    from: state.doc.lineAt(r.from).from,
    to: state.doc.lineAt(r.to).to,
  }));
}

/** 文書先頭の YAML フロントマター（--- で囲まれた部分）の範囲 */
function frontmatterRange(doc) {
  if (doc.lines < 2 || doc.line(1).text !== '---') return null;
  const limit = Math.min(doc.lines, 500);
  for (let n = 2; n <= limit; n++) {
    const text = doc.line(n).text;
    if (text === '---' || text === '...') return { from: 0, to: doc.line(n).to };
  }
  return null;
}

function handleLinkClick(event, view) {
  if (event.button !== 0 || !hasMod(event)) return false;
  const link = event.target instanceof Element && event.target.closest('[data-href]');
  if (!link) return false;
  event.preventDefault();
  view.state.facet(openLinkHandler)(link.getAttribute('data-href'));
  return true;
}

// ---------------------------------------------------------------------------
// ウィジェット

/** タスクの [ ] / [x]。ソースの 3 文字と同じ幅の箱に入れ、出し入れしても後ろの文字が動かないようにする */
class CheckboxWidget extends WidgetType {
  constructor(checked, width) {
    super();
    this.checked = checked;
    this.width = width;
  }
  eq(other) { return other.checked === this.checked && other.width === this.width; }
  toDOM(view) {
    const cell = document.createElement('span');
    cell.className = 'cm-md-checkbox-cell';
    cell.style.width = `${this.width}ch`;
    const box = cell.appendChild(document.createElement('input'));
    box.type = 'checkbox';
    box.className = 'cm-md-checkbox';
    box.checked = this.checked;
    const toggle = () => {
      const pos = view.posAtDOM(cell);
      if (!/^\[[ xX]\]$/.test(view.state.sliceDoc(pos, pos + 3))) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' } });
    };
    // 左クリックで切り替える。右クリック（メニューを開く操作）では切り替えない
    box.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      toggle();
    });
    // 表示の切り替えは文書の変更から作り直すウィジェットに任せる。
    // キーボード（Space）で押されたとき（detail が 0）は、ここで切り替える
    box.addEventListener('click', (event) => {
      event.preventDefault();
      if (event.detail === 0) toggle();
    });
    return cell;
  }
  ignoreEvent() { return true; }
}

// ---------------------------------------------------------------------------
// 表のソース表示中の Tab / Shift-Tab でセルを移動する

function moveTableCell(direction) {
  return (view) => {
    const { state } = view;
    const pos = state.selection.main.head;
    const table = findAncestor(syntaxTree(state).resolveInner(pos, -1), 'Table') ||
                  findAncestor(syntaxTree(state).resolveInner(pos, 1), 'Table');
    if (!table) return false;

    const rows = [];
    const cells = [];
    for (let child = table.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'TableHeader' && child.name !== 'TableRow') continue;
      rows.push(child);
      cells.push(...splitRow(state.sliceDoc(child.from, child.to), child.from));
    }
    let current = -1;
    cells.forEach((cell, i) => { if (cell.from <= pos) current = i; });
    const next = current + direction;

    if (next < 0) return true;
    if (next >= cells.length) {
      // 最後のセルで Tab を押したら行を足す。引用やリストの中の表は行頭の記号を再現できないので足さない
      const lastRow = rows[rows.length - 1];
      if (state.doc.lineAt(lastRow.from).from !== lastRow.from) return true;
      const width = splitRow(state.sliceDoc(rows[0].from, rows[0].to)).length;
      const insert = '\n|' + '  |'.repeat(width);
      view.dispatch({
        changes: { from: lastRow.to, insert },
        selection: EditorSelection.cursor(lastRow.to + 3),
        scrollIntoView: true,
      });
      return true;
    }
    view.dispatch({
      selection: EditorSelection.range(cells[next].from, cells[next].to),
      scrollIntoView: true,
    });
    return true;
  };
}

function findAncestor(node, name) {
  for (let n = node; n; n = n.parent) if (n.name === name) return n;
  return null;
}

// ライブプレビューの装飾。文書は Markdown のテキストのまま持ち、
// カーソル（選択範囲）がかかっていない行だけ記号を隠して見た目を整える。
// 表は、ソースの行のまま、セルを箱にして列をそろえる（tableCells.js）。
//
// 記号は消さずに透明にして（concealed）、その文字があった幅を残す。記号を出し入れしても文字の位置が
// 動かず、等幅フォントの桁もソースのとおりにそろう。
// 例外として、次の記号は幅ごと隠す（collapse）。
// - 見出しの「# 」。左の余白にぶら下げるので、見出しの文字は動かない。
// - 強調・取り消し線・エスケープ・リンクの記号。インラインコードと違って箱を持たないので、
//   幅を残すと余分な空白に見える。カーソルがその要素に入ったときだけ、その行の後ろの文字が動く。

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { linkAttributes, normalizeLabel, openLinkHandler } from './inline.js';
import { tableCells } from './tableCells.js';
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
    if (tr.reconfigured || tr.effects.some((e) => e.is(setFocus))) {
      return buildDecorations(tr.state);
    }
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return rebuildChanged(decorations, tr);
    if (tr.selection) return rebuildAroundSelection(decorations, tr.startState, tr.state);
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function livePreview({ openLink } = {}) {
  return [
    openLinkHandler.of(openLink),
    focusField,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
    previewField,
    tableCells(),
    EditorView.domEventHandlers({ mousedown: handleLinkClick }),
  ];
}

// ---------------------------------------------------------------------------
// 装飾の組み立て

/**
 * 文書や構文木が変わったときは、変わったブロックと、カーソルの前後の行を含むブロックの装飾だけを作り直す。
 * 変わったブロックは、変更のあった範囲と、文書の直下のブロックの並びを変更の前後で比べて食い違う範囲
 * （コードブロックを開いて後ろがすべてコードになったときなど）。リンクの参照定義は文書のどこのリンクにも
 * 効くので、参照定義にかかる変更とフロントマターにかかる変更では、全体を作り直す
 */
function rebuildChanged(decorations, tr) {
  const { startState: before, state: after, changes } = tr;
  const spans = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => spans.push({ from: fromB, to: toB }));
  for (const span of selectionSpans(before)) {
    spans.push({ from: changes.mapPos(span.from, -1), to: changes.mapPos(span.to, 1) });
  }
  spans.push(...selectionSpans(after));
  spans.push(...changedBlocks(syntaxTree(before), syntaxTree(after), changes));

  const frontmatters = [frontmatterRange(before.doc), frontmatterRange(after.doc)].filter(Boolean);
  const expanded = mergeSpans(spans.map((span) => expandToBlocks(after, span)));
  if (expanded.some((span) => frontmatters.some((f) => span.from <= f.to + 1)) ||
      !sameDefinitions(cachedDefinitions(before), cachedDefinitions(after))) {
    return buildDecorations(after);
  }
  return replaceSpans(decorations.map(changes), after, expanded);
}

/** 変更の前後で、文書の直下のブロックの並び（種類と範囲）が食い違うところ（変更の後の位置） */
function changedBlocks(treeBefore, treeAfter, changes) {
  const blocksOf = (tree, map) => {
    const list = [];
    // SyntaxNode の nextSibling は大きな木では遅いので、カーソルでたどる
    for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
      list.push({ name: child.name, from: map(child.from, -1), to: map(child.to, 1) });
    }
    return list;
  };
  const before = blocksOf(treeBefore, (pos, assoc) => changes.mapPos(pos, assoc));
  const after = blocksOf(treeAfter, (pos) => pos);
  const same = (a, b) => a.name === b.name && a.from === b.from && a.to === b.to;
  let head = 0;
  while (head < before.length && head < after.length && same(before[head], after[head])) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head &&
         same(before[before.length - 1 - tail], after[after.length - 1 - tail])) tail++;
  const differing = [...before.slice(head, before.length - tail), ...after.slice(head, after.length - tail)];
  return differing.map((b) => ({ from: b.from, to: b.to }));
}

/** 構文木ごとの、リンクの参照定義（linkDefinitions）。文書を変えるたびに前後の定義を比べるので覚えておく */
const definitionsByTree = new WeakMap();
function cachedDefinitions(state) {
  const tree = syntaxTree(state);
  if (!definitionsByTree.has(tree)) definitionsByTree.set(tree, linkDefinitions(state));
  return definitionsByTree.get(tree);
}

function sameDefinitions(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * 範囲を、その行と、それに重なる文書の直下のブロックまで広げる。
 * 表は広げない。表の行の装飾は行ごとに決まるので（tableCells.js）、長い表の中の入力で全体を作り直さないため
 */
function expandToBlocks(state, { from, to }) {
  from = state.doc.lineAt(Math.min(from, state.doc.length)).from;
  to = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  for (const block of topLevelBlocks(syntaxTree(state), from, to)) {
    if (block.name === 'Table') continue;
    from = Math.min(from, block.from);
    to = Math.max(to, block.to);
  }
  return { from, to };
}

/** 範囲（文書の直下のブロックの単位）の装飾を作り直して入れ替える */
function replaceSpans(decorations, state, spans) {
  for (const span of spans) {
    const rebuilt = [];
    for (const cursor = buildDecorations(state, span).iter(); cursor.value; cursor.next()) {
      rebuilt.push(cursor.value.range(cursor.from, cursor.to));
    }
    decorations = decorations.update({
      filter: (from, to) => to < span.from || from > span.to,
      filterFrom: span.from,
      filterTo: span.to,
      add: rebuilt,
    });
  }
  return decorations;
}

/**
 * カーソル（選択範囲）が動いただけのときは、動く前と後の行を含むブロックの装飾だけを作り直す。
 * 記号を出すかどうかは、カーソルのある行と、それを含むブロック（コードブロックや表）で決まるため。
 * 長い文書でも、カーソルの移動にかかる時間が文書の長さによらないようにする
 */
function rebuildAroundSelection(decorations, before, after) {
  const spans = mergeSpans([...selectionSpans(before), ...selectionSpans(after)]);
  const frontmatter = frontmatterRange(after.doc);
  // フロントマターの行の装飾は、ブロックの単位では作り直せないので、全体を作り直す
  if (frontmatter && spans.some((s) => s.from <= frontmatter.to)) return buildDecorations(after);
  return replaceSpans(decorations, after, spans);
}

/** 選択範囲のある行を含む、文書の直下のブロックの範囲。フォーカスがないときは、どの行も記号を出さないので空 */
function selectionSpans(state) {
  if (!state.field(focusField)) return [];
  return state.selection.ranges.map((r) => expandToBlocks(state, r));
}

/** from から to に重なる、文書の直下のブロック */
function topLevelBlocks(tree, from, to) {
  const blocks = [];
  // 先頭から順にたどると長い文書で遅いので、from に接するブロック（終わりが from 以降の最初のもの）から始める
  const first = tree.topNode.childAfter(from - 1);
  if (!first) return blocks;
  const cursor = first.cursor();
  do {
    if (cursor.to < from) continue;
    if (cursor.from > to) break;
    blocks.push(cursor.node);
  } while (cursor.nextSibling());
  return blocks;
}

/** 重なる（接する）範囲をまとめる */
function mergeSpans(spans) {
  const sorted = spans.sort((a, b) => a.from - b.from);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/** 装飾を作る。span を渡したときは、その範囲にある文書の直下のブロックの装飾だけを作る */
function buildDecorations(state, span = null) {
  const doc = state.doc;
  let linkDefinitionsCache = null;
  const definitions = () => (linkDefinitionsCache ??= cachedDefinitions(state));
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

  const frontmatter = span ? null : frontmatterRange(doc);
  if (frontmatter) lineClass(frontmatter.from, frontmatter.to, 'cm-md-frontmatter');

  syntaxTree(state).iterate({
    from: span ? span.from : 0,
    to: span ? span.to : doc.length,
    enter(ref) {
      const { name, from, to } = ref;
      if (name === 'Document') return;
      // span の外のブロック（範囲の端に接するだけのもの）には入らない
      if (span && (to < span.from || from > span.to)) return false;
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

        case 'Image': {
          // 画像は描かずにソースのまま出す。マウスを載せると浮かせて表示し（imagePreview.js）、Ctrl+クリックで開く
          const url = node.getChild('URL');
          let href = url ? doc.sliceString(url.from, url.to) : null;
          if (!href) {
            const label = node.getChild('LinkLabel');
            const marks = node.getChildren('LinkMark');
            const name = label && label.to - label.from > 2
              ? doc.sliceString(label.from + 1, label.to - 1)
              : marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
            href = definitions().get(normalizeLabel(name)) ?? null;
          }
          mark('cm-md-image', from, to, href === null ? undefined : { 'data-image-src': href, 'data-href': href });
          return false;
        }

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

        // 表は tableCells.js が行とセルの箱を付ける。セルの中の強調やリンクは、ここで本文と同じく装飾する
      }
    },
  });

  return Decoration.set(decorations, true);
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

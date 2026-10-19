// 太字と斜体の切り替え（hushmark.bold / hushmark.italic。既定のキーは Ctrl+B / Ctrl+I）。
// Typora や Word と同じく、同じ操作をもう一度すると元に戻る（トグル）。
//
// - 選択範囲が太字の中身か、記号を含めた太字の全体なら、太字を外す。そうでなければ囲む
// - 選択がないとき
//   - 空の「****」の間なら、それを消す（Ctrl+B を 2 回押したとき）
//   - 太字の中身の末尾なら、閉じの記号の後ろに出る（Ctrl+B → 入力 → Ctrl+B で太字を書き終える）
//   - 太字の中のそのほかの位置なら、太字を外す
//   - 英数字の語の途中なら、その語を囲む
//   - それ以外では「****」を入れて間にカーソルを置く
// 太字か斜体かは構文木で見分ける（太字の「**」の内側の「*」を斜体の記号と取り違えない）。

import { EditorSelection } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

const NODE = { '**': 'StrongEmphasis', '*': 'Emphasis' };
const WORD = /[\p{Script=Latin}\p{Nd}_]/u;

/** 要素の中身（最初と最後の記号の間） */
function innerOf(node) {
  const marks = node.getChildren('EmphasisMark');
  if (marks.length < 2) return null;
  return { from: marks[0].to, to: marks[marks.length - 1].from, open: marks[0], close: marks[marks.length - 1] };
}

/** from〜to を含む、種類が name の要素。内側のものから探す */
function elementAround(state, name, from, to) {
  for (let node = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (node.name === name && node.from <= from && node.to >= to) return node;
  }
  for (let node = syntaxTree(state).resolveInner(from, -1); node; node = node.parent) {
    if (node.name === name && node.from <= from && node.to >= to) return node;
  }
  return null;
}

function unwrap(element, inner, range) {
  const open = inner.open.to - inner.open.from;
  const changes = [{ from: inner.open.from, to: inner.open.to }, { from: inner.close.from, to: inner.close.to }];
  const map = (pos) => Math.min(Math.max(pos, inner.from), inner.to) - open;
  return { changes, range: EditorSelection.range(map(range.anchor), map(range.head)) };
}

function toggleRange(state, marker, range) {
  const len = marker.length;
  const name = NODE[marker];
  const wrap = (from, to) => ({
    changes: [{ from, insert: marker }, { from: to, insert: marker }],
    range: EditorSelection.range(range.anchor + len, range.head + len),
  });

  if (!range.empty) {
    const element = elementAround(state, name, range.from, range.to);
    const inner = element && innerOf(element);
    if (inner && ((inner.from === range.from && inner.to === range.to) || (element.from === range.from && element.to === range.to))) {
      return unwrap(element, inner, range);
    }
    return wrap(range.from, range.to);
  }

  const pos = range.head;
  if (state.sliceDoc(pos - len, pos) === marker && state.sliceDoc(pos, pos + len) === marker) {
    return { changes: { from: pos - len, to: pos + len }, range: EditorSelection.cursor(pos - len) };
  }
  const element = elementAround(state, name, pos, pos);
  const inner = element && innerOf(element);
  if (inner && pos >= inner.from && pos <= inner.to) {
    if (pos === inner.to && inner.to > inner.from) return { range: EditorSelection.cursor(inner.close.to) };
    return unwrap(element, inner, range);
  }
  const word = state.wordAt(pos);
  if (word && word.from < pos && word.to > pos &&
      WORD.test(state.sliceDoc(pos - 1, pos)) && WORD.test(state.sliceDoc(pos, pos + 1))) {
    let { from, to } = word;
    while (from < pos && !WORD.test(state.sliceDoc(from, from + 1))) from++;
    while (to > pos && !WORD.test(state.sliceDoc(to - 1, to))) to--;
    return wrap(from, to);
  }
  return wrap(pos, pos);
}

/** marker（'**' か '*'）で囲む・外すコマンド */
export function toggleInline(marker) {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    dispatch(state.update(state.changeByRange((range) => {
      const result = toggleRange(state, marker, range);
      return { changes: result.changes || [], range: result.range };
    }), { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

// ---------------------------------------------------------------------------
// 語の単位の削除（Ctrl+Backspace / Ctrl+Delete）の範囲の調整

/** 記号を隠す要素なら、その中身の範囲 */
export function hiddenElement(node) {
  switch (node.name) {
    case 'Emphasis': case 'StrongEmphasis': case 'Strikethrough': case 'InlineCode': {
      const marks = node.getChildren(node.name === 'Strikethrough' ? 'StrikethroughMark' : node.name === 'InlineCode' ? 'CodeMark' : 'EmphasisMark');
      return marks.length >= 2 ? { from: marks[0].to, to: marks[marks.length - 1].from } : null;
    }
    case 'Link': {
      const marks = node.getChildren('LinkMark');
      return marks.length >= 2 && node.getChild('URL') ? { from: marks[0].to, to: marks[1].from } : null;
    }
    default:
      return null;
  }
}

/**
 * 語の単位の削除の範囲 from〜to を、記号の片方だけを消さないように直す。
 * - 強調やリンクの閉じの記号（後ろへの削除では開きの記号）だけを消すことになるときは、代わりに中身の最後
 *   （最初）の語を消す。中身がすべてなくなるときは、要素ごと消す
 * - 項目や見出しの内容の先頭からの Ctrl+Backspace は、行頭の記号（「- [ ] 」など）をまとめて消す。
 *   項目の末尾からの Ctrl+Delete は、次の項目の記号も消して内容だけをつなげる
 * wordAt(text, pos, forward) は、text の中の pos から次 / 前の語の境目
 * @returns {{ from: number, to: number }[]} 消す範囲
 */
export function adjustWordDeletion(state, from, to, forward, wordAt, lineMarkup) {
  const head = forward ? from : to;
  const line = state.doc.lineAt(head);
  if (!forward && from >= line.from) {
    const markup = lineMarkup(state, line);
    if (markup && head === markup.contentStart) {
      const start = markup.listMark ? markup.listMark.from : markup.heading ? markup.heading.from : from;
      return [{ from: Math.min(from, start), to }];
    }
  }
  if (forward && from === line.to && to === line.to + 1 && lineMarkup(state, line)?.listMark) {
    // 項目の末尾から：次の項目の記号も消し、内容だけをつなげる（Delete と同じ）
    const next = state.doc.line(line.number + 1);
    const markup = lineMarkup(state, next);
    if (markup && markup.listMark) return [{ from, to: markup.contentStart }];
  }
  let element = null;
  syntaxTree(state).iterate({
    from: Math.max(from - 1, 0),
    to: Math.min(to + 1, state.doc.length),
    enter(ref) {
      if (element) return false;
      const inner = hiddenElement(ref.node);
      if (!inner) return undefined;
      // 要素がすべて範囲に入っているか、範囲が中身の中だけなら直さない
      if ((ref.from >= from && ref.to <= to) || (from >= inner.from && to <= inner.to)) return undefined;
      if (to <= ref.from || from >= ref.to) return undefined;
      element = { from: ref.from, to: ref.to, inner };
      return false;
    },
  });
  if (!element) return [{ from, to }];
  const { inner } = element;
  const text = state.sliceDoc(inner.from, inner.to);
  if (!forward && to > inner.to) {
    // 閉じの記号を消すことになる後ろからの削除：中身のうち範囲に入る部分、なければ最後の語
    let start = Math.max(from, inner.from);
    if (start >= inner.to) start = inner.from + wordAt(text, text.length, false);
    // 中身の末尾に空白を残すと強調として成り立たないので、語の前の空白も消す
    while (start > inner.from && /\s/.test(state.sliceDoc(start - 1, start))) start--;
    const rest = to > element.to ? [{ from: element.to, to }] : [];
    if (start <= inner.from) return [{ from: Math.min(from, element.from), to }];
    return [{ from: start, to: inner.to }, ...rest];
  }
  if (forward && from < inner.from) {
    let end = Math.min(to, inner.to);
    if (end <= inner.from) end = inner.from + wordAt(text, 0, true);
    while (end < inner.to && /\s/.test(state.sliceDoc(end, end + 1))) end++;
    const rest = from < element.from ? [{ from, to: element.from }] : [];
    if (end >= inner.to) return [{ from, to: Math.max(to, element.to) }];
    return [...rest, { from: inner.from, to: end }];
  }
  // 中身から始めて開きの記号（後ろへは閉じの記号）にかかる削除：中身の端で止める
  return [{ from: Math.max(from, inner.from), to: Math.min(to, inner.to) }];
}

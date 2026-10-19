// リスト・タスク・引用・見出しの行での入力の操作。CodeMirror の Markdown のコマンド
// （insertNewlineContinueMarkup）を土台に、多くのエディタ（Typora、Obsidian、Notion など）と同じ動きに直す。
//
// - 空の項目で Enter を押すと、項目の数によらず 1 回でリストを抜ける（入れ子なら 1 段浅くする）。
//   最上位のリストを抜けるときは空行を入れ、次に書く段落が最後の項目の続きにならないようにする
// - 内容の先頭で Enter を押すと、上に空の項目を入れる。元の項目のチェックはそのまま
// - 子を持つ項目の末尾で Enter を押すと、最初の子の位置に項目を作る（親子の関係を変えない）
// - Shift+Enter は、項目や引用の中の改行にする（内容の位置まで字下げする）。続きの行で Enter を押すと次の項目を作る
// - 項目の行頭の Backspace は、最初の項目なら記号をまとめて消し、続きの行なら前の行とつなげる
// - 最初の項目では Tab で字下げしない（親になる項目がなく、4 桁の字下げはコードブロックになるため）。
//   番号付きの項目を Tab で新しい入れ子にしたときは、番号を 1 にする
// - 項目の末尾で Delete を押すと、次の項目の記号を消して内容だけをつなげる
// - Home は、記号の後ろ（内容の先頭）と行頭を行き来する。Home と End は、行頭や行末の隠した記号の手前で止まらない
// - 記号を隠した行で記号のあたりをクリックしたら、カーソルを内容の先頭に置く。行末の右をクリックしたら、
//   隠した閉じの記号の後ろに置く（行頭の強調の左なら、開きの記号の前）
// - 見出しの文字の先頭で Enter を押すと上に空の行を入れ、Backspace を押すと「## 」をまとめて消す
//   （「## 」は左の余白に出ているので、利用者には見出しの先頭に見える）
// - 空の引用の行で Enter を押すと引用を抜ける（入れ子なら 1 段浅くする）
// - setext 見出しの末尾で Enter を押すと、下線の後ろに新しい行を作る
// - 閉じていないコードブロックを開いた行の末尾で Enter を押すと、閉じのフェンスも入れる
// - リストの項目以外では、Tab でカーソルの位置に空白を入れる（VSCode のテキストエディタと同じ）

import { EditorSelection, EditorState, Prec, countColumn } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { getIndentUnit, indentString, syntaxTree } from '@codemirror/language';
import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { rowEndOf, rowStartOf } from './verticalMove.js';
import { hiddenElement } from './inlineFormat.js';

/** 2 つ目の項目で空の項目を下に送って「緩いリスト」にする CodeMirror の動きは使わない */
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/**
 * 行の先頭にある Markdown の記号。listMark（リストの記号）、task（[ ] の記号）、quoteEnd（最後の > の後ろ）、
 * heading（見出しの #）と、記号の後ろの空白を飛ばした内容の先頭（contentStart）。記号がなければ null
 */
export function lineMarkup(state, line) {
  let listMark = null;
  let task = null;
  let quoteEnd = null;
  let heading = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(ref) {
      if (ref.from < line.from) return;
      if (ref.from > line.to) return false;
      switch (ref.name) {
        case 'ListMark': listMark = ref.node; task = null; break;
        case 'TaskMarker': if (listMark && ref.from >= listMark.to) task = ref.node; break;
        case 'QuoteMark': quoteEnd = ref.to; break;
        case 'HeaderMark':
          if (ref.from === line.from + /^ {0,3}/.exec(line.text)[0].length && /^ATXHeading/.test(ref.node.parent.name)) heading = ref.node;
          break;
      }
    },
  });
  const end = Math.max(task ? task.to : 0, listMark ? listMark.to : 0, quoteEnd ?? 0, heading ? heading.to : 0);
  if (!end) return null;
  let contentStart = end;
  while (contentStart < line.to && /[ \t]/.test(state.doc.sliceString(contentStart, contentStart + 1))) contentStart++;
  return { listMark, task, quoteEnd, heading, contentStart, item: listMark && listMark.parent };
}

/** 項目の内容の先頭（チェックボックスを含めない）。継続の行はこの桁にそろえる */
function itemContentStart(state, line, markup) {
  let pos = markup.listMark.to;
  while (pos < line.to && pos < markup.listMark.to + 4 && state.doc.sliceString(pos, pos + 1) === ' ') pos++;
  return pos === markup.listMark.to ? pos + 1 : pos;
}

/** 次の項目に付ける記号の行頭部分。チェックは外し、番号はそのまま（後で振り直す） */
function emptyItemPrefix(state, line, markup) {
  const text = state.sliceDoc(line.from, markup.contentStart);
  if (!markup.task) return /\s$/.test(text) ? text : `${text} `;
  return `${state.sliceDoc(line.from, markup.task.from)}[ ] `;
}

const isList = (node) => node && (node.name === 'BulletList' || node.name === 'OrderedList');
const itemNumber = (state, item) => {
  const mark = item.getChild('ListMark');
  return mark ? Number(/^\d+/.exec(state.sliceDoc(mark.from, mark.to))?.[0]) : NaN;
};

/**
 * 番号付きのリストで、first（項目）から後ろの番号を number から振り直す変更。
 * 番号が 1 つずつ増えていないリスト（すべて「1.」など）は書いた人の書き方なので変えない
 */
function renumber(state, first, number, skip = null) {
  const changes = [];
  for (let item = first; item; item = item.nextSibling) {
    if (item.name !== 'ListItem' || item === skip) continue;
    const mark = item.getChild('ListMark');
    const digits = /^\d+/.exec(state.sliceDoc(mark.from, mark.to))[0];
    if (Number(digits) !== number) changes.push({ from: mark.from, to: mark.from + digits.length, insert: String(number) });
    number++;
  }
  return changes;
}

function isSequential(state, list) {
  let prev = null;
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (item.name !== 'ListItem') continue;
    const n = itemNumber(state, item);
    if (prev !== null && n !== prev + 1) return false;
    prev = n;
  }
  return true;
}

/** 1 つだけのカーソル。複数のカーソルや選択範囲では CodeMirror の操作に任せる */
function singleCursor(state) {
  const { ranges } = state.selection;
  return ranges.length === 1 && ranges[0].empty ? ranges[0].head : null;
}

function insertNewline({ state, dispatch }) {
  const pos = singleCursor(state);
  if (pos === null) return continueMarkup({ state, dispatch });
  const line = state.doc.lineAt(pos);
  const br = state.lineBreak;
  const fence = unclosedFenceAt(state, line);
  if (fence && !/\S/.test(state.sliceDoc(pos, line.to))) {
    // 閉じていないコードブロックを開いた行の末尾：閉じのフェンスも入れ、間の行に移る（Typora と同じ）。
    // 閉じるまでは、後ろの文書がすべてコードとして描かれるため
    const prefix = fence.prefix;
    const insert = `${br}${prefix}${br}${prefix}${fence.mark}`;
    dispatch(state.update({ changes: { from: pos, to: line.to, insert }, selection: { anchor: pos + br.length + prefix.length }, scrollIntoView: true, userEvent: 'input' }));
    return true;
  }
  const underline = setextUnderlineAfter(state, pos);
  if (underline) {
    // setext 見出しの末尾：下線の後ろに新しい行を作る（下線の前で改行すると、見出しが段落に、下線が水平線に変わる）
    dispatch(state.update({ changes: { from: underline.to, insert: br }, selection: { anchor: underline.to + br.length }, scrollIntoView: true, userEvent: 'input' }));
    return true;
  }
  const markup = lineMarkup(state, line);
  if (!markup) {
    // 項目の続きの行（Shift+Enter で作った行など）：次の項目を作る。続きの行の改行は Shift+Enter
    const item = continuedItem(state, line);
    if (item) {
      const itemLine = state.doc.lineAt(item.from);
      const itemMarkup = lineMarkup(state, itemLine);
      let prefix = emptyItemPrefix(state, itemLine, itemMarkup);
      const changes = [];
      if (item.parent.name === 'OrderedList') {
        const n = itemNumber(state, item);
        prefix = prefix.replace(/\d+/, String(n + 1));
        if (isSequential(state, item.parent)) changes.push(...renumber(state, item.nextSibling, n + 2));
      }
      let from = pos;
      while (from > line.from && /[ \t]/.test(state.sliceDoc(from - 1, from))) from--;
      const after = state.sliceDoc(pos, line.to).replace(/^[ \t]+/, '');
      changes.push({ from, to: line.to, insert: br + prefix + after });
      dispatch(state.update({ changes, selection: { anchor: from + br.length + prefix.length }, scrollIntoView: true, userEvent: 'input' }));
      return true;
    }
  }
  if (!markup || pos < markup.contentStart) return continueMarkup({ state, dispatch });
  const content = state.sliceDoc(markup.contentStart, line.to);

  // リストの項目や引用の中でコードブロックを開いた行の末尾：次の行を内容の位置にそろえ、コードを項目や引用の中に書く
  // （そろえないと、コードが項目や引用の外に出て、閉じの ``` が新しいコードブロックの始まりになる）
  if (/^(`{3,}|~{3,})/.test(content) && !/\S/.test(state.sliceDoc(pos, line.to)) && !markup.heading) {
    const insert = br + continuationPrefix(state, line, markup);
    dispatch(state.update({ changes: { from: pos, to: line.to, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true, userEvent: 'input' }));
    return true;
  }

  if (!markup.listMark) {
    // 見出しの文字の先頭：見出しはそのままにして、上に空の行を入れる。
    // 「## 」は左の余白に出ているので、利用者には見出しの先頭で押したように見えるため
    if (markup.heading && pos === markup.contentStart && /\S/.test(content)) {
      const set = state.changes({ from: line.from, insert: br });
      dispatch(state.update({ changes: set, selection: { anchor: set.mapPos(pos, 1) }, scrollIntoView: true, userEvent: 'input' }));
      return true;
    }
    // 空の引用の行：入れ子なら 1 段浅く、そうでなければ引用を抜ける
    if (markup.quoteEnd !== null && !markup.heading && !/\S/.test(content)) {
      const prefix = state.sliceDoc(line.from, markup.quoteEnd);
      const outer = prefix.replace(/>\s*$/, '').replace(/\s+$/, '');
      if (outer.includes('>')) {
        dispatch(state.update({ changes: { from: line.from, to: line.to, insert: `${outer} ` }, selection: { anchor: line.from + outer.length + 1 }, userEvent: 'input' }));
        return true;
      }
      const prevBlank = line.number > 1 && !/[^\s>]/.test(state.doc.line(line.number - 1).text);
      const insert = prevBlank ? '' : br;
      dispatch(state.update({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length }, scrollIntoView: true, userEvent: 'input' }));
      return true;
    }
    // 引用の中のコードブロックの行：「> 」と字下げを続ける（コードの中では Markdown の継続が働かないため）
    if (markup.quoteEnd !== null && !markup.heading && inFencedCode(state, pos)) {
      const insert = br + continuationPrefix(state, line, markup);
      dispatch(state.update({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true, userEvent: 'input' }));
      return true;
    }
    return continueMarkup({ state, dispatch });
  }
  const { item } = markup;

  // 空の項目：入れ子なら 1 段浅く（CodeMirror に任せる）、最上位ならリストを抜ける
  if (!/\S/.test(content)) {
    const nested = item.parent && item.parent.parent && item.parent.parent.name === 'ListItem';
    if (nested) return continueMarkup({ state, dispatch });
    const quote = state.sliceDoc(line.from, markup.listMark.from).replace(/\s+$/, '');
    const prevBlank = line.number > 1 && !/[^\s>]/.test(state.doc.line(line.number - 1).text);
    const rest = quote ? `${quote} ` : '';
    const insert = prevBlank ? rest : `${quote}${br}${rest}`;
    const changes = [{ from: line.from, to: line.to, insert }];
    if (item.parent.name === 'OrderedList' && isSequential(state, item.parent)) changes.push(...renumber(state, item.nextSibling, itemNumber(state, item)));
    dispatch(state.update({ changes, selection: { anchor: line.from + insert.length }, scrollIntoView: true, userEvent: 'input' }));
    return true;
  }

  // 内容の先頭：上に空の項目を入れ、カーソルは内容と一緒に下の行へ
  if (pos === markup.contentStart) {
    const prefix = emptyItemPrefix(state, line, markup);
    const changes = [{ from: line.from, insert: prefix + br }];
    if (item.parent.name === 'OrderedList' && isSequential(state, item.parent)) changes.push(...renumber(state, item, itemNumber(state, item) + 1));
    const set = state.changes(changes);
    dispatch(state.update({ changes: set, selection: { anchor: set.mapPos(pos, 1) }, scrollIntoView: true, userEvent: 'input' }));
    return true;
  }

  // 子を持つ項目の、最初の行の末尾：最初の子の位置に新しい項目を作る
  const childList = item.lastChild && isList(item.lastChild) ? item.lastChild : item.getChild('BulletList') || item.getChild('OrderedList');
  if (childList && !/\S/.test(state.sliceDoc(pos, line.to)) && state.doc.lineAt(childList.from).number > line.number) {
    const firstChild = childList.firstChild;
    const childLine = state.doc.lineAt(firstChild.from);
    const childMarkup = lineMarkup(state, childLine);
    if (childMarkup && childMarkup.listMark) {
      const prefix = emptyItemPrefix(state, childLine, childMarkup);
      let from = pos;
      while (from > markup.contentStart && /\s/.test(state.sliceDoc(from - 1, from))) from--;
      const changes = [{ from, to: line.to, insert: br + prefix }];
      if (childList.name === 'OrderedList') changes.push(...renumber(state, firstChild, itemNumber(state, firstChild) + 1));
      dispatch(state.update({ changes, selection: { anchor: from + br.length + prefix.length }, scrollIntoView: true, userEvent: 'input' }));
      return true;
    }
  }
  return continueMarkup({ state, dispatch });
}

/** pos が setext 見出しの最後の文字の行の末尾なら、その下線の行 */
function setextUnderlineAfter(state, pos) {
  const line = state.doc.lineAt(pos);
  if (pos !== line.to || line.number === state.doc.lines) return null;
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'SetextHeading1' || node.name === 'SetextHeading2') {
      const mark = node.getChild('HeaderMark');
      const next = state.doc.line(line.number + 1);
      return mark && mark.from >= next.from && mark.to <= next.to ? next : null;
    }
  }
  return null;
}

/**
 * line が項目の続きの行（項目の最初の行ではない段落の行）なら、その項目。コードブロックの中は除く
 */
function continuedItem(state, line) {
  const at = line.from + /^[ \t]*/.exec(line.text)[0].length;
  for (let node = syntaxTree(state).resolveInner(at, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'Blockquote' || node.name === 'Table') return null;
    if (node.name === 'ListItem') return node.from < line.from ? node : null;
  }
  return null;
}

/**
 * 項目の行頭で Backspace。
 * - 最上位のリストの最初の項目の内容の先頭：記号（- [ ] など）をまとめて消して段落にする
 * - 項目の続きの行の行頭（1 回目の Backspace で記号を空白にした行も含む）：前の行とつなげる
 *   （空白を 1 つずつ消すと、見た目と違って前の項目の続きになる行が途中にできるため）
 * そのほかは CodeMirror の Markdown の Backspace（記号を空白にする）に任せる
 */
function deleteItemMarkup({ state, dispatch }) {
  const pos = singleCursor(state);
  if (pos === null) return false;
  const line = state.doc.lineAt(pos);
  const markup = lineMarkup(state, line);
  if (markup && markup.listMark && pos === markup.contentStart) {
    const { item } = markup;
    let prev = item.prevSibling;
    while (prev && prev.name !== 'ListItem') prev = prev.prevSibling;
    const nested = item.parent.parent && item.parent.parent.name === 'ListItem';
    if (prev || nested) return false;
    const changes = [{ from: markup.listMark.from, to: pos }];
    if (item.parent.name === 'OrderedList' && isSequential(state, item.parent)) changes.push(...renumber(state, item.nextSibling, itemNumber(state, item)));
    dispatch(state.update({ changes, userEvent: 'delete.backward' }));
    return true;
  }
  if (markup || line.number === 1 || /\S/.test(state.sliceDoc(line.from, pos))) return false;
  const prevLine = state.doc.line(line.number - 1);
  // 空白だけの行（空のタスクの記号を空白にした行など）は構文木では項目に入らないので、上の行で調べる
  const blank = !/\S/.test(line.text);
  if (!(blank ? itemAround(state, prevLine) : continuedItem(state, line))) return false;
  const to = Math.max(pos, line.from + /^[ \t]*/.exec(line.text)[0].length);
  dispatch(state.update({ changes: { from: prevLine.to, to }, selection: { anchor: prevLine.to }, userEvent: 'delete.backward' }));
  return true;
}

/** line を含む項目（コードブロックの中は除く） */
function itemAround(state, line) {
  const at = line.from + /^[ \t]*/.exec(line.text)[0].length;
  for (let node = syntaxTree(state).resolveInner(at, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return null;
    if (node.name === 'ListItem') return node;
  }
  return null;
}

/** 見出しの文字の先頭で Backspace：「## 」をまとめて消して段落にする（引用の「> 」と同じ） */
function deleteHeadingMark({ state, dispatch }) {
  const pos = singleCursor(state);
  if (pos === null) return false;
  const line = state.doc.lineAt(pos);
  const markup = lineMarkup(state, line);
  if (!markup || !markup.heading || markup.listMark || pos !== markup.contentStart) return false;
  dispatch(state.update({ changes: { from: markup.heading.from, to: pos }, userEvent: 'delete.backward' }));
  return true;
}

/** リストの項目以外での Tab：選択範囲がなければ、カーソルの位置に次のタブ位置までの空白（またはタブ）を入れる */
function insertTab({ state, dispatch }) {
  if (state.readOnly || state.selection.ranges.some((r) => !r.empty)) return false;
  const unit = indentString(state, getIndentUnit(state));
  dispatch(state.update(state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const column = countColumn(line.text, state.tabSize, range.head - line.from);
    const insert = unit === '\t' ? '\t' : ' '.repeat(state.tabSize - (column % state.tabSize));
    return { changes: { from: range.head, insert }, range: EditorSelection.cursor(range.head + insert.length) };
  }), { scrollIntoView: true, userEvent: 'input' }));
  return true;
}

/**
 * line が、閉じていないコードブロックを開いた行なら、そのフェンス（``` など）と、続きの行の行頭（引用の > や
 * 項目の字下げ）
 */
function unclosedFenceAt(state, line) {
  const markup = lineMarkup(state, line);
  const start = markup ? markup.contentStart : line.from + /^[ \t]*/.exec(line.text)[0].length;
  const match = /^(`{3,}|~{3,})/.exec(state.sliceDoc(start, line.to));
  if (!match) return null;
  for (let node = syntaxTree(state).resolveInner(start, 1); node; node = node.parent) {
    if (node.name !== 'FencedCode') continue;
    if (node.from !== start || node.getChildren('CodeMark').length > 1) return null;
    const prefix = markup ? continuationPrefix(state, line, markup) : state.sliceDoc(line.from, start);
    return { mark: match[1], prefix };
  }
  return null;
}

function inFencedCode(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'FencedCode') return true;
  }
  return false;
}

/** 項目や引用の続きの行の行頭：引用の > は残し、リストの記号は同じ幅の空白にする */
function continuationPrefix(state, line, markup) {
  if (!markup.listMark) return state.sliceDoc(line.from, markup.contentStart);
  const contentCol = itemContentStart(state, line, markup) - line.from;
  const head = line.text.slice(0, markup.listMark.from - line.from);
  return head + ' '.repeat(Math.max(contentCol - head.length, 0));
}

/** Shift+Enter：項目や引用の中の改行。次の行を内容の桁まで字下げする（引用の > は残す） */
function insertLineBreakInItem({ state, dispatch }) {
  const pos = singleCursor(state);
  if (pos === null) return false;
  const line = state.doc.lineAt(pos);
  const markup = lineMarkup(state, line);
  if (!markup || (!markup.listMark && markup.quoteEnd === null) || markup.heading || pos < markup.contentStart) return false;
  const indent = continuationPrefix(state, line, markup);
  let from = pos;
  while (from > markup.contentStart && /[ \t]/.test(state.sliceDoc(from - 1, from))) from--;
  const insert = state.lineBreak + indent;
  dispatch(state.update({ changes: { from, to: pos, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: 'input' }));
  return true;
}

/** 選択範囲がかかる行がすべて 1 つの行の中にあるとき、その行 */
function singleLine(state) {
  const { ranges } = state.selection;
  const line = state.doc.lineAt(ranges[0].from);
  return ranges.every((r) => r.from >= line.from && r.to <= line.to) ? line : null;
}

/** Tab：リストの項目の行を字下げする */
function indentItem({ state, dispatch }) {
  if (state.readOnly) return false;
  const line = singleLine(state);
  if (!line) return false;
  const markup = lineMarkup(state, line);
  if (!markup || !markup.listMark || markup.listMark.from < line.from) return false;
  const { item } = markup;
  let prev = item.prevSibling;
  while (prev && prev.name !== 'ListItem') prev = prev.prevSibling;
  // 最初の項目は、入れ子にする親がないので字下げしない
  if (!prev) return true;
  // 字下げの単位が、上の項目の内容の桁に届かないとき（「1. a」の下で単位が 2 桁のときなど）は、
  // 入れ子にならないので内容の桁まで字下げする
  const prevLine = state.doc.lineAt(prev.from);
  const prevMarkup = lineMarkup(state, prevLine);
  const needed = prevMarkup && prevMarkup.listMark
    ? countColumn(prevLine.text, state.tabSize, itemContentStart(state, prevLine, prevMarkup) - prevLine.from) -
      countColumn(line.text, state.tabSize, markup.listMark.from - line.from)
    : 0;
  const unit = getIndentUnit(state);
  const changes = [{ from: line.from, insert: unit >= needed ? indentString(state, unit) : ' '.repeat(needed) }];
  if (item.parent.name === 'OrderedList' && isSequential(state, item.parent)) {
    const prevHasList = prev.getChild('OrderedList') || prev.getChild('BulletList');
    if (!prevHasList) {
      const mark = markup.listMark;
      const digits = /^\d+/.exec(state.sliceDoc(mark.from, mark.to))[0];
      if (digits !== '1') changes.push({ from: mark.from, to: mark.from + digits.length, insert: '1' });
    }
    changes.push(...renumber(state, item.nextSibling, itemNumber(state, item)));
  }
  dispatch(state.update({ changes, userEvent: 'input.indent' }));
  return true;
}

/** 項目の末尾で Delete：次の行も項目なら、その記号を消して内容をつなげる */
function joinNextItem({ state, dispatch }) {
  const pos = singleCursor(state);
  if (pos === null) return false;
  const line = state.doc.lineAt(pos);
  if (pos !== line.to || line.number === state.doc.lines) return false;
  const markup = lineMarkup(state, line);
  if (!markup || !markup.listMark) return false;
  const next = state.doc.line(line.number + 1);
  const nextMarkup = lineMarkup(state, next);
  if (!nextMarkup || !nextMarkup.listMark || nextMarkup.listMark.from < next.from) return false;
  const changes = [{ from: pos, to: nextMarkup.contentStart }];
  const list = nextMarkup.item.parent;
  if (list.name === 'OrderedList' && isSequential(state, list)) changes.push(...renumber(state, nextMarkup.item.nextSibling, itemNumber(state, nextMarkup.item)));
  dispatch(state.update({ changes, userEvent: 'delete.forward' }));
  return true;
}

/**
 * Home の行き先。折り返した 2 つ目以降の見た目の行では、その見た目の行の先頭（すでにそこにいれば行の先頭へ）。
 * 行の先頭では、記号のある行は記号の後ろ（内容の先頭）と行頭を、字下げのある行は字下げの後ろと行頭を行き来する
 * （CodeMirror の Home と同じ。ただし行頭の ** などを幅ごと隠していても、その前を行頭とする）
 */
function homeTarget(view, range) {
  const { state } = view;
  const line = state.doc.lineAt(range.head);
  const rowStart = rowStartOf(view, range.head, range.assoc, line);
  if (rowStart > line.from && range.head !== rowStart) return rowStart;
  const markup = lineMarkup(state, line);
  if (markup) return range.head === markup.contentStart ? line.from : markup.contentStart;
  const space = /^\s*/.exec(line.text)[0].length;
  return space && range.head !== line.from + space ? line.from + space : line.from;
}

/** End の行き先。見た目の行の末尾（すでにそこにいれば行末）。行末の ** やリンクの (URL) を隠していても、その後ろ */
function endTarget(view, range) {
  const line = view.state.doc.lineAt(range.head);
  const rowEnd = rowEndOf(view, range.head, range.assoc, line);
  return rowEnd === range.head ? line.to : rowEnd;
}

const lineBoundary = (forward, extend) => (view) => {
  const { state } = view;
  const selection = EditorSelection.create(state.selection.ranges.map((range) => {
    const target = forward ? endTarget(view, range) : homeTarget(view, range);
    const assoc = forward ? -1 : 1;
    return extend ? EditorSelection.range(range.anchor, target, assoc) : EditorSelection.cursor(target, assoc);
  }), state.selection.mainIndex);
  view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
  return true;
};

/**
 * 記号を隠した行（カーソルのなかった行）をクリックして、カーソルが記号の中か前に置かれたら、内容の先頭に移す。
 * 隠れた記号の位置に入力すると、項目や見出しが壊れるため。記号が出ている行（カーソルのある行）では動かさない
 */
const clickToContent = EditorState.transactionFilter.of((tr) => {
  if (!tr.isUserEvent('select.pointer') || tr.docChanged || !tr.selection) return tr;
  const { ranges } = tr.selection;
  if (ranges.length !== 1 || !ranges[0].empty) return tr;
  const { state } = tr;
  const pos = ranges[0].head;
  const line = state.doc.lineAt(pos);
  const wasActive = tr.startState.selection.ranges.some((r) => state.doc.lineAt(r.head).number === line.number);
  if (wasActive) return tr;
  const target = visibleEdge(state, line, pos);
  return target === pos ? tr : [tr, { selection: { anchor: target }, sequential: true }];
});

/**
 * 記号を隠した行の pos を、見た目で同じ場所にある位置のうち、内容の外側に寄せる。
 * - 行頭の記号（- や > など）の中か前は、内容の先頭へ
 * - 行末で、後ろに隠した閉じの記号（** や ](URL) など）しかないなら、行末へ（End と同じ。打った文字が
 *   太字やリンクの中に入らないように）
 */
export function visibleEdge(state, line, pos) {
  const markup = lineMarkup(state, line);
  const start = markup ? markup.contentStart : line.from;
  if (pos < start) return start;
  if (pos < line.to && onlyMarks(state, pos, line.to, true)) return line.to;
  if (pos > start && onlyMarks(state, start, pos, false)) return start;
  return pos;
}

/** from〜to が、強調やリンクの閉じの記号（closing でなければ開きの記号）だけからなるか */
function onlyMarks(state, from, to, closing) {
  const marks = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(ref) {
      const inner = hiddenElement(ref.node);
      if (inner) marks.push(closing ? { from: inner.to, to: ref.to } : { from: ref.from, to: inner.from });
    },
  });
  marks.sort((a, b) => a.from - b.from);
  let pos = from;
  for (const range of marks) {
    if (range.to <= pos) continue;
    if (range.from > pos) return false;
    pos = range.to;
  }
  return pos >= to;
}

export function blockEditing() {
  return [
    // Markdown の Enter と Backspace（Prec.high）より先に効かせる。main.js で markdownSupport より前に置く
    Prec.high(keymap.of([
      { key: 'Enter', run: insertNewline },
      { key: 'Shift-Enter', run: insertLineBreakInItem },
      { key: 'Tab', run: (view) => indentItem(view) || insertTab(view) },
      { key: 'Backspace', run: (view) => deleteHeadingMark(view) || deleteItemMarkup(view) },
      { key: 'Delete', run: joinNextItem },
      { key: 'Home', run: lineBoundary(false, false), shift: lineBoundary(false, true) },
      { key: 'End', run: lineBoundary(true, false), shift: lineBoundary(true, true) },
      { mac: 'Cmd-ArrowLeft', run: lineBoundary(false, false), shift: lineBoundary(false, true) },
      { mac: 'Cmd-ArrowRight', run: lineBoundary(true, false), shift: lineBoundary(true, true) },
    ])),
    clickToContent,
  ];
}

export const blockCommands = { insertNewline, insertLineBreakInItem, indentItem, insertTab, joinNextItem, deleteHeadingMark, deleteItemMarkup };

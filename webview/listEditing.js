// リスト・タスク・引用・見出しの行での入力の操作。CodeMirror の Markdown のコマンド
// （insertNewlineContinueMarkup）を土台に、多くのエディタ（Typora、Obsidian、Notion など）と同じ動きに直す。
//
// - 空の項目で Enter を押すと、項目の数によらず 1 回でリストを抜ける（入れ子なら 1 段浅くする）。
//   最上位のリストを抜けるときは空行を入れ、次に書く段落が最後の項目の続きにならないようにする
// - 内容の先頭で Enter を押すと、上に空の項目を入れる。元の項目のチェックはそのまま
// - 子を持つ項目の末尾で Enter を押すと、最初の子の位置に項目を作る（親子の関係を変えない）
// - Shift+Enter は、項目の中の改行にする（内容の位置まで字下げする）
// - 最初の項目では Tab で字下げしない（親になる項目がなく、4 桁の字下げはコードブロックになるため）。
//   番号付きの項目を Tab で新しい入れ子にしたときは、番号を 1 にする
// - 項目の末尾で Delete を押すと、次の項目の記号を消して内容だけをつなげる
// - Home は、記号の後ろ（内容の先頭）と行頭を行き来する
// - 記号を隠した行で記号のあたりをクリックしたら、カーソルを内容の先頭に置く

import { EditorSelection, EditorState, Prec, countColumn } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { getIndentUnit, indentString, syntaxTree } from '@codemirror/language';
import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';

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
  const markup = lineMarkup(state, line);
  if (!markup || !markup.listMark || pos < markup.contentStart) return continueMarkup({ state, dispatch });
  const { item } = markup;
  const content = state.sliceDoc(markup.contentStart, line.to);
  const br = state.lineBreak;

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

/** Shift+Enter：項目の中の改行。次の行を内容の桁まで字下げする（引用の > は残す） */
function insertLineBreakInItem({ state, dispatch }) {
  const pos = singleCursor(state);
  if (pos === null) return false;
  const line = state.doc.lineAt(pos);
  const markup = lineMarkup(state, line);
  if (!markup || !markup.listMark || pos < markup.contentStart) return false;
  const contentCol = itemContentStart(state, line, markup) - line.from;
  const head = line.text.slice(0, markup.listMark.from - line.from);
  const indent = head + ' '.repeat(Math.max(contentCol - head.length, 0));
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
 * Home：記号のある行の最初の見た目の行では、内容の先頭と行頭を行き来する。
 * 折り返した 2 つ目以降の見た目の行と、記号のない行は CodeMirror に任せる
 */
function homeTarget(view, range) {
  const { state } = view;
  const line = state.doc.lineAt(range.head);
  const markup = lineMarkup(state, line);
  if (!markup) return null;
  const rowStart = view.moveToLineBoundary(range, false).head;
  if (rowStart > markup.contentStart) return null;
  return range.head === markup.contentStart ? line.from : markup.contentStart;
}

const home = (extend) => (view) => {
  const { state } = view;
  let handled = false;
  const selection = EditorSelection.create(state.selection.ranges.map((range) => {
    const target = homeTarget(view, range);
    if (target === null) return null;
    handled = true;
    return extend ? EditorSelection.range(range.anchor, target) : EditorSelection.cursor(target);
  }).map((r, i) => r || state.selection.ranges[i]), state.selection.mainIndex);
  if (!handled) return false;
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
  const markup = lineMarkup(state, line);
  if (!markup || pos >= markup.contentStart) return tr;
  return [tr, { selection: { anchor: markup.contentStart }, sequential: true }];
});

export function listEditing() {
  return [
    // Markdown の Enter と Backspace（Prec.high）より先に効かせる。main.js で markdownSupport より前に置く
    Prec.high(keymap.of([
      { key: 'Enter', run: insertNewline },
      { key: 'Shift-Enter', run: insertLineBreakInItem },
      { key: 'Tab', run: indentItem },
      { key: 'Delete', run: joinNextItem },
      { key: 'Home', run: home(false), shift: home(true) },
      { mac: 'Cmd-ArrowLeft', run: home(false), shift: home(true) },
    ])),
    clickToContent,
  ];
}

export const listCommands = { insertNewline, insertLineBreakInItem, indentItem, joinNextItem };

// VSCode のエディタの検索ウィジェットに似せた検索・置換パネル。
// 検索の本体（一致の強調、次へ・前へ、置換）は @codemirror/search を使い、見た目と操作だけを作る。

import { EditorSelection } from '@codemirror/state';
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery,
  openSearchPanel, replaceAll, replaceNext, search, setSearchQuery,
} from '@codemirror/search';
import { hasMod, isMac, shortcutLabel } from './platform.js';
import { t } from './strings.js';

/** 件数を数える上限。これを超えたら「1000+」と出す */
const COUNT_LIMIT = 1000;
/** 検索語と置換の文字列の履歴の上限（↑ / ↓ で呼び出す。VSCode と同じく、開いている間だけ覚える） */
const HISTORY_LIMIT = 50;
const findHistory = [];
const replaceHistory = [];

/**
 * 置換の文字列の大文字と小文字を、一致した文字列に合わせる（VSCode の「大文字と小文字を保持する」）。
 * すべて大文字ならすべて大文字に、すべて小文字ならすべて小文字に、先頭だけ大文字なら先頭だけ大文字にする
 */
export function preserveCase(matched, replacement) {
  if (!replacement) return replacement;
  // 大文字と小文字のある文字だけで決める（かなや漢字は数えない）
  const letters = matched.replace(/[^\p{Lu}\p{Ll}\p{Lt}]/gu, '');
  if (!letters) return replacement;
  if (letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return replacement.toUpperCase();
  if (letters === letters.toLowerCase()) return replacement.toLowerCase();
  const first = letters[0];
  const rest = letters.slice(1);
  if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement;
}

/** 正規表現の置換の文字列（$1、$&、$$）を、一致に当てはめる */
function expandReplacement(replace, match) {
  return replace.replace(/\$([$&]|\d{1,2})/g, (all, ref) => {
    if (ref === '$') return '$';
    if (ref === '&') return match[0];
    return match[Number(ref)] ?? all;
  });
}

/** 履歴を ↑ / ↓ でたどる */
function stepHistory(history, input, direction) {
  if (history.length === 0) return;
  let index = history.lastIndexOf(input.value);
  if (index < 0) index = history.length;
  const next = Math.min(Math.max(index + direction, 0), history.length - 1);
  if (next === index) return;
  input.value = history[next];
  input.dispatchEvent(new Event('input'));
}

function remember(history, value) {
  if (!value) return;
  const at = history.indexOf(value);
  if (at >= 0) history.splice(at, 1);
  history.push(value);
  if (history.length > HISTORY_LIMIT) history.shift();
}

/** 選択範囲内の検索の印（VSCode の codicon の selection と同じ形） */
function selectionIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'cm-md-find-icon');
  for (const d of ['M2 3h12', 'M2 6.5h12', 'M2 10h8', 'M2 13.5h5']) {
    const path = svg.appendChild(document.createElementNS(ns, 'path'));
    path.setAttribute('d', d);
  }
  return svg;
}

export function findWidget() {
  return search({ top: true, createPanel: (view) => new FindPanel(view) });
}

/** Ctrl+F：検索を開く。選択中の文字列（1 行以内）があれば検索語にする */
export function openFind(view) {
  openSearchPanel(view);
  const panel = findPanelOf(view);
  if (panel) panel.focusFind();
  return true;
}

/** Ctrl+H（macOS では Cmd+Option+F）：置換の欄も出して開く */
export function openReplace(view) {
  openSearchPanel(view);
  const panel = findPanelOf(view);
  if (panel) {
    panel.setReplaceVisible(true);
    panel.focusReplace();
  }
  return true;
}

/**
 * 表のセルのエディタから検索を開く。本文のエディタの選択ではなく、セルで選んでいる文字列を検索語にする
 * （openSearchPanel は本文のエディタの選択から検索語を決めるので、開いた後に置き換える）
 */
export function openFindWith(view, text, replace) {
  (replace ? openReplace : openFind)(view);
  if (text) view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...getSearchQuery(view.state), search: text })) });
  const panel = findPanelOf(view);
  if (panel) {
    if (replace) panel.focusReplace();
    else panel.focusFind();
  }
  return true;
}

/** 開いているパネル。@codemirror/search は作ったパネルを外に出さないので、ここで覚えておく */
const panels = new WeakMap();

function findPanelOf(view) {
  const panel = panels.get(view);
  if (!panel) return null;
  // 開き直すたびに、その時点のカーソル位置から探す。選択範囲は、選択範囲内の検索に使うので覚えておく
  // （検索語を打つと、エディタの選択は一致に移るため）
  panel.searchStart = view.state.selection.main.from;
  panel.openRanges = view.state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
  return panel;
}

/** 検索の条件の切り替えのキー。VSCode と同じく、Windows・Linux では Alt+C など、macOS では Cmd+Option+C など */
function toggleLabel(key) {
  return shortcutLabel(isMac ? `Mod+Alt+${key}` : `Alt+${key}`);
}

class FindPanel {
  constructor(view) {
    panels.set(view, this);
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.searchStart = view.state.selection.main.from;
    this.openRanges = view.state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
    this.replaceVisible = false;

    const el = (tag, className, props = {}) => Object.assign(document.createElement(tag), { className }, props);
    this.dom = el('div', 'cm-md-find');
    this.dom.setAttribute('role', 'dialog');
    this.dom.setAttribute('aria-label', t('Find'));

    this.expander = el('button', 'cm-md-find-expand', { type: 'button', title: `${t('Toggle Replace')} (${shortcutLabel(isMac ? 'Mod+Alt+F' : 'Mod+H')})`, textContent: '›' });
    this.expander.addEventListener('click', () => this.setReplaceVisible(!this.replaceVisible));

    const rows = el('div', 'cm-md-find-rows');

    // 1 行目: 検索語、切り替え、件数、前へ・次へ・閉じる
    const findRow = el('div', 'cm-md-find-row');
    const findBox = el('div', 'cm-md-find-box');
    this.findInput = el('input', 'cm-md-find-input', { type: 'text', placeholder: t('Find'), spellcheck: false });
    this.findInput.setAttribute('main-field', 'true');
    this.findInput.setAttribute('aria-label', t('Find'));
    this.caseToggle = this.toggle('Aa', `${t('Match Case')} (${toggleLabel('C')})`, 'caseSensitive');
    this.wordToggle = this.toggle('ab', `${t('Match Whole Word')} (${toggleLabel('W')})`, 'wholeWord');
    this.regexToggle = this.toggle('.*', `${t('Use Regular Expression')} (${toggleLabel('R')})`, 'regexp');
    findBox.append(this.findInput, this.caseToggle, this.wordToggle, this.regexToggle);
    // 選択範囲内の検索。オンにしたときの選択範囲の中だけを探す
    this.scope = null;
    this.scopeToggle = this.toggle('', `${t('Find in Selection')} (${toggleLabel('L')})`, null);
    this.scopeToggle.append(selectionIcon());
    this.scopeToggle.addEventListener('click', () => this.flipScope());
    this.count = el('span', 'cm-md-find-count');
    const prev = this.button('↑', `${t('Previous Match')} (${shortcutLabel('Shift+Enter')})`, () => this.move(-1));
    const next = this.button('↓', `${t('Next Match')} (${shortcutLabel('Enter')})`, () => this.move(1));
    const close = this.button('×', `${t('Close')} (Esc)`, () => this.close());
    findRow.append(findBox, this.count, prev, next, this.scopeToggle, close);

    // 2 行目: 置換
    this.replaceRow = el('div', 'cm-md-find-row cm-md-find-replace-row');
    const replaceBox = el('div', 'cm-md-find-box');
    this.replaceInput = el('input', 'cm-md-find-input', { type: 'text', placeholder: t('Replace'), spellcheck: false });
    this.replaceInput.setAttribute('aria-label', t('Replace'));
    this.preserveCaseOn = false;
    this.preserveToggle = this.toggle('AB', `${t('Preserve Case')} (${toggleLabel('P')})`, null);
    this.preserveToggle.addEventListener('click', () => this.flipPreserveCase());
    replaceBox.append(this.replaceInput, this.preserveToggle);
    const replaceOne = this.button(t('Replace'), `${t('Replace')} (Enter)`, () => this.replace(false));
    const replaceEvery = this.button(t('All'), `${t('Replace All')} (${shortcutLabel('Mod+Alt+Enter')})`, () => this.replace(true));
    this.replaceRow.append(replaceBox, replaceOne, replaceEvery);

    rows.append(findRow, this.replaceRow);
    this.dom.append(this.expander, rows);

    this.findInput.addEventListener('input', () => this.onFindInput());
    this.replaceInput.addEventListener('input', () => this.commit());
    this.dom.addEventListener('keydown', (event) => this.onKeyDown(event));

    this.fillFromQuery(this.query);
    this.setReplaceVisible(false);
  }

  get top() { return true; }

  mount() {
    this.focusFind();
    this.updateCount();
  }

  destroy() {
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  update(update) {
    // 選択範囲内の検索の範囲と、開いたときの選択範囲は、文書の変更に合わせて写す
    if (update.docChanged) {
      const map = (ranges) => ranges && ranges.map((r) => ({ from: update.changes.mapPos(r.from, 1), to: update.changes.mapPos(r.to, -1) }));
      this.scope = map(this.scope);
      this.openRanges = map(this.openRanges);
    }
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.fillFromQuery(this.query);
        }
      }
    }
    if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.length)) {
      this.updateCount();
    }
  }

  // ------------------------------------------------------------ 部品

  toggle(label, title, key) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-md-find-toggle';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('mousedown', (event) => event.preventDefault());
    if (key) b.addEventListener('click', () => this.flip(key));
    return b;
  }

  button(label, title, action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-md-find-button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('mousedown', (event) => event.preventDefault());
    b.addEventListener('click', action);
    return b;
  }

  // ------------------------------------------------------------ 状態

  fillFromQuery(query) {
    if (this.findInput.value !== query.search) this.findInput.value = query.search;
    if (this.replaceInput.value !== query.replace) this.replaceInput.value = query.replace;
    this.caseToggle.setAttribute('aria-pressed', String(query.caseSensitive));
    this.wordToggle.setAttribute('aria-pressed', String(query.wholeWord));
    this.regexToggle.setAttribute('aria-pressed', String(query.regexp));
  }

  readQuery(overrides = {}) {
    return new SearchQuery({
      search: this.findInput.value,
      replace: this.replaceInput.value,
      caseSensitive: this.caseToggle.getAttribute('aria-pressed') === 'true',
      wholeWord: this.wordToggle.getAttribute('aria-pressed') === 'true',
      regexp: this.regexToggle.getAttribute('aria-pressed') === 'true',
      // 選択範囲内の検索がオンなら、その範囲の中の一致だけにする
      test: this.scope ? this.scopeTest : undefined,
      ...overrides,
    });
  }

  /** 選択範囲内の検索を切り替える。オンにしたときの選択範囲（空なら、カーソルのある行）を覚える */
  flipScope() {
    const { state } = this.view;
    if (this.scope) {
      this.scope = null;
    } else {
      // 検索を開いたときの選択範囲。なければ今の選択範囲、それもなければカーソルのある行
      const current = state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
      const opened = this.openRanges && this.openRanges.length ? this.openRanges : current;
      const head = state.doc.lineAt(state.selection.main.head);
      this.scope = opened.length ? opened : [{ from: head.from, to: head.to }];
    }
    this.scopeTest ??= (_match, _state, from, to) => !!this.scope && this.scope.some((r) => from >= r.from && to <= r.to);
    this.scopeToggle.setAttribute('aria-pressed', String(!!this.scope));
    this.commit({ test: this.scope ? this.scopeTest : undefined });
    this.updateCount();
  }

  flipPreserveCase() {
    this.preserveCaseOn = !this.preserveCaseOn;
    this.preserveToggle.setAttribute('aria-pressed', String(this.preserveCaseOn));
  }

  commit(overrides) {
    const query = this.readQuery(overrides);
    if (query.eq(this.query)) return false;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    return true;
  }

  flip(key) {
    this.commit({ [key]: !this.query[key] });
    this.fillFromQuery(this.query);
    this.revealFrom(this.searchStart);
  }

  setReplaceVisible(visible) {
    this.replaceVisible = visible;
    this.replaceRow.hidden = !visible;
    this.expander.textContent = visible ? '⌄' : '›';
    this.expander.setAttribute('aria-expanded', String(visible));
  }

  focusFind() {
    this.findInput.focus();
    this.findInput.select();
  }

  focusReplace() {
    this.replaceInput.focus();
    this.replaceInput.select();
  }

  // ------------------------------------------------------------ 操作

  /** 打つたびに、検索を始めた位置から最初の一致へ移る（VSCode と同じ） */
  onFindInput() {
    this.commit();
    this.revealFrom(this.searchStart);
  }

  revealFrom(pos) {
    const match = this.matchFrom(pos);
    if (!match) {
      this.updateCount();
      return;
    }
    this.view.dispatch({
      selection: EditorSelection.single(match.from, match.to),
      scrollIntoView: true,
      userEvent: 'select.search',
    });
  }

  matchFrom(pos) {
    if (!this.query.valid || !this.query.search) return null;
    const after = this.query.getCursor(this.view.state, pos).next();
    if (!after.done) return after.value;
    const wrapped = this.query.getCursor(this.view.state, 0).next();
    return wrapped.done ? null : wrapped.value;
  }

  move(direction) {
    if (!this.query.valid || !this.query.search) return;
    remember(findHistory, this.query.search);
    (direction > 0 ? findNext : findPrevious)(this.view);
    this.searchStart = this.view.state.selection.main.from;
  }

  replace(all) {
    this.commit();
    remember(findHistory, this.query.search);
    remember(replaceHistory, this.query.replace);
    if (!this.preserveCaseOn) {
      (all ? replaceAll : replaceNext)(this.view);
      return;
    }
    // 大文字と小文字を保つときは、一致ごとに置換の文字列を合わせて当てる
    const { state } = this.view;
    if (!this.query.valid || !this.query.search || state.readOnly) return;
    const changesFor = (match) => {
      const text = this.query.regexp ? expandReplacement(this.query.replace, match.match) : this.query.replace;
      return { from: match.from, to: match.to, insert: preserveCase(state.sliceDoc(match.from, match.to), text) };
    };
    if (all) {
      const changes = [];
      const cursor = this.query.getCursor(state);
      for (let r = cursor.next(); !r.done; r = cursor.next()) changes.push(changesFor(r.value));
      if (changes.length) this.view.dispatch({ changes, userEvent: 'input.replace.all' });
      return;
    }
    const sel = state.selection.main;
    const current = this.query.getCursor(state, sel.from).next();
    if (!current.done && current.value.from === sel.from && current.value.to === sel.to) {
      const change = changesFor(current.value);
      this.view.dispatch({ changes: change, selection: EditorSelection.cursor(change.from + change.insert.length), userEvent: 'input.replace' });
    }
    findNext(this.view);
  }

  /** すべての一致を選択し、エディタに戻る（Alt+Enter。VSCode の「一致するすべての出現箇所を選択」） */
  selectAll() {
    if (!this.query.valid || !this.query.search) return;
    remember(findHistory, this.query.search);
    const ranges = [];
    const cursor = this.query.getCursor(this.view.state);
    for (let r = cursor.next(); !r.done; r = cursor.next()) ranges.push(EditorSelection.range(r.value.from, r.value.to));
    if (ranges.length === 0) return;
    this.view.dispatch({ selection: EditorSelection.create(ranges), scrollIntoView: true, userEvent: 'select.search' });
    this.view.focus();
  }

  close() {
    remember(findHistory, this.query.search);
    closeSearchPanel(this.view);
    this.view.focus();
  }

  updateCount() {
    const { state } = this.view;
    const query = this.query;
    this.findInput.classList.toggle('cm-md-find-invalid', !!query.search && !query.valid);
    if (!query.search) {
      this.count.textContent = '';
      return;
    }
    if (!query.valid) {
      this.count.textContent = t('Invalid regular expression');
      return;
    }
    const sel = state.selection.main;
    let total = 0;
    let current = 0;
    const cursor = query.getCursor(state);
    for (let r = cursor.next(); !r.done && total <= COUNT_LIMIT; r = cursor.next()) {
      total++;
      if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    }
    if (total === 0) this.count.textContent = t('No results');
    else if (total > COUNT_LIMIT) this.count.textContent = `? / ${COUNT_LIMIT}+`;
    else this.count.textContent = `${current || '?'} / ${total}`;
    this.dom.classList.toggle('cm-md-find-none', total === 0);
  }

  onKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    const mod = hasMod(event);
    const key = event.key.toLowerCase();
    // Option を押すと、macOS では別の文字になる（Option+C は ç）。Option を使うキーは、文字ではなくキーの位置で見る
    const code = event.code;
    const toggleKeys = isMac ? event.altKey && event.metaKey && !event.ctrlKey : event.altKey && !event.ctrlKey && !event.metaKey;
    const replaceKeys = isMac ? mod && event.altKey && code === 'KeyF' : mod && !event.shiftKey && key === 'h';
    let handled = true;

    if (key === 'escape') this.close();
    // 検索語の履歴（入力欄の ↑ / ↓）
    else if ((key === 'arrowup' || key === 'arrowdown') && !mod && !event.altKey && (event.target === this.findInput || event.target === this.replaceInput)) {
      const history = event.target === this.findInput ? findHistory : replaceHistory;
      stepHistory(history, event.target, key === 'arrowup' ? -1 : 1);
    }
    else if (key === 'enter' && event.target === this.findInput && event.altKey && !mod && !event.shiftKey) this.selectAll();
    else if (key === 'enter' && event.target === this.replaceInput && !event.shiftKey) this.replace(mod && event.altKey);
    else if (key === 'enter') this.move(event.shiftKey ? -1 : 1);
    // 次・前の一致。macOS の VSCode では Cmd+G / Cmd+Shift+G も使う
    else if (key === 'f3' || (isMac && mod && !event.altKey && key === 'g')) this.move(event.shiftKey ? -1 : 1);
    else if (toggleKeys && code === 'KeyC') this.flip('caseSensitive');
    else if (toggleKeys && code === 'KeyW') this.flip('wholeWord');
    else if (toggleKeys && code === 'KeyR') this.flip('regexp');
    else if (toggleKeys && code === 'KeyL') this.flipScope();
    else if (toggleKeys && code === 'KeyP') this.flipPreserveCase();
    else if (replaceKeys) {
      this.setReplaceVisible(true);
      this.focusReplace();
    } else if (mod && !event.shiftKey && !event.altKey && key === 'f') this.focusFind();
    else if (mod && (key === 'z' || key === 'y')) {
      // 入力欄の中の取り消しは入力欄に任せる（VSCode 側の取り消しに渡さない）
      event.stopPropagation();
      return;
    } else handled = false;

    if (handled) {
      event.preventDefault();
      // VSCode の Webview は Ctrl+F などを横取りするので、ここで止める
      event.stopPropagation();
    }
  }
}

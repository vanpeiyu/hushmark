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
  // 開き直すたびに、その時点のカーソル位置から探す
  panel.searchStart = view.state.selection.main.from;
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
    this.count = el('span', 'cm-md-find-count');
    const prev = this.button('↑', `${t('Previous Match')} (${shortcutLabel('Shift+Enter')})`, () => this.move(-1));
    const next = this.button('↓', `${t('Next Match')} (${shortcutLabel('Enter')})`, () => this.move(1));
    const close = this.button('×', `${t('Close')} (Esc)`, () => this.close());
    findRow.append(findBox, this.count, prev, next, close);

    // 2 行目: 置換
    this.replaceRow = el('div', 'cm-md-find-row cm-md-find-replace-row');
    const replaceBox = el('div', 'cm-md-find-box');
    this.replaceInput = el('input', 'cm-md-find-input', { type: 'text', placeholder: t('Replace'), spellcheck: false });
    this.replaceInput.setAttribute('aria-label', t('Replace'));
    replaceBox.append(this.replaceInput);
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
    b.addEventListener('click', () => this.flip(key));
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
      ...overrides,
    });
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
    (direction > 0 ? findNext : findPrevious)(this.view);
    this.searchStart = this.view.state.selection.main.from;
  }

  replace(all) {
    this.commit();
    (all ? replaceAll : replaceNext)(this.view);
  }

  close() {
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
    else if (key === 'enter' && event.target === this.replaceInput && !event.shiftKey) this.replace(mod && event.altKey);
    else if (key === 'enter') this.move(event.shiftKey ? -1 : 1);
    // 次・前の一致。macOS の VSCode では Cmd+G / Cmd+Shift+G も使う
    else if (key === 'f3' || (isMac && mod && !event.altKey && key === 'g')) this.move(event.shiftKey ? -1 : 1);
    else if (toggleKeys && code === 'KeyC') this.flip('caseSensitive');
    else if (toggleKeys && code === 'KeyW') this.flip('wholeWord');
    else if (toggleKeys && code === 'KeyR') this.flip('regexp');
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

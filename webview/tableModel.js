// GFM の表の行をセルに分割する。DOM に依存しないのでテストから直接呼べる。
// Lezer の構文木は空のセルにノードを作らないため、列がずれないよう自前で分割する。

import { displayWidth } from './textWidth.js';

/**
 * 表の 1 行をセルに分割する。
 * @param {string} text 行のテキスト（行頭の引用記号などは含めない）
 * @param {number} base text の先頭の文書内オフセット
 * @returns {{text: string, from: number, to: number}[]}
 *   from/to は前後の空白を除いたセル内容の範囲。空のセルでは from === to。
 */
export function splitRow(text, base = 0) {
  const segments = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '|') {
      segments.push([start, i]);
      start = i + 1;
    }
  }
  segments.push([start, text.length]);

  // 行頭・行末のパイプの外側は空白だけのセグメントになるので除く
  const blank = ([s, e]) => text.slice(s, e).trim() === '';
  if (segments.length > 1 && blank(segments[0])) segments.shift();
  if (segments.length > 1 && blank(segments[segments.length - 1])) segments.pop();

  return segments.map(([s, e]) => {
    const raw = text.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    if (lead === raw.length) {
      // 空のセル。カーソルはパイプの直後の空白 1 つ分だけ進めた位置に置く
      const pos = base + Math.min(s + 1, e);
      return { text: '', from: pos, to: pos };
    }
    return { text: raw.trim(), from: base + s + lead, to: base + e - trail };
  });
}

/**
 * 区切り行（|:--|--:|）から列ごとの揃え位置を得る。
 * @returns {('left'|'center'|'right'|null)[]}
 */
export function parseAlignments(text) {
  return splitRow(text).map(({ text: cell }) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/**
 * 表のソース行から描画用のモデルを作る。
 * @param {{text: string, from: number}[]} lines 表の各行（2 行目が区切り行）
 * @returns {{aligns: (string|null)[], rows: {text: string, from: number, to: number, missing?: boolean, pipeAtEnd?: boolean}[][]}}
 *   rows[0] が見出し行。各行は見出しの列数に揃える（GFM の仕様どおり、余りは捨て、足りない分は空にする）。
 *   足りない分のセルには missing: true を付ける。
 */
export function buildTableModel(lines) {
  const header = splitRow(lines[0].text, lines[0].from);
  const width = header.length;
  const aligns = parseAlignments(lines[1] ? lines[1].text : '');
  const rows = [header];
  for (const line of lines.slice(2)) {
    const cells = splitRow(line.text, line.from).slice(0, width);
    const end = line.from + line.text.length;
    // ソースに無いセル。書き込むときは行末に「 内容 |」を足す（行末にパイプが無ければ「 | 内容 |」）
    const pipeAtEnd = /(^|[^\\])\|\s*$/.test(line.text);
    while (cells.length < width) cells.push({ text: '', from: end, to: end, missing: true, pipeAtEnd });
    rows.push(cells);
  }
  return { aligns: aligns.slice(0, width), rows };
}

/** この幅以下のセルしかない列は折り返さない */
const NOWRAP_WIDTH = 16;

/**
 * 折り返さない列。日本語はどの文字の間でも折り返せるので、長いセルのある表では
 * 「りんご」のような短いセルまで折り返されてしまう。短いセルしかない列はその幅を保つ。
 * @returns {boolean[]} 列ごとに、折り返さないなら true
 */
export function nowrapColumns(model) {
  return model.rows[0].map((_, col) =>
    model.rows.every((cells) => !cells[col] || displayWidth(cells[col].text) <= NOWRAP_WIDTH));
}

/**
 * セルのエディタの中身を、表のソースに書き込む変更にする。位置は表の先頭からのオフセット。
 * - 中身の前後の空白は書き込まない。セルの範囲（from と to）は前後の空白を除いたものなので、書き込むと
 *   前の入力で足した空白がセルの外に残り、入力のたびに空白が増えてしまうため。
 * - ソースで省略されているセル（行末に | が足りない）に書くときは、手前の省略されたセルも空のセルとして補う。
 * - 中身が \ で終わり、すぐ後ろが | のときは空白を 1 つ挟む。\| になってセルの区切りが消えないようにする。
 * @param text | をエスケープ済みのセルの中身
 * @param charAfter 今のセルの範囲のすぐ後ろの 1 文字
 * @returns {{from: number, to: number, insert: string} | null} 書き込むものが無いときは null
 */
export function cellChange(model, row, col, text, charAfter) {
  const cells = model.rows[row];
  const cell = cells[col];
  let content = text.trim();
  if (cell.missing) {
    if (content === '') return null;
    const firstMissing = cells.findIndex((c) => c.missing);
    const fill = '  |'.repeat(col - firstMissing);
    return { from: cell.to, to: cell.to, insert: `${cell.pipeAtEnd ? '' : ' |'}${fill} ${content} |` };
  }
  if (charAfter === '|' && /(^|[^\\])(\\\\)*\\$/.test(content)) content += ' ';
  return { from: cell.from, to: cell.to, insert: content };
}

/**
 * セルに書き込む文字列の | をエスケープする。すでに \ が付いているものはそのまま。
 * @returns {string}
 */
export function escapePipes(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      out += ch + (text[i + 1] ?? '');
      i++;
    } else {
      out += ch === '|' ? '\\|' : ch;
    }
  }
  return out;
}

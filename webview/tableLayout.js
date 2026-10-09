// 表の列の幅の配分。DOM に依存しないのでテストから直接呼べる。
//
// セルの中身は、折り返せない単位（segment）の並びとして受け取る。単位の幅は、ブラウザーで実際に描いて測ったもの
// （tableCells.js）。折り返しは、ブラウザーと同じく、行に収まるだけ単位を詰める。1 つの単位が列より広いときは、
// 文字の間で折る（overflow-wrap: break-word）。
//
// 列の幅は、桁（unit、半角 1 文字の幅）の整数倍で決める。収まらない表では、次の費用が最小の配分を選ぶ。
// - 表の高さ（行ごとの、最も行数の多いセルの行数の合計）
// - 短いセル（SHORT_COLUMNS 桁以下）を折り返すごとに 1。短いセルが細切れになるのは、高さが 1 行増えるのと同じくらい読みにくい
// - セルの 3 行目以降、1 行ごとに 0.5
// - 見出しの行が 2 行以上になると 1
// 費用が同じなら、各列を「どのセルの行数も変わらない最小の幅」まで縮めたときの合計が小さい配分を選ぶ。
// 余った幅は、折り返している列に、まだ必要な幅の比で配る。配っても折り返す位置が変わらない列には配らない。
// 縮めた幅が同じ列（[対応中] のようなラベルだけの列など）には、同じだけ配って幅をそろえる。

/** 折り返すと読みにくい短いセルの幅（桁） */
export const SHORT_COLUMNS = 24;
/** 費用の重み */
const SHORT_WRAP = 1;
const EXTRA_LINE = 0.5;
const HEAD_WRAP = 1;
/** 全通りを調べる配分の数の上限。超えたら、近い配分を順に試して改善していく */
const SEARCH_BUDGET = 20000;

const EPSILON = 0.01;

/**
 * @typedef {{ w: number, space: number, graphemes: number[] }} Segment
 *   w は単位の幅（後ろの空白を除く）、space は後ろの空白の幅、graphemes は 1 文字ずつの幅（px）
 */

/**
 * 幅 width で折り返したときの行数と、折り返す位置
 * @param {Segment[]} segments
 * @returns {{ lines: number, breaks: string }}
 */
export function wrapSegments(segments, width) {
  let lines = 1;
  let cur = 0;
  let pending = 0;
  const breaks = [];
  segments.forEach((seg, i) => {
    if (cur > 0 && cur + pending + seg.w > width + EPSILON) {
      lines++;
      breaks.push(i);
      cur = 0;
    } else if (cur > 0) {
      cur += pending;
    }
    if (cur === 0 && seg.w > width + EPSILON) {
      seg.graphemes.forEach((g, j) => {
        if (cur > 0 && cur + g > width + EPSILON) {
          lines++;
          breaks.push(`${i}.${j}`);
          cur = 0;
        }
        cur += g;
      });
    } else {
      cur += seg.w;
    }
    pending = seg.space;
  });
  return { lines, breaks: breaks.join(',') };
}

/** 中身の幅（折り返さないときの幅） */
export function naturalWidth(segments) {
  let width = 0;
  segments.forEach((seg, i) => { width += seg.w + (i < segments.length - 1 ? seg.space : 0); });
  return width;
}

/**
 * 列の幅を決める。
 * @param {{ segments: Segment[] }[][]} rows 行ごとのセル。rows[0] は見出しの行。列の数は rows[0] の長さ
 * @param {number} available 列の中身に使える幅（px）。| やセルの前後の空白の幅は除いたもの
 * @param {number} unit 1 桁の幅（px）
 * @returns {number[]} 列ごとの中身の幅（px）
 */
export function layoutColumns(rows, available, unit) {
  const n = rows[0].length;
  const cellsOf = (col) => rows.map((row) => (row[col] ? row[col].segments : []));
  const natural = [];
  for (let col = 0; col < n; col++) natural.push(Math.max(0, ...cellsOf(col).map(naturalWidth)));
  // 収まるなら、どの列も折り返さない
  if (natural.reduce((s, w) => s + w, 0) <= available + EPSILON) return natural.map((w) => Math.ceil(w));

  const units = Math.floor(available / unit);
  const maxUnits = natural.map((w) => Math.max(1, Math.ceil(w / unit - EPSILON)));
  const short = rows.map((row) => row.map((cell) => naturalWidth(cell ? cell.segments : []) <= SHORT_COLUMNS * unit + EPSILON));

  // 列 col を k 桁にしたときの、行ごとのセルの行数（覚えておく）
  const memo = new Map();
  const linesAt = (col, k) => {
    const key = col * 100000 + k;
    let v = memo.get(key);
    if (!v) {
      v = cellsOf(col).map((segs) => wrapSegments(segs, k * unit).lines);
      memo.set(key, v);
    }
    return v;
  };

  const cost = (widths) => {
    let total = 0;
    rows.forEach((_, r) => {
      let height = 1;
      for (let col = 0; col < n; col++) {
        const lines = linesAt(col, widths[col])[r];
        height = Math.max(height, lines);
        if (lines > 1 && short[r][col]) total += SHORT_WRAP;
        if (lines >= 3) total += EXTRA_LINE * (lines - 2);
      }
      total += height + (r === 0 && height > 1 ? HEAD_WRAP : 0);
    });
    return total;
  };

  /** 各列を、どのセルの行数も変わらない最小の幅まで縮めた幅 */
  const tighten = (widths) => widths.map((k, col) => {
    const base = linesAt(col, k);
    let t = k;
    while (t > 1 && linesAt(col, t - 1).every((l, r) => l === base[r])) t--;
    return t;
  });

  // 候補の幅は、どれかのセルの行数が変わる幅だけ（その間の幅は、行数が同じで狭い方が無駄がない）
  const candidates = maxUnits.map((max, col) => {
    const list = [];
    for (let k = 1; k <= max; k++) {
      if (k === 1 || linesAt(col, k).some((l, r) => l !== linesAt(col, k - 1)[r])) list.push(k);
    }
    return list;
  });

  let best = null;
  const consider = (widths) => {
    const c = cost(widths);
    // 縮めた幅は、費用が最良以下のときだけ求める（費用より重い）
    if (best && c > best.cost + EPSILON) return;
    const tight = tighten(widths);
    const sum = tight.reduce((s, k) => s + k, 0);
    if (!best || c < best.cost - EPSILON || sum < best.sum) best = { cost: c, tight, sum };
  };

  const search = (col, acc, used) => {
    if (col === n) {
      consider(acc);
      return;
    }
    // 残りの列に最低 1 桁ずつ残す
    const rest = n - col - 1;
    for (const k of candidates[col]) {
      if (used + k + rest > units) break;
      acc.push(k);
      search(col + 1, acc, used + k);
      acc.pop();
    }
  };
  if (countLayouts(candidates, units, SEARCH_BUDGET) <= SEARCH_BUDGET) search(0, [], 0);
  if (!best) localSearch();

  /** 列が多くて全通りを調べきれないときは、比例配分から始めて、幅を列の間で移して費用を下げていく */
  function localSearch() {
    best = null;
    let widths = proportional(maxUnits, units);
    consider(widths);
    for (let round = 0; round < 200; round++) {
      let improved = null;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          for (const step of [1, 2, 3, 5, 8, 13]) {
            if (widths[j] - step < 1 || widths[i] + step > maxUnits[i]) break;
            const next = widths.slice();
            next[i] += step;
            next[j] -= step;
            const c = cost(next);
            if (c < (improved ? improved.cost : best.cost) - EPSILON) improved = { cost: c, widths: next };
          }
        }
      }
      if (!improved) break;
      widths = improved.widths;
      consider(widths);
    }
  }

  const widths = distributeSlack(best.tight, units, maxUnits, (col, k) => cellsOf(col).map((segs) => wrapSegments(segs, k * unit)));
  return widths.map((k, col) => Math.min(k * unit, Math.ceil(natural[col])));
}

/** 合計が units 以下になる幅の組み合わせの数。limit を超えたら数えるのをやめて limit + 1 を返す */
function countLayouts(candidates, units, limit) {
  // ways[u] = それまでの列で、合計 u 桁になる組み合わせの数
  let ways = new Array(units + 1).fill(0);
  ways[0] = 1;
  for (const list of candidates) {
    const next = new Array(units + 1).fill(0);
    for (let u = 0; u <= units; u++) {
      if (!ways[u]) continue;
      for (const k of list) {
        if (u + k > units) break;
        next[u + k] = Math.min(limit + 1, next[u + k] + ways[u]);
      }
    }
    ways = next;
  }
  return Math.min(limit + 1, ways.reduce((s, w) => s + w, 0));
}

/** 最大の幅に比例させた配分（桁）。合計は units 以下 */
function proportional(maxUnits, units) {
  const total = maxUnits.reduce((s, k) => s + k, 0);
  const widths = maxUnits.map((k) => Math.max(1, Math.floor((k * units) / total)));
  return widths;
}

/**
 * 余った幅を、折り返している列に、まだ必要な幅の比で配る。配っても折り返す位置が変わらない列には配らない。
 * 縮めた幅が同じ列には、同じだけ配る
 */
function distributeSlack(tight, units, maxUnits, wrapAt) {
  const widths = tight.slice();
  let slack = units - widths.reduce((s, k) => s + k, 0);
  if (slack <= 0) return widths;
  const signature = (col, k) => wrapAt(col, k).map((w) => w.breaks).join('|');
  const need = widths.map((k, col) => {
    const wraps = wrapAt(col, k).some((w) => w.lines > 1);
    if (!wraps) return 0;
    const reach = Math.min(maxUnits[col], k + slack);
    return signature(col, reach) !== signature(col, k) ? maxUnits[col] - k : 0;
  });
  const totalNeed = need.reduce((s, d) => s + d, 0);
  if (totalNeed === 0) return widths;
  const add = need.map((d) => Math.floor((slack * d) / totalNeed));
  // 縮めた幅が同じ列には、少ない方に合わせて同じだけ配る
  for (let i = 0; i < widths.length; i++) {
    for (let j = i + 1; j < widths.length; j++) {
      if (need[i] > 0 && need[j] > 0 && widths[i] === widths[j]) add[i] = add[j] = Math.min(add[i], add[j]);
    }
  }
  add.forEach((a, col) => { widths[col] += a; });
  slack -= add.reduce((s, a) => s + a, 0);
  // 端数は、まだ必要な幅が最も大きい列に足す。幅をそろえた列には足さない（そろわなくなるため）
  const paired = widths.map((k, col) => need[col] > 0 && widths.some((m, other) => other !== col && need[other] > 0 && m === k));
  let target = -1;
  need.forEach((d, col) => { if (d > 0 && !paired[col] && (target < 0 || d > need[target])) target = col; });
  if (target >= 0) widths[target] += slack;
  return widths.map((k, col) => Math.min(k, maxUnits[col]));
}

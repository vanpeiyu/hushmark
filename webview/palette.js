// 配色の生成。元の色（seed）から、明るい地・暗い地それぞれの色を作る。DOM に依存しないのでテストから直接呼べる。
//
// 色は OKLCH（人の目の感じ方に合わせた明るさ L・鮮やかさ C・色相 h）で扱う。元の色からは色相と鮮やかさだけを取り、
// 明るさは用途ごとにここで決める。どの色を指定されても、地と文字の明るさの差は一定に保たれる。
// さらに、文字に使う色は、地の色との WCAG のコントラスト比が 4.5 以上になるまで明るさを調整する。

/** プレビューの色（hushmark.previewColor）ごとの元の色。mono は無彩色の地に、既定のアクセント（青）を使う */
export const COLOR_SEEDS = {
  green: '#16a34a',
  cyan: '#0891b2',
  blue: '#2563eb',
  purple: '#8b5cf6',
  pink: '#db2777',
  orange: '#ea580c',
  sepia: '#8b5a2b',
};
const DEFAULT_ACCENT = '#0969da';

/** 文字に求めるコントラスト比（WCAG 2 の AA） */
export const MIN_CONTRAST = 4.5;

/**
 * 用途ごとの明るさ（L）と、元の色の鮮やかさに掛ける割合と上限（c は C の倍率、max は上限）。
 * 地の色（surface）は淡く色を付けるだけにし、アクセント（accent）は元の色の鮮やかさを生かす
 */
const LEVELS = {
  light: {
    bg: { l: 0.99, c: 0.06, max: 0.008 },
    blockBg: { l: 0.965, c: 0.12, max: 0.014 },
    codeBg: { l: 0.945, c: 0.12, max: 0.016 },
    border: { l: 0.91, c: 0.15, max: 0.02 },
    borderStrong: { l: 0.82, c: 0.15, max: 0.025 },
    fg: { l: 0.27, c: 0.12, max: 0.02 },
    strongFg: { l: 0.2, c: 0.12, max: 0.02 },
    muted: { l: 0.52, c: 0.15, max: 0.03 },
    accent: { l: 0.52, c: 1, max: 0.16 },
    accentSoft: { l: 0.88, c: 0.5, max: 0.07 },
    accentBg: { l: 0.965, c: 0.25, max: 0.025 },
  },
  dark: {
    bg: { l: 0.22, c: 0.08, max: 0.012 },
    blockBg: { l: 0.255, c: 0.12, max: 0.016 },
    codeBg: { l: 0.28, c: 0.12, max: 0.018 },
    border: { l: 0.32, c: 0.15, max: 0.02 },
    borderStrong: { l: 0.42, c: 0.15, max: 0.025 },
    fg: { l: 0.88, c: 0.08, max: 0.015 },
    strongFg: { l: 0.95, c: 0.06, max: 0.01 },
    muted: { l: 0.7, c: 0.12, max: 0.025 },
    accent: { l: 0.76, c: 1, max: 0.13 },
    accentSoft: { l: 0.42, c: 0.5, max: 0.07 },
    accentBg: { l: 0.27, c: 0.25, max: 0.03 },
  },
};

/** 元の色によらない色。検索の一致・エラーと、コードブロックの構文の色 */
const FIXED = {
  light: {
    match: 'rgba(255, 213, 0, 0.35)',
    matchCurrent: 'rgba(255, 150, 0, 0.45)',
    error: '#cf222e',
    tokKeyword: '#cf222e',
    tokString: '#0a3069',
    tokNumber: '#0550ae',
    tokComment: '#6e7781',
    tokProperty: '#0550ae',
    tokType: '#953800',
    tokDefinition: '#8250df',
  },
  dark: {
    match: 'rgba(255, 213, 0, 0.25)',
    matchCurrent: 'rgba(255, 150, 0, 0.4)',
    error: '#ff7b72',
    tokKeyword: '#ff7b72',
    tokString: '#a5d6ff',
    tokNumber: '#79c0ff',
    tokComment: '#8b949e',
    tokProperty: '#79c0ff',
    tokType: '#ffa657',
    tokDefinition: '#d2a8ff',
  },
};

/**
 * 配色を作る。
 * @param {object} options
 * @param {string} options.color プレビューの色（hushmark.previewColor）。mono は無彩色
 * @param {string} [options.customColor] color が custom のときの元の色（#rrggbb）
 * @param {'light' | 'dark'} options.mode 明るい地か暗い地か
 * @returns {Record<string, string>} 用途ごとの色（CSS の色の値）
 */
export function buildPalette({ color, customColor, mode }) {
  const seedHex = color === 'custom' ? (parseHex(customColor) ? customColor : DEFAULT_ACCENT) : COLOR_SEEDS[color];
  const accentSeed = toOklch(parseHex(seedHex || DEFAULT_ACCENT));
  // モノクロでは、地の色に色を付けない
  const tintSeed = seedHex ? accentSeed : { l: 0, c: 0, h: 0 };
  const levels = LEVELS[mode];

  const derive = (seed, { l, c, max }) => ({ l, c: Math.min(seed.c * c, max), h: seed.h });
  const colors = {};
  for (const name of ['bg', 'blockBg', 'codeBg', 'border', 'borderStrong', 'fg', 'strongFg', 'muted']) {
    colors[name] = derive(tintSeed, levels[name]);
  }
  for (const name of ['accent', 'accentSoft', 'accentBg']) colors[name] = derive(accentSeed, levels[name]);

  // 文字に使う色は、文字を置く地の色のどれに対しても読める明るさにする
  const surfaces = ['bg', 'blockBg', 'codeBg', 'accentBg'].map((name) => colors[name]);
  for (const name of ['fg', 'strongFg', 'muted', 'accent']) {
    colors[name] = ensureContrast(colors[name], surfaces, mode);
  }
  // 太字の下の蛍光ペン（accentSoft）の上にも本文の文字を置く
  colors.accentSoft = ensureContrast(colors.accentSoft, [colors.fg, colors.strongFg], mode === 'light' ? 'dark' : 'light');

  const hex = Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, toHex(color)]));
  const alpha = (name, a) => withAlpha(hex[name], a);
  const dark = mode === 'dark';
  return {
    ...hex,
    codeFg: hex.fg,
    link: hex.accent,
    linkLine: alpha('accent', 0.4),
    highlight: hex.accentSoft,
    selection: alpha('accent', dark ? 0.32 : 0.2),
    caret: hex.fg,
    hover: alpha('fg', dark ? 0.08 : 0.06),
    lineHighlight: alpha('fg', dark ? 0.05 : 0.04),
    lineHighlightBorder: 'transparent',
    tokVariable: hex.fg,
    ...FIXED[mode],
  };
}

/**
 * 地の色のどれに対してもコントラスト比が MIN_CONTRAST 以上になるまで、明るさを動かす。
 * 明るい地では暗く、暗い地では明るくする
 */
function ensureContrast(color, surfaces, mode) {
  const step = mode === 'light' ? -0.005 : 0.005;
  let current = color;
  // #rrggbb に丸めた後の色で比べる（丸める前に基準を満たしても、丸めるとわずかに下回ることがある）
  const quantized = (c) => toRgb(c).map((v) => Math.round(v * 255) / 255);
  for (let i = 0; i < 200; i++) {
    const rgb = quantized(current);
    if (surfaces.every((s) => contrast(rgb, quantized(s)) >= MIN_CONTRAST)) return current;
    current = { ...current, l: Math.min(1, Math.max(0, current.l + step)) };
  }
  return current;
}

// ---------------------------------------------------------------------------
// 色の計算（OKLab は Björn Ottosson による定義）

export function parseHex(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

function toOklch([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363015719 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

/** OKLCH から線形の sRGB（範囲の外になりうる） */
function oklchToLinear({ l, c, h }) {
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** sRGB の範囲に収まるよう、明るさと色相を保って鮮やかさを下げる */
function toGamut(color) {
  const inside = (c) => oklchToLinear(c).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  if (inside(color)) return color;
  let lo = 0;
  let hi = color.c;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inside({ ...color, c: mid })) lo = mid;
    else hi = mid;
  }
  return { ...color, c: lo };
}

/** OKLCH から sRGB（0〜1） */
export function toRgb(color) {
  return oklchToLinear(toGamut(color)).map((v) => Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))));
}

function toHex(color) {
  return `#${toRgb(color).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

function withAlpha(hex, alpha) {
  const [r, g, b] = parseHex(hex).map((v) => Math.round(v * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG 2 の相対輝度とコントラスト比 */
function luminance(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_CONTRAST, COLOR_SEEDS, buildPalette, contrast, modeOf, parseHex } from '../webview/palette.js';

/** テストに使う元の色。色相を一周させ、鮮やかさと明るさの極端なもの（白・黒・純色）も含める */
function sampleColors() {
  const colors = ['#ffffff', '#000000', '#808080', '#ffff00', '#00ffff', '#ff00ff', '#ff0000', '#00ff00', '#0000ff', ...Object.values(COLOR_SEEDS)];
  for (let h = 0; h < 360; h += 15) {
    for (const [s, l] of [[100, 50], [60, 30], [40, 80]]) colors.push(hslToHex(h, s, l));
  }
  return colors;
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const v = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const rgb = (hex) => parseHex(hex);

test('どの色を指定しても、文字の色は地の色に対して読みやすさの基準を満たす', () => {
  const failures = [];
  for (const color of sampleColors()) {
    for (const mode of ['light', 'dark']) {
      const p = buildPalette({ color: 'custom', customColor: color, mode });
      const pairs = [];
      for (const text of ['fg', 'strongFg', 'muted', 'accent']) {
        for (const surface of ['bg', 'blockBg', 'codeBg', 'accentBg']) pairs.push([text, surface]);
      }
      // 太字の下の蛍光ペンの上の文字
      pairs.push(['fg', 'highlight'], ['strongFg', 'highlight']);
      for (const [text, surface] of pairs) {
        const ratio = contrast(rgb(p[text]), rgb(p[surface]));
        if (ratio < MIN_CONTRAST) failures.push(`${color} ${mode} ${text}/${surface} ${ratio.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('色ごとの配色と、モノクロの配色', () => {
  for (const color of ['mono', ...Object.keys(COLOR_SEEDS)]) {
    for (const mode of ['light', 'dark']) {
      const p = buildPalette({ color, mode });
      for (const value of Object.values(p)) assert.match(value, /^(#[0-9a-f]{6}|rgba\(.+\)|transparent)$/, `${color} ${mode}`);
    }
  }
  // モノクロでは、地にもアクセントにも色を付けない（R・G・B が同じ）
  for (const mode of ['light', 'dark']) {
    const neutral = buildPalette({ color: 'mono', mode });
    for (const name of ['bg', 'fg', 'border', 'blockBg', 'accent', 'accentSoft', 'accentBg', 'link', 'highlight']) {
      const [r, g, b] = rgb(neutral[name]).map((v) => Math.round(v * 255));
      assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1, `${mode} ${name} ${neutral[name]}`);
    }
  }
  // 色を選んだときは、地にもその色を淡く付ける（緑なら G が最も大きい）
  const [r, g, b] = rgb(buildPalette({ color: 'green', mode: 'light' }).blockBg);
  assert.ok(g > r && g > b);
});

test('custom の色が不正なときは、既定のアクセントを使う', () => {
  const invalid = buildPalette({ color: 'custom', customColor: 'red; }', mode: 'light' });
  assert.deepEqual(invalid, buildPalette({ color: 'custom', customColor: '#0969da', mode: 'light' }));
});

// VSCode のテーマの背景色と文字色（editor.background と editor.foreground）
const THEMES = {
  'Light Modern': { bg: '#ffffff', fg: '#3b3b3b' },
  'Dark Modern': { bg: '#1f1f1f', fg: '#cccccc' },
  'Solarized Light': { bg: '#fdf6e3', fg: '#657b83' },
  'Solarized Dark': { bg: '#002b36', fg: '#839496' },
  Monokai: { bg: '#272822', fg: '#f8f8f2' },
};

test('テーマの色を使うときは、背景と文字にテーマの色をそのまま使い、選択範囲などはテーマに任せる', () => {
  for (const [name, base] of Object.entries(THEMES)) {
    const p = buildPalette({ color: 'green', base });
    assert.equal(p.bg, base.bg, name);
    assert.equal(p.fg, base.fg, name);
    for (const key of ['selection', 'caret', 'lineHighlight', 'lineNumber', 'match', 'matchCurrent']) {
      assert.ok(!(key in p), `${name}: ${key}`);
    }
  }
});

test('テーマの色を使うときも、Hushmark が作る文字の色は地の色に対して読みやすさの基準を満たす', () => {
  const failures = [];
  for (const [name, base] of Object.entries(THEMES)) {
    for (const color of ['green', 'pink', 'mono', 'sepia']) {
      const p = buildPalette({ color, base });
      for (const text of ['strongFg', 'muted', 'accent']) {
        for (const surface of ['bg', 'blockBg', 'codeBg', 'accentBg']) {
          const ratio = contrast(rgb(p[text]), rgb(p[surface]));
          if (ratio < MIN_CONTRAST) failures.push(`${name} ${color} ${text}/${surface} ${ratio.toFixed(2)}`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('明るい地か暗い地かは、テーマの背景色の明るさで決める', () => {
  assert.equal(modeOf(THEMES['Solarized Light'].bg), 'light');
  assert.equal(modeOf(THEMES['Solarized Dark'].bg), 'dark');
  assert.equal(modeOf(THEMES.Monokai.bg), 'dark');
});

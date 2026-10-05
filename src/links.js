'use strict';

// リンク先の文字列を、開ける形に直す。VSCode に依存しないので単体テストから直接呼べる。

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** 数値の文字参照と、よく使う名前付きの文字参照を元の文字に戻す。知らない名前はそのまま残す */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Markdown に書かれたリンク先を、開ける形に直す。
 * - <https://...>（山括弧で囲んだリンク先）の山括弧を外す
 * - \( などの Markdown のエスケープと、&amp; などの文字参照を元の文字に戻す
 * - www. で始まるもの（GFM の裸の URL）には https:// を付ける
 * - メールアドレスには mailto: を付ける
 */
function normalizeHref(raw) {
  let href = String(raw).trim();
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
  href = href.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  href = decodeEntities(href);
  if (/^www\./i.test(href)) return `https://${href}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(href)) return `mailto:${href}`;
  return href;
}

module.exports = { decodeEntities, normalizeHref };

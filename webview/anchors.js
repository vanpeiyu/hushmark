// 文書内のリンク（#見出し）の行き先。見出しのアンカーは GitHub と同じ規則で作る。

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

/** 見出しの文字列に含めない記号のノード */
const MARKUP_NODES = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'URL', 'LinkTitle', 'LinkLabel', 'HTMLTag', 'StrikethroughMark']);

/**
 * 見出しの文字列から GitHub と同じアンカーを作る。小文字にし、文字・数字・結合文字・連結子（_）・
 * 空白・ハイフン以外を消して、空白をハイフンにする
 */
export function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** 文書の見出しのアンカーと位置。同じアンカーが続くときは、GitHub と同じく 2 つ目から -1、-2 を付ける */
export function headingAnchors(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 1000) || syntaxTree(state);
  const anchors = [];
  const used = new Map();
  tree.iterate({
    enter(node) {
      if (!/^(ATX|Setext)Heading\d$/.test(node.name)) return;
      let text = '';
      let pos = node.from;
      tree.iterate({
        from: node.from,
        to: node.to,
        enter(inner) {
          if (inner.from < pos) return;
          if (inner.name === 'Escape') {
            // \# などは、記号の \ だけを落とす
            text += state.sliceDoc(pos, inner.from) + state.sliceDoc(inner.from + 1, inner.to);
            pos = inner.to;
            return false;
          }
          if (!MARKUP_NODES.has(inner.name)) return;
          text += state.sliceDoc(pos, inner.from);
          pos = inner.to;
          return false;
        },
      });
      text += state.sliceDoc(pos, node.to);
      const base = slugify(text.replace(/\n/g, ' '));
      const count = used.get(base) || 0;
      used.set(base, count + 1);
      anchors.push({ anchor: count === 0 ? base : `${base}-${count}`, from: node.from });
      return false;
    },
  });
  return anchors;
}

/** アンカー（# の後ろ。URL のエンコードは戻す）に当たる見出しの位置。見つからなければ null */
export function findAnchor(state, fragment) {
  let wanted = fragment;
  try {
    wanted = decodeURIComponent(fragment);
  } catch {
    // % の後ろが 16 進数でないものは、そのまま比べる
  }
  wanted = wanted.toLowerCase();
  const hit = headingAnchors(state).find((a) => a.anchor === wanted);
  return hit ? hit.from : null;
}

/** アンカーに当たる見出しにカーソルを置き、画面の上端に出す。見つかったら true */
export function revealAnchor(view, fragment) {
  const pos = findAnchor(view.state, fragment);
  if (pos === null) return false;
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'start' }),
  });
  view.focus();
  return true;
}

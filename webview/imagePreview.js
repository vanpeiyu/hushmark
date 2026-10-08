// 画像のリンク（![alt](path)）にマウスを載せると、その画像を浮かせて表示する。
// 文書の中には画像を描かない。描くと行の高さが変わり、縦の位置がソースの行とそろわなくなるため。

import { ViewPlugin } from '@codemirror/view';

/** マウスを載せてから表示するまでの時間 */
const SHOW_DELAY = 250;

/**
 * @param {(href: string) => Promise<string | null>} resolve 画像のリンク先を、img に渡せる URL にする
 *   （表示できないときは null）
 */
export function imagePreview(resolve) {
  return ViewPlugin.define((view) => {
    let target = null;
    let timer = null;
    let popup = null;

    const hide = () => {
      clearTimeout(timer);
      target = null;
      if (popup) popup.remove();
      popup = null;
    };

    const show = async (element) => {
      const src = await resolve(element.getAttribute('data-image-src'));
      if (!src || target !== element || !element.isConnected) return;
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.addEventListener('error', hide);
      img.addEventListener('load', () => {
        if (target !== element) return;
        popup = document.createElement('div');
        popup.className = 'cm-md-image-preview';
        popup.appendChild(img);
        document.body.appendChild(popup);
        place(popup, element.getBoundingClientRect());
      });
    };

    const onMove = (event) => {
      const element = event.target instanceof Element ? event.target.closest('[data-image-src]') : null;
      if (element === target) return;
      hide();
      if (!element) return;
      target = element;
      timer = setTimeout(() => show(element), SHOW_DELAY);
    };

    view.dom.addEventListener('mousemove', onMove);
    view.dom.addEventListener('mouseleave', hide);
    view.scrollDOM.addEventListener('scroll', hide, { passive: true });
    window.addEventListener('keydown', hide, true);
    return {
      update(update) { if (update.docChanged) hide(); },
      destroy() {
        hide();
        view.dom.removeEventListener('mousemove', onMove);
        view.dom.removeEventListener('mouseleave', hide);
        view.scrollDOM.removeEventListener('scroll', hide);
        window.removeEventListener('keydown', hide, true);
      },
    };
  });
}

/** 画像のリンクの下に置く。下に収まらず上のほうが広ければ上に置く */
function place(popup, anchor) {
  const margin = 6;
  const { width, height } = popup.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom;
  const top = below >= height + margin || below >= anchor.top ? anchor.bottom + margin : anchor.top - height - margin;
  const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
  popup.style.top = `${Math.max(margin, top)}px`;
  popup.style.left = `${left}px`;
}

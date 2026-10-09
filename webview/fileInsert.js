// 画像の貼り付けと、ファイルのドロップ。VSCode の Markdown のテキストエディタと同じく、
// - クリップボードの画像を貼り付けると、文書と同じフォルダーに保存して画像のリンクを入れる（文字列もあるときは文字列）
// - OS のファイルマネージャーから画像をドロップしても同じ
// - VSCode のエクスプローラーからファイルをドロップすると（Shift を押しながら）、そのファイルへの相対パスのリンクを入れる
// 保存とパスの計算は拡張機能本体が行う（request）。

import { EditorView } from '@codemirror/view';

/**
 * @param {(message: object) => Promise<string | null>} request 拡張機能本体に頼み、入れる Markdown を受け取る
 */
export function fileInsert(request) {
  /** 拡張機能本体の答えを待つ間に文書が変わっても、入れる位置がずれないよう、位置を変更に合わせて動かす */
  const insertLater = (view, pos, promise) => {
    let at = pos;
    const track = (update) => { if (update.docChanged) at = update.changes.mapPos(at); };
    trackers.add(track);
    promise.then((text) => {
      trackers.delete(track);
      if (!text || view.state.readOnly) return;
      view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
    });
  };
  const trackers = new Set();

  const imagesOf = (files) => [...(files || [])].filter((f) => /^image\//.test(f.type));
  const encode = (files) => Promise.all(files.map(async (file) => ({ data: toBase64(await file.arrayBuffer()), type: file.type, name: file.name })));

  return [
    EditorView.updateListener.of((update) => { for (const track of trackers) track(update); }),
    EditorView.domEventHandlers({
      paste(event, view) {
        // Excel のセルなど、文字列と画像の両方をコピーしたものは、文字列として貼り付ける
        if (event.clipboardData?.getData('text/plain')) return false;
        const images = imagesOf(event.clipboardData?.files);
        if (images.length === 0 || view.state.readOnly) return false;
        event.preventDefault();
        const { from, to } = view.state.selection.main;
        // 選んでいた範囲は、画像のリンクで置き換える
        if (to > from) view.dispatch({ changes: { from, to }, userEvent: 'delete' });
        insertLater(view, from, encode(images).then((list) => request({ type: 'pasteImages', images: list })));
        return true;
      },
      drop(event, view) {
        if (view.state.readOnly || !event.dataTransfer) return false;
        const uris = (event.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).filter((u) => u && !u.startsWith('#'));
        const images = imagesOf(event.dataTransfer.files);
        if (uris.length === 0 && images.length === 0) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
        insertLater(view, pos, uris.length > 0
          ? request({ type: 'linkFiles', uris })
          : encode(images).then((list) => request({ type: 'pasteImages', images: list })));
        return true;
      },
    }),
  ];
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

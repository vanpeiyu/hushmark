// Markdown の解析を最後まで済ませた EditorState を作る。
// 装飾などの StateField は、作るときに解析を一定の時間しか待たない。マシンが遅いと途中までの解析で
// 作られ、テストの結果が実行の速さで変わるので、解析を済ませてから状態に反映させる。

import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';

export function parsedState(config) {
  const state = EditorState.create(config);
  if (!ensureSyntaxTree(state, state.doc.length, 60000)) throw new Error('Markdown の解析が終わらない');
  // 解析の結果は、次のトランザクションで状態に入る
  return state.update({}).state;
}

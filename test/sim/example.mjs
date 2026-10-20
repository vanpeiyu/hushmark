// test/sim/sim.mjs の使い方の例。npm run build の後に node test/sim/example.mjs で実行する
import { open } from './sim.mjs';

const ed = await open('- [ ] 買い物\n', { cursor: 0 });
await ed.press('End');
await ed.press('Enter');
await ed.type('掃除');
const s = await ed.inspect();
console.log(JSON.stringify({ doc: s.doc, line: s.line, col: s.col, textBefore: s.textBefore, errors: ed.errors }));
await ed.close();

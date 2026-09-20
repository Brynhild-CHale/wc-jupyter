// Reset every fixture, then run the whole suite. Needs a Jupyter server for all
// but pane-test; see README.md.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const fs = require('fs'), path = require('path');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
fs.mkdirSync(FIX, { recursive: true });
const w = (n, o) => fs.writeFileSync(path.join(FIX, n), JSON.stringify(o, null, 1));

w('roundtrip.ipynb', { cells: [
  { cell_type:'markdown', id:'m1', metadata:{ tags:['intro'], jupyter:{ source_hidden:true } }, attachments:{ 'logo.png':{ 'image/png':'iVBORw0KGgo=' } }, source:['# Title\n'] },
  { cell_type:'code', id:'keep', execution_count:7, metadata:{ tags:['slow'], collapsed:false, scrolled:true, custom_field:{ deep:[1,2,3] } }, outputs:[{ output_type:'stream', name:'stdout', text:['kept\n'] }], source:['value = 1\n','value'] },
  { cell_type:'raw', id:'r1', metadata:{ format:'text/latex' }, source:['\\LaTeX raw cell\n'] },
], metadata:{ kernelspec:{ name:'python3', language:'python', display_name:'Python 3' }, language_info:{ name:'python' }, authors:[{ name:'Dev' }], custom_top_level:{ keep:'me' } }, nbformat:4, nbformat_minor:5 });

w('truncation.ipynb', { cells: [
  { cell_type:'code', id:'huge', metadata:{}, execution_count:null, outputs:[], source:'z'.repeat(120000) },
  { cell_type:'code', id:'after1', metadata:{}, execution_count:null, outputs:[], source:'def critical_analysis():\n    return 42' },
  { cell_type:'code', id:'after2', metadata:{}, execution_count:null, outputs:[], source:"print('also mine')" },
], metadata:{ kernelspec:{ name:'python3', language:'python' } }, nbformat:4, nbformat_minor:5 });

w('struct45.ipynb', { cells: [
  { cell_type:'code', id:'a1', metadata:{}, execution_count:1, outputs:[], source:'first = 1' },
  { cell_type:'code', id:'a2', metadata:{ tags:['keep'] }, execution_count:2, outputs:[{ output_type:'stream', name:'stdout', text:['out\n'] }], source:'second = 2' },
], metadata:{ kernelspec:{ name:'python3', language:'python' } }, nbformat:4, nbformat_minor:5 });

w('struct44.ipynb', { cells: [
  { cell_type:'code', metadata:{}, execution_count:null, outputs:[], source:'legacy = 1' },
  { cell_type:'markdown', metadata:{}, source:'# legacy md' },
], metadata:{ kernelspec:{ name:'python3', language:'python' } }, nbformat:4, nbformat_minor:4 });

const suites = ['pane-test.cjs', 'save-harness.mjs', 'trunc-harness.mjs', 'struct-harness.mjs', 'journal-harness.mjs', 'cellundo-harness.mjs', 'tabs-harness.mjs', 'kernel-harness.mjs', 'exec-harness.mjs', 'format-harness.mjs', 'death-harness.mjs'];
let bad = 0;
for (const s of suites) {
  let out = '';
  try { out = execFileSync(process.execPath, [new URL(s, import.meta.url).pathname], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); bad++; }
  const last = out.trim().split('\n').pop();
  console.log(s.padEnd(22) + last);
}
console.log('\n' + (bad ? bad + ' SUITE(S) FAILED' : 'ALL SUITES GREEN'));
process.exit(bad ? 1 : 0);

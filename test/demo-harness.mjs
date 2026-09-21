// The bundled demo notebook.
//
// It exists to be shown to someone, so it has to actually run — and it has to
// keep running as the pack changes. It also earns its keep as a regression test:
// it is the only thing here that exercises every output kind in one pass, and it
// is how the reconnect-window bug was found (a cell whose iopub was lost while
// the socket was being replaced, which no headless harness could see).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
const fs = require('fs'), path = require('path');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';

let fails = 0;
const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 120) : '')); };
const note = (l, v) => console.log('  ----  ' + l + '  -> ' + String(v));

console.log('— the repo copy and the shipped copy are the same notebook —');
// A pack installs components, themes and one SKILL.md. There is no mechanism
// for a data file, so the notebook travels inside service.js — and the readable
// copy under demo/ is then free to drift. This is what stops it.
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'components', 'jpy-notebook', 'service.js'), 'utf8');
const m = src.match(/const DEMO_NOTEBOOK = ("(?:[^"\\]|\\.)*");/);
ok('service.js carries the notebook', !!m);
const embedded = JSON.parse(JSON.parse(m[1]));
const onDisk = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'demo', 'signal-quality.ipynb'), 'utf8'));
ok('demo/signal-quality.ipynb matches it exactly', JSON.stringify(embedded) === JSON.stringify(onDisk),
  'embedded ' + JSON.stringify(embedded).length + ' B vs on-disk ' + JSON.stringify(onDisk).length + ' B');
ok('it is valid nbformat 4.5', embedded.nbformat === 4 && embedded.nbformat_minor === 5, embedded.nbformat + '.' + embedded.nbformat_minor);
ok('every cell has a unique id', new Set(embedded.cells.map(c => c.id)).size === embedded.cells.length);
// The trap that broke this notebook the first time it was generated.
const joined = embedded.cells.map(c => (Array.isArray(c.source) ? c.source.join('') : c.source));
ok('source lines carry their own newlines (nbformat joins with \'\')',
  joined.every(t => !/\w\n?import |\)\w+ =/.test(t.replace(/\n/g, '\n'))) && joined.some(t => t.includes('\n')),
  'a cell whose lines lost their \\n concatenates into a SyntaxError');
note('cells', embedded.cells.length + ' (' + embedded.cells.filter(c => c.cell_type === 'code').length + ' code)');

let store = {}; let onEv = null;
const ctx = () => ({
  name: 'jpy-notebook', mountId: 'dm',
  params: { notebooks: [], open_root: FIX, renderers: true },
  webChatDir: FIX + '/.web-chat', log: () => {},
  fence: (p, c) => { const r = path.resolve(p, c); return (r === p || r.startsWith(p + path.sep)) ? r : null; },
  diff: () => null,
  driver: {
    setStore(p) { Object.assign(store, p); return Promise.resolve({ ok: true }); },
    getStore(k) { const o = {}; for (const x of k || []) if (x in store) o[x] = store[x]; return Promise.resolve(o); },
    streamEvents({ onEvent }) { onEv = onEvent; return { close() {} }; },
  },
});
let sq = 0;
const ctl = (op, e) => { const patch = { jpy_ctl: { seq: (sq = Math.max(Date.now(), sq + 1)), op, ...(e || {}) } }; Object.assign(store, patch); onEv({ patch }); };
const until = async (p, ms = 240000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return true; await new Promise(r => setTimeout(r, 400)); } return false; };

console.log('\n— the demo op writes it and opens it —');
const target = path.join(FIX, 'wc-jupyter-demo.ipynb');
try { fs.unlinkSync(target); } catch {}
await svc.start(ctx());
await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering');
ok('connected', store.jpy_conn.ok === true, store.jpy_conn.error);
await new Promise(r => setTimeout(r, 40));

ctl('demo', {});
ok('it reports ready', await until(() => store.jpy_demo && store.jpy_demo.state === 'ready', 30000), JSON.stringify(store.jpy_demo || {}).slice(0, 110));
ok('the notebook is on disk', fs.existsSync(target), target);
const tab = await (async () => { await until(() => (store.jpy_nb.tabs || []).some(t => t.name === 'wc-jupyter-demo.ipynb'), 20000); return (store.jpy_nb.tabs || []).find(t => t.name === 'wc-jupyter-demo.ipynb'); })();
ok('and opened as a tab', !!tab, (store.jpy_nb.tabs || []).map(t => t.name).join(','));
ok('re-running it is idempotent, not a refusal', await (async () => { ctl('demo', {}); return until(() => store.jpy_demo && store.jpy_demo.state === 'ready', 20000); })(), store.jpy_demo && store.jpy_demo.state);

console.log('\n— it runs, and every output kind arrives —');
const ids = (tab.cells || []).filter(c => c.type === 'code').map(c => c.id);
note('code cells', ids.length);
const t0 = Date.now();
ctl('run-all', {});
const finished = await until(() => ids.every(id => { const o = store['jpy_out_' + id]; return o && ['ok', 'error'].includes(o.state); }), 240000);
ok('every cell settled (none left at In [*])', finished, ids.filter(id => { const o = store['jpy_out_' + id]; return !o || o.state === 'busy'; }).length + ' still busy');
note('elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's');

const kinds = new Set();
for (const id of ids) for (const o of ((store['jpy_out_' + id] || {}).outputs || [])) kinds.add(o.kind === 'image' ? 'image:' + String(o.mime || '').split('/').pop() : o.kind);
note('kinds produced', [...kinds].sort().join(', '));
for (const want of ['stream', 'html', 'image:png', 'image:svg+xml', 'vendor', 'json', 'markdown', 'error', 'text', 'unrenderable']) {
  ok('renders ' + want, kinds.has(want), [...kinds].join(','));
}
const errs = ids.filter(id => (store['jpy_out_' + id] || {}).state === 'error');
ok('exactly one cell fails, and on purpose', errs.length === 1, errs.length + ' errored');
ok('every cell that ran got an In [n]', ids.every(id => Number.isInteger((store['jpy_out_' + id] || {}).exec_count)),
  ids.filter(id => !Number.isInteger((store['jpy_out_' + id] || {}).exec_count)).length + ' without one');

await stopSvc();
try { fs.unlinkSync(target); } catch {}
console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
process.exit(fails ? 1 : 0);

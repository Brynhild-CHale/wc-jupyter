// nbformat quirks, read straight off the committed fixture.
//
// test-fixtures/sample.ipynb is deliberately awkward: list-form source, a cell
// with BOTH a stream and an execute_result, a cell with no `id` at all (legal
// before 4.5 and still present in the wild), and a saved traceback. Every other
// harness writes its own notebook inline with tidy string source, which is
// exactly why none of them exercised any of this.
//
// THE TRAP: nbformat multiline fields are a string OR a list of strings joined
// with '' — each line already carries its own newline. Joining with '\n'
// double-spaces every file anyone else wrote, and the damage is silent because
// it still round-trips as valid JSON.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs'), path = require('path');
const readJson = require('./nbread.cjs');

const SRC = path.join(import.meta.dirname, '..', 'test-fixtures', 'sample.ipynb');
const NB = FIX + '/format.ipynb';
fs.rmSync(FIX + '/.web-chat/jpy-format', { recursive: true, force: true });
fs.copyFileSync(SRC, NB);
const ORIGINAL = readJson(NB);

const store = {}; let onEv = null;
const ctx = {
  name: 'jpy-notebook', mountId: 'mf', params: { notebooks: [NB] }, webChatDir: FIX + '/.web-chat',
  log: () => {},
  fence: (parent, child) => { const r = path.resolve(parent, child); return (r === parent || r.startsWith(parent + path.sep)) ? r : null; },
  diff: () => null,
  driver: {
    setStore(p) { Object.assign(store, p); return Promise.resolve({ ok: true }); },
    getStore(k) { const o = {}; for (const x of k || []) if (x in store) o[x] = store[x]; return Promise.resolve(o); },
    streamEvents({ onEvent }) { onEv = onEvent; return { close() {} }; },
  },
};
let sq = 0; const nx = () => (sq = Math.max(Date.now(), sq + 1));
const ctl = (op, extra) => { const patch = { jpy_ctl: { seq: nx(), op, ...(extra || {}) } }; Object.assign(store, patch); if (onEv) onEv({ patch }); };
const until = async (p, w, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return; await new Promise(r => setTimeout(r, 120)); } throw new Error('timeout ' + w); };
// nbformat REWRITES the file, it does not echo it: keys come back alphabetised
// and a multiline field may switch between a string and a list of lines. Both
// are lossless and both defeat a JSON.stringify comparison, so compare on a
// canonical form instead — recursively sorted keys, and any all-string array
// collapsed to the text it represents.
const canon = (v) => {
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? v.join('') : v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

let fails = 0; const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 110) : '')); };

await svc.start(ctx);
await until(() => store.jpy_nb && (store.jpy_nb.tabs || []).length, 'tabs');
const tab = store.jpy_nb.tabs[0];
const cells = tab.cells || [];
const src = (id) => (store['jpy_src_' + id] || {}).source;

console.log('\n— a notebook reads with no kernel at all —');
ok('the file loaded', !tab.error, tab.error);
ok('all three cells are there', cells.length === 3, cells.length);

console.log('\n— list-form source joins with \'\', not \'\\n\' —');
ok('markdown source is exact', src('md1') === '# Analysis\n\nSome **notes** before the code.\n', JSON.stringify(src('md1')));
ok('code source is exact', src('code1') === "x = 6 * 7\nprint('hello')\nprint('world')\nx", JSON.stringify(src('code1')));
ok('no line got doubled', !/\n\n\n/.test(String(src('md1'))) && !String(src('code1')).includes('\n\n'), 'joined with a newline would show here');

console.log('\n— a cell with no `id` still gets a stable one —');
const idless = cells[2];
ok('it was given an id', !!idless.id, idless.id);
ok('...derived from its index, so it survives a reload', idless.id === 'c2', idless.id);

console.log('\n— outputs saved IN THE FILE render before anything runs —');
await until(() => store['jpy_out_code1'], 'saved outputs published');
const o1 = store['jpy_out_code1'];
ok('the saved outputs came through', (o1.outputs || []).length === 2, JSON.stringify((o1.outputs || []).map(o => o.kind)));
ok('marked as from-file, not from this session', o1.state === 'saved', o1.state);
ok('the stream text is list-joined correctly', (o1.outputs || []).some(o => o.kind === 'stream' && o.text === 'hello\nworld\n'), JSON.stringify((o1.outputs || []).find(o => o.kind === 'stream')));
ok('the execute_result came through too', (o1.outputs || []).some(o => o.kind === 'text' || o.kind === 'html'), JSON.stringify((o1.outputs || []).map(o => o.kind)));
const o2 = store['jpy_out_' + idless.id];
ok('a saved traceback renders as an error', !!o2 && (o2.outputs || []).some(o => o.kind === 'error'), o2 && JSON.stringify((o2.outputs || []).map(o => o.kind)));

console.log('\n— a save rewrites ONLY the cell that changed —');
ctl('edit', { cell: 'code1', source: 'x = 1\nx' });
await until(() => { const nb = readJson(NB); const c = nb.cells.find(c => c.id === 'code1'); return String(Array.isArray(c.source) ? c.source.join('') : c.source).startsWith('x = 1'); }, 'save to land');
const after = readJson(NB);
const byId = (nb, id) => nb.cells.find((c, i) => (c.id || 'c' + i) === id);
ok('the untouched markdown cell survived unchanged',
  same(byId(after, 'md1'), byId(ORIGINAL, 'md1')),
  JSON.stringify(byId(after, 'md1')).slice(0, 80));
// The id-less cell comes back WITH an id, and it is not one of ours: we mint
// 'u' + 8 hex, this is bare 8 hex. nbformat's validator repairs a 4.5 notebook
// on write, because 4.5 requires unique cell ids and this fixture violates that.
// Worth pinning, because it means the cell's IDENTITY changes across the first
// save: it was 'c2' (synthesised from its index) and afterwards it is whatever
// the server minted, so its jpy_out_ key and its journal history detach from it.
const repaired = after.cells[2];
ok('the server gave the id-less cell an id', typeof repaired.id === 'string' && repaired.id.length > 0, repaired.id);
ok('...and it is the SERVER\'s repair, not one of our minted ids', !/^u[0-9a-f]{8}$/.test(repaired.id), repaired.id);
ok('its source and outputs were left alone',
  same({ s: repaired.source, o: repaired.outputs }, { s: ORIGINAL.cells[2].source, o: ORIGINAL.cells[2].outputs }),
  JSON.stringify(repaired.source).slice(0, 60));
ok('(the server also normalised its string source to list form, losslessly)',
  Array.isArray(repaired.source) && repaired.source.join('') === '1/0', JSON.stringify(repaired.source));
ok('nbformat_minor was not bumped', after.nbformat_minor === ORIGINAL.nbformat_minor, after.nbformat_minor);
ok("the edited cell's saved outputs were left alone",
  same(byId(after, 'code1').outputs, byId(ORIGINAL, 'code1').outputs),
  'outputs are never written back');
ok('and its list-form source became a plain string, not a double-spaced list',
  !String(Array.isArray(byId(after, 'code1').source) ? byId(after, 'code1').source.join('') : byId(after, 'code1').source).includes('\n\n'),
  JSON.stringify(byId(after, 'code1').source));

await stopSvc();
// keep NB for inspection when JPY_KEEP=1
if (!process.env.JPY_KEEP) { try { fs.unlinkSync(NB); } catch {} }
console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
process.exit(fails ? 1 : 0);

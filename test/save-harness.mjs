import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
// Release the kernel with the service, EVERY time — a harness that starts the
// service more than once starts a kernel each time, and pairing the two by hand
// meant tabs-harness (three starts, one release) leaked two per run.
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
// Fixture root — override with JPY_FIXTURES to run this anywhere.
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs');
const readJson = require('./nbread.cjs');   // the service may be mid-write

const { seed } = await import('./fixtures.mjs');
const [NB] = seed(FIX, 'roundtrip.ipynb');   // fresh every run: portable, and no drift
fs.rmSync(FIX + '/.web-chat/jpy-history', { recursive: true, force: true });
const before = readJson(NB);

const store = {}; let onEv = null;
const ctx = {
  name: 'jpy-notebook', mountId: 'm', params: { notebooks: [NB] },
  webChatDir: FIX + '/.web-chat', log: () => {}, fence: (p, c) => c, diff: () => null,
  driver: {
    setStore(p) { Object.assign(store, p); return Promise.resolve({ ok: true }); },
    getStore(k) { const o = {}; for (const x of k || []) if (x in store) o[x] = store[x]; return Promise.resolve(o); },
    streamEvents({ onEvent }) { onEv = onEvent; return { close() {} }; },
  },
};
const ctl = (op, extra) => { const patch = { jpy_ctl: { seq: Date.now(), op, ...(extra || {}) } }; Object.assign(store, patch); if (onEv) onEv({ patch }); };
const until = async (p, what, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout: ' + what); };

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x)) ? Object.keys(x).sort().reduce((o, kk) => (o[kk] = x[kk], o), {}) : x);
let fails = 0;
const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 130) : '')); };

await svc.start(ctx);
await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering', 'connect');
ok('connected', store.jpy_conn.ok === true, store.jpy_conn.error || store.jpy_conn.state);
ok('tab reports itself saveable (inside server root)', store.jpy_nb.tabs[0].saveable === true, store.jpy_nb.tabs[0].save_hint);
ok('jpy_nb does NOT leak the raw notebook', !('raw' in store.jpy_nb.tabs[0]));

console.log('\n— edit + run the edited buffer —');
ctl('run', { cell: 'keep', source: 'value = 99\nvalue' });
await until(() => store.jpy_out_keep && ['ok', 'error'].includes(store.jpy_out_keep.state), 'run');
const res = (store.jpy_out_keep.outputs || []).find(o => o.kind === 'text' || o.kind === 'html');
ok('the EDITED source ran, not the file version', String(res && (res.text || res.plain)).includes('99'), res && (res.text || res.plain));
// Autosave now writes the edit within ~1.2s, so `dirty` does not persist — the
// meaningful assertion is that the edit REACHED THE FILE without anyone asking.
await until(() => String(readJson(NB).cells[1].source).includes('99'), 'autosave to land');
ok('autosave wrote the edited cell with no explicit save', true);

console.log('\n— save —');
ctl('save', {});
await until(() => store.jpy_save && ['saved', 'error', 'stale', 'unsaveable'].includes(store.jpy_save.state), 'save');
ok('save reported saved', store.jpy_save.state === 'saved', store.jpy_save.error || store.jpy_save.state);
ok('dirty cleared after save', (store.jpy_nb.tabs[0].dirty || []).length === 0);

const after = readJson(NB);
// The pane drops its own buffer the moment it sees state 'saved', so the
// service must have made jpy_src_ canonical BEFORE saying so — otherwise the
// cell visibly reverts to its load-time text on the next render.
ok('jpy_src_ reflects the SAVED text, not the load-time text',
   store.jpy_src_keep && String(store.jpy_src_keep.source).includes('99'),
   store.jpy_src_keep && store.jpy_src_keep.source);

console.log('\n— the round-trip: what survived —');
ok('edited source hit the FILE', String(after.cells[1].source).includes('99'), JSON.stringify(after.cells[1].source));
ok('cell metadata preserved', canon(after.cells[1].metadata) === canon(before.cells[1].metadata), JSON.stringify(after.cells[1].metadata));
ok('other cells untouched', JSON.stringify(after.cells[0].source) === JSON.stringify(before.cells[0].source));
ok('ATTACHMENTS preserved', canon(after.cells[0].attachments) === canon(before.cells[0].attachments), JSON.stringify(after.cells[0].attachments));
ok('raw cell preserved', after.cells[2] && after.cells[2].cell_type === 'raw' && canon(after.cells[2].metadata) === canon(before.cells[2].metadata));
ok('saved outputs of untouched cells preserved', canon(after.cells[1].outputs) === canon(before.cells[1].outputs));
ok('notebook metadata preserved (authors)', JSON.stringify(after.metadata.authors) === JSON.stringify(before.metadata.authors));
ok('custom top-level metadata preserved', JSON.stringify(after.metadata.custom_top_level) === JSON.stringify(before.metadata.custom_top_level));
ok('nbformat_minor preserved', after.nbformat_minor === before.nbformat_minor, after.nbformat_minor);
ok('cell COUNT unchanged', after.cells.length === before.cells.length, after.cells.length);

console.log('\n— staleness —');
const touched = readJson(NB);
touched.cells[0].source = ['# Changed by someone else\n'];
fs.writeFileSync(NB, JSON.stringify(touched, null, 1));
ctl('run', { cell: 'keep', source: 'value = 1234\nvalue' });
await until(() => store.jpy_out_keep && store.jpy_out_keep.state === 'ok', 'rerun');
ctl('save', {});
await until(() => store.jpy_save && ['saved', 'error', 'stale'].includes(store.jpy_save.state) && store.jpy_save.at !== null || store.jpy_save.state === 'stale', 'second save');
ok('external edit detected -> refuses rather than clobbering', store.jpy_save.state === 'stale', store.jpy_save.state + ': ' + (store.jpy_save.error || ''));
const final = readJson(NB);
ok("the other person's change is still on disk", String(final.cells[0].source).includes('someone else'));

await stopSvc();
console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
process.exit(fails ? 1 : 0);

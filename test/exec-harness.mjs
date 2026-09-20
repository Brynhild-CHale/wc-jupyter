// Execution counts: the In [n] beside a cell.
//
// Every cell that runs gets one, and they ascend in the order the kernel ran
// them. The bug this pins down: the count was read off `execute_result`, which a
// kernel emits ONLY when a cell's last statement produces a value — so a cell
// that merely printed, only called display(), or raised, ran fine and stayed
// blank. With a notebook of mixed cells that reads as "only the first couple
// actually ran".
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs'), path = require('path');
const NB = FIX + '/exec.ipynb';

// One cell per way a cell can end, because that is the axis the bug was on.
const CELLS = [
  { id: 'value',   source: '6 * 7',                                        why: 'a bare expression (execute_result)' },
  { id: 'printed', source: 'print("no result value here")',                why: 'print only (stream, no result)' },
  { id: 'shown',   source: 'from IPython.display import display\ndisplay({"text/plain": "shown"}, raw=True)', why: 'display only (display_data)' },
  { id: 'quiet',   source: 'x = 1',                                        why: 'an assignment — no output at all' },
  { id: 'raises',  source: '1 / 0',                                        why: 'an exception (error)' },
];

fs.rmSync(FIX + '/.web-chat/jpy-exec', { recursive: true, force: true });
fs.writeFileSync(NB, JSON.stringify({
  cells: CELLS.map((c) => ({ cell_type: 'code', id: c.id, metadata: {}, execution_count: null, outputs: [], source: c.source })),
  metadata: { kernelspec: { name: 'python3', language: 'python' } }, nbformat: 4, nbformat_minor: 5,
}, null, 1));

const store = {}; let onEv = null;
const ctx = {
  name: 'jpy-notebook', mountId: 'me', params: { notebooks: [NB] }, webChatDir: FIX + '/.web-chat',
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
const until = async (p, w, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return; await new Promise(r => setTimeout(r, 120)); } throw new Error('timeout ' + w); };
const settle = (ms) => new Promise(r => setTimeout(r, ms || 400));
let fails = 0; const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 110) : '')); };

const out = (id) => store['jpy_out_' + id] || {};
const done = (id) => ['ok', 'error'].includes(out(id).state);

await svc.start(ctx);
await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering', 'connect');
ok('connected', store.jpy_conn.ok === true, store.jpy_conn.error);
await settle(30);

console.log('\n— every cell that runs gets a number, whatever it ends with —');
ctl('run-all', {});
await until(() => CELLS.every((c) => done(c.id)), 'run-all to finish');
for (const c of CELLS) {
  ok(`${c.id}: ${c.why}`, Number.isInteger(out(c.id).exec_count), 'state=' + out(c.id).state + ' exec_count=' + out(c.id).exec_count);
}

console.log('\n— and they ascend in the order the kernel ran them —');
const counts = CELLS.map((c) => out(c.id).exec_count);
ok('all five are distinct', new Set(counts).size === CELLS.length, counts.join(','));
ok('strictly increasing down the notebook', counts.every((n, i) => i === 0 || n > counts[i - 1]), counts.join(','));
ok('a failing cell still gets one', Number.isInteger(out('raises').exec_count) && out('raises').state === 'error', out('raises').exec_count);

console.log('\n— re-running one cell advances only that cell —');
const beforeAll = CELLS.map((c) => out(c.id).exec_count);
const top = Math.max(...beforeAll);
ctl('run', { cell: 'printed', source: 'print("again")' });
await until(() => out('printed').exec_count > top, 're-run of printed');
ok('the re-run cell took the next number', out('printed').exec_count === top + 1, top + ' -> ' + out('printed').exec_count);
ok('and its neighbours did not move',
  CELLS.filter((c) => c.id !== 'printed').every((c, i) => out(c.id).exec_count === beforeAll[CELLS.findIndex((x) => x.id === c.id)]),
  CELLS.map((c) => c.id + '=' + out(c.id).exec_count).join(' '));

console.log('\n— a restarted kernel starts the numbering over —');
ctl('restart', {});
await settle(3000);
ctl('run', { cell: 'value', source: '6 * 7' });
await until(() => out('value').exec_count === 1, 'count resets to 1 after restart', 40000);
ok('the first cell after a restart is In [1]', out('value').exec_count === 1, out('value').exec_count);

await stopSvc();
try { fs.unlinkSync(NB); } catch {}
console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
process.exit(fails ? 1 : 0);

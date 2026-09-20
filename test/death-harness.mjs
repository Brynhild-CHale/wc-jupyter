// A kernel that dies under a running cell.
//
// There used to be exactly one way out of a run — iopub
// status{execution_state:'idle'} for that cell's msg_id — and a dead kernel
// never sends one. The server auto-restarts the kernel and broadcasts
// 'restarting' with an EMPTY parent_header, which the per-cell guard dropped,
// and the socket stays open. So the cell sat at In [*] for ever, `running`
// stayed true, and every later run queued behind it and wrote NOTHING: you
// pressed Run and the pane did not even acknowledge it, while the connection
// banner still said "kernel ready".
//
// The assertion that matters is the last one in each block: a subsequent run
// works WITHOUT the user having to know to press Restart.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel, serverToken } = await import('./kernel-cleanup.mjs');
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs'), path = require('path');
const NB = FIX + '/death.ipynb';

// Two ways a kernel really dies: a clean process exit, and a segfault in a C
// extension (the shape an OOM kill or a bad native wheel takes).
const SUICIDE = {
  exit: 'import os, time\nprint("two", flush=True)\ntime.sleep(0.3)\nos._exit(0)',
  segv: 'import ctypes, time\nprint("two", flush=True)\ntime.sleep(0.3)\nctypes.string_at(0)',
};

const write = (kill) => fs.writeFileSync(NB, JSON.stringify({
  cells: [
    { cell_type: 'code', id: 'c1', execution_count: null, metadata: {}, outputs: [], source: 'print("one")' },
    { cell_type: 'code', id: 'c2', execution_count: null, metadata: {}, outputs: [], source: kill },
    { cell_type: 'code', id: 'c3', execution_count: null, metadata: {}, outputs: [], source: 'print("three")' },
    { cell_type: 'code', id: 'c4', execution_count: null, metadata: {}, outputs: [], source: 'print("four")' },
  ],
  metadata: { kernelspec: { name: 'python3', language: 'python' } }, nbformat: 4, nbformat_minor: 5,
}, null, 1));

let store = {}; let onEv = null;
const ctx = () => ({
  name: 'jpy-notebook', mountId: 'md', params: { notebooks: [NB] }, webChatDir: FIX + '/.web-chat',
  log: () => {},
  fence: (parent, child) => { const r = path.resolve(parent, child); return (r === parent || r.startsWith(parent + path.sep)) ? r : null; },
  diff: () => null,
  driver: {
    setStore(p) { Object.assign(store, p); return Promise.resolve({ ok: true }); },
    getStore(k) { const o = {}; for (const x of k || []) if (x in store) o[x] = store[x]; return Promise.resolve(o); },
    streamEvents({ onEvent }) { onEv = onEvent; return { close() {} }; },
  },
});
let sq = 0; const nx = () => (sq = Math.max(Date.now(), sq + 1));
const ctl = (op, extra) => { const patch = { jpy_ctl: { seq: nx(), op, ...(extra || {}) } }; Object.assign(store, patch); if (onEv) onEv({ patch }); };
const until = async (p, w, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return true; await new Promise(r => setTimeout(r, 120)); } return false; };
const settle = (ms) => new Promise(r => setTimeout(r, ms || 400));
let fails = 0; const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 120) : '')); };
const out = (id) => store['jpy_out_' + id] || null;
const settled = (id) => { const o = out(id); return !!o && ['ok', 'error'].includes(o.state); };

async function boot(kill) {
  write(kill);
  store = {}; sq = 0;
  fs.rmSync(FIX + '/.web-chat/jpy-death', { recursive: true, force: true });
  await svc.start(ctx());
  await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering', 'connect');
  await settle(30);
}

for (const [name, kill] of Object.entries(SUICIDE)) {
  console.log(`\n=== the kernel dies by ${name} under Run All ===`);
  await boot(kill);
  ok('connected', store.jpy_conn.ok === true, store.jpy_conn.error);

  ctl('run-all', {});
  ok('the cell that died SETTLES instead of hanging at In [*]',
    await until(() => settled('c2'), 'c2 settles', 25000),
    out('c2') && out('c2').state);
  ok('...as an error, naming the kernel', out('c2') && out('c2').state === 'error'
    && (out('c2').outputs || []).some(o => o.kind === 'error' && /Kernel/i.test(String(o.ename))),
    out('c2') && JSON.stringify((out('c2').outputs || []).map(o => o.ename || o.kind)));
  ok('the cell before it still has its result', out('c1') && out('c1').state === 'ok', out('c1') && out('c1').state);

  // THE regression: before the fix, `running` stayed true for ever and this
  // wrote nothing at all — no output, no error, no state change.
  await settle(600);
  const seqBefore = out('c3') ? out('c3').seq : null;
  ctl('run', { cell: 'c3', source: 'print("three")' });
  ok('a LATER run is acknowledged at all (the queue is not bricked)',
    await until(() => out('c3') && out('c3').seq !== seqBefore, 'c3 acknowledged', 20000),
    out('c3') && JSON.stringify(out('c3')).slice(0, 80));
  ok('...and it actually produces its output, with no Restart needed',
    await until(() => settled('c3') && (out('c3').outputs || []).some(o => o.kind === 'stream' && String(o.text).includes('three')), 'c3 output', 25000),
    out('c3') && JSON.stringify(out('c3').outputs || []).slice(0, 90));
  ok('...and it got an execution count from the fresh kernel',
    out('c3') && Number.isInteger(out('c3').exec_count), out('c3') && out('c3').exec_count);

  await stopSvc();
}

console.log('\n=== a deliberate Restart under a running cell ===');
await boot('import time\nprint("busy", flush=True)\ntime.sleep(30)');
ctl('run', { cell: 'c2' });
await until(() => out('c2') && out('c2').state === 'busy', 'c2 busy');
ok('the cell is running', out('c2').state === 'busy', out('c2').state);
ctl('restart', {});
ok('Restart settles it rather than abandoning it at In [*]',
  await until(() => settled('c2'), 'c2 settles after restart', 25000),
  out('c2') && out('c2').state);
ok('and the notebook runs again afterwards',
  await (async () => { ctl('run', { cell: 'c1', source: 'print("one")' }); return until(() => settled('c1') && out('c1').state === 'ok', 'c1 after restart', 25000); })(),
  out('c1') && out('c1').state);
await stopSvc();

console.log('\n=== the kernel is REMOVED outright, announcing nothing ===');
// The auto-restart above never exercises the watchdog: jupyter restarts the
// kernel in place, so its id still resolves and kernelGone() correctly says no.
// Deleting the kernel is the case the watchdog exists for — no lifecycle
// broadcast, and on this server the socket does not close either.
// SIGINT is IGNORED on purpose. Deleting a kernel normally interrupts it first,
// so the cell raises KeyboardInterrupt and the kernel sends a clean idle — the
// ordinary path, where the connection is rightly still healthy at that moment.
// That made this block pass for the wrong reason about half the time. Refusing
// the interrupt forces the case the watchdog exists for: the kernel is taken
// away without ever settling the cell.
await boot('import time, signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nprint("busy", flush=True)\ntime.sleep(120)');
const url = store.jpy_conn.server && store.jpy_conn.server.url;
const tok = url ? serverToken(url) : null;
const kid = store.jpy_conn.kernel && store.jpy_conn.kernel.id;
ctl('run', { cell: 'c2' });
await until(() => out('c2') && out('c2').state === 'busy', 'c2 busy');
ok('the cell is running', out('c2').state === 'busy', out('c2').state);
await fetch(url + 'api/kernels/' + kid, { method: 'DELETE', headers: tok ? { Authorization: 'token ' + tok } : {} });
ok('the kernel is gone from the server',
  await until(async () => true, 'noop') && !(await (await fetch(url + 'api/kernels', { headers: tok ? { Authorization: 'token ' + tok } : {} })).json()).some(k => k.id === kid),
  kid && kid.slice(0, 8));
// KERNEL_WATCH_MS is 10s, so allow two ticks.
ok('the watchdog settles the cell rather than leaving it at In [*] for ever',
  await until(() => settled('c2'), 'watchdog', 40000),
  out('c2') && out('c2').state);
const viaWatchdog = ((out('c2') || {}).outputs || []).some(o => o.ename === 'KernelGone');
ok('...and it was the watchdog that did it, not a clean interrupt from the kernel',
  viaWatchdog, ((out('c2') || {}).outputs || []).map(o => o.ename || o.kind).join(','));
ok('...and says so on the connection, instead of still claiming kernel ready',
  !viaWatchdog || await until(() => store.jpy_conn.ok === false && /gone|restart/i.test(String(store.jpy_conn.error || '') + String(store.jpy_conn.hint || '')), 'conn reports it', 5000),
  JSON.stringify({ ok: store.jpy_conn.ok, error: store.jpy_conn.error, hint: store.jpy_conn.hint, ename: ((out('c2') || {}).outputs || []).map(o => o.ename).join(',') }));
await svc.stop();

try { fs.unlinkSync(NB); } catch {}
console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
process.exit(fails ? 1 : 0);

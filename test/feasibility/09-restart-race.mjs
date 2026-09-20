// Characterisation, not a pass/fail test: how often a deliberate Restart under a
// running cell leaves the next run hung.
//
// This scenario lives here rather than in the main suite because its outcome is
// not deterministic, and a suite that passes four times in five is worse than no
// suite. It reports a RATE. Run it before and after touching the restart path.
//
// What was measured on 2026-09-20 (jupyter_server 2.21.1, ipykernel 7.3.0), each
// figure over 5 iterations of: run a 30s cell, Restart while it runs, then
// immediately run another cell.
//
//   baseline, before any of the kernel-death work     frequent hangs, cell busy for ever
//   + settle-on-restart (abortRuns)                   2/5 hung
//   + socket rebind after restart                     1/5 hung
//   + conn.ok false during the window                 1/5 hung
//   + hold runs while settling                        1/5 hung
//   + wait for the kernel's own ready announcement    0/5, then 1/5 on a re-run
//
// So the remaining race is real but rare, and it is specific to restarting WHILE
// a cell is running and dispatching another immediately. The symptom is a cell
// stuck at In [*] with the pane reporting connected; Restart clears it.
//
// The likely remaining gap: `waitKernelReady` resolves on the first parentless
// idle/starting, and ipykernel can emit one that belongs to the OLD kernel
// before the new one is listening. Pairing the announcement with a kernel_info
// round trip would settle it properly — that is the next thing to try.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('../kernel-cleanup.mjs');
const svc = require('../../components/jpy-notebook/service.js');
const fs = require('fs'), path = require('path');

const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const N = Number(process.env.ITERATIONS || 5);
const NB = FIX + '/restart-race.ipynb';
fs.writeFileSync(NB, JSON.stringify({
  cells: [
    { cell_type: 'code', id: 'quick', execution_count: null, metadata: {}, outputs: [], source: 'print("one")' },
    { cell_type: 'code', id: 'slow', execution_count: null, metadata: {}, outputs: [], source: 'import time\nprint("busy", flush=True)\ntime.sleep(30)' },
  ],
  metadata: { kernelspec: { name: 'python3', language: 'python' } }, nbformat: 4, nbformat_minor: 5,
}, null, 1));

let store = {}, onEv = null;
const ctx = () => ({
  name: 'jpy-notebook', mountId: 'rr', params: { notebooks: [NB] }, webChatDir: FIX + '/.web-chat',
  log: () => {},
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
const until = async (p, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return Date.now() - t0; await new Promise((r) => setTimeout(r, 80)); } return -1; };
const out = (id) => store['jpy_out_' + id];

console.log(`restart-under-load, ${N} iterations\n`);
const tally = {};
for (let i = 0; i < N; i++) {
  store = {}; sq = 0;
  await svc.start(ctx());
  await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering');
  await new Promise((r) => setTimeout(r, 60));

  ctl('run', { cell: 'slow' });
  await until(() => out('slow') && out('slow').state === 'busy');
  ctl('restart', {});
  const settle = await until(() => out('slow') && ['ok', 'error'].includes(out('slow').state), 25000);
  const conn = await until(() => store.jpy_conn && store.jpy_conn.ok === true, 20000);
  ctl('run', { cell: 'quick', source: 'print("one")' });
  const ran = await until(() => out('quick') && ['ok', 'error'].includes(out('quick').state), 20000);

  const verdict = ran < 0 ? 'HUNG' : (out('quick').state === 'ok' ? 'ok' : 'error:' + out('quick').state);
  tally[verdict] = (tally[verdict] || 0) + 1;
  console.log(`  #${i + 1}  settle=${settle}ms conn=${conn}ms run=${ran}ms  slow=${out('slow') && out('slow').state} quick=${out('quick') && out('quick').state} connOk=${store.jpy_conn.ok}`);

  await shutdownKernel(store.jpy_conn);
  await svc.stop();
}
const hung = tally.HUNG || 0;
console.log(`\ntally: ${JSON.stringify(tally)}`);
console.log(`hang rate: ${hung}/${N}`);
try { fs.unlinkSync(NB); } catch {}
process.exit(0);

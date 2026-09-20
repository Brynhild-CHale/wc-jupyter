// Kernel acquisition: the pane must RE-FIND the kernel it already has instead of
// starting another one. Measured against a live server by kernel count, because
// that is the number that actually ran the dev server out of kernels.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel, serverToken } = await import('./kernel-cleanup.mjs');
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs'), path = require('path');
const A = FIX + '/kern-a.ipynb', B = FIX + '/kern-b.ipynb';
const OUT = '/tmp/wc-jpy-outside/kern-outside.ipynb';

fs.rmSync(FIX + '/.web-chat/jpy-kern', { recursive: true, force: true });
const nb = (tag) => JSON.stringify({
  cells: [{ cell_type: 'code', id: 'k', metadata: {}, execution_count: null, outputs: [], source: 'print("' + tag + '")' }],
  metadata: { kernelspec: { name: 'python3', language: 'python' } }, nbformat: 4, nbformat_minor: 5,
}, null, 1);
fs.writeFileSync(A, nb('A')); fs.writeFileSync(B, nb('B'));
fs.mkdirSync('/tmp/wc-jpy-outside', { recursive: true });
fs.writeFileSync(OUT, nb('OUT'));

let store = {}; let onEv = null;
const mk = (notebooks) => ({
  name: 'jpy-notebook', mountId: 'mk', params: { notebooks }, webChatDir: FIX + '/.web-chat',
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
const until = async (p, w, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return; await new Promise(r => setTimeout(r, 120)); } throw new Error('timeout ' + w); };
const settle = (ms) => new Promise(r => setTimeout(r, ms || 400));
let fails = 0; const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 120) : '')); };

// --- the server, read the same way the service reads it ---------------------
const SERVER = { url: null, token: null };
const api = (p, init) => fetch(SERVER.url + p, { ...(init || {}), headers: { ...((init || {}).headers || {}), ...(SERVER.token ? { Authorization: 'token ' + SERVER.token } : {}) } });
const kernelIds = async () => { const r = await api('api/kernels'); return r.ok ? (await r.json()).map(k => k.id) : []; };
const sessions = async () => { const r = await api('api/sessions'); return r.ok ? await r.json() : []; };
const nKernels = async () => (await kernelIds()).length;

const boot = async (notebooks) => {
  store = {}; sq = 0;
  await svc.start(mk(notebooks));
  await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering', 'connect');
  await settle(30);   // the start-time floor refuses ops stamped at or before startedAt
};
const kid = () => store.jpy_conn && store.jpy_conn.kernel && store.jpy_conn.kernel.id;

// Boot once just to learn the server URL the service picked, then align on it.
await boot([A]);
SERVER.url = store.jpy_conn.server && store.jpy_conn.server.url;
SERVER.token = SERVER.url ? serverToken(SERVER.url) : null;
ok('connected to a server', !!store.jpy_conn.ok, store.jpy_conn.error);
ok('the harness can reach the same server', SERVER.url && (await api('api/status')).ok, SERVER.url);

console.log('\n— a notebook gets a SESSION, not a bare kernel —');
const first = kid();
const ss = await sessions();
const mine = ss.find(x => x.kernel && x.kernel.id === first);
ok('the kernel is attached to a session', !!mine, (ss.length + ' session(s)'));
ok('...keyed on the notebook path', !!mine && mine.path === 'kern-a.ipynb', mine && mine.path);
ok('...so JupyterLab sees it as that notebook running', !!mine && mine.type === 'notebook', mine && mine.type);

console.log('\n— a respawn RE-FINDS it instead of starting another —');
let before = await nKernels();
await svc.stop();
await boot([A]);
ok('the kernel count did not move', (await nKernels()) === before, before + ' -> ' + (await nKernels()));
ok('and it is the same kernel', kid() === first, first + ' -> ' + kid());

console.log('\n— ...even when a different tab is active —');
before = await nKernels();
await svc.stop();
await boot([B, A]);                       // B first, so B is the active tab
ok('still no new kernel', (await nKernels()) === before, before + ' -> ' + (await nKernels()));
ok('it adopted the one already open for A', kid() === first, kid());

console.log('\n— a session whose kernel DIED must not be adopted —');
// This is the failure that matters: adopting a corpse gives a pane that reports
// connected, opens a socket on an id the server no longer routes, and leaves
// every cell at In [*] for ever.
await svc.stop();
await api('api/kernels/' + encodeURIComponent(first), { method: 'DELETE' });
await settle(400);
ok('the kernel is really gone', !(await kernelIds()).includes(first), (await kernelIds()).length + ' left');
// acquireKernel also DELETEs a session whose kernel is gone rather than adopting
// it. That branch is guarded but not reachable here: this Jupyter reaps the
// session along with the kernel, so the case only arises when a kernel dies
// WITHOUT going through the API (a crash, or a server restart with sessions
// persisted). kernelAlive is what stands in front of it either way, and the
// assertions below prove the outcome that matters — a dead id is never adopted.
const stale = (await sessions()).find(x => x.kernel && x.kernel.id === first);
ok('the stale session did not survive its kernel on this server', !stale, stale ? 'lingered' : 'server reaped it with the kernel');
await boot([A]);
ok('it did NOT reconnect to the dead kernel', kid() !== first, 'was ' + first + ', now ' + kid());
ok('it reports connected', store.jpy_conn.ok === true, store.jpy_conn.error);
// and the real proof: it can actually execute
ctl('run', { cell: 'k', source: 'print("alive")' });
let ran = false;
try {
  await until(() => { const o = store.jpy_out_k; return o && (o.state === 'ok' || o.state === 'error'); }, 'run after recovery', 25000);
  ran = true;
} catch {}
ok('and the replacement kernel actually runs a cell', ran && store.jpy_out_k.state === 'ok', store.jpy_out_k && JSON.stringify(store.jpy_out_k).slice(0, 90));
const second = kid();

console.log('\n— a notebook the contents API cannot address still gets a kernel —');
before = await nKernels();
await svc.stop();
store = {}; sq = 0;
await svc.start(mk([OUT]));
await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering', 'connect outside');
await settle(30);
ok('it connects', store.jpy_conn.ok === true, store.jpy_conn.error);
ok('with a bare kernel, since there is no path to key a session on',
  !(await sessions()).some(x => x.kernel && x.kernel.id === kid()), kid());
ok('which is a NEW kernel (nothing to re-find)', (await nKernels()) === before + 1, before + ' -> ' + (await nKernels()));
await shutdownKernel(store.jpy_conn);     // it can never be re-found, so release it here
await svc.stop();

console.log('\n— teardown leaves the server as it was found —');
for (const s of await sessions()) {
  if (s.kernel && (s.kernel.id === first || s.kernel.id === second)) {
    await api('api/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' });
  }
}
await settle(400);
ok('the adopted kernel was released too', !(await kernelIds()).includes(second), (await kernelIds()).length + ' kernel(s) left');

try { fs.unlinkSync(A); fs.unlinkSync(B); fs.unlinkSync(OUT); } catch {}
console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
process.exit(fails ? 1 : 0);

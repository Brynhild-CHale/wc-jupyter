// The renderer transport: discovery in the kernel, bytes on loopback, and a
// vendor payload shaped for the pane instead of dropped.
//
// This is the piece the whole JS-box design rests on, and the one that could not
// be taken on trust: the store cannot carry a 4.59 MiB renderer (~1.2M tokens in
// one get_store), the kernel silently discards it at that size, and Jupyter's own
// asset route does not exist on a bare server. So the service serves it.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
const fs = require('fs'), path = require('path');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const NB = FIX + '/renderer.ipynb';

fs.writeFileSync(NB, JSON.stringify({
  cells: [
    { cell_type: 'code', id: 'fig', execution_count: null, metadata: {}, outputs: [], source:
      'import plotly.graph_objects as go\nfig = go.Figure(go.Scatter(x=[1,2,3], y=[4,5,6]))\nfig.update_layout(title="probe", width=420, height=300)\nfig' },
    { cell_type: 'code', id: 'plain', execution_count: null, metadata: {}, outputs: [], source: 'print("hello")' },
  ],
  metadata: { kernelspec: { name: 'python3', language: 'python' } }, nbformat: 4, nbformat_minor: 5,
}, null, 1));

let store = {}; let onEv = null;
const mk = (extra) => ({
  name: 'jpy-notebook', mountId: 'rn', params: { notebooks: [NB], ...(extra || {}) }, webChatDir: FIX + '/.web-chat',
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
const until = async (p, w, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p()) return true; await new Promise(r => setTimeout(r, 150)); } return false; };
let fails = 0; const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 120) : '')); };
const note = (l, v) => console.log('  ----  ' + l + '  -> ' + String(v));

console.log('— renderers are OFF unless the param says so —');
store = {}; sq = 0;
await svc.start(mk());
await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering', 'connect');
await new Promise(r => setTimeout(r, 400));
ok('no renderers advertised without the param',
  !store.jpy_render || store.jpy_render.enabled === false, JSON.stringify(store.jpy_render));
await stopSvc();

console.log('\n— with renderers:true, the kernel is asked where its JS lives —');
store = {}; sq = 0;
await svc.start(mk({ renderers: true }));
await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering', 'connect');
ok('connected', store.jpy_conn.ok === true, store.jpy_conn.error);
ok('a renderer manifest was published', await until(() => store.jpy_render && store.jpy_render.enabled, 'manifest'), JSON.stringify(store.jpy_render || {}).slice(0, 120));
let R = (store.jpy_render || {}).renderers || {};

// Install it from here if the kernel does not have it. This is the "manage
// extensions from chat" path under test as much as it is setup: %pip in the LIVE
// kernel, then re-discover, with nothing restarting — not the service, not the
// pane, not the Jupyter server.
if (!(R.plotly && R.plotly.available)) {
  console.log('\n— installing plotly into the live kernel (nothing restarts) —');
  const t0 = Date.now();
  ctl('install', { package: 'plotly' });
  const done = await until(() => store.jpy_install && ['installed', 'unavailable', 'refused'].includes(store.jpy_install.state), 'install', 300000);
  ok('the install reported back', done, JSON.stringify(store.jpy_install || {}).slice(0, 120));
  note('took', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  ok('...and it succeeded', store.jpy_install && store.jpy_install.state === 'installed', store.jpy_install && (store.jpy_install.detail || store.jpy_install.state));
  ok('the manifest picked it up with no restart', await until(() => { R = (store.jpy_render || {}).renderers || {}; return R.plotly && R.plotly.available; }, 'rediscover', 30000), JSON.stringify(R.plotly || {}).slice(0, 110));
}

console.log('\n— a junk package name never reaches the kernel —');
ctl('install', { package: 'plotly; import os; os.system("touch /tmp/pwned")' });
await until(() => store.jpy_install && store.jpy_install.state === 'refused', 'refusal', 8000);
ok('refused before execution', store.jpy_install && store.jpy_install.state === 'refused', JSON.stringify(store.jpy_install || {}).slice(0, 110));
ok('...and nothing ran', !fs.existsSync('/tmp/pwned'));

note('plotly', JSON.stringify(R.plotly || {}).slice(0, 150));
note('vega', JSON.stringify(R.vega || {}).slice(0, 120));

if (R.plotly && R.plotly.available) {
  ok('plotly reports a version', typeof R.plotly.version === 'string', R.plotly.version);
  ok('...and a loopback URL, not bytes', /^http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]+\.js$/.test(R.plotly.url), R.plotly.url);
  ok('...sized like the real bundle (>1 MiB)', R.plotly.bytes > 1024 * 1024, R.plotly.bytes);
  const manifestBytes = JSON.stringify(store.jpy_render).length;
  ok('the STORE carries only the URL', manifestBytes < 2000, manifestBytes + ' B for the whole manifest vs ' + R.plotly.bytes + ' B of JS');

  console.log('\n— the loopback server —');
  const res = await fetch(R.plotly.url);
  const body = await res.text();
  ok('serves the bundle', res.status === 200, res.status);
  ok('...as JavaScript', /javascript/.test(res.headers.get('content-type') || ''), res.headers.get('content-type'));
  ok('...with nosniff', res.headers.get('x-content-type-options') === 'nosniff');
  ok('...and NO CORS header, so only a <script src> can read it', !res.headers.get('access-control-allow-origin'), res.headers.get('access-control-allow-origin'));
  ok('the bytes are really plotly', /plotly\.js v/.test(body.slice(0, 400)) && body.includes('newPlot'), body.slice(0, 60).replace(/\n/g, ' '));
  const bad = await fetch(R.plotly.url.replace(/\/a\/[^.]+/, '/a/' + 'x'.repeat(24)));
  ok('an unknown id is refused', bad.status === 404, bad.status);
  const trav = await fetch('http://127.0.0.1:' + new URL(R.plotly.url).port + '/a/../../etc/passwd');
  ok('traversal is refused', trav.status === 404 || trav.status === 400, trav.status);
} else {
  note('plotly not installed in this kernel — transport assertions skipped', R.plotly && R.plotly.why);
}

console.log('\n— a vendor payload reaches the pane as a spec, not as nothing —');
ctl('run', { cell: 'fig' });
const ran = await until(() => store.jpy_out_fig && ['ok', 'error'].includes(store.jpy_out_fig.state), 'run', 60000);
ok('the cell ran', ran && store.jpy_out_fig.state === 'ok', store.jpy_out_fig && store.jpy_out_fig.state);
const outs = (store.jpy_out_fig || {}).outputs || [];
const vend = outs.find(o => o.kind === 'vendor');
ok('it produced a vendor output (it used to produce NOTHING)', !!vend, outs.map(o => o.kind).join(','));
if (vend) {
  ok('named as plotly', vend.renderer === 'plotly', vend.renderer);
  ok('carrying the spec itself', vend.spec && Array.isArray(vend.spec.data), Object.keys(vend.spec || {}).join(','));
  ok('the spec is cheap enough for the store', vend.bytes < 100000, vend.bytes + ' B');
  ok('with a text/plain fallback for when the renderer is missing', typeof vend.plain === 'string', JSON.stringify(vend.plain).slice(0, 60));
}

console.log('\n— an ordinary cell is untouched —');
ctl('run', { cell: 'plain', source: 'print("hello")' });
await until(() => store.jpy_out_plain && ['ok', 'error'].includes(store.jpy_out_plain.state), 'plain');
ok('still a plain stream', ((store.jpy_out_plain || {}).outputs || []).some(o => o.kind === 'stream' && String(o.text).includes('hello')),
  JSON.stringify((store.jpy_out_plain || {}).outputs || []).slice(0, 90));

await stopSvc();
try { fs.unlinkSync(NB); } catch {}
console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
process.exit(fails ? 1 : 0);

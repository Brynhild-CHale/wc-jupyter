// 08-plotly-selfsufficiency.mjs — IS THE vnd.plotly.v1+json PAYLOAD ACTUALLY DRAWABLE?
//
// An INDEPENDENT re-check of the claim reported out of the "mime-bundles" probe:
//
//   CLAIM: "The vnd.plotly.v1+json payload is self-sufficient for a JS box to draw with.
//           Call Plotly.newPlot(div, payload.data, payload.layout, <your own config>).
//           No extra state, no prior output needed."
//
// 03-mime-bundles.mjs established the SHAPE of the payload by asking Python what keys
// it has. That is not the same as establishing that a browser can draw it. This probe
// does the missing half: it takes the exact bytes off the kernel's iopub channel and
// feeds them to the real plotly.js from the user's own install, inside a real
// <iframe sandbox="allow-scripts"> in a real Chrome, and reports what got drawn and
// what the page tried to fetch while drawing it.
//
// It deliberately hunts for the ways the convenient answer could be wrong:
//   - is layout.template an inlined object, or a NAME plotly.js has never heard of?
//   - does newPlot resolve but draw nothing?
//   - does drawing reach for the network (topojson, MathJax, fonts) from an origin
//     that is "null" and cannot use credentials?
//   - does the pane's own mime ladder even see the bundle?
//
// SAFETY. It starts its OWN jupyter_server (default :8933) in a throwaway `uv run`
// env and kills it on the way out, including on Ctrl-C. JUPYTER_RUNTIME_DIR is
// redirected into a temp dir so the pack's runtime-file discovery cannot find it.
// Ports 8888 / 8899 (the user's live server) and 5176 (the web-chat daemon) are
// refused outright. It never speaks to the daemon.
//
// Run:   node test/feasibility/08-plotly-selfsufficiency.mjs
// Env:   JPY_PROBE_PORT (8933)   CHROME (path to a Chrome/Chromium binary)
//        JPY_PROBE_KEEP=1 (leave the jupyter server up for poking at)
//
// Writes 08-plotly-selfsufficiency.results.json next to itself.

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.resolve(HERE, '../..');
const SERVICE = path.join(PACK, 'components/jpy-notebook/service.js');
const RESULTS = path.join(HERE, '08-plotly-selfsufficiency.results.json');

const WANT = Number(process.env.JPY_PROBE_PORT || 8933);
const FORBIDDEN = new Set([8888, 8899, 5173, 5174, 5175, 5176]);
const KEEP = process.env.JPY_PROBE_KEEP === '1';
const TOKEN = 'probe' + Math.random().toString(36).slice(2, 12);
let PORT = WANT;
let BASE = `http://127.0.0.1:${PORT}/`;

const PKGS = ['jupyter-server', 'ipykernel', 'plotly'];

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? null), 'utf8');
const num = (n) => Number(n).toLocaleString('en-US');
const kb = (n) => (n < 1024 ? `${num(n)} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const oneline = (s, n = 110) => String(s).replace(/\s+/g, ' ').slice(0, n);
const H = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const h = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

const R = { meta: {}, payloads: {}, python: {}, browser: {}, checks: [], notes: [] };
let fails = 0;
const ok = (label, cond, detail) => {
  if (!cond) fails++;
  R.checks.push({ label, pass: !!cond, detail: detail === undefined ? null : String(detail).slice(0, 400) });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  -> ' + oneline(detail, 120) : ''}`);
};
const fact = (label, value) => {
  R.notes.push({ label, value: typeof value === 'string' ? value : JSON.stringify(value) });
  console.log(`  FACT  ${pad(label, 42)} -> ${oneline(value, 130)}`);
};

// The pane's real ladder, read out of the shipped service so this probe cannot
// drift from the code it is judging.
function paneContract() {
  try {
    const src = fs.readFileSync(SERVICE, 'utf8');
    const lad = src.match(/const MIME_LADDER = \[([\s\S]*?)\];/);
    const cap = src.match(/const MAX_OUT_BYTES = ([^;]+);/);
    return {
      ladder: lad ? [...lad[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [],
      maxOutBytes: cap ? Number(Function('return ' + cap[1])()) : null,
    };
  } catch (e) { return { ladder: [], maxOutBytes: null, error: String(e) }; }
}
const PANE = paneContract();

// ---------------------------------------------------------------------------
// jupyter server lifecycle  (our own, never the user's)
// ---------------------------------------------------------------------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-jpy-selfsuf-'));
const RUNTIME = path.join(ROOT, 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });

let server = null, kernelId = null, ws = null, chrome = null, statics = null;
const auth = { Authorization: 'token ' + TOKEN };
const api = (p, init) => fetch(BASE + p, { ...(init || {}), headers: { ...auth, ...((init || {}).headers || {}) } });

const portFree = (p) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  const done = (free) => { try { s.destroy(); } catch {} res(free); };
  s.setTimeout(700);
  s.once('connect', () => done(false));
  s.once('error', () => done(true));
  s.once('timeout', () => done(false));
});

async function claimPort() {
  for (let p = WANT; p < WANT + 12; p++) {
    if (FORBIDDEN.has(p)) continue;
    if (await portFree(p)) { PORT = p; BASE = `http://127.0.0.1:${PORT}/`; return p; }
  }
  throw new Error(`no free port in ${WANT}..${WANT + 11}`);
}

async function startServer() {
  const args = ['run', '--no-project'];
  for (const p of PKGS) args.push('--with', p);
  args.push('python', '-m', 'jupyter_server', '--no-browser', `--port=${PORT}`,
    '--ServerApp.ip=127.0.0.1', `--ServerApp.token=${TOKEN}`, `--ServerApp.root_dir=${ROOT}`,
    '--ServerApp.open_browser=False', '--ServerApp.disable_check_xsrf=True');
  server = spawn('uv', args, {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, JUPYTER_RUNTIME_DIR: RUNTIME, PYDEVD_DISABLE_FILE_VALIDATION: '1' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    try {
      const r = await api('api/status');
      if (r.ok) return { ms: Date.now() - t0, status: await r.json() };
    } catch {}
    if (server.exitCode !== null) throw new Error('server died:\n' + log.slice(-1500));
    await sleep(400);
  }
  throw new Error('server never came up:\n' + log.slice(-1500));
}

function stopAll() {
  try { if (ws) ws.close(); } catch {}
  try { if (chrome) process.kill(-chrome.pid, 'SIGKILL'); } catch {}
  try { if (chrome) chrome.kill('SIGKILL'); } catch {}
  try { if (statics) statics.close(); } catch {}
  if (server && !KEEP) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
    try { server.kill('SIGTERM'); } catch {}
  }
}
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });

// ---------------------------------------------------------------------------
// kernel: REST start + WS drive (the protocol service.js speaks)
// ---------------------------------------------------------------------------
const SESSION = 'selfsuf-' + Math.random().toString(36).slice(2);
const waiters = new Map();

async function startKernel() {
  const r = await api('api/kernels', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'python3' }),
  });
  if (!r.ok) throw new Error('kernel start HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  kernelId = (await r.json()).id;
  return kernelId;
}

async function openSocket() {
  const u = new URL(BASE + 'api/kernels/' + kernelId + '/channels');
  u.protocol = 'ws:';
  u.searchParams.set('token', TOKEN);
  ws = new WebSocket(u.toString());
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws timeout')), 30000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws refused')); };
  });
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    try { m.__bytes = Buffer.byteLength(ev.data, 'utf8'); } catch { m.__bytes = null; }
    const pid = m.parent_header && m.parent_header.msg_id;
    const w = pid && waiters.get(pid);
    if (!w) return;
    w.msgs.push(m);
    if (m.msg_type === 'execute_reply') w.reply = m;
    if (m.msg_type === 'status' && m.content && m.content.execution_state === 'idle') w.idle = true;
    if (w.idle && w.reply) { clearTimeout(w.timer); setTimeout(() => { waiters.delete(pid); w.resolve(w.msgs); }, 150); }
  };
}

let seq = 0;
function run(code, timeout = 180000) {
  const id = 'selfsuf-' + (++seq) + '-' + Date.now();
  const frame = {
    header: { msg_id: id, username: 'probe', session: SESSION, msg_type: 'execute_request', version: '5.3' },
    parent_header: {}, metadata: {},
    content: { code, silent: false, store_history: true, allow_stdin: false, stop_on_error: false },
    channel: 'shell',
  };
  return new Promise((resolve, reject) => {
    const w = { msgs: [], resolve, idle: false, reply: null };
    w.timer = setTimeout(() => { waiters.delete(id); reject(new Error('cell timed out:\n' + code.slice(0, 160))); }, timeout);
    waiters.set(id, w);
    ws.send(JSON.stringify(frame));
  });
}

function analyse(msgs) {
  const out = { outputs: [], stdout: '', stderr: '', errors: [], json: [] };
  for (const m of msgs) {
    if (m.msg_type === 'stream') {
      const t = m.content.text || '';
      if (m.content.name === 'stderr') out.stderr += t; else out.stdout += t;
    } else if (m.msg_type === 'display_data' || m.msg_type === 'execute_result') {
      out.outputs.push({ type: m.msg_type, data: m.content.data || {}, metadata: m.content.metadata || {}, wire_bytes: m.__bytes });
    } else if (m.msg_type === 'error') {
      out.errors.push({ ename: m.content.ename, evalue: m.content.evalue, tb: (m.content.traceback || []).join('\n').slice(0, 1200) });
    }
  }
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('PROBE_JSON ')) { try { out.json.push(JSON.parse(line.slice(11))); } catch (e) { out.json.push({ parse_error: String(e) }); } }
  }
  return out;
}

async function cell(code) {
  const t0 = Date.now();
  const a = analyse(await run(code));
  a.ms = Date.now() - t0;
  if (a.errors.length) console.log(`  !! kernel error: ${a.errors[0].ename}: ${oneline(a.errors[0].evalue, 120)}`);
  return a;
}

// ---------------------------------------------------------------------------
// chrome: find a binary, drive it over CDP (no npm dependencies)
// ---------------------------------------------------------------------------
function findChrome() {
  const cands = [];
  if (process.env.CHROME) cands.push(process.env.CHROME);
  const globDirs = (base, tail) => {
    try {
      for (const d of fs.readdirSync(base)) cands.push(path.join(base, d, ...tail));
    } catch {}
  };
  globDirs(path.join(os.homedir(), '.cache/puppeteer/chrome'),
    ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']);
  globDirs(path.join(os.homedir(), '.cache/puppeteer/chrome'),
    ['chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']);
  globDirs(path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']);
  globDirs(path.join(os.homedir(), 'Library/Caches/ms-playwright'), ['chrome-mac/Chromium.app/Contents/MacOS/Chromium']);
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  cands.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
  return null;
}

class CDP {
  constructor(wsUrl) { this.id = 0; this.pend = new Map(); this.listeners = []; this.wsUrl = wsUrl; }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('cdp ws timeout')), 20000);
      this.ws.addEventListener('open', () => { clearTimeout(t); res(); });
      this.ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('cdp ws error')); });
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pend.has(m.id)) {
        const [res, rej] = this.pend.get(m.id); this.pend.delete(m.id);
        m.error ? rej(new Error(m.method + ' ' + JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        for (const fn of this.listeners) fn(m);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const i = ++this.id;
    return new Promise((res, rej) => {
      this.pend.set(i, [res, rej]);
      this.ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error(method + ' timed out')); } }, 60000);
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

// ---------------------------------------------------------------------------
// the page the JS box proposal actually describes
// ---------------------------------------------------------------------------
// JSON that is safe to drop inside a <script> in an HTML document, and safe to
// nest inside another document's srcdoc.
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function boxSrcdoc({ payload, mode, jsUrl, pingUrl, waitMs }) {
  return `<!doctype html><meta charset="utf-8">
<body style="margin:0"><div id="plot"></div>
<script src="${jsUrl}"><\/script>
<script>
(function () {
  var out = { mode: ${safeJson(mode)}, origin: String(location.origin), onerror: [], console_err: [] };
  var reported = false;
  function report(o) { if (reported) return; reported = true; try { parent.postMessage(JSON.stringify(o), '*'); } catch (e) {} }
  window.onerror = function (m) { out.onerror.push(String(m).slice(0, 200)); };
  try { out.localStorage = typeof localStorage; localStorage.setItem('x', '1'); out.localStorage_write = 'allowed'; }
  catch (e) { out.localStorage_write = 'threw ' + e.name; }
  try { out.parent_document = !!parent.document; } catch (e) { out.parent_document = 'threw ' + e.name; }
  try { out.top_href = String(top.location.href).slice(0, 60); } catch (e) { out.top_href = 'threw ' + e.name; }
  // Positive control: a request the probe MUST see, or "it made no requests"
  // is a statement about the listener, not about plotly.
  try { fetch(${safeJson(pingUrl)}).then(function (r) { out.ping_status = r.status; }, function (e) { out.ping_status = 'failed ' + e.name; }); } catch (e) { out.ping_status = 'threw'; }
  out.has_Plotly = typeof window.Plotly;
  if (typeof window.Plotly === 'undefined') { out.ok = false; out.err = 'no Plotly global after <script src>'; return report(out); }
  out.plotly_version = String(window.Plotly.version || '?');
  out.newPlot_type = typeof window.Plotly.newPlot;
  var payload = ${safeJson(payload)};
  var args, gd = document.getElementById('plot');
  if (out.mode === 'no_layout') args = [payload.data];
  else if (out.mode === 'no_template') { var L = JSON.parse(JSON.stringify(payload.layout || {})); delete L.template; args = [payload.data, L]; }
  else if (out.mode === 'data_only_string_template') { var S = JSON.parse(JSON.stringify(payload.layout || {})); S.template = 'plotly'; args = [payload.data, S]; }
  else args = [payload.data, payload.layout];
  out.arg_count = args.length;
  var t0 = performance.now();
  try {
    Promise.resolve(window.Plotly.newPlot.apply(window.Plotly, [gd].concat(args))).then(function () {
      out.ok = true;
      out.ms = Math.round(performance.now() - t0);
      out.svg = gd.querySelectorAll('svg').length;
      out.canvas = gd.querySelectorAll('canvas').length;
      out.trace_nodes = gd.querySelectorAll('.trace').length;
      out.point_nodes = gd.querySelectorAll('.point').length;
      out.line_nodes = gd.querySelectorAll('.js-line').length;
      out.geo_paths = gd.querySelectorAll('.geo path').length;
      out.basemap_paths = gd.querySelectorAll('.geo .coastlines path, .geo .land path, .geo .countries path, .landlayer path, .coastlinelayer path').length;
      out.topojson_url = (gd._context && gd._context.topojsonURL) || null;
      out.geo_assets = (window.PlotlyGeoAssets ? Object.keys(window.PlotlyGeoAssets) : null);
      var t = gd.querySelector('.gtitle');
      out.title_text = t ? t.textContent : null;
      out.data_len = (gd.data || []).length;
      out.full_template = !!(gd._fullLayout && gd._fullLayout.template);
      out.plot_bg = (function () { var b = gd.querySelector('.bg'); return b ? (b.getAttribute('fill') || getComputedStyle(b).fill) : null; })();
      var r = gd.getBoundingClientRect();
      out.box = { w: Math.round(r.width), h: Math.round(r.height) };
      out.svg_px = (function () { var s = gd.querySelector('svg'); if (!s) return null; var q = s.getBoundingClientRect(); return { w: Math.round(q.width), h: Math.round(q.height) }; })();
      out.dom_bytes = gd.innerHTML.length;
      setTimeout(function () { report(out); }, ${waitMs});
    }, function (e) {
      out.ok = false; out.err = String((e && e.message) || e).slice(0, 300);
      out.stack = String((e && e.stack) || '').slice(0, 400);
      report(out);
    });
  } catch (e) {
    out.ok = false; out.err = 'threw sync: ' + String((e && e.message) || e).slice(0, 300);
    report(out);
  }
  setTimeout(function () { if (!reported) { out.ok = false; out.err = 'newPlot never settled'; report(out); } }, ${waitMs + 12000});
})();
<\/script>`;
}

function parentPage(srcdoc) {
  return `<!doctype html><meta charset="utf-8"><title>jsbox</title>
<body style="margin:0;background:#fff">
<div id="host"></div>
<script>
window.__result = null;
addEventListener('message', function (e) {
  var d; try { d = JSON.parse(e.data); } catch (err) { d = { raw: String(e.data).slice(0, 200) }; }
  window.__result = { origin: String(e.origin), payload: d };
});
var f = document.createElement('iframe');
f.setAttribute('sandbox', 'allow-scripts');
f.style.cssText = 'width:640px;height:420px;border:0';
f.srcdoc = "@@SRCDOC@@";
document.getElementById('host').appendChild(f);
<\/script>`.replace('"@@SRCDOC@@"', () => safeJson(srcdoc));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const t00 = Date.now();
try {
  H('0 — SETUP');
  if (FORBIDDEN.has(WANT)) throw new Error(`refusing port ${WANT}: reserved for the user's live services`);
  await claimPort();
  fact('probe port (never 8899 / 5176)', PORT);
  fact('probe root_dir', ROOT);
  fact('pane mime ladder today', PANE.ladder.join(' > ') || '(could not read service.js)');
  fact('pane per-output cap', PANE.maxOutBytes ? kb(PANE.maxOutBytes) : '?');

  const CHROME = findChrome();
  fact('chrome binary', CHROME || 'NONE FOUND — the execution half will be skipped');

  const boot = await startServer();
  fact('jupyter_server up in', `${(boot.ms / 1000).toFixed(1)}s   version ${boot.status ? '' : ''}${JSON.stringify(boot.status).slice(0, 80)}`);
  await startKernel();
  await openSocket();
  fact('kernel', kernelId);
  R.meta = { port: PORT, root: ROOT, chrome: CHROME, kernel: kernelId, node: process.version, started: new Date().toISOString() };

  // -- 1. the payload, off the wire ----------------------------------------
  H('1 — THE PAYLOAD, TAKEN OFF THE IOPUB CHANNEL');

  const env = await cell(`
import sys, os, json, plotly, plotly.io as pio, plotly.graph_objects as go
print('PROBE_JSON ' + json.dumps({
  'python': sys.version.split()[0], 'prefix': sys.prefix, 'plotly': plotly.__version__,
  'default_renderer': str(pio.renderers.default), 'renderers': sorted(list(pio.renderers)),
  'plotly_dir': os.path.dirname(plotly.__file__)}))
`);
  const E = env.json[0] || {};
  R.python.env = E;
  fact('python / plotly', `${E.python} / plotly ${E.plotly}`);
  fact('pio.renderers.default', E.default_renderer);

  // The same figure 03 used, so the numbers are comparable to the claim.
  const c1 = await cell(`
fig = go.Figure(go.Scatter(x=[1,2,3,4], y=[4,1,9,3], mode='lines+markers', name='probe'))
fig.update_layout(title='probe figure', width=420, height=300)
fig
`);
  const out1 = c1.outputs[0];
  const bundleKeys = out1 ? Object.keys(out1.data) : [];
  R.payloads.scatter_bundle_keys = bundleKeys;
  ok('the figure produced an output at all', !!out1, out1 ? out1.type : 'none');
  fact('bundle keys (default renderer)', bundleKeys.join(', ') || 'none');
  const PL = out1 && out1.data['application/vnd.plotly.v1+json'];
  ok('application/vnd.plotly.v1+json is present', !!PL, PL ? Object.keys(PL).join(',') : 'ABSENT');
  ok('the pane\'s ladder today would render NOTHING for it',
    !bundleKeys.some((k) => PANE.ladder.includes(k)),
    `ladder=[${PANE.ladder.join(',')}] vs bundle=[${bundleKeys.join(',')}]`);

  if (!PL) throw new Error('no vnd.plotly payload — nothing further to test');

  const payloadBytes = bytesOf(PL);
  const tpl = PL.layout && PL.layout.template;
  const tplBytes = tpl === undefined ? 0 : bytesOf(tpl);
  R.payloads.scatter = PL;
  R.payloads.scatter_metrics = {
    json_bytes: payloadBytes, top: Object.keys(PL).sort(), data_len: (PL.data || []).length,
    trace0_keys: Object.keys((PL.data || [{}])[0] || {}).sort(),
    layout_keys: Object.keys(PL.layout || {}).sort(),
    config: PL.config === undefined ? null : PL.config,
    has_frames: 'frames' in PL,
    template_type: tpl === undefined ? 'absent' : Array.isArray(tpl) ? 'array' : typeof tpl,
    template_bytes: tplBytes,
    template_keys: tpl && typeof tpl === 'object' ? Object.keys(tpl).sort() : null,
  };
  const M = R.payloads.scatter_metrics;
  h('the vnd.plotly.v1+json payload, dissected (node reading the wire bytes)');
  console.log('  ' + JSON.stringify({ ...M, template_keys: M.template_keys }, null, 2).split('\n').join('\n  '));

  ok('payload top-level is exactly {data, layout}', M.top.join(',') === 'data,layout', M.top.join(','));
  ok('payload carries NO config key', PL.config === undefined, 'config=' + JSON.stringify(PL.config));
  ok('payload carries no frames', !M.has_frames);
  ok('layout.template is an inlined OBJECT, not a name string',
    M.template_type === 'object', `${M.template_type}${M.template_type === 'string' ? ' = ' + JSON.stringify(tpl) : ''} (${kb(tplBytes)})`);
  fact('the whole iopub frame on the wire', `${kb(out1.wire_bytes || 0)} (one display_data message, JSON text frame)`);
  fact('template share of the payload', `${kb(tplBytes)} of ${kb(payloadBytes)} = ${((tplBytes / payloadBytes) * 100).toFixed(1)}%`);
  fact('payload with template stripped', kb(payloadBytes - tplBytes));
  fact('text/plain fallback in the bundle',
    out1.data['text/plain'] ? oneline(out1.data['text/plain'], 70) : 'ABSENT — a non-rendering pane has nothing to show');

  // Byte counts get quoted without saying which encoding they came from, and the
  // three differ by ~10%. Measure all of them against the same figure.
  const cz = await cell(`
import json
b = fig._repr_mimebundle_()
if isinstance(b, tuple): b = b[0]
pl = b['application/vnd.plotly.v1+json']
print('PROBE_JSON ' + json.dumps({
  'python_default_separators': len(json.dumps(pl).encode()),
  'python_compact_separators': len(json.dumps(pl, separators=(',', ':')).encode()),
  'fig_to_json': len(fig.to_json().encode())}))
`);
  const SZ = cz.json[0] || {};
  R.payloads.scatter_sizes = { ...SZ, node_compact: payloadBytes, iopub_frame: out1.wire_bytes };
  fact('same payload, four ways to count it',
    `python json.dumps default ${SZ.python_default_separators} B | python compact ${SZ.python_compact_separators} B | node JSON.stringify ${payloadBytes} B | whole iopub frame ${out1.wire_bytes} B`);

  // renderer forced to plotly_mimetype: same payload?
  const c2 = await cell(`
pio.renderers.default = 'plotly_mimetype'
fig
`);
  const PL2 = c2.outputs[0] && c2.outputs[0].data['application/vnd.plotly.v1+json'];
  ok('plotly_mimetype renderer emits a byte-identical payload',
    !!PL2 && bytesOf(PL2) === payloadBytes, PL2 ? `${kb(bytesOf(PL2))} vs ${kb(payloadBytes)}` : 'absent');

  // a figure whose drawing might need the network
  const c3 = await cell(`
gfig = go.Figure(go.Scattergeo(lon=[-74.0,-118.2,2.35], lat=[40.7,34.0,48.85], mode='markers', text=['NY','LA','Paris']))
gfig.update_layout(title='geo probe', width=420, height=300)
gfig
`);
  const GEO = c3.outputs[0] && c3.outputs[0].data['application/vnd.plotly.v1+json'];
  R.payloads.geo = GEO || null;
  fact('scattergeo payload', GEO ? `${kb(bytesOf(GEO))}, layout keys: ${Object.keys(GEO.layout || {}).join(',')}` : 'ABSENT');

  const c4 = await cell(`
lfig = go.Figure(go.Scatter(x=[1,2,3], y=[2,1,3]))
lfig.update_layout(title=r'$\\alpha + \\beta$', width=420, height=300)
lfig
`);
  const LTX = c4.outputs[0] && c4.outputs[0].data['application/vnd.plotly.v1+json'];
  R.payloads.latex = LTX || null;
  fact('LaTeX-title payload', LTX ? `${kb(bytesOf(LTX))}` : 'ABSENT');

  // -- 2. the renderer JS, in the user's own install -----------------------
  H('2 — THE RENDERER JS THAT SHIPS INSIDE THE PYTHON PACKAGE');

  const c5 = await cell(`
import os, re, json, plotly, glob
root = os.path.dirname(plotly.__file__)
cand = os.path.join(root, 'package_data', 'plotly.min.js')
info = {'candidate': cand, 'exists': os.path.exists(cand)}
if info['exists']:
    src = open(cand, encoding='utf8', errors='replace').read()
    info['bytes'] = os.path.getsize(cand)
    info['newPlot_hits'] = src.count('newPlot')
    m = re.search(r'plotly\\.js v(\\d+\\.\\d+\\.\\d+)', src)
    info['banner_version'] = m.group(1) if m else None
    info['head'] = src[:160]
    info['looks_umd'] = ('typeof exports' in src[:4000]) or ('typeof module' in src[:4000])
topo = []
for base in [root, os.path.join(os.sys.prefix, 'share', 'jupyter', 'labextensions')]:
    if not os.path.isdir(base): continue
    for dirpath, _dn, fn in os.walk(base):
        for f in fn:
            if 'topojson' in f.lower() or '_110m' in f.lower() or '_50m' in f.lower():
                fp = os.path.join(dirpath, f)
                topo.append({'path': os.path.relpath(fp, base), 'base': base, 'bytes': os.path.getsize(fp)})
info['topojson_files'] = sorted(topo, key=lambda d: -d['bytes'])[:8]
info['topojson_count'] = len(topo)
info['all_js'] = sorted([{'rel': os.path.relpath(p, root), 'bytes': os.path.getsize(p)}
                         for p in glob.glob(root + '/**/*.js', recursive=True)],
                        key=lambda d: -d['bytes'])[:6]
lab = os.path.join(os.sys.prefix, 'share', 'jupyter', 'labextensions')
info['labext_root'] = lab
info['labext'] = sorted(os.listdir(lab)) if os.path.isdir(lab) else 'MISSING'
if os.path.isdir(lab):
    ents = []
    for dirpath, _dn, fn in os.walk(lab):
        for f in fn:
            p = os.path.join(dirpath, f)
            ents.append({'rel': os.path.relpath(p, lab), 'bytes': os.path.getsize(p)})
    info['labext_files'] = sorted(ents, key=lambda d: -d['bytes'])[:6]
    info['labext_total'] = sum(e['bytes'] for e in ents)
print('PROBE_JSON ' + json.dumps(info))
`);
  const A = c5.json[0] || {};
  R.python.assets = A;
  ok('plotly.min.js ships inside the installed python package', !!A.exists, A.candidate);
  if (A.exists) {
    fact('plotly.min.js', `${kb(A.bytes)}   banner "plotly.js v${A.banner_version}"   newPlot occurrences ${A.newPlot_hits}   UMD-ish ${A.looks_umd}`);
    ok('the bundle actually contains newPlot', A.newPlot_hits > 0, A.newPlot_hits + ' hits');
  }
  ok('the install ships the geo topojson the CDN would otherwise serve',
    (A.topojson_count || 0) > 0,
    A.topojson_count ? `${A.topojson_count} file(s): ${(A.topojson_files || []).slice(0, 3).map((f) => f.path + ' ' + kb(f.bytes)).join(', ')}` : 'NONE in the package or the labextension');
  fact('labextensions dir', A.labext_root + ' -> ' + (Array.isArray(A.labext) ? A.labext.join(',') : A.labext));
  if (A.labext_total) fact('labextension payload', `${kb(A.labext_total)} across the tree; biggest: ${(A.labext_files || []).map((f) => f.rel + ' ' + kb(f.bytes)).slice(0, 3).join(', ')}`);

  // Does OUR OWN jupyter server hand those bytes out? (the delivery leg)
  h('can the running jupyter server hand a JS box the renderer bytes?');
  const tryUrls = [];
  if (Array.isArray(A.labext) && A.labext.length) {
    for (const name of A.labext) {
      const files = (A.labext_files || []).filter((f) => f.rel.startsWith(name + '/'));
      const re = files.find((f) => /remoteEntry.*\.js$/.test(f.rel)) || files[0];
      if (re) tryUrls.push('labextensions/' + re.rel);
    }
  }
  R.python.served = [];
  for (const u of tryUrls.slice(0, 4)) {
    let withTok = 'ERR', noTok = 'ERR', ct = '';
    try { const r = await api(u); withTok = r.status; ct = r.headers.get('content-type') || ''; } catch (e) { withTok = String(e).slice(0, 40); }
    try { const r = await fetch(BASE + u); noTok = r.status; } catch (e) { noTok = String(e).slice(0, 40); }
    R.python.served.push({ url: u, withToken: withTok, noToken: noTok, contentType: ct });
    console.log(`  ${pad(oneline(u, 58), 60)} token:${pad(withTok, 5)} no-token:${pad(noTok, 5)} ${ct}`);
  }

  const c6 = await cell(`
import re, json
html = fig.to_html(include_plotlyjs=False, full_html=False)
urls = re.findall(r'https?://[^\\s"\\'<>]+', html)
print('PROBE_JSON ' + json.dumps({'bytes': len(html.encode()), 'script_tags': html.count('<script'),
  'has_newPlot': 'newPlot' in html, 'urls': sorted(set(urls))[:4], 'head': html[:200]}))
`);
  const TH = c6.json[0] || {};
  R.python.to_html = TH;
  fact('fig.to_html(include_plotlyjs=False)', `${kb(TH.bytes || 0)}  <script>x${TH.script_tags}  newPlot:${TH.has_newPlot}  urls:${(TH.urls || []).join(' ') || 'none'}`);

  // -- 3. EXECUTION: does a sandboxed iframe actually draw it? -------------
  H('3 — EXECUTION: THE REAL plotly.js, IN A REAL sandbox="allow-scripts" IFRAME');

  if (!CHROME) {
    console.log('  SKIP — no Chrome/Chromium binary found. Set CHROME=/path/to/chrome and re-run.');
    R.browser.skipped = 'no chrome binary';
  } else if (!A.exists) {
    console.log('  SKIP — no plotly.min.js in the install to serve.');
    R.browser.skipped = 'no plotly.min.js';
  } else {
    // A tiny static server: stands in for "the renderer JS comes from the user's
    // own install", and lets us watch every request the box makes.
    const jsBuf = fs.readFileSync(A.candidate);
    const pages = new Map();
    const sport = await (async () => { for (let p = 8951; p < 8975; p++) { if (!FORBIDDEN.has(p) && await portFree(p)) return p; } throw new Error('no static port'); })();
    statics = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/plotly.min.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(jsBuf);
      }
      if (u.pathname === '/__probe_ping') { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
      const page = pages.get(u.pathname);
      if (page) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(page); }
      res.writeHead(404); res.end('no');
    });
    await new Promise((r) => statics.listen(sport, '127.0.0.1', r));
    const SBASE = `http://127.0.0.1:${sport}`;
    fact('static origin serving the renderer', `${SBASE}/plotly.min.js  (${kb(jsBuf.length)} from the install)`);

    const udd = path.join(ROOT, 'chrome-profile');
    const dport = await (async () => { for (let p = 9333; p < 9360; p++) { if (await portFree(p)) return p; } throw new Error('no devtools port'); })();
    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      '--disable-component-update', '--window-size=900,600',
      `--user-data-dir=${udd}`, `--remote-debugging-port=${dport}`, 'about:blank'],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let cerr = '';
    chrome.stderr.on('data', (d) => { cerr += d; });

    let ver = null;
    for (let i = 0; i < 80; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(250); }
    }
    if (!ver) throw new Error('chrome devtools never came up:\n' + cerr.slice(-800));
    fact('chrome', ver.Browser);
    R.browser.chrome = ver.Browser;

    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.open();

    const scenarios = [
      { name: 'contract', mode: 'contract', payload: PL, wait: 400, why: 'newPlot(div, payload.data, payload.layout) — exactly what the claim proposes' },
      { name: 'no_layout', mode: 'no_layout', payload: PL, wait: 400, why: 'is layout load-bearing, or does the data alone draw?' },
      { name: 'no_template', mode: 'no_template', payload: PL, wait: 400, why: 'is the inlined template load-bearing?' },
      { name: 'string_template', mode: 'data_only_string_template', payload: PL, wait: 400, why: 'what if template were a NAME instead of an object (the failure the payload avoids)' },
      ...(GEO ? [{ name: 'geo', mode: 'contract', payload: GEO, wait: 3000, why: 'does drawing reach for the network (topojson)?' }] : []),
      ...(GEO ? [{ name: 'geo_offline', mode: 'contract', payload: GEO, wait: 4000, block: ['*cdn.plot.ly*', '*plot.ly*'],
                   why: 'the same geo figure with the CDN BLOCKED — what does an offline JS box actually show?' }] : []),
      ...(LTX ? [{ name: 'latex_title', mode: 'contract', payload: LTX, wait: 2500, why: 'does a LaTeX title reach for MathJax?' }] : []),
    ];

    R.browser.scenarios = {};
    for (const s of scenarios) {
      const pagePath = '/p-' + s.name + '.html';
      pages.set(pagePath, parentPage(boxSrcdoc({ payload: s.payload, mode: s.mode, jsUrl: `${SBASE}/plotly.min.js`, pingUrl: `${SBASE}/__probe_ping?s=${s.name}`, waitMs: s.wait })));

      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const reqs = [];
      const failed = [];
      const consoleErr = [];
      // A sandboxed iframe gets its OWN target in Chrome (site isolation), so its
      // requests never reach the page session. Auto-attach and instrument every
      // child session too, or "it made no network requests" is an artefact of
      // not having been listening.
      const sessions = new Set([sessionId]);
      const instrument = async (sid) => {
        try {
          await cdp.send('Network.enable', {}, sid);
          await cdp.send('Log.enable', {}, sid);
          await cdp.send('Runtime.enable', {}, sid);
          await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid);
          if (s.block) await cdp.send('Network.setBlockedURLs', { urls: s.block }, sid);
        } catch {}
        try { await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid); } catch {}
      };
      const off = (m) => {
        if (m.method === 'Target.attachedToTarget' && sessions.has(m.sessionId || sessionId)) {
          const sid = m.params.sessionId;
          sessions.add(sid);
          instrument(sid);
          return;
        }
        if (!sessions.has(m.sessionId)) return;
        const where = m.sessionId === sessionId ? 'page' : 'frame';
        if (m.method === 'Network.requestWillBeSent') reqs.push({ url: m.params.request.url, type: m.params.type, where });
        if (m.method === 'Network.responseReceived') {
          const r = reqs.find((q) => q.url === m.params.response.url && q.status === undefined);
          if (r) { r.status = m.params.response.status; r.mime = m.params.response.mimeType; }
        }
        if (m.method === 'Network.loadingFailed') failed.push({ err: m.params.errorText, type: m.params.type, where });
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErr.push(where + ': ' + oneline((m.params.args || []).map((a) => a.value || a.description || '').join(' '), 160));
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErr.push(where + ': ' + oneline(m.params.entry.text + ' ' + (m.params.entry.url || ''), 160));
      };
      cdp.on(off);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Log.enable', {}, sessionId);
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      if (s.block) await cdp.send('Network.setBlockedURLs', { urls: s.block }, sessionId);
      cdp.send('Page.navigate', { url: SBASE + pagePath }, sessionId).catch(() => {});

      let got = null, gotSession = sessionId;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !got) {
        await sleep(250);
        for (const sid of [...sessions]) {
          try {
            const r = await cdp.send('Runtime.evaluate', { expression: 'window.__result && JSON.stringify(window.__result)', returnByValue: true }, sid);
            if (r.result && typeof r.result.value === 'string') { got = JSON.parse(r.result.value); gotSession = sid; break; }
          } catch {}
        }
      }
      let shot = null, shotPath = null;
      try {
        const sc = await cdp.send('Page.captureScreenshot', { format: 'png' }, gotSession);
        const buf = Buffer.from(sc.data, 'base64');
        shot = buf.length;
        shotPath = path.join(HERE, `08-shot-${s.name}.png`);
        fs.writeFileSync(shotPath, buf);
      } catch {}
      await cdp.send('Target.closeTarget', { targetId });
      cdp.listeners = cdp.listeners.filter((f) => f !== off);

      const p = got ? got.payload : null;
      const external = reqs.filter((r) => !r.url.startsWith(SBASE) && !r.url.startsWith('data:') && !r.url.startsWith('about:'));
      const frameReqs = reqs.filter((r) => r.where === 'frame');
      R.browser.scenarios[s.name] = { why: s.why, frame_origin: got ? got.origin : null, result: p, requests: reqs, frameReqs, external, failed, consoleErr, screenshot_bytes: shot, screenshot: shotPath };

      h(`scenario "${s.name}" — ${s.why}`);
      if (!p) { console.log('  NO RESULT — the box never posted back'); fails++; continue; }
      console.log(`  drew:${p.ok === true}  ${p.err ? 'err="' + oneline(p.err, 90) + '"' : ''}`);
      console.log(`  Plotly global:${p.has_Plotly} v${p.plotly_version}  newPlot:${p.newPlot_type}  args passed:${p.arg_count}  ms:${p.ms}`);
      console.log(`  DOM: svg=${p.svg} canvas=${p.canvas} .trace=${p.trace_nodes} .point=${p.point_nodes} .js-line=${p.line_nodes} geo-paths=${p.geo_paths} title=${JSON.stringify(p.title_text)}`);
      console.log(`  size: gd ${p.box && p.box.w}x${p.box && p.box.h}  svg ${p.svg_px && p.svg_px.w}x${p.svg_px && p.svg_px.h}  innerHTML ${kb(p.dom_bytes || 0)}  plot bg ${p.plot_bg}`);
      console.log(`  isolation: frame origin ${JSON.stringify(got.origin)} / location.origin ${JSON.stringify(p.origin)}  parent.document:${p.parent_document}  top.location:${p.top_href}  localStorage write:${p.localStorage_write}`);
      console.log(`  requests: ${reqs.length} total (${frameReqs.length} from inside the box), ${external.length} off our origin${external.length ? ' -> ' + external.map((r) => oneline(r.url, 70)).join(' | ') : ''}`);
      for (const r of reqs) console.log(`      [${r.where}] ${pad(r.status === undefined ? '---' : r.status, 4)} ${pad(r.type || '?', 10)} ${oneline(r.url, 78)}`);
      if (p.topojson_url !== undefined) console.log(`  geo: basemap paths=${p.basemap_paths} topojsonURL=${JSON.stringify(p.topojson_url)} PlotlyGeoAssets=${JSON.stringify(p.geo_assets)}`);
      if (failed.length) console.log(`  failed loads: ${failed.map((f) => f.type + ' ' + f.err).join(', ')}`);
      if (consoleErr.length) console.log(`  console errors: ${consoleErr.slice(0, 3).join(' | ')}`);
      if (p.onerror && p.onerror.length) console.log(`  window.onerror: ${p.onerror.slice(0, 3).join(' | ')}`);
      if (shot) console.log(`  screenshot: ${kb(shot)} of PNG came back (page rendered)`);
    }

    // ---- the verdicts that matter -----------------------------------------
    h('verdicts');
    const S = R.browser.scenarios;
    const c = S.contract && S.contract.result;
    ok('a null-origin sandboxed iframe loaded plotly.js cross-origin via <script src>',
      !!(c && c.has_Plotly === 'object'), c ? `typeof Plotly = ${c.has_Plotly}, v${c.plotly_version}` : 'no result');
    ok('newPlot(div, payload.data, payload.layout) DREW the figure',
      !!(c && c.ok === true && c.svg > 0 && c.trace_nodes > 0),
      c ? `ok=${c.ok} svg=${c.svg} traces=${c.trace_nodes} points=${c.point_nodes}` : 'no result');
    ok('the drawn figure honoured the payload\'s title',
      !!(c && c.title_text === 'probe figure'), c && JSON.stringify(c.title_text));
    ok('the drawn figure honoured the payload\'s width/height (420x300)',
      !!(c && c.svg_px && c.svg_px.w === 420 && c.svg_px.h === 300), c && JSON.stringify(c.svg_px));
    // Guard: "no requests" is only evidence if we were actually listening to the
    // iframe's own target. Prove the instrumentation saw the box fetch plotly.js.
    ok('INSTRUMENTATION: a request made from inside the box was visible to the probe',
      !!(S.contract && S.contract.frameReqs.some((r) => /__probe_ping/.test(r.url))),
      S.contract && ('frame reqs: ' + (S.contract.frameReqs.map((r) => oneline(r.url, 50)).join(' | ') || 'NONE — network findings below are unproven')));
    ok('drawing the scatter made ZERO off-origin requests (no CDN, no fonts)',
      !!(S.contract && S.contract.external.length === 0),
      S.contract && (S.contract.external.map((r) => r.url).join(' ') || `none of ${S.contract.requests.length} observed`));
    ok('the box is isolated: origin null, parent.document unreachable',
      !!(c && c.origin === 'null' && String(c.parent_document).startsWith('threw')),
      c && `origin=${c.origin} parent.document=${c.parent_document}`);
    if (S.no_layout) ok('data alone still draws (layout is optional, not required)',
      !!(S.no_layout.result && S.no_layout.result.ok), S.no_layout.result && `svg=${S.no_layout.result.svg}`);
    if (S.no_template) ok('stripping the inlined template still draws (template is style, not structure)',
      !!(S.no_template.result && S.no_template.result.ok),
      S.no_template.result && `bg with template=${c && c.plot_bg} / without=${S.no_template.result.plot_bg}`);
    if (S.string_template) {
      const r = S.string_template.result;
      fact('if layout.template were a NAME string instead', r ? (r.ok ? `still drew (bg ${r.plot_bg})` : 'FAILED: ' + oneline(r.err, 80)) : 'no result');
    }
    if (S.geo) {
      const g = S.geo;
      ok('CHALLENGE: a scattergeo payload draws with NO network reach-out',
        !!(g.result && g.result.ok && g.external.length === 0),
        `ok=${g.result && g.result.ok} geo-paths=${g.result && g.result.geo_paths} external=${g.external.map((r) => oneline(r.url, 60)).join(' ') || 'none'}`);
      fact('geo base map (land/coastlines) drawn offline',
        g.result ? `${g.result.basemap_paths} basemap path(s); topojsonURL=${JSON.stringify(g.result.topojson_url)}; cached assets=${JSON.stringify(g.result.geo_assets)}` : 'no result');
    }
    if (S.latex_title) {
      const l = S.latex_title;
      ok('CHALLENGE: a LaTeX title draws with NO network reach-out',
        !!(l.result && l.result.ok && l.external.length === 0),
        `title=${JSON.stringify(l.result && l.result.title_text)} external=${l.external.map((r) => oneline(r.url, 60)).join(' ') || 'none'}`);
    }
  }

} catch (e) {
  fails++;
  console.error('\n!! PROBE ABORTED: ' + (e && e.stack || e));
  R.abort = String(e && e.message || e);
} finally {
  H('CLEANUP');
  if (kernelId && !KEEP) {
    try { const r = await api('api/kernels/' + kernelId, { method: 'DELETE' }); console.log(`  kernel deleted -> HTTP ${r.status}`); } catch (e) { console.log('  kernel delete failed: ' + e); }
  }
  stopAll();
  await sleep(600);
  console.log(`  jupyter on :${PORT} ${KEEP ? 'LEFT UP (JPY_PROBE_KEEP=1)' : 'stopped'}   port now free: ${await portFree(PORT)}`);
  try { if (!KEEP) fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  R.meta.ms = Date.now() - t00;
  R.meta.fails = fails;
  fs.writeFileSync(RESULTS, JSON.stringify(R, null, 2));
  console.log(`  wrote ${RESULTS}`);
  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}  in ${(R.meta.ms / 1000).toFixed(1)}s`);
  process.exit(0);
}

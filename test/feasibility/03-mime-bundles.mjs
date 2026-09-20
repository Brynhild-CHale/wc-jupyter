// 03-mime-bundles.mjs — WHAT THE LIBRARIES ACTUALLY EMIT
//
// Feasibility probe for the "JS box" proposal (render vendor mime bundles inside
// an <iframe sandbox="allow-scripts">, loading renderer JS from the user's own
// install). This script answers the only question that comes first: which mime
// keys do real figures from real libraries actually put on the wire, how big are
// they, and is the payload self-sufficient?
//
// It measures. Nothing here is asserted from documentation.
//
//   - Starts its OWN jupyter_server (default port 8913) in a throwaway `uv run`
//     env holding plotly, altair, bokeh, pandas, matplotlib, ipywidgets.
//     JUPYTER_RUNTIME_DIR is redirected to a temp dir so this server is NOT
//     discoverable by the pack's own runtime-file discovery — it cannot be
//     mistaken for the user's live server.
//   - Starts one kernel, drives it over the REST + WebSocket protocol with
//     Node's globals (same protocol service.js speaks), runs real figures, and
//     records every iopub message.
//   - Shuts the kernel down and kills the server on the way out, including on
//     Ctrl-C.
//
// Run:   node test/feasibility/03-mime-bundles.mjs
// Env:   JPY_PROBE_PORT (8913)  JPY_PROBE_KEEP=1 (leave the server up)
//
// It writes the full raw record next to itself as 03-mime-bundles.results.json.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.resolve(HERE, '../..');
const SERVICE = path.join(PACK, 'components/jpy-notebook/service.js');
// The preferred port is 8913; if something is already listening there (another
// probe, a stale run) we walk upward rather than touch it. NEVER 8899 — that is
// the user's live server.
const WANT = Number(process.env.JPY_PROBE_PORT || 8913);
const FORBIDDEN = new Set([8888, 8899]);
let PORT = WANT;
const TOKEN = 'probe' + Math.random().toString(36).slice(2, 12);
let BASE = `http://127.0.0.1:${PORT}/`;
const KEEP = process.env.JPY_PROBE_KEEP === '1';
const RESULTS = path.join(HERE, '03-mime-bundles.results.json');

const PKGS = ['jupyter-server', 'ipykernel', 'plotly', 'altair', 'bokeh', 'pandas', 'matplotlib', 'ipywidgets'];

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? null), 'utf8');
const num = (n) => n.toLocaleString('en-US');
const kb = (n) => (n < 1024 ? `${num(n)} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const oneline = (s, n = 90) => String(s).replace(/\s+/g, ' ').slice(0, n);
const H = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const h = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);

const record = { meta: {}, cells: {}, notes: [] };
let fails = 0;
const ok = (label, cond, detail) => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  -> ' + oneline(detail, 110) : ''}`);
};
// For a measurement whose VALUE is the finding — nothing to pass or fail.
const fact = (label, value) => console.log(`  FACT  ${label}  -> ${oneline(value, 150)}`);

// The pane's real ladder + cap, read out of the shipped service so this probe
// cannot drift away from the code it is judging.
function paneContract() {
  const src = fs.readFileSync(SERVICE, 'utf8');
  const lad = src.match(/const MIME_LADDER = \[([\s\S]*?)\];/);
  const cap = src.match(/const MAX_OUT_BYTES = ([^;]+);/);
  return {
    ladder: lad ? [...lad[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [],
    maxOutBytes: cap ? Number(Function('return ' + cap[1])()) : null,
  };
}
const PANE = paneContract();

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------
let server = null;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-jpy-probe-'));
const RUNTIME = path.join(ROOT, 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });

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
  args.push('python', '-m', 'jupyter_server',
    '--no-browser', `--port=${PORT}`, '--ServerApp.ip=127.0.0.1',
    `--ServerApp.token=${TOKEN}`, `--ServerApp.root_dir=${ROOT}`,
    '--ServerApp.open_browser=False', '--ServerApp.disable_check_xsrf=True');
  server = spawn('uv', args, {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // The redirected runtime dir is what keeps this server invisible to the
    // pack's discovery (it globs jpserver-*.json out of the user's runtime dir).
    env: { ...process.env, JUPYTER_RUNTIME_DIR: RUNTIME, PYDEVD_DISABLE_FILE_VALIDATION: '1' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (server.exitCode !== null) throw new Error('server died:\n' + log.slice(-2000));
    try {
      const r = await fetch(BASE + 'api/status', { headers: auth, signal: AbortSignal.timeout(900) });
      if (r.ok) return { ms: Date.now() - t0, status: await r.json() };
    } catch {}
    await sleep(350);
  }
  throw new Error('server never came up:\n' + log.slice(-2000));
}

function stopServer() {
  if (!server || KEEP) return;
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  try { server.kill('SIGTERM'); } catch {}
}

// ---------------------------------------------------------------------------
// kernel: REST start + WS drive (the protocol service.js speaks)
// ---------------------------------------------------------------------------
let kernelId = null, ws = null;
const SESSION = 'probe-' + Math.random().toString(36).slice(2);
const waiters = new Map();      // msg_id -> {msgs, resolve, idle, reply}

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
  u.searchParams.set('token', TOKEN);            // authenticates the upgrade
  ws = new WebSocket(u.toString());              // no subprotocol => JSON text frames
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws timeout')), 20000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws refused')); };
  });
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const pid = m.parent_header && m.parent_header.msg_id;
    const w = pid && waiters.get(pid);
    if (!w) return;
    w.msgs.push(m);
    if (m.msg_type === 'execute_reply') w.reply = m;
    if (m.msg_type === 'status' && m.content && m.content.execution_state === 'idle') w.idle = true;
    if (w.idle && w.reply) { clearTimeout(w.timer); setTimeout(() => { waiters.delete(pid); w.resolve(w.msgs); }, 180); }
  };
}

let seq = 0;
function run(code, timeout = 240000) {
  const id = 'probe-' + (++seq) + '-' + Date.now();
  const frame = {
    header: { msg_id: id, username: 'probe', session: SESSION, msg_type: 'execute_request', version: '5.3' },
    parent_header: {}, metadata: {},
    content: { code, silent: false, store_history: true, allow_stdin: false, stop_on_error: false },
    channel: 'shell',
  };
  return new Promise((resolve, reject) => {
    const w = { msgs: [], resolve, idle: false, reply: null };
    w.timer = setTimeout(() => { waiters.delete(id); reject(new Error('cell timed out after ' + timeout + 'ms:\n' + code.slice(0, 200))); }, timeout);
    waiters.set(id, w);
    ws.send(JSON.stringify(frame));
  });
}

// ---------------------------------------------------------------------------
// message -> measurements
// ---------------------------------------------------------------------------
const joinSrc = (v) => (Array.isArray(v) ? v.join('') : v);

function analyse(msgs) {
  const out = { outputs: [], stdout: '', stderr: '', errors: [], comms: [], json: [], msgTypes: {} };
  for (const m of msgs) {
    out.msgTypes[m.msg_type] = (out.msgTypes[m.msg_type] || 0) + 1;
    if (m.msg_type === 'stream') {
      const t = m.content.text || '';
      if (m.content.name === 'stderr') out.stderr += t; else out.stdout += t;
    } else if (m.msg_type === 'display_data' || m.msg_type === 'execute_result' || m.msg_type === 'update_display_data') {
      const data = m.content.data || {};
      const keys = Object.keys(data).map((k) => ({
        mime: k,
        bytes: bytesOf(typeof data[k] === 'string' || Array.isArray(data[k]) ? joinSrc(data[k]) : data[k]),
        kind: typeof data[k] === 'string' ? 'string' : Array.isArray(data[k]) ? 'string[]' : 'json',
        top: (data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])) ? Object.keys(data[k]) : null,
        head: typeof data[k] === 'string' ? data[k].slice(0, 260) : Array.isArray(data[k]) ? joinSrc(data[k]).slice(0, 260) : null,
      }));
      out.outputs.push({
        type: m.msg_type, keys,
        total: keys.reduce((a, b) => a + b.bytes, 0),
        metadata: m.content.metadata || {},
        transient: m.content.transient || null,
        raw: data,
      });
    } else if (m.msg_type === 'error') {
      out.errors.push({ ename: m.content.ename, evalue: m.content.evalue, tb: (m.content.traceback || []).join('\n').slice(0, 1200) });
    } else if (m.msg_type === 'comm_open' || m.msg_type === 'comm_msg' || m.msg_type === 'comm_close') {
      out.comms.push({
        msg_type: m.msg_type,
        target: m.content.target_name || null,
        comm_id: m.content.comm_id,
        dataKeys: Object.keys(m.content.data || {}),
        stateKeys: m.content.data && m.content.data.state ? Object.keys(m.content.data.state) : null,
        bytes: bytesOf(m.content),
        buffers: (m.buffers || []).length,
      });
    }
  }
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('PROBE_JSON ')) { try { out.json.push(JSON.parse(line.slice(11))); } catch (e) { out.json.push({ parse_error: String(e) }); } }
  }
  return out;
}

async function cell(name, code, opts = {}) {
  const t0 = Date.now();
  const msgs = await run(code, opts.timeout);
  const a = analyse(msgs);
  a.ms = Date.now() - t0;
  a.code = code;
  record.cells[name] = {
    ms: a.ms, code, msgTypes: a.msgTypes, errors: a.errors, comms: a.comms, json: a.json,
    stdout: a.stdout.split('\n').filter((l) => !l.startsWith('PROBE_JSON ')).join('\n').slice(0, 4000),
    stderr: a.stderr.slice(0, 4000),
    outputs: a.outputs.map((o) => ({
      type: o.type, total: o.total, metadata: o.metadata, transient: o.transient,
      keys: o.keys.map(({ mime, bytes, kind, top, head }) => ({
        mime, bytes, kind, top, head,
        // a bounded sample of the actual payload, so a future reader does not
        // have to re-run the probe to see the shape
        sample: kind === 'json' ? JSON.stringify(o.raw[mime]).slice(0, 2500) : null,
      })),
    })),
  };
  if (a.errors.length) console.log(`  !! ${name}: ${a.errors[0].ename}: ${oneline(a.errors[0].evalue, 160)}`);
  return a;
}

// What would today's pane do with this bundle? Deterministic from the measured
// key set plus the ladder read out of service.js.
function ladderVerdict(keys) {
  const set = new Set(keys.map((k) => k.mime));
  const pick = PANE.ladder.find((m) => set.has(m)) || null;
  const dropped = keys.filter((k) => k.mime !== pick).map((k) => k.mime);
  const picked = keys.find((k) => k.mime === pick);
  return { pick, dropped, bytes: picked ? picked.bytes : 0, overCap: picked ? picked.bytes > PANE.maxOutBytes : false };
}

// What is INSIDE a text/html or application/javascript payload: the thing that
// decides whether a JS box could just run it, and where its code comes from.
function htmlFacts(s) {
  const urls = [...new Set(s.match(/https?:\/\/[^\s"'<>)\\]+/g) || [])];
  const ext = urls.filter((u) => /\.js(\?|$)|cdn|unpkg|jsdelivr/.test(u));
  return {
    scripts: (s.match(/<script/g) || []).length,
    srcTags: (s.match(/<script[^>]+src=/g) || []).length,
    requirejs: /require(js)?\s*[.(]/.test(s) || /define\.amd/.test(s),
    newPlot: /newPlot\s*\(/.test(s),
    vegaEmbed: /vegaEmbed/.test(s),
    bokeh: /Bokeh\./.test(s),
    docsJson: /docs_json/.test(s),
    specInline: /"\$schema"|\\"\$schema\\"/.test(s),
    externalUrls: ext.slice(0, 5),
    allUrls: urls.length,
  };
}

function showBundle(label, a) {
  h(label);
  if (!a.outputs.length) { console.log('  (no display_data / execute_result)'); }
  a.outputs.forEach((o, i) => {
    console.log(`  ${o.type} #${i + 1}   ${kb(o.total)} total across ${o.keys.length} mime key(s)`);
    for (const k of o.keys) {
      console.log(`      ${pad(k.mime, 44)} ${pad(kb(k.bytes), 12)} ${k.kind}${k.top ? '  top: ' + k.top.join(',') : ''}`);
      const raw = o.raw[k.mime];
      if (typeof raw === 'string' && raw.length > 200 && /html|javascript|bokehjs/.test(k.mime)) {
        const f = htmlFacts(raw);
        console.log(`          <script>x${f.scripts} (src=${f.srcTags})  require:${f.requirejs}  newPlot:${f.newPlot}  vegaEmbed:${f.vegaEmbed}  Bokeh.:${f.bokeh}  docs_json:${f.docsJson}  spec-inline:${f.specInline}`);
        console.log(`          external JS: ${f.externalUrls.length ? f.externalUrls.join(' ') : 'none'}${f.allUrls ? `   (${f.allUrls} url(s) in payload)` : ''}`);
        record.notes.push({ payload: label + ' ' + k.mime, bytes: k.bytes, facts: f });
      }
    }
    if (Object.keys(o.metadata).length) console.log(`      metadata: ${oneline(JSON.stringify(o.metadata), 150)}`);
    if (o.transient) console.log(`      transient: ${oneline(JSON.stringify(o.transient), 120)}`);
    const v = ladderVerdict(o.keys);
    console.log(`      pane today -> ${v.pick ? `renders ${v.pick} (${kb(v.bytes)})${v.overCap ? '  ** OVER the ' + kb(PANE.maxOutBytes) + ' per-cell cap **' : ''}` : 'NOTHING (no ladder key present)'}`);
    if (v.dropped.length) console.log(`      dropped     -> ${v.dropped.join(', ')}`);
  });
  if (a.comms.length) console.log(`  comm traffic: ${a.comms.map((c) => `${c.msg_type}(${c.target || ''}) ${kb(c.bytes)}${c.buffers ? ' +' + c.buffers + ' buffers' : ''}`).join(', ')}`);
  if (a.stderr.trim()) console.log(`  stderr: ${oneline(a.stderr, 200)}`);
}

const plainOf = (o) => o.keys.find((k) => k.mime === 'text/plain');
const keyOf = (o, mime) => o.keys.find((k) => k.mime === mime);
const vendorOf = (o) => o.keys.filter((k) => /^application\/vnd\./.test(k.mime));

// ---------------------------------------------------------------------------
// python probe sources
// ---------------------------------------------------------------------------
const PY_ENV = `
import json, sys, os, pathlib, importlib
info = {'python': sys.version.split()[0], 'prefix': sys.prefix, 'executable': sys.executable, 'versions': {}}
for name in ['plotly','altair','bokeh','pandas','matplotlib','ipywidgets','IPython','ipykernel','jupyter_server','nbformat','matplotlib_inline','vl_convert']:
    try:
        m = importlib.import_module(name); info['versions'][name] = getattr(m, '__version__', '?')
    except Exception as e:
        info['versions'][name] = 'MISSING(%s)' % type(e).__name__
assets = {}
for name in ['plotly','altair','bokeh','ipywidgets','widgetsnbextension','matplotlib']:
    try:
        m = importlib.import_module(name); root = pathlib.Path(m.__file__).parent
    except Exception:
        continue
    files = []
    for p in root.rglob('*.js'):
        try: files.append((p.stat().st_size, str(p)))
        except OSError: pass
    files.sort(reverse=True)
    assets[name] = {'root': str(root), 'js_files': len(files),
                    'js_bytes': sum(s for s, _ in files),
                    'top': [{'bytes': s, 'path': p} for s, p in files[:6]]}
info['package_js'] = assets
lab = os.path.join(sys.prefix, 'share', 'jupyter', 'labextensions')
ext = []
if os.path.isdir(lab):
    for dirpath, dirnames, filenames in os.walk(lab):
        if 'package.json' in filenames:
            try: pkg = json.load(open(os.path.join(dirpath, 'package.json')))
            except Exception: pkg = {}
            tot = 0; remote = []
            for dp, dn, fn in os.walk(dirpath):
                for f in fn:
                    try: tot += os.path.getsize(os.path.join(dp, f))
                    except OSError: pass
                    if f.startswith('remoteEntry'): remote.append(os.path.relpath(os.path.join(dp, f), lab))
            js = []
            for dp, dn, fn in os.walk(dirpath):
                for f in fn:
                    if f.endswith('.js'):
                        try: js.append((os.path.getsize(os.path.join(dp, f)), os.path.relpath(os.path.join(dp, f), lab)))
                        except OSError: pass
            js.sort(reverse=True)
            ext.append({'dir': os.path.relpath(dirpath, lab), 'name': pkg.get('name'), 'version': pkg.get('version'),
                        'bytes': tot, 'remoteEntry': remote,
                        'biggest_js': [{'bytes': s, 'rel': r} for s, r in js[:3]],
                        'jupyterlab_extension': bool((pkg.get('jupyterlab') or {}).get('extension')) or bool((pkg.get('jupyterlab') or {}).get('_build'))})
            dirnames[:] = []
info['labextensions_root'] = lab
info['labextensions'] = sorted(ext, key=lambda e: -e['bytes'])
print('PROBE_JSON ' + json.dumps(info))
`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
process.on('SIGINT', () => { stopServer(); process.exit(130); });

H('03 — MIME BUNDLES: what the libraries actually emit');
console.log(`pane contract read from ${path.relative(PACK, SERVICE)}`);
console.log(`  MIME_LADDER    ${PANE.ladder.join(' > ')}`);
console.log(`  MAX_OUT_BYTES  ${num(PANE.maxOutBytes)} (${kb(PANE.maxOutBytes)}) per cell, across all outputs`);
record.meta.pane = PANE;

// Sweep any temp root a previous run left behind (an early exit skips the
// finally block, and these dirs are ours by name).
try {
  for (const d of fs.readdirSync(os.tmpdir())) {
    if (/^wc-jpy-probe-/.test(d) && path.join(os.tmpdir(), d) !== ROOT) {
      try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch {}
    }
  }
} catch {}

await claimPort();
if (PORT !== WANT) console.log(`\nport ${WANT} is occupied by something else — using ${PORT} instead and leaving it alone`);

let boot;
try {
  console.log(`\nstarting jupyter_server on ${PORT} (uv --with ${PKGS.join(' --with ')})`);
  boot = await startServer();
  console.log(`  up in ${boot.ms} ms   root_dir=${ROOT}   runtime_dir=${RUNTIME}`);
  record.meta.server = { port: PORT, bootMs: boot.ms, status: boot.status, root: ROOT };
  await startKernel();
  await openSocket();
  console.log(`  kernel ${kernelId} + websocket open`);

  // -- 0. environment ------------------------------------------------------
  H('0 — ENVIRONMENT UNDER TEST');
  const env = await cell('env', PY_ENV);
  const E = env.json[0] || {};
  record.meta.env = E;
  console.log(`  python ${E.python}   prefix ${E.prefix}`);
  for (const [k, v] of Object.entries(E.versions || {})) console.log(`      ${pad(k, 18)} ${v}`);
  ok('every library under test imported', !Object.entries(E.versions || {}).some(([k, v]) => ['plotly', 'altair', 'bokeh', 'pandas', 'matplotlib', 'ipywidgets'].includes(k) && String(v).startsWith('MISSING')));

  h('JS shipped INSIDE the python packages');
  for (const [name, a] of Object.entries(E.package_js || {})) {
    console.log(`  ${pad(name, 20)} ${pad(a.js_files + ' .js', 10)} ${pad(kb(a.js_bytes), 12)} ${a.root}`);
    for (const f of a.top.slice(0, 3)) console.log(`        ${pad(kb(f.bytes), 12)} ${f.path.replace(a.root, '…')}`);
  }
  h(`prebuilt labextensions under ${E.labextensions_root || '(none)'}`);
  for (const x of E.labextensions || []) {
    console.log(`  ${pad(x.name || x.dir, 42)} ${pad(x.version || '', 10)} ${pad(kb(x.bytes), 11)} remoteEntry: ${x.remoteEntry.length ? x.remoteEntry.join(' ') : 'NONE'}`);
  }

  // -- 1. plotly -----------------------------------------------------------
  H('1 — PLOTLY');
  const p1 = await cell('plotly_default', `
import plotly, plotly.graph_objects as go, plotly.io as pio, json
print('PROBE_JSON ' + json.dumps({'version': plotly.__version__, 'default_renderer': str(pio.renderers.default), 'renderers': sorted(list(pio.renderers))}))
fig = go.Figure(go.Scatter(x=[1,2,3,4], y=[4,1,9,3], mode='lines+markers', name='probe'))
fig.update_layout(title='probe figure', width=420, height=300)
fig
`);
  const pinfo = p1.json[0] || {};
  console.log(`  plotly ${pinfo.version}   pio.renderers.default = "${pinfo.default_renderer}"`);
  console.log(`  available renderers: ${(pinfo.renderers || []).join(', ')}`);
  showBundle('plotly: default repr of a Figure (`fig` as the last expression)', p1);

  const p2 = await cell('plotly_mimetype', `
pio.renderers.default = 'plotly_mimetype'
fig
`);
  showBundle('plotly: renderers.default = "plotly_mimetype"', p2);

  const p3 = await cell('plotly_notebook', `
pio.renderers.default = 'notebook'
fig
`);
  showBundle('plotly: renderers.default = "notebook" (self-contained JS)', p3);

  const p4 = await cell('plotly_notebook_connected', `
pio.renderers.default = 'notebook_connected'
fig
`);
  showBundle('plotly: renderers.default = "notebook_connected" (CDN)', p4);

  const p5 = await cell('plotly_to_html', `
import re, json
out = {}
for kw in ['cdn', True, 'require', 'directory', False]:
    try:
        html = fig.to_html(include_plotlyjs=kw, full_html=False)
    except Exception as e:
        out[repr(kw)] = {'error': type(e).__name__ + ': ' + str(e)[:160]}; continue
    urls = re.findall(r'https?://[^\\s"\\'<>]+', html)
    out[repr(kw)] = {'bytes': len(html.encode()), 'script_tags': html.count('<script'),
                     'has_require': 'require(' in html or 'requirejs' in html,
                     'has_newPlot': 'newPlot' in html, 'urls': sorted(set(urls))[:4],
                     'head': html[:180]}
pio.renderers.default = 'plotly_mimetype'
print('PROBE_JSON ' + json.dumps(out))
`);
  h('plotly: fig.to_html(include_plotlyjs=…) variants');
  const pv = p5.json[0] || {};
  for (const [k, v] of Object.entries(pv)) {
    if (v.error) { console.log(`  ${pad(k, 12)} ERROR ${v.error}`); continue; }
    console.log(`  ${pad(k, 12)} ${pad(kb(v.bytes), 12)} <script>x${v.script_tags}  require:${v.has_require}  newPlot:${v.has_newPlot}  urls:${v.urls.join(' ') || 'none'}`);
  }
  record.cells.plotly_to_html_summary = pv;

  const p7 = await cell('plotly_fallback_hunt', `
import json, plotly.io as pio
out = {}
for r in ['plotly_mimetype', 'plotly_mimetype+notebook', 'notebook', 'json']:
    try:
        pio.renderers.default = r
        b = fig._repr_mimebundle_()
        if isinstance(b, tuple): b = b[0]
        out[r] = {'keys': sorted(b.keys()), 'has_text_plain': 'text/plain' in b}
    except Exception as e:
        out[r] = {'error': type(e).__name__ + ': ' + str(e)[:120]}
out['repr_str_len'] = len(repr(fig))
out['repr_head'] = repr(fig)[:120]
pio.renderers.default = 'plotly_mimetype'
print('PROBE_JSON ' + json.dumps(out))
`);
  h('plotly: is a text/plain fallback available under ANY renderer?');
  console.log('  ' + JSON.stringify(p7.json[0], null, 2).split('\n').join('\n  '));

  const p8 = await cell('plotly_scaling', `
import json, numpy as np, plotly.graph_objects as go
out = {}
for n in [100, 2000, 20000, 200000]:
    x = np.arange(n); y = np.random.rand(n)
    f = go.Figure(go.Scattergl(x=x, y=y, mode='markers'))
    b = f._repr_mimebundle_()
    if isinstance(b, tuple): b = b[0]
    pl = b['application/vnd.plotly.v1+json']
    out[str(n)] = {'bundle_bytes': len(json.dumps(pl).encode())}
print('PROBE_JSON ' + json.dumps(out))
`);
  h('plotly: how the vnd.plotly payload scales with data (vs the 256 KiB cell cap)');
  for (const [n, v] of Object.entries(p8.json[0] || {})) {
    console.log(`  ${pad(n + ' points', 16)} ${pad(kb(v.bundle_bytes), 12)} ${v.bundle_bytes > PANE.maxOutBytes ? 'OVER the per-cell cap' : 'fits'}`);
  }

  const pmime = (p2.outputs[0] && keyOf(p2.outputs[0], 'application/vnd.plotly.v1+json')) || null;
  ok('plotly emits application/vnd.plotly.v1+json', !!pmime, pmime && pmime.top && pmime.top.join(','));
  fact('text/plain fallback in the plotly bundle',
    p2.outputs[0] && plainOf(p2.outputs[0]) ? oneline(plainOf(p2.outputs[0]).head, 70) : 'ABSENT — a non-rendering pane has nothing at all to show');

  const p6 = await cell('plotly_payload_shape', `
import json
b = fig._repr_mimebundle_() if hasattr(fig, '_repr_mimebundle_') else {}
pl = b.get('application/vnd.plotly.v1+json') or json.loads(fig.to_json())
out = {'bundle_keys': sorted(b.keys()), 'payload_top': sorted(pl.keys()),
       'data_len': len(pl.get('data', [])), 'trace0_keys': sorted((pl.get('data') or [{}])[0].keys()),
       'layout_keys': sorted((pl.get('layout') or {}).keys()),
       'config': pl.get('config'), 'has_frames': 'frames' in pl,
       'json_bytes': len(json.dumps(pl).encode())}
print('PROBE_JSON ' + json.dumps(out))
`);
  h('plotly: the vnd.plotly.v1+json payload, dissected');
  console.log('  ' + JSON.stringify(p6.json[0], null, 2).split('\n').join('\n  '));

  // -- 2. altair / vega-lite ----------------------------------------------
  H('2 — ALTAIR / VEGA-LITE');
  const a1 = await cell('altair_default', `
import altair as alt, pandas as pd, json
print('PROBE_JSON ' + json.dumps({'altair': alt.__version__, 'schema_version': getattr(alt, 'SCHEMA_VERSION', None),
                                  'active_renderer': str(getattr(alt.renderers, 'active', None)),
                                  'renderers': sorted(list(alt.renderers.names()))}))
df = pd.DataFrame({'cat': list('ABCDE'), 'val': [5, 3, 6, 7, 2]})
chart = alt.Chart(df).mark_bar().encode(x='cat:N', y='val:Q').properties(width=300, height=200, title='probe chart')
chart
`);
  const ainfo = a1.json[0] || {};
  console.log(`  altair ${ainfo.altair}   SCHEMA_VERSION ${ainfo.schema_version}   active renderer "${ainfo.active_renderer}"`);
  console.log(`  renderers: ${(ainfo.renderers || []).join(', ')}`);
  showBundle('altair: default repr of a Chart', a1);

  const a2 = await cell('altair_spec', `
import json
b = chart._repr_mimebundle_()
vk = [k for k in b if 'vega' in k]
spec = b[vk[0]] if vk else json.loads(chart.to_json())
out = {'bundle_keys': sorted(b.keys()), 'vendor_mimes': vk, 'spec_top': sorted(spec.keys()),
       'schema': spec.get('$schema'), 'data_keys': sorted((spec.get('data') or {}).keys()),
       'n_values': len((spec.get('data') or {}).get('values') or []),
       'mark': spec.get('mark'), 'encoding_channels': sorted((spec.get('encoding') or {}).keys()),
       'json_bytes': len(json.dumps(spec).encode())}
print('PROBE_JSON ' + json.dumps(out))
`);
  h('altair: the vega-lite spec, dissected');
  console.log('  ' + JSON.stringify(a2.json[0], null, 2).split('\n').join('\n  '));

  // The default renderer gave text/html. The vendor bundle the proposal is about
  // only appears under another renderer — find out which, and what it is called.
  const a2b = await cell('altair_renderer_sweep', `
import json
out = {}
for name in ['default', 'mimetype', 'jupyterlab', 'html', 'json', 'browser', 'jupyter']:
    try:
        alt.renderers.enable(name)
        b = chart._repr_mimebundle_()
        if isinstance(b, tuple): b = b[0]
        d = {}
        for k, v in b.items():
            d[k] = len(v.encode()) if isinstance(v, str) else len(json.dumps(v).encode())
        out[name] = {'keys': sorted(b.keys()), 'bytes': d,
                     'vendor': [k for k in b if k.startswith('application/vnd.')]}
    except Exception as e:
        out[name] = {'error': type(e).__name__ + ': ' + str(e)[:140]}
alt.renderers.enable('mimetype')
print('PROBE_JSON ' + json.dumps(out))
`);
  h('altair: every renderer, and which of them emits a vendor bundle');
  for (const [name, v] of Object.entries(a2b.json[0] || {})) {
    if (v.error) { console.log(`  ${pad(name, 12)} ERROR ${v.error}`); continue; }
    console.log(`  ${pad(name, 12)} ${v.keys.map((k) => `${k}=${kb(v.bytes[k])}`).join('  ')}${v.vendor.length ? '   VENDOR: ' + v.vendor.join(',') : ''}`);
  }

  const a2c = await cell('altair_mimetype_display', `
alt.renderers.enable('mimetype')
chart
`);
  showBundle('altair: displayed under the "mimetype" renderer', a2c);
  const vmime = a2c.outputs[0] ? vendorOf(a2c.outputs[0])[0] : null;
  ok('altair CAN emit a vega-lite vendor bundle', !!vmime, vmime && `${vmime.mime} ${kb(vmime.bytes)}`);
  ok('...and it still carries text/plain', !!(a2c.outputs[0] && plainOf(a2c.outputs[0])), a2c.outputs[0] && plainOf(a2c.outputs[0]) && plainOf(a2c.outputs[0]).head);

  const a2d = await cell('altair_spec_selfcontained', `
import json
b = chart._repr_mimebundle_()
if isinstance(b, tuple): b = b[0]
vk = [k for k in b if 'vega' in k]
spec = b[vk[0]]
out = {'vendor_mime': vk[0] if vk else None, 'spec_top': sorted(spec.keys()), 'schema': spec.get('$schema'),
       'data': spec.get('data'), 'datasets_keys': list((spec.get('datasets') or {}).keys()),
       'datasets_rows': {k: len(v) for k, v in (spec.get('datasets') or {}).items()},
       'datasets_bytes': len(json.dumps(spec.get('datasets') or {}).encode()),
       'config_bytes': len(json.dumps(spec.get('config') or {}).encode()),
       'total_bytes': len(json.dumps(spec).encode())}
alt.renderers.enable('default')
print('PROBE_JSON ' + json.dumps(out))
`);
  h('altair: is the vendor payload self-contained (does the data travel with it)?');
  console.log('  ' + JSON.stringify(a2d.json[0], null, 2).split('\n').join('\n  '));

  const a3 = await cell('altair_html', `
import re, json
out = {}
try:
    html = chart.to_html()
    urls = sorted(set(re.findall(r'https?://[^\\s"\\'<>]+', html)))
    out['to_html'] = {'bytes': len(html.encode()), 'script_tags': html.count('<script'), 'urls': urls[:6],
                      'has_vegaEmbed': 'vegaEmbed' in html, 'head': html[:200]}
except Exception as e:
    out['to_html'] = {'error': type(e).__name__ + ': ' + str(e)[:200]}
try:
    import vl_convert; out['vl_convert'] = vl_convert.__version__
except Exception as e:
    out['vl_convert'] = 'MISSING(%s)' % type(e).__name__
print('PROBE_JSON ' + json.dumps(out))
`);
  h('altair: is there any self-contained HTML path, and does altair ship JS?');
  console.log('  ' + JSON.stringify(a3.json[0], null, 2).split('\n').join('\n  '));
  const altAssets = (E.package_js || {}).altair || {};
  const vegaRuntime = (altAssets.top || []).filter((f) => /vega|vl-|embed/i.test(f.path) && f.bytes > 100000);
  ok('altair ships NO vega / vega-lite runtime of its own', vegaRuntime.length === 0,
    `${altAssets.js_files} .js file(s) totalling ${kb(altAssets.js_bytes || 0)}: ${(altAssets.top || []).map((f) => path.basename(f.path) + ' ' + kb(f.bytes)).join(', ') || 'none'}`);

  // -- 3. bokeh ------------------------------------------------------------
  H('3 — BOKEH');
  const b0 = await cell('bokeh_output_notebook', `
import bokeh, json
from bokeh.plotting import figure
from bokeh.io import output_notebook, show
print('PROBE_JSON ' + json.dumps({'bokeh': bokeh.__version__}))
p = figure(width=320, height=220, title='probe')
p.line([1,2,3,4], [3,1,4,2])
output_notebook()
`);
  console.log(`  bokeh ${(b0.json[0] || {}).bokeh}`);
  showBundle('bokeh: output_notebook() — the load handshake', b0);

  const b1 = await cell('bokeh_show', `show(p)`);
  showBundle('bokeh: show(p) after output_notebook()', b1);

  const b2 = await cell('bokeh_embed', `
import json
from bokeh.embed import json_item, components
from bokeh.resources import INLINE, CDN
ji = json_item(p, 'probe-div')
script, div = components(p)
out = {'json_item_top': sorted(ji.keys()), 'json_item_bytes': len(json.dumps(ji).encode()),
       'doc_top': sorted((ji.get('doc') or {}).keys()),
       'components_script_bytes': len(script.encode()), 'components_div_bytes': len(div.encode()),
       'components_script_head': script[:200],
       'CDN_js_files': list(CDN.js_files), 'INLINE_js_raw_bytes': [len(s.encode()) for s in INLINE.js_raw][:8],
       'INLINE_total_bytes': sum(len(s.encode()) for s in INLINE.js_raw)}
print('PROBE_JSON ' + json.dumps(out))
`);
  h('bokeh: the embed API and where its JS comes from');
  console.log('  ' + JSON.stringify(b2.json[0], null, 2).split('\n').join('\n  '));

  const b3 = await cell('bokeh_exec_payload', `
import json
out = {}
try:
    b = p._repr_mimebundle_() if hasattr(p, '_repr_mimebundle_') else {}
    if isinstance(b, tuple): b = b[0]
    out['repr_mimebundle_keys'] = sorted(b.keys())
    for k, v in b.items():
        try: n = len(v.encode()) if isinstance(v, str) else len(json.dumps(v).encode())
        except Exception: n = -1
        out[k] = {'type': type(v).__name__, 'bytes': n,
                  'top': sorted(v.keys()) if isinstance(v, dict) else None,
                  'head': v[:200] if isinstance(v, str) else None}
except Exception as e:
    out['error'] = type(e).__name__ + ': ' + str(e)[:200]
print('PROBE_JSON ' + json.dumps(out))
`);
  h('bokeh: what a figure puts in its own mimebundle');
  console.log('  ' + JSON.stringify(b3.json[0], null, 2).split('\n').join('\n  '));

  const b4 = await cell('bokeh_without_load', `
from bokeh.io import reset_output
import json
reset_output()          # forget that output_notebook() ever ran
show(p)
print('PROBE_JSON ' + json.dumps({'note': 'show() after reset_output(); outputs above are whatever bokeh emitted'}))
`);
  showBundle('bokeh: show(p) with NO output_notebook() beforehand', b4);
  ok('bokeh show() needs the output_notebook() handshake to emit anything renderable',
    b4.outputs.length < b1.outputs.length || b4.outputs.every((o) => !vendorOf(o).length),
    `${b4.outputs.length} output(s) vs ${b1.outputs.length} with the handshake`);

  // -- 4. matplotlib -------------------------------------------------------
  H('4 — MATPLOTLIB');
  const m1 = await cell('mpl_png', `
%matplotlib inline
%config InlineBackend.figure_formats = ['png']
import matplotlib, matplotlib.pyplot as plt, json
print('PROBE_JSON ' + json.dumps({'matplotlib': matplotlib.__version__, 'backend': matplotlib.get_backend()}))
fig, ax = plt.subplots(figsize=(4, 3))
ax.plot([1,2,3,4], [2,1,3,5]); ax.set_title('probe')
fig
`);
  console.log(`  matplotlib ${(m1.json[0] || {}).matplotlib}  backend ${(m1.json[0] || {}).backend}`);
  showBundle('matplotlib: default inline (png)', m1);

  const m2 = await cell('mpl_svg', `
%config InlineBackend.figure_formats = ['svg']
fig
`);
  showBundle('matplotlib: figure_formats = ["svg"]', m2);

  const m3 = await cell('mpl_both', `
%config InlineBackend.figure_formats = ['svg', 'png']
fig
`);
  showBundle('matplotlib: figure_formats = ["svg","png"] (both in one bundle)', m3);
  const m4 = await cell('mpl_dense_svg', `
%config InlineBackend.figure_formats = ['svg']
import numpy as np, json
sizes = {}
for n in [200, 5000, 50000]:
    f2, a2_ = plt.subplots(figsize=(4, 3))
    a2_.scatter(np.random.rand(n), np.random.rand(n), s=2)
    from io import StringIO
    buf = StringIO(); f2.savefig(buf, format='svg'); sizes[str(n)] = len(buf.getvalue().encode())
    plt.close(f2)
print('PROBE_JSON ' + json.dumps(sizes))
`);
  h('matplotlib: how svg scales with mark count (vs the 256 KiB cell cap)');
  for (const [n, bytes] of Object.entries(m4.json[0] || {})) {
    console.log(`  ${pad(n + ' points', 16)} ${pad(kb(bytes), 12)} ${bytes > PANE.maxOutBytes ? 'OVER the per-cell cap' : 'fits'}`);
  }

  const svgKey = m2.outputs[0] && keyOf(m2.outputs[0], 'image/svg+xml');
  ok('matplotlib emits image/svg+xml under the svg format', !!svgKey, svgKey && kb(svgKey.bytes));
  ok('the svg fits the per-cell cap', !!svgKey && svgKey.bytes < PANE.maxOutBytes, svgKey && `${kb(svgKey.bytes)} vs ${kb(PANE.maxOutBytes)}`);

  // -- 5. ipywidgets -------------------------------------------------------
  H('5 — IPYWIDGETS');
  const w1 = await cell('widgets_slider', `
import ipywidgets as w, json
print('PROBE_JSON ' + json.dumps({'ipywidgets': w.__version__}))
s = w.IntSlider(value=7, min=0, max=10, description='probe')
s
`);
  console.log(`  ipywidgets ${(w1.json[0] || {}).ipywidgets}`);
  showBundle('ipywidgets: IntSlider displayed', w1);
  h('ipywidgets: the comm traffic that accompanies it');
  for (const c of w1.comms) console.log(`  ${pad(c.msg_type, 12)} target=${pad(c.target || '-', 26)} ${pad(kb(c.bytes), 11)} data keys: ${c.dataKeys.join(',')}${c.stateKeys ? '  state keys: ' + c.stateKeys.length : ''}`);
  record.cells.widgets_slider.commDetail = w1.comms;

  const w2 = await cell('widgets_embed', `
import json, re
out = {}
b = s._repr_mimebundle_()
out['mimebundle_keys'] = sorted(b.keys())
for k, v in b.items():
    out[k] = v if isinstance(v, (dict, str)) and len(json.dumps(v)) < 400 else {'bytes': len(json.dumps(v).encode())}
try:
    from ipywidgets.embed import embed_data, embed_minimal_html
    d = embed_data(views=[s])
    out['embed_data'] = {'top': sorted(d.keys()), 'manager_state_bytes': len(json.dumps(d['manager_state']).encode()),
                         'view_specs': d['view_specs'],
                         'n_models': len((d['manager_state'].get('state') or {}))}
    embed_minimal_html('/tmp/wc-probe-widget.html', views=[s], title='probe')
    html = open('/tmp/wc-probe-widget.html').read()
    out['embed_minimal_html'] = {'bytes': len(html.encode()), 'urls': sorted(set(re.findall(r'https?://[^\\s"\\'<>]+', html)))[:6],
                                 'script_tags': html.count('<script')}
except Exception as e:
    out['embed_error'] = type(e).__name__ + ': ' + str(e)[:200]
print('PROBE_JSON ' + json.dumps(out))
`);
  h('ipywidgets: is there any state outside the comm?');
  console.log('  ' + JSON.stringify(w2.json[0], null, 2).split('\n').join('\n  '));

  const w3 = await cell('widgets_models', `
import json
from ipywidgets.embed import embed_data
d = embed_data(views=[s])
st = d['manager_state'].get('state') or {}
out = {'models': [{'id': k, 'module': v.get('model_module'), 'name': v.get('model_name'),
                   'module_version': v.get('model_module_version'),
                   'view_module': v.get('state', {}).get('_view_module'),
                   'state_keys': len(v.get('state') or {})} for k, v in st.items()],
       'manager_state_version': d['manager_state'].get('version_major'),
       'value_in_state': [v.get('state', {}).get('value') for v in st.values() if 'value' in (v.get('state') or {})]}
print('PROBE_JSON ' + json.dumps(out))
`);
  h('ipywidgets: the models behind one IntSlider (what a static render would have to carry)');
  console.log('  ' + JSON.stringify(w3.json[0], null, 2).split('\n').join('\n  '));

  // -- 6. pandas control ---------------------------------------------------
  H('6 — PANDAS (the control: what the ladder already handles)');
  const d1 = await cell('pandas_df', `
import pandas as pd
pd.DataFrame({'city': ['Oslo','Lima','Cairo'], 'n': [1, 2, 3], 'f': [1.5, 2.5, 3.5]})
`);
  showBundle('pandas: DataFrame repr', d1);

  // -- 7. can the renderer JS be reached over HTTP? -----------------------
  H('7 — SERVING THE RENDERER JS FROM THE USER\'S OWN INSTALL (secondary probe)');
  const probeUrls = [];
  for (const x of (E.labextensions || []).slice(0, 6)) {
    if (x.remoteEntry.length) probeUrls.push('lab/extensions/' + x.remoteEntry[0]);
    probeUrls.push('lab/extensions/' + x.dir + '/package.json');
  }
  probeUrls.push('static/lab/package.json', 'api/status');
  for (const u of probeUrls) {
    let s = 'ERR', len = '';
    try { const r = await api(u); s = r.status; const t = await r.arrayBuffer(); len = kb(t.byteLength); } catch (e) { s = String(e).slice(0, 40); }
    console.log(`  ${pad(String(s), 6)} ${pad(len, 12)} ${u}`);
    record.notes.push({ url: u, status: s, bytes: len });
  }
  console.log(`  (this env has no jupyterlab — a 404 here means the ROUTE is absent, not the files)`);

  // ... so start a SECOND throwaway server that does have jupyterlab, and ask it
  // for the same files. This is what decides whether "load the renderer JS from
  // the user's own install" is reachable over HTTP at all.
  const labPort = await (async () => { for (let p = PORT + 1; p < PORT + 12; p++) { if (!FORBIDDEN.has(p) && await portFree(p)) return p; } return null; })();
  if (labPort) {
    const labTok = 'probe' + Math.random().toString(36).slice(2, 10);
    const labBase = `http://127.0.0.1:${labPort}/`;
    const labArgs = ['run', '--no-project', '--with', 'jupyterlab', '--with', 'plotly', '--with', 'ipywidgets',
      'python', '-m', 'jupyter_server', '--no-browser', `--port=${labPort}`, '--ServerApp.ip=127.0.0.1',
      `--ServerApp.token=${labTok}`, `--ServerApp.root_dir=${ROOT}`, '--ServerApp.open_browser=False'];
    const lab = spawn('uv', labArgs, { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, JUPYTER_RUNTIME_DIR: RUNTIME } });
    try {
      const t0 = Date.now();
      let up = false;
      while (Date.now() - t0 < 240000) {
        try { const r = await fetch(labBase + 'api/status', { headers: { Authorization: 'token ' + labTok }, signal: AbortSignal.timeout(900) }); if (r.ok) { up = true; break; } } catch {}
        await sleep(400);
      }
      console.log(`\n  second server (jupyterlab installed) on ${labPort}: ${up ? 'up in ' + (Date.now() - t0) + ' ms' : 'FAILED to start'}`);
      if (up) {
        const urls = [];
        for (const x of (E.labextensions || [])) {
          if (x.remoteEntry.length) urls.push('lab/extensions/' + x.remoteEntry[0]);
          for (const j of (x.biggest_js || []).slice(0, 1)) if (!/remoteEntry/.test(j.rel)) urls.push('lab/extensions/' + j.rel);
        }
        urls.push('lab/extensions/jupyterlab-plotly/package.json', 'lab/api/extensions', 'api/status');
        console.log(`  ${pad('code', 6)} ${pad('bytes', 12)} ${pad('content-type', 26)} ${pad('CORS', 8)} ${pad('no-token', 10)} url`);
        for (const u of urls) {
          try {
            const r = await fetch(labBase + u, { headers: { Authorization: 'token ' + labTok } });
            const buf = await r.arrayBuffer();
            const head = Buffer.from(buf.slice(0, 70)).toString('utf8').replace(/\s+/g, ' ');
            // A <script src> from a sandboxed (origin "null") iframe sends no
            // Authorization header and no cookies, so the ANONYMOUS status is
            // the one that decides whether the JS box can load this at all.
            let anon = '-';
            try { anon = String((await fetch(labBase + u)).status); } catch { anon = 'ERR'; }
            console.log(`  ${pad(r.status, 6)} ${pad(kb(buf.byteLength), 12)} ${pad(r.headers.get('content-type') || '-', 26)} ${pad(r.headers.get('access-control-allow-origin') || 'none', 8)} ${pad(anon, 10)} ${u}`);
            if (r.ok && /javascript/.test(r.headers.get('content-type') || '')) console.log(`         head: ${head}`);
            record.notes.push({ labServe: u, status: r.status, anonStatus: anon, bytes: buf.byteLength, ctype: r.headers.get('content-type'), cors: r.headers.get('access-control-allow-origin') });
          } catch (e) { console.log(`  ERR    ${u}: ${String(e).slice(0, 80)}`); }
        }
      }
    } finally {
      try { process.kill(-lab.pid, 'SIGTERM'); } catch {}
      try { lab.kill('SIGTERM'); } catch {}
    }
  }

  // -- 8. do the shipped bundles actually parse as JS? --------------------
  H('8 — THE SHIPPED JS, PARSED *AND RUN* (does a file give you a usable global?)');
  console.log('  Parsing proves the file is whole. RUNNING it in a bare vm sandbox (a window/');
  console.log('  document stub, no real DOM) is the closest thing to "would a <script src> in');
  console.log('  the JS box define the global a renderer needs". A throw here is a finding, not');
  console.log('  a bug: it says the file needs a real browser or a loader around it.\n');
  const candidates = [];
  for (const [name, a] of Object.entries(E.package_js || {})) {
    for (const f of (a.top || []).slice(0, 3)) if (f.bytes > 50000) candidates.push({ name, ...f });
  }
  const sandboxFor = () => {
    const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, removeChild() {}, addEventListener() {}, getContext: () => null, classList: { add() {}, remove() {} }, children: [], childNodes: [] });
    const s = {
      navigator: { userAgent: 'node-probe', platform: 'probe' },
      location: { href: 'about:blank', protocol: 'http:' },
      setTimeout, clearTimeout, setInterval, clearInterval, console: { log() {}, warn() {}, error() {} },
      document: {
        createElement: el, createElementNS: el, createTextNode: () => ({}),
        head: el(), body: el(), documentElement: el(),
        addEventListener() {}, removeEventListener() {},
        querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
        getElementsByTagName: () => [], currentScript: null, readyState: 'complete',
      },
    };
    s.window = s; s.self = s; s.globalThis = s;
    s.addEventListener = () => {}; s.removeEventListener = () => {};
    s.getComputedStyle = () => ({ getPropertyValue: () => '' });
    return s;
  };
  for (const c of candidates) {
    let src = '';
    try { src = fs.readFileSync(c.path, 'utf8'); } catch (e) { console.log(`  ${c.name}: unreadable ${e}`); continue; }
    let parses = false, perr = '';
    const t0 = Date.now();
    let script = null;
    try { script = new vm.Script(src, { filename: c.path }); parses = true; } catch (e) { perr = String(e).split('\n')[0].slice(0, 90); }
    const parseMs = Date.now() - t0;
    let ran = false, rerr = '', found = [];
    if (parses) {
      const sb = sandboxFor();
      const before = new Set(Object.keys(sb));
      try {
        vm.createContext(sb);
        script.runInContext(sb, { timeout: 25000 });
        ran = true;
        found = Object.keys(sb).filter((k) => !before.has(k));
      } catch (e) { rerr = String(e).split('\n')[0].slice(0, 90); }
    }
    const umd = /typeof\s+define\s*===?\s*["']function["']/.test(src) || /define\.amd/.test(src);
    const chunkPush = /(webpackChunk|rspackChunk)[A-Za-z_]*\s*=/.test(src);
    // The two things a <script src> integration actually needs: what version of
    // the JS library this file IS, and what it hangs on window on the way out.
    const banner = (src.slice(0, 500).match(/(plotly\.js|Bokeh ?JS|bokeh|vega[-a-z]*)\s+v?(\d+\.\d+\.\d+)/i) || []).slice(1).join(' ') || '(no banner)';
    const assigns = [...new Set([...src.slice(-4000).matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]))].slice(0, 4);
    console.log(`  ${pad(path.basename(c.path), 30)} ${pad(kb(c.bytes), 11)} parse:${parses ? 'OK' : 'FAIL(' + perr + ')'} ${pad(parseMs + 'ms', 7)} run:${ran ? 'OK' : 'THREW(' + rerr + ')'}`);
    console.log(`  ${pad('', 30)} banner: ${pad(banner, 22)} tail assigns window.: ${assigns.join(', ') || '(none)'}`);
    console.log(`  ${pad('', 30)} globals defined in sandbox: ${found.slice(0, 8).join(', ') || '(none)'}   UMD/AMD:${umd}  webpack/rspack-chunk:${chunkPush}`);
    record.notes.push({ js: c.path, bytes: c.bytes, parses, parseErr: perr, ran, runErr: rerr, newGlobals: found.slice(0, 12), umd, chunkPush, banner, tailAssigns: assigns });
  }

  // -- 8b. every vendor mime string these libraries can emit ---------------
  H('8b — EVERY application/vnd.* STRING IN THE INSTALLED SOURCE');
  const g1 = await cell('mime_constants', `
import re, json, pathlib, importlib
pat = re.compile(r'application/vnd\\.[A-Za-z0-9_.+-]*[A-Za-z0-9]')
found = {}
for name in ['altair', 'plotly', 'bokeh', 'ipywidgets']:
    try: root = pathlib.Path(importlib.import_module(name).__file__).parent
    except Exception: continue
    hits = {}
    for p in list(root.rglob('*.py')) + list(root.rglob('*.jinja')) + list(root.rglob('*.json')):
        try: t = p.read_text(errors='ignore')
        except Exception: continue
        for m in pat.findall(t):
            hits.setdefault(m, []).append(str(p.relative_to(root)))
    found[name] = {k: sorted(set(v))[:2] for k, v in sorted(hits.items())}
print('PROBE_JSON ' + json.dumps(found))
`);
  for (const [lib, hits] of Object.entries(g1.json[0] || {})) {
    console.log(`  ${lib}`);
    for (const [mime, where] of Object.entries(hits)) console.log(`      ${pad(mime, 48)} ${where.join(', ')}`);
  }

  // -- 8c. does the spelling hold across versions? -------------------------
  H('8c — MIME-STRING STABILITY ACROSS LIBRARY VERSIONS (throwaway uv envs)');
  const uvPrint = (args, ms = 300000) => new Promise((res) => {
    const p = spawn('uv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { e += d; });
    const t = setTimeout(() => { try { p.kill(); } catch {} res({ out: o, err: 'TIMEOUT' }); }, ms);
    p.on('close', () => { clearTimeout(t); res({ out: o, err: e }); });
  });
  const versionProbes = [
    ['altair 4.2.2', ['run', '--no-project', '--python', '3.12', '--with', 'altair==4.2.2', 'python', '-c',
      'from altair.vegalite.v4.display import VEGALITE_MIME_TYPE as M; print("MIME", M)']],
    ['altair 5.5.0', ['run', '--no-project', '--python', '3.12', '--with', 'altair==5.5.0', 'python', '-c',
      'from altair.vegalite.v5.display import VEGALITE_MIME_TYPE as M, VEGA_MIME_TYPE as V; print("MIME", M, V)']],
    ['altair 6.3.0 (this env)', ['run', '--no-project', '--with', 'altair', 'python', '-c',
      'from altair.vegalite.v6.display import VEGALITE_MIME_TYPE as M; print("MIME", M)']],
    ['plotly 5.24.1', ['run', '--no-project', '--python', '3.12', '--with', 'plotly==5.24.1', 'python', '-c',
      'import plotly.io as pio, plotly.graph_objects as go; pio.renderers.default="plotly_mimetype"; print("MIME", " ".join(go.Figure()._repr_mimebundle_().keys()))']],
    ['plotly 7.1.0 (this env)', ['run', '--no-project', '--with', 'plotly', 'python', '-c',
      'import plotly.io as pio, plotly.graph_objects as go; pio.renderers.default="plotly_mimetype"; print("MIME", " ".join(go.Figure()._repr_mimebundle_().keys()))']],
    ['bokeh 3.10.0 (this env)', ['run', '--no-project', '--with', 'bokeh', 'python', '-c',
      'from bokeh.io.notebook import LOAD_MIME_TYPE, EXEC_MIME_TYPE; print("MIME", LOAD_MIME_TYPE, EXEC_MIME_TYPE)']],
    ['bokeh 3.4.3', ['run', '--no-project', '--python', '3.12', '--with', 'bokeh==3.4.3', 'python', '-c',
      'from bokeh.io.notebook import LOAD_MIME_TYPE, EXEC_MIME_TYPE; print("MIME", LOAD_MIME_TYPE, EXEC_MIME_TYPE)']],
    ['ipywidgets 7.8.5', ['run', '--no-project', '--python', '3.12', '--with', 'ipywidgets==7.8.5', 'python', '-c',
      'import re, pathlib, ipywidgets; r=pathlib.Path(ipywidgets.__file__).parent; s=set();\n' +
      'for p in r.rglob("*.py"):\n s |= set(re.findall(r"application/vnd\\.jupyter\\.[A-Za-z0-9_.+-]*[A-Za-z0-9]", p.read_text(errors="ignore")))\n' +
      'print("MIME", " ".join(sorted(s)))']],
    ['ipywidgets 8.1.9 (this env)', ['run', '--no-project', '--with', 'ipywidgets', 'python', '-c',
      'import ipywidgets as w; print("MIME", " ".join(w.IntSlider()._repr_mimebundle_().keys()))']],
  ];
  for (const [label, args] of versionProbes) {
    const r = await uvPrint(args);
    const line = (r.out.match(/^MIME .*/m) || [])[0] || 'FAILED: ' + oneline(r.err.split('\n').filter(Boolean).pop() || '', 90);
    console.log(`  ${pad(label, 26)} ${line.replace(/^MIME /, '')}`);
    record.notes.push({ versionProbe: label, result: line });
  }

  // -- 9. the summary table ------------------------------------------------
  H('9 — SUMMARY: every measured bundle, richest key first');
  const rows = [
    ['plotly (default)', p1], ['plotly (plotly_mimetype)', p2], ['plotly (notebook)', p3],
    ['plotly (notebook_connected)', p4], ['altair (default renderer)', a1], ['altair (mimetype renderer)', a2c],
    ['bokeh output_notebook()', b0], ['bokeh show()', b1], ['bokeh show() unprimed', b4],
    ['matplotlib png', m1], ['matplotlib svg', m2],
    ['ipywidgets IntSlider', w1], ['pandas DataFrame', d1],
  ];
  console.log(`  ${pad('case', 30)}${pad('mime keys (bytes)', 74)}plain?  pane today`);
  for (const [label, a] of rows) {
    const o = a.outputs[0];
    if (!o) { console.log(`  ${pad(label, 30)}(no output bundle)`); continue; }
    const keys = o.keys.map((k) => `${k.mime}=${kb(k.bytes)}`).join('  ');
    const v = ladderVerdict(o.keys);
    console.log(`  ${pad(label, 30)}${pad(oneline(keys, 72), 74)}${pad(plainOf(o) ? 'yes' : 'NO', 8)}${v.pick || 'nothing'}${v.overCap ? ' (OVER CAP)' : ''}`);
    if (a.outputs.length > 1) {
      for (const extra of a.outputs.slice(1)) {
        const v2 = ladderVerdict(extra.keys);
        console.log(`  ${pad('  + ' + extra.type, 30)}${pad(oneline(extra.keys.map((k) => `${k.mime}=${kb(k.bytes)}`).join('  '), 72), 74)}${pad(plainOf(extra) ? 'yes' : 'NO', 8)}${v2.pick || 'nothing'}`);
      }
    }
  }

  H('CHECKS');
  ok('a vendor bundle is present for plotly', vendorOf(p2.outputs[0] || { keys: [] }).length > 0);
  ok('altair\'s DEFAULT renderer emits text/html, not a vendor bundle',
    vendorOf(a1.outputs[0] || { keys: [] }).length === 0 && !!keyOf(a1.outputs[0] || { keys: [] }, 'text/html'));
  ok('a vendor bundle is present for altair once the mimetype renderer is on', vendorOf(a2c.outputs[0] || { keys: [] }).length > 0);
  ok('a vendor bundle is present for bokeh show()', b1.outputs.some((o) => vendorOf(o).length > 0));
  ok('a vendor bundle is present for ipywidgets', vendorOf(w1.outputs[0] || { keys: [] }).length > 0);
  ok('no probe cell raised', Object.values(record.cells).every((c) => !c.errors || !c.errors.length),
    Object.entries(record.cells).filter(([, c]) => c.errors && c.errors.length).map(([n]) => n).join(','));

} catch (e) {
  fails++;
  console.error('\nPROBE ABORTED: ' + (e && e.stack || e));
} finally {
  try { if (ws) ws.close(); } catch {}
  if (kernelId && !KEEP) {
    try { const r = await api('api/kernels/' + kernelId, { method: 'DELETE' }); console.log(`\nkernel ${kernelId} deleted (HTTP ${r.status})`); } catch {}
  }
  try {
    const r = await api('api/kernels');
    if (r.ok) console.log(`kernels left on ${PORT}: ${(await r.json()).length}`);
  } catch {}
  stopServer();
  await sleep(400);
  console.log(`server on ${PORT} ${KEEP ? 'LEFT RUNNING (JPY_PROBE_KEEP=1)' : 'stopped'}`);
  try { fs.writeFileSync(RESULTS, JSON.stringify(record, null, 2)); console.log(`raw record -> ${RESULTS}`); } catch (e) { console.log('could not write results: ' + e); }
  if (!KEEP) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nall checks green');
  process.exit(fails ? 1 : 0);
}

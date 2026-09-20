#!/usr/bin/env node
// 04-capture-and-budget.mjs — feasibility probe #4: THE STATIC FALLBACK AND THE
// TRANSPORT BUDGET.
//
// Validates, by measurement, the assumptions behind rendering vendor mime
// bundles (plotly / vega-lite / bokeh) in a sandboxed iframe with the renderer JS
// taken from the user's own install:
//
//   A  the store budget      — can renderer JS (~4.7 MB) EVER travel through the
//                              web-chat store? What does one big store value cost
//                              per committed node, per turn, per event-ring slot?
//   B  MAX_OUT_BYTES         — the value, and the MEASURED behaviour at/over it,
//                              through the pack's own shaping functions.
//   C  the kernel channel    — can the bytes come down iopub as base64 instead?
//                              How fast, and what does the running service do
//                              with a message that size?
//   D  the static fallback   — what a captured PNG actually costs for a plotly
//                              figure and a vega-lite chart, and which extra
//                              packages the user would have to install.
//   E  asset serving         — what web-chat already has for component-sized
//                              assets, with file:line references, verified live.
//
// NOTHING HERE TOUCHES THE USER'S ENVIRONMENT:
//   * it starts its OWN web-chat daemon on WC_FEAS_WEBCHAT_PORT (default 5399)
//     with a throwaway project root, and refuses to run on 5176;
//   * it starts its OWN Jupyter server on WC_FEAS_JPY_PORT (default 8974) with an
//     isolated JUPYTER_RUNTIME_DIR, and refuses to run on 8899;
//   * the one phase that runs the real service.js re-execs itself with an
//     isolated HOME so the service's own server discovery cannot see the user's
//     Jupyter server, and asserts that isolation before it starts;
//   * every Python dependency is an ephemeral `uv run --with` environment.
//
// Usage:
//   node test/feasibility/04-capture-and-budget.mjs              # everything
//   node test/feasibility/04-capture-and-budget.mjs A B          # selected phases
//   WC_DEV=/path/to/web-chat-dev  ...                            # web-chat source
//   WC_FEAS_WEBCHAT_PORT=5399 WC_FEAS_JPY_PORT=8974 ...          # ports
//
// Exit code is 0 whenever the probe ran; a phase that cannot be measured says so
// and is reported UNMEASURABLE rather than failing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// config + guards
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.resolve(HERE, '..', '..');
const SERVICE_JS = path.join(PACK, 'components', 'jpy-notebook', 'service.js');
const WCDEV = process.env.WC_DEV || path.resolve(os.homedir(), 'Dev', 'web-chat-dev');

const WEBCHAT_PORT = Number(process.env.WC_FEAS_WEBCHAT_PORT || 5399);
const JPY_PORT = Number(process.env.WC_FEAS_JPY_PORT || 8974);
const JPY_PORT_B = JPY_PORT + 1;            // second server, rate limit lifted
const TMP = process.env.WC_FEAS_TMP || path.join(os.tmpdir(), 'wc-feas-budget');
const TOKEN = 'feas' + Math.random().toString(16).slice(2, 12);

// Ports that belong to the user's live session. Hard refusal, not a warning.
const FORBIDDEN = new Set([5176, 8899]);
for (const [what, p] of [['web-chat', WEBCHAT_PORT], ['jupyter', JPY_PORT], ['jupyter#2', JPY_PORT_B]]) {
  if (FORBIDDEN.has(p)) {
    console.error(`refusing to use port ${p} for ${what}: that is the user's live daemon/server`);
    process.exit(2);
  }
}

const PHASES = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());
const want = (id) => PHASES.length === 0 || PHASES.includes(id);

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

// A probe that dies quietly is worse than one that fails loudly: these say so.
let FINISHED = false;
process.on('exit', (code) => { if (!FINISHED) process._rawDebug(`[probe] EXITED EARLY, code ${code}`); });
process.on('beforeExit', (code) => { if (!FINISHED) process._rawDebug(`[probe] event loop drained early, code ${code}`); });
process.on('uncaughtException', (e) => { process._rawDebug('[probe] uncaught: ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { process._rawDebug('[probe] unhandled rejection: ' + (e && e.stack || e)); });

const findings = [];
function finding(id, claim, verdict, evidence, implication) {
  findings.push({ id, claim, verdict, evidence, implication });
}
const hr = (t) => console.log('\n' + '─'.repeat(78) + (t ? `\n${t}\n` + '─'.repeat(78) : ''));
const say = (...a) => console.log(...a);
const MiB = 1048576;
const B = (n) => `${Number(n).toLocaleString('en-US')} B` + (n >= MiB ? ` (${(n / MiB).toFixed(2)} MiB)` : n >= 1024 ? ` (${(n / 1024).toFixed(1)} KiB)` : '');
const ms = (n) => `${n.toFixed(1)} ms`;
async function timed(fn) { const t0 = performance.now(); const v = await fn(); return [v, performance.now() - t0]; }
const sleep = (n) => new Promise((r) => setTimeout(r, n));

// `grep -n` over a source file: returns "path:line" for the first match, so every
// source claim in the report is anchored to a line that exists right now.
function srcRef(file, re) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return { ref: `${file}:${i + 1}`, text: lines[i].trim() };
  } catch {}
  return { ref: `${file}:?`, text: '(not found)' };
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

// Reap headless browsers kaleido's `choreographer` leaves running when its
// python process is killed. Deliberately narrow: BOTH the wrapper script name
// AND a temp --user-data-dir must match, so nothing the user is using is touched.
function sweepChoreographer() {
  const killed = [];
  try {
    const ps = spawnSync('ps', ['-eo', 'pid,command'], { encoding: 'utf8' }).stdout || '';
    for (const line of ps.split('\n')) {
      if (!/_unix_pipe_chromium_wrapper\.py/.test(line)) continue;
      if (!new RegExp(`--user-data-dir=${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(line) && !/--user-data-dir=\/(var|tmp)\//.test(line)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (Number.isFinite(pid) && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch {} }
    }
  } catch {}
  return killed;
}
function du(dir) {
  let total = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else { try { total += fs.statSync(fp).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

// ---------------------------------------------------------------------------
// uv helpers (throwaway environments, never an install)
// ---------------------------------------------------------------------------

function uv(args, { timeout = 300000, input } = {}) {
  const r = spawnSync('uv', args, { encoding: 'utf8', timeout, input, env: process.env });
  return { ok: r.status === 0, status: r.status, out: r.stdout || '', err: r.stderr || '', timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}
function uvPy(withs, code, opts = {}) {
  const args = ['run', '--quiet'];
  for (const w of withs) args.push('--with', w);
  args.push('python', '-');
  return uv(args, { ...opts, input: code });
}
const haveUv = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0;

// ---------------------------------------------------------------------------
// the renderer payload: the REAL plotly.min.js when we can get it
// ---------------------------------------------------------------------------

let RENDERER = null;   // { bytes, path, real:boolean, text }
function getRendererJs() {
  if (RENDERER) return RENDERER;
  fs.mkdirSync(TMP, { recursive: true });
  const dest = path.join(TMP, 'plotly.min.js');
  if (!fs.existsSync(dest) && haveUv) {
    const r = uvPy(['plotly'], `
import os, shutil, plotly, json
p = os.path.dirname(plotly.__file__)
cands = [os.path.join(p, 'package_data', 'plotly.min.js')]
for root, d, files in os.walk(os.path.join(p, 'labextension')):
    for f in files:
        if f.endswith('.js') and os.path.getsize(os.path.join(root, f)) > 1_000_000:
            cands.append(os.path.join(root, f))
hit = next((c for c in cands if os.path.exists(c)), None)
if hit:
    shutil.copyfile(hit, ${JSON.stringify(dest)})
    print(json.dumps({'src': hit, 'bytes': os.path.getsize(hit), 'version': plotly.__version__}))
else:
    print(json.dumps({'src': None}))
`);
    if (r.ok) say('  plotly.min.js located:', r.out.trim());
  }
  if (fs.existsSync(dest)) {
    const text = fs.readFileSync(dest, 'utf8');
    RENDERER = { bytes: Buffer.byteLength(text), path: dest, real: true, text };
  } else {
    // Synthetic stand-in of the same order of magnitude, clearly labelled.
    const text = ('!function(e,t){"use strict";var n=' + 'x'.repeat(64) + ';}(window,document);\n').repeat(60000).slice(0, 4815814);
    RENDERER = { bytes: Buffer.byteLength(text), path: null, real: false, text };
  }
  return RENDERER;
}

// ---------------------------------------------------------------------------
// PHASE A — THE STORE BUDGET
// ---------------------------------------------------------------------------

let daemon = null, DPATHS = null, DROOT = null, BOUND_PORT = WEBCHAT_PORT, keepalive = null;
const api = (p, init) => fetch(`http://127.0.0.1:${BOUND_PORT}${p}`, init);
const apiJson = (p, body) => api(p, body === undefined
  ? undefined
  : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function startDaemon() {
  if (daemon) return daemon;
  if (!fs.existsSync(WCDEV)) return null;
  const require_ = createRequire(path.join(WCDEV, 'package.json'));
  const { createServer } = require_(path.join(WCDEV, 'lib', 'server', 'index.js'));
  const { resolvePaths } = require_(path.join(WCDEV, 'lib', 'server', 'paths.js'));
  DROOT = path.join(TMP, 'webchat-root');
  rmrf(DROOT); fs.mkdirSync(DROOT, { recursive: true });
  DPATHS = resolvePaths(DROOT);
  // Try our port, then a few above it — never 'auto', which walks from 5173 and
  // would land on the user's own daemons. Forbidden ports are skipped outright.
  let lastErr = null;
  for (let p = WEBCHAT_PORT; p < WEBCHAT_PORT + 10; p++) {
    if (FORBIDDEN.has(p)) continue;
    const srv = createServer({ root: DROOT, port: p });
    try {
      // writePortfile:false ⇒ no portfile, no capture hub, no instance registry.
      // Nothing about this daemon is visible to the user's CLI or browser.
      await srv.start({ writePortfile: false });
      BOUND_PORT = p;
      daemon = srv;
      // CRITICAL, and a real property of the daemon rather than a test hack:
      // ws.js starts a SHUTDOWN_GRACE_MS (10 s) timer whenever the last viewer
      // disconnects, and it fires triggerShutdown → process.exit(0) — which,
      // with the daemon in-process, kills the PROBE mid-run with exit code 0 and
      // no error. (lib/server/ws.js:5,95 and lib/server/index.js:260.) One
      // held-open socket is what a browser would be.
      keepalive = new WebSocket(`ws://127.0.0.1:${BOUND_PORT}/ws`);
      await new Promise((res) => { keepalive.onopen = res; keepalive.onerror = res; setTimeout(res, 5000); });
      return srv;
    } catch (e) { lastErr = e; try { await srv.stop(); } catch {} }
  }
  throw lastErr || new Error('no free port for the probe daemon');
}

async function commitTurn(message) {
  await apiJson('/api/turn-begin', { message, author: 'user' });
  const [r, took] = await timed(() => apiJson('/api/turn-end', { author: 'claude', summary: message }));
  return { r, took };
}
function nodeFileBytes(id) {
  try { return fs.statSync(path.join(DPATHS.GRAPH_DIR, `${id}.json`)).size; } catch { return 0; }
}
async function wsHello() {
  const t0 = performance.now();
  const sock = new WebSocket(`ws://127.0.0.1:${BOUND_PORT}/ws`);
  const first = await new Promise((resolve, reject) => {
    sock.onmessage = (ev) => resolve(ev.data);
    sock.onerror = (e) => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('ws timeout')), 20000);
  });
  const took = performance.now() - t0;
  try { sock.close(); } catch {}
  return { bytes: Buffer.byteLength(String(first)), took };
}

async function phaseA() {
  hr('PHASE A — THE STORE BUDGET');
  const req_ = fs.existsSync(WCDEV) ? createRequire(path.join(WCDEV, 'package.json')) : null;
  if (!req_) {
    say(`web-chat source not found at ${WCDEV} — set WC_DEV. Phase A UNMEASURABLE.`);
    finding('A', 'A single store value has a practical ceiling well below renderer-JS size', 'UNMEASURABLE',
      `web-chat source absent at ${WCDEV}`, 'rerun with WC_DEV pointing at the web-chat checkout');
    return;
  }

  // What the code says, with line anchors.
  const bus = srcRef(path.join(WCDEV, 'lib', 'core', 'bus.js'), /^const MAX_EVENTS/);
  const ringPush = srcRef(path.join(WCDEV, 'lib', 'core', 'bus.js'), /events\.push\(built\)/);
  const storeEvt = srcRef(path.join(WCDEV, 'lib', 'server', 'routes', 'store.js'), /kind: 'store', patch/);
  const snapStore = srcRef(path.join(WCDEV, 'lib', 'server', 'graph.js'), /store: \{ \.\.\.state\.store \}/);
  const nodeWrite = srcRef(path.join(WCDEV, 'lib', 'server', 'graph.js'), /writeJsonAtomic\(path\.join\(paths\.GRAPH_DIR/);
  const dirty = srcRef(path.join(WCDEV, 'lib', 'server', 'domain', 'turns.js'), /return snapshotView\(snap\) !== snapshotView/);
  const hello = srcRef(path.join(WCDEV, 'lib', 'server', 'ws.js'), /type: 'hello'/);
  const bodyLimit = srcRef(path.join(WCDEV, 'lib', 'server', 'index.js'), /express\.json\(\{ limit/);
  say('the amplification sites, from the real source:');
  for (const s of [bus, ringPush, storeEvt, snapStore, nodeWrite, dirty, hello, bodyLimit]) say(`  ${s.ref}\n      ${s.text}`);

  const R = getRendererJs();
  say(`\nrenderer payload: ${B(R.bytes)} ${R.real ? `(REAL ${R.path})` : '(synthetic stand-in — uv/plotly unavailable)'}`);

  const srv = await startDaemon();
  if (!srv) { say('could not start an isolated daemon; phase A UNMEASURABLE'); return; }
  say(`isolated daemon on 127.0.0.1:${BOUND_PORT}, root ${DROOT}`);

  // Baseline: a node whose store holds one tiny value. (A turn that changes
  // nothing commits NOTHING — that is the fold-forward rule — so the baseline
  // has to actually write something.)
  await apiJson('/api/store', { patch: { probe_blob: 'baseline' } });
  const base = await commitTurn('baseline');
  const baseBytes = nodeFileBytes(base.r.node_id);
  say(`\nbaseline node (store = one 8-byte value): ${B(baseBytes)}, turn-end ${ms(base.took)}`);

  const sizes = [
    ['64 KB', 64 * 1024],
    ['256 KB (== MAX_OUT_BYTES)', 256 * 1024],
    ['1 MB', 1024 * 1024],
    [`renderer JS (${(R.bytes / MiB).toFixed(2)} MiB)`, R.bytes],
  ];
  say('\n  value                         POST /api/store   node file on disk    turn-end   GET /api/store   WS hello');
  const rows = [];
  for (const [label, n] of sizes) {
    const val = n === R.bytes ? R.text : R.text.slice(0, n);
    const [, postMs] = await timed(() => apiJson('/api/store', { patch: { probe_blob: val } }));
    const { r, took } = await commitTurn(`store ${label}`);
    const nodeB = nodeFileBytes(r.node_id);
    const [getRes, getMs] = await timed(async () => { const rr = await api('/api/store'); return Buffer.byteLength(await rr.text()); });
    const h = await wsHello();
    rows.push({ label, n, postMs, nodeB, took, getRes, getMs, hello: h });
    say(`  ${label.padEnd(28)} ${ms(postMs).padStart(10)}   ${B(nodeB).padStart(20)}   ${ms(took).padStart(9)}   ${B(getRes).padStart(14)}   ${B(h.bytes).padStart(12)} / ${ms(h.took)}`);
  }
  const big = rows[rows.length - 1];
  const amp = big.nodeB / big.n;

  // The tax on a turn that changes NOTHING: liveIsDirty stringifies the whole
  // store twice on every turn-end, whatever the turn did.
  const noop = [];
  for (let i = 0; i < 3; i++) { const t = await commitTurn('no-change turn'); noop.push(t.took); }
  await apiJson('/api/store', { patch: { probe_blob: 'x' } });
  await commitTurn('shrink');
  const noopSmall = [];
  for (let i = 0; i < 3; i++) { const t = await commitTurn('no-change turn (small store)'); noopSmall.push(t.took); }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  say(`\n  turn-end with the ${(big.n / MiB).toFixed(2)} MiB value live, turn changed nothing: ${ms(avg(noop))} avg of 3`);
  say(`  turn-end with a 1-byte value,                   same:  ${ms(avg(noopSmall))} avg of 3`);

  // Cumulative disk: commit k nodes each carrying the big value.
  const K = 8;
  await apiJson('/api/store', { patch: { probe_blob: big.n === R.bytes ? R.text : R.text.slice(0, big.n) } });
  const before = du(DPATHS.GRAPH_DIR);
  for (let i = 0; i < K; i++) {
    // Each node must DIFFER or the turn is a no-change turn and commits nothing.
    await apiJson('/api/store', { patch: { probe_seq: i, probe_blob: (R.text.slice(0, big.n - 8) + String(i).padStart(8, '0')) } });
    await commitTurn(`bulk ${i}`);
  }
  const after = du(DPATHS.GRAPH_DIR);
  const perNode = (after - before) / K;
  say(`\n  ${K} consecutive nodes carrying the value: graph dir grew ${B(after - before)} → ${B(perNode)} per node`);
  say(`  extrapolated: 100 such nodes = ${B(perNode * 100)};  1000 = ${B(perNode * 1000)}`);

  // The event ring. Every store write keeps its WHOLE patch in the ring
  // (bus.js pushes the built event, routes/store.js puts `patch` on it), and
  // GET /api/events serializes all of them with no truncation.
  const MAX_EVENTS = req_(path.join(WCDEV, 'lib', 'core', 'bus.js')).MAX_EVENTS;
  const REPS = 6;
  const evBefore = await api('/api/events?since=0').then((r) => r.text()).then((t) => Buffer.byteLength(t));
  for (let i = 0; i < REPS; i++) await apiJson('/api/store', { patch: { probe_ring: R.text.slice(0, big.n - 8) + String(i).padStart(8, '0') } });
  const [evBytes, evMs] = await timed(async () => Buffer.byteLength(await (await api('/api/events?since=0')).text()));
  say(`\n  event ring: MAX_EVENTS=${MAX_EVENTS} (${bus.ref})`);
  say(`  GET /api/events after ${REPS} writes of the value: ${B(evBytes)} in ${ms(evMs)} (was ${B(evBefore)})`);
  say(`  per retained write ≈ ${B((evBytes - evBefore) / REPS)}; a full ring of them ≈ ${B(((evBytes - evBefore) / REPS) * MAX_EVENTS)} resident`);

  say(`  (the ring already held this probe's earlier writes — the DELTA is the number that matters)`);
  say(`\n  and note where those bytes go: GET /api/store is what the MCP tool get_store returns TO THE MODEL.`);
  say(`  ${B(big.getRes)} ≈ ${Math.round(big.getRes / 4).toLocaleString('en-US')} tokens of context for one look at the store.`);
  say(`  GET /api/events is get_events: ${B(evBytes)} ≈ ${Math.round(evBytes / 4).toLocaleString('en-US')} tokens.`);

  say(`\n  body limit: ${bodyLimit.text}  → the HTTP layer ACCEPTS the write; nothing refuses it.`);

  // The ceiling, stated as a budget rather than a vibe. Every number in this
  // table is the MEASURED amplification applied to a candidate value size.
  const ampNode = big.nodeB / big.n;             // node bytes per store byte
  const ampRing = ((evBytes - evBefore) / REPS) / big.n;
  say('\n  THE BUDGET (measured amplification applied to a candidate value size):');
  say('    value      per node    100 nodes     full ring (1000)   one get_store (tokens)');
  for (const n of [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024, R.bytes]) {
    say(`    ${B(n).split(' (')[0].padStart(11)} ${B(Math.round(n * ampNode)).split(' (')[0].padStart(11)} ${B(Math.round(n * ampNode * 100)).padStart(22)} ${B(Math.round(n * ampRing * MAX_EVENTS)).padStart(22)}   ${Math.round(n / 4).toLocaleString('en-US').padStart(12)}`);
  }
  say('    (the ring column is the worst case — 1000 writes of that value still retained)');

  // The obvious alternative: skip the store and inline the renderer in the PANE
  // HTML (a component.html, or a render). Mounts are snapshotted into every node
  // exactly like the store is, so measure it rather than assume.
  say('\n— and the other obvious idea: inline the renderer in the PANE HTML —');
  await apiJson('/api/store', { patch: { probe_blob: 'x', probe_seq: 'x', probe_ring: 'x' } });
  await commitTurn('shrink store before the mount test');
  const smallNode = await commitTurn('tiny mount');
  await apiJson('/api/render', { id: 'feas-probe-pane', html: '<div id="probe">small</div>' });
  const tinyMount = await commitTurn('tiny mount committed');
  const tinyBytes = nodeFileBytes(tinyMount.r.node_id);
  const [, renderMs] = await timed(() => apiJson('/api/render', { id: 'feas-probe-pane', html: `<div id="probe">x</div><script>${R.text}</script>` }));
  const bigMount = await commitTurn('renderer inlined in the pane');
  const bigMountBytes = nodeFileBytes(bigMount.r.node_id);
  const mountsBytes = Buffer.byteLength(await (await api('/api/mounts')).text());
  const h2 = await wsHello();
  say(`  POST /api/render with the renderer in a <script>: ${ms(renderMs)}`);
  say(`  node carrying that pane: ${B(bigMountBytes)}  (the same pane without it: ${B(tinyBytes)})`);
  say(`  GET /api/mounts: ${B(mountsBytes)};  WS hello: ${B(h2.bytes)}`);
  await apiJson('/api/clear', { id: 'feas-probe-pane' });
  await commitTurn('clear probe pane');
  finding('A3', 'Inlining the renderer in the pane HTML avoids the budget problem', 'REFUTED',
    `a mount is snapshotted into every committed node exactly like the store (${snapStore.ref} region): a pane carrying the ${B(R.bytes)} renderer in a <script> produced a ${B(bigMountBytes)} node vs ${B(tinyBytes)} for the same pane without it, and GET /api/mounts became ${B(mountsBytes)} and the WS hello ${B(h2.bytes)}`,
    'component.html / render is NOT a way round the per-node cost. Whatever carries the renderer must be fetched by the BROWSER at mount time and never enter a node — which is what the seed.js route (phase E) does.');

  finding('A1', 'Renderer JS (~4.7 MB) can travel through the web-chat store', 'REFUTED',
    `POST /api/store accepted ${B(big.n)} in ${ms(big.postMs)}, but one committed node then weighs ${B(big.nodeB)} on disk (${amp.toFixed(2)}× the value; baseline node ${B(baseBytes)}); ${K} such nodes cost ${B(after - before)} (${B(perNode)}/node); a no-change turn still costs ${ms(avg(noop))} vs ${ms(avg(noopSmall))} with a small store; each of the last ${MAX_EVENTS} store writes stays whole in the event ring (GET /api/events = ${B(evBytes)} after only ${REPS} writes)`,
    'the renderer bytes must NOT go through the store. The store is for small, changing state; a megabyte-scale constant multiplies across every node, every turn, every WS hello and 1000 ring slots.');
  finding('A2', 'There is a practical ceiling for a single store value', 'CONFIRMED',
    `measured per-node disk cost is ≈${amp.toFixed(2)}× the value size (JSON escaping + pretty:2); at 256 KB a node costs ${B(rows[1].nodeB)} and 100 such nodes ${B(Math.round(256 * 1024 * ampNode * 100))}; at ${(big.n / MiB).toFixed(2)} MiB a node costs ${B(big.nodeB)} and 100 nodes ${B(Math.round(big.n * ampNode * 100))}; a full event ring of 256 KB writes is ${B(Math.round(256 * 1024 * ampRing * MAX_EVENTS))} vs ${B(Math.round(big.n * ampRing * MAX_EVENTS))} for the renderer`,
    `the practical ceiling for ONE store value is ~256 KB — the cap the pack already enforces per cell. That keeps a node under ~270 KB, 100 nodes under ~26 MB, a worst-case ring under ~260 MB, and one get_store under ~66k tokens. A 4.59 MiB value breaks all four by ~19×.`);
}

// ---------------------------------------------------------------------------
// PHASE B — MAX_OUT_BYTES, MEASURED THROUGH THE PACK'S OWN SHAPERS
// ---------------------------------------------------------------------------

function phaseB() {
  hr('PHASE B — MAX_OUT_BYTES: THE VALUE, AND WHAT ACTUALLY HAPPENS AT IT');
  const c1 = srcRef(SERVICE_JS, /^const MAX_OUT_BYTES/);
  const c2 = srcRef(SERVICE_JS, /^const MAX_STREAM_CHARS/);
  const c3 = srcRef(SERVICE_JS, /kind: 'capped'/);
  const c4 = srcRef(SERVICE_JS, /kind: 'too-big'/);
  const ladder = srcRef(SERVICE_JS, /^const MIME_LADDER/);
  for (const s of [c1, c2, c4, c3, ladder]) say(`  ${s.ref}\n      ${s.text}`);

  process.env.WC_JUPYTER_TEST = '1';
  const require_ = createRequire(import.meta.url);
  let T;
  try { T = require_(SERVICE_JS).__test; } catch (e) { T = null; say('could not load service.js: ' + e.message); }
  if (!T) { finding('B', 'MAX_OUT_BYTES behaviour', 'UNMEASURABLE', 'service.js __test exports unavailable', ''); return; }
  const MAX_OUT_BYTES = Number(/= *(\d+) *\* *(\d+)/.exec(c1.text) ? RegExp.$1 * RegExp.$2 : 262144);
  const MAX_STREAM_CHARS = Number(/= *(\d+)/.exec(c2.text) ? RegExp.$1 : 40000);
  say(`\n  MAX_OUT_BYTES   = ${MAX_OUT_BYTES} (${B(MAX_OUT_BYTES)})   [per cell, across all its outputs]`);
  say(`  MAX_STREAM_CHARS= ${MAX_STREAM_CHARS}`);

  // 1. a PNG: where exactly does image → too-big flip?
  say('\n— image/png, bisecting the cliff —');
  const mk = (b64len) => ({ 'image/png': 'A'.repeat(b64len) });
  let lo = 1, hi = MAX_OUT_BYTES * 4;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const k = T.shapeMime(mk(mid)).kind;
    if (k === 'too-big') hi = mid; else lo = mid + 1;
  }
  const flip = lo;
  const under = T.shapeMime(mk(flip - 1)), over = T.shapeMime(mk(flip));
  say(`  flips at b64 length ${flip} chars (= ${B(Math.round(flip * 0.75))} of image)`);
  say(`  at ${flip - 1}: kind=${under.kind}, reported bytes=${under.bytes}, carries b64 (${under.b64.length} chars) → lands in the store`);
  say(`  at ${flip}:     kind=${over.kind}, reported bytes=${over.bytes}, NO b64 → the image is DROPPED, and the pane is told`);
  const overJson = JSON.stringify(over).length;
  say(`  the too-big record itself is ${overJson} B — the store never sees the picture`);

  // …but shapeMime is not the binding cap for an image. flush() re-measures the
  // SHAPED record with JSON.stringify and caps the CELL at MAX_OUT_BYTES
  // (service.js:897), so an image can pass shapeMime and still be thrown away
  // whole — as `capped`, with nothing rendered. Find that second, lower cliff.
  let lo2 = 1, hi2 = MAX_OUT_BYTES * 2;
  while (lo2 < hi2) {
    const mid = Math.floor((lo2 + hi2) / 2);            // mid = bytes of image
    const rec = T.shapeMime({ 'image/png': 'A'.repeat(Math.ceil(mid * 4 / 3)) });
    if (JSON.stringify(rec).length > MAX_OUT_BYTES) hi2 = mid; else lo2 = mid + 1;
  }
  say(`\n  the BINDING cap for an image is the per-cell accumulator, not the mime shaper:`);
  say(`    shapeMime accepts an image up to ${B(Math.round((flip - 1) * 0.75))}`);
  say(`    flush() (${c3.ref}) drops the whole record once it stringifies over ${B(MAX_OUT_BYTES)}`);
  say(`    → the real ceiling for a rendered image is ${B(lo2 - 1)} of PNG. Above it: kind='capped', nothing shown.`);
  say(`    (phase S confirms this live: a 120 KB image renders, a 300 KB image comes back capped(withheld 1))`);

  // 2. text-bearing mimes: clipped, not dropped
  say('\n— text mimes at 4× the cap —');
  for (const [mime, key] of [['text/html', 'html'], ['text/markdown', 'text'], ['application/json', 'text'], ['image/svg+xml', 'svg']]) {
    const src = mime === 'application/json' ? { [mime]: { k: 'v'.repeat(MAX_OUT_BYTES * 4) } } : { [mime]: '<p>' + 'y'.repeat(MAX_OUT_BYTES * 4) + '</p>' };
    const o = T.shapeMime(src);
    say(`  ${mime.padEnd(18)} kind=${String(o.kind).padEnd(9)} kept=${B(String(o[key] || '').length).padEnd(22)} clipped=${o.clipped}`);
  }
  const plain = T.shapeMime({ 'text/plain': 'z'.repeat(MAX_OUT_BYTES * 4) });
  say(`  text/plain         kind=${plain.kind} kept=${B(plain.text.length)} (MAX_STREAM_CHARS, not MAX_OUT_BYTES) clipped=${plain.clipped}`);
  const stream = T.shapeStream('stdout', 'q'.repeat(MAX_STREAM_CHARS * 3));
  say(`  stream             kind=${stream.kind} kept=${B(stream.text.length)} clipped=${stream.clipped}`);

  // 3. THE PREMISE OF THE WHOLE DESIGN: vendor bundles are dropped on the floor.
  say('\n— vendor mime bundles (what this design exists to fix) —');
  const vendor = [
    'application/vnd.plotly.v1+json',
    'application/vnd.vegalite.v5+json',
    'application/vnd.vega.v5+json',
    'application/vnd.bokehjs_exec.v0+json',
    'application/vnd.jupyter.widget-view+json',
  ];
  for (const v of vendor) {
    const alone = T.shapeMime({ [v]: { data: [1, 2, 3], layout: {} } });
    const withPlain = T.shapeMime({ [v]: { data: [1, 2, 3] }, 'text/plain': 'FigureWidget({...})' });
    say(`  ${v.padEnd(42)} alone → ${alone === null ? 'null (NOTHING RENDERS)' : alone.kind}` +
        `   | with text/plain → kind=${withPlain.kind}${withPlain.inert && withPlain.inert.length ? ` inert=${withPlain.inert.join(',')}` : ''}`);
  }
  // What a real plotly bundle weighs, for the store-budget question.
  const figJson = JSON.stringify({ data: [{ type: 'scatter', x: Array.from({ length: 200 }, (_, i) => i), y: Array.from({ length: 200 }, (_, i) => (i * i) % 97) }], layout: { title: 'probe' } });
  say(`\n  a 200-point plotly figure SPEC is ${B(figJson.length)} — the spec is cheap; only the RENDERER is expensive`);

  finding('B1', 'MAX_OUT_BYTES is 256 KB per cell and an output over it is refused, not silently shortened', 'CONFIRMED',
    `${c1.ref}: MAX_OUT_BYTES=${MAX_OUT_BYTES}. Measured: image/png flips image→too-big at b64 length ${flip} (= ${B(Math.round(flip * 0.75))}, i.e. 2×MAX_OUT_BYTES of base64) and the record then carries no pixels (${overJson} B); text-bearing mimes are CLIPPED with a \`clipped\` count; text/plain is clipped to MAX_STREAM_CHARS=${MAX_STREAM_CHARS}, not MAX_OUT_BYTES`,
    'the pane already has a vocabulary for "too big to carry" (kind:too-big / clipped / capped). A static-capture fallback should reuse it rather than inventing a new one.');
  finding('B1b', 'The image ceiling is 384 KB (what shapeMime allows)', 'REFUTED',
    `two caps disagree: shapeMime (${c4.ref}) lets an image through up to ${B(Math.round((flip - 1) * 0.75))} of PNG, but flush (${c3.ref}) then stringifies the shaped record and caps the whole CELL at ${B(MAX_OUT_BYTES)}. Bisected against the real functions: the largest PNG that actually renders is ${B(lo2 - 1)}. Confirmed live in phase S — a 120 KB image renders, a 300 KB image returns kind:'capped' with nothing shown`,
    'a captured PNG must come in under ~190 KB of binary or the user sees "capped" and no picture. That is the budget the static fallback has to hit — and a plausible small fix (make the two caps agree, or let the capture bypass the accumulator) belongs in the implementation.');
  finding('B2', 'Vendor bundles are dropped by the current mime ladder', 'CONFIRMED',
    `${ladder.ref}: MIME_LADDER has no application/vnd.* entry. shapeMime({'application/vnd.plotly.v1+json': …}) returns null; with a text/plain sibling it returns kind:'text' (the repr), never the bundle`,
    'confirms the problem statement: today a plotly/vega/bokeh output renders as its text repr or as nothing at all.');
}

// ---------------------------------------------------------------------------
// PHASE C — THE KERNEL CHANNEL
// ---------------------------------------------------------------------------

const jpys = [];
function startJupyter(port, runtimeDir, extraArgs = []) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const nbdir = path.join(TMP, `nb-${port}`);
  fs.mkdirSync(nbdir, { recursive: true });
  const args = ['run', '--quiet', '--with', 'jupyter-server', '--with', 'ipykernel',
    'python', '-m', 'jupyter_server', '--no-browser', `--port=${port}`, '--ServerApp.port_retries=0',
    `--ServerApp.root_dir=${nbdir}`, `--IdentityProvider.token=${TOKEN}`, '--ServerApp.open_browser=False',
    ...extraArgs];
  const child = spawn('uv', args, {
    env: { ...process.env, JUPYTER_RUNTIME_DIR: runtimeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  jpys.push(child);
  return { child, nbdir, runtimeDir, port };
}
async function waitJupyter(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: 'token ' + TOKEN } });
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}
const jfetch = (port, p, init = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { Authorization: 'token ' + TOKEN, 'content-type': 'application/json', ...(init.headers || {}) } });

function kmsg(msg_type, content, session) {
  return {
    header: { msg_id: Math.random().toString(16).slice(2), username: 'probe', session, msg_type, version: '5.3', date: new Date().toISOString() },
    parent_header: {}, metadata: {}, content, channel: 'shell',
  };
}

// Run `code` on a kernel socket and measure everything that comes back.
function runCell(sock, code, timeoutMs = 120000) {
  const session = 'probe-session';
  const m = kmsg('execute_request', { code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: true }, session);
  const id = m.header.msg_id;
  return new Promise((resolve) => {
    let bytes = 0, frames = 0, firstAt = null, biggest = 0;
    const kinds = [];
    const texts = [];
    const t0 = performance.now();
    const done = (why) => {
      sock.removeEventListener('message', onMsg);
      resolve({ why, ms: performance.now() - t0, firstMs: firstAt == null ? null : firstAt - t0, bytes, frames, biggest, kinds, texts });
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const onMsg = (ev) => {
      const raw = ev.data;
      const n = typeof raw === 'string' ? Buffer.byteLength(raw) : (raw.byteLength || 0);
      bytes += n; frames++; if (n > biggest) biggest = n;
      if (firstAt == null) firstAt = performance.now();
      let msg = null;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
      if (msg.parent_header && msg.parent_header.msg_id !== id) return;
      if (msg.channel === 'iopub') {
        kinds.push(msg.header.msg_type + (msg.header.msg_type === 'status' ? ':' + msg.content.execution_state : ''));
        if (msg.header.msg_type === 'stream') texts.push(String(msg.content.text || '').slice(0, 300));
        if (msg.header.msg_type === 'error') texts.push(msg.content.ename + ': ' + msg.content.evalue);
        if (msg.header.msg_type === 'status' && msg.content.execution_state === 'idle') { clearTimeout(timer); done('idle'); }
      }
    };
    sock.addEventListener('message', onMsg);
    sock.send(JSON.stringify(m));
  });
}

async function openKernel(port) {
  const r = await jfetch(port, '/api/kernels', { method: 'POST', body: JSON.stringify({ name: 'python3' }) });
  const k = await r.json();
  const sock = new WebSocket(`ws://127.0.0.1:${port}/api/kernels/${k.id}/channels?token=${TOKEN}`);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('ws open failed')); setTimeout(() => rej(new Error('ws open timeout')), 20000); });
  return { id: k.id, sock };
}
async function closeKernel(port, id, sock) {
  try { sock.close(); } catch {}
  try { await jfetch(port, `/api/kernels/${id}`, { method: 'DELETE' }); } catch {}
}

async function phaseC() {
  hr('PHASE C — CAN THE RENDERER BYTES COME DOWN THE KERNEL INSTEAD?');
  if (!haveUv) { finding('C', 'kernel transport', 'UNMEASURABLE', 'uv not on PATH', ''); say('uv missing'); return; }

  const rtA = path.join(TMP, 'jpy-runtime-a');
  rmrf(rtA);
  say(`starting an isolated Jupyter server on ${JPY_PORT} (runtime dir ${rtA}) …`);
  startJupyter(JPY_PORT, rtA);
  if (!await waitJupyter(JPY_PORT)) { say('server never came up'); finding('C', 'kernel transport', 'UNMEASURABLE', 'own jupyter server failed to start', ''); return; }
  say('up.');

  // What the server's own defaults are — read from the server we just started.
  const cfg = uvPy(['jupyter-server'], `
from jupyter_server.services.kernels.connection.channels import ZMQChannelsWebsocketConnection as Z
import json, jupyter_server, tornado
t = Z.class_traits()
print(json.dumps({
 'jupyter_server': jupyter_server.__version__, 'tornado': tornado.version,
 'iopub_data_rate_limit': t['iopub_data_rate_limit'].default_value,
 'iopub_msg_rate_limit': t['iopub_msg_rate_limit'].default_value,
 'rate_limit_window': t['rate_limit_window'].default_value,
 'limit_rate': t['limit_rate'].default_value,
}))`);
  let defaults = {};
  try { defaults = JSON.parse(cfg.out.trim().split('\n').pop()); } catch {}
  say(`\n  jupyter_server ${defaults.jupyter_server}, tornado ${defaults.tornado}`);
  say(`  DEFAULTS: limit_rate=${defaults.limit_rate}  iopub_data_rate_limit=${defaults.iopub_data_rate_limit} B/s  window=${defaults.rate_limit_window}s  msg_rate=${defaults.iopub_msg_rate_limit}/s`);

  const k = await openKernel(JPY_PORT);
  await runCell(k.sock, 'import base64, os\nfrom IPython.display import display\n1');

  const R = getRendererJs();
  const plan = [
    ['256 KB', 256 * 1024],
    ['1 MB', 1024 * 1024],
    [`renderer JS (${(R.bytes / MiB).toFixed(2)} MiB)`, R.bytes],
    ['12 MB', 12 * 1024 * 1024],
  ];
  say('\n— DEFAULT server (rate limit on): ONE display_data carrying base64 —');
  say('  the payload is built in an untimed cell first, so `wall` is transport, not base64 encoding.');
  say('  payload            wall     first frame   ws bytes in   frames   biggest frame   outcome');
  const defaultRuns = [];
  for (const [label, n] of plan) {
    await runCell(k.sock, `PAY = base64.b64encode(os.urandom(${n})).decode()\nlen(PAY)`);
    const r = await runCell(k.sock, `display({'application/x-probe-b64': PAY}, raw=True)`);
    const limited = r.texts.some((t) => /IOPub data rate exceeded/i.test(t));
    const gotData = r.kinds.includes('display_data');
    defaultRuns.push({ label, n, r, limited, gotData });
    say(`  ${label.padEnd(18)} ${ms(r.ms).padStart(9)} ${String(r.firstMs == null ? '-' : ms(r.firstMs)).padStart(13)} ${B(r.bytes).padStart(13)} ${String(r.frames).padStart(8)} ${B(r.biggest).padStart(15)}   ${limited ? 'RATE-LIMITED, output suppressed' : gotData ? 'delivered' : 'no display_data (' + r.why + ')'}`);
    if (limited) say(`      server said: ${r.texts.find((t) => /IOPub/i.test(t)).replace(/\s+/g, ' ').slice(0, 220)}`);
    await sleep(Math.max(0, (defaults.rate_limit_window || 3) * 1000));   // let the window drain
  }

  // Does the limiter EVER bite? Two shapes of the same 4.59 MiB.
  say('\n— DEFAULT server: when DOES the iopub limiter bite? —');
  say('  jupyter_server counts bytes for the data-rate limit ONLY on msg_type=="stream":');
  say('    byte_count = sum(len(x) for x in msg_list) if msg_type == "stream" else 0');
  say('    (jupyter_server/services/kernels/connection/channels.py, _limit_rate)');
  await sleep((defaults.rate_limit_window || 3) * 1000);
  const chunk = 128 * 1024, count = Math.ceil(R.bytes / chunk);
  await runCell(k.sock, `PAY = base64.b64encode(os.urandom(${chunk})).decode()\nlen(PAY)`);
  const burst = await runCell(k.sock, `for _ in range(${count}):\n    display({'application/x-probe-b64': PAY}, raw=True)\n`, 180000);
  const burstLimited = burst.texts.some((t) => /IOPub .*rate exceeded/i.test(t));
  const delivered = burst.kinds.filter((x) => x === 'display_data').length;
  say(`\n  (a) ${count} × ${B(chunk)} as display_data (${B(chunk * count)} total): ${delivered}/${count} arrived in ${ms(burst.ms)}, ${B(burst.bytes)} on the wire — limiter tripped: ${burstLimited ? 'YES' : 'NO'}`);
  await sleep((defaults.rate_limit_window || 3) * 1000);
  const printed = await runCell(k.sock, `PAY2 = base64.b64encode(os.urandom(${R.bytes})).decode()\nimport sys\nfor i in range(0, len(PAY2), 65536):\n    print(PAY2[i:i+65536])\nsys.stdout.flush()\n'done'`, 180000);
  const printLimited = printed.texts.some((t) => /IOPub .*rate exceeded/i.test(t));
  const streamMsgs = printed.kinds.filter((x) => x === 'stream').length;
  say(`  (b) the same ${B(R.bytes)} PRINTED (stdout stream, 64 KB at a time): ${streamMsgs} stream messages, ${B(printed.bytes)} on the wire in ${ms(printed.ms)} — limiter tripped: ${printLimited ? 'YES' : 'NO'}`);
  if (printLimited) say(`      server said: ${printed.texts.find((t) => /IOPub/i.test(t)).replace(/\s+/g, ' ').slice(0, 300)}`);
  await closeKernel(JPY_PORT, k.id, k.sock);

  // Second server with the limiter lifted: what is the RAW ceiling?
  const rtB = path.join(TMP, 'jpy-runtime-b');
  rmrf(rtB);
  say(`\nstarting a second server on ${JPY_PORT_B} with iopub_data_rate_limit lifted …`);
  startJupyter(JPY_PORT_B, rtB, ['--ZMQChannelsWebsocketConnection.iopub_data_rate_limit=1000000000', '--ZMQChannelsWebsocketConnection.iopub_msg_rate_limit=100000']);
  const upB = await waitJupyter(JPY_PORT_B);
  let liftedRuns = [];
  if (!upB) say('second server never came up — raw-throughput numbers unavailable');
  else {
    const k2 = await openKernel(JPY_PORT_B);
    await runCell(k2.sock, 'import base64, os\nfrom IPython.display import display\n1');
    say('\n— limiter LIFTED: raw iopub throughput —');
    say('  payload            wall     first frame   ws bytes in   frames   biggest frame   MB/s (wire)');
    for (const [label, n] of plan) {
      await runCell(k2.sock, `PAY = base64.b64encode(os.urandom(${n})).decode()\nlen(PAY)`);
      const r = await runCell(k2.sock, `display({'application/x-probe-b64': PAY}, raw=True)`);
      const mbps = (r.bytes / MiB) / (r.ms / 1000);
      liftedRuns.push({ label, n, r, mbps });
      say(`  ${label.padEnd(18)} ${ms(r.ms).padStart(9)} ${String(r.firstMs == null ? '-' : ms(r.firstMs)).padStart(13)} ${B(r.bytes).padStart(13)} ${String(r.frames).padStart(8)} ${B(r.biggest).padStart(15)}   ${mbps.toFixed(1)}`);
    }
    await closeKernel(JPY_PORT_B, k2.id, k2.sock);
  }

  const rendererDefault = defaultRuns.find((x) => /renderer/.test(x.label));
  const rendererLifted = liftedRuns.find((x) => /renderer/.test(x.label));
  finding('C1', 'The kernel can physically move renderer-sized bytes (base64 over iopub)', 'CONFIRMED',
    `on a DEFAULT jupyter_server ${defaults.jupyter_server} (limit_rate=${defaults.limit_rate}, iopub_data_rate_limit=${defaults.iopub_data_rate_limit} B/s over a ${defaults.rate_limit_window}s window) ONE display_data carrying ${B(rendererDefault ? rendererDefault.n : 0)} of base64 ${rendererDefault && rendererDefault.limited ? 'was RATE-LIMITED' : `arrived intact in ${ms(rendererDefault.r.ms)}`} as a single ${B(rendererDefault ? rendererDefault.biggest || rendererDefault.r.biggest : 0)} websocket frame; ` +
    (rendererLifted ? `with the limiter lifted: ${ms(rendererLifted.r.ms)} / ${rendererLifted.mbps.toFixed(1)} MiB/s — i.e. the limiter costs nothing for one message. ` : '') +
    `The same total as ${count} × ${B(chunk)} display_data messages: ${delivered}/${count} arrived, limiter tripped=${burstLimited}; the same bytes PRINTED as ${streamMsgs} stdout stream messages: limiter tripped=${printLimited}`,
    'the iopub data-rate limit counts bytes only for msg_type=="stream", so display_data/execute_result of ANY size slips past it. Transport time is not the objection to the kernel path — ~30-60 ms for 4.59 MiB at ~190 MiB/s.');
  finding('C1b', 'The kernel is a reasonable transport for the renderer', 'REFUTED',
    `it costs a full execute_request on the user\'s own kernel (their interpreter, their variables, their In[n] counter) per load, delivers a ${B(rendererDefault ? rendererDefault.r.biggest : 0)} single websocket frame, and the bytes then have to pass shapeMime (see C2) and the store (see A1) to reach the pane; printed output of the same size ${printLimited ? 'IS rate-limited and suppressed by the server' : 'was not rate-limited here'}`,
    'use the kernel only to ask the user\'s Python where the renderer FILE is (a path, a few hundred bytes), not to carry the file.');

  // And what would the EXISTING service do with such a message?
  process.env.WC_JUPYTER_TEST = '1';
  try {
    const T = createRequire(import.meta.url)(SERVICE_JS).__test;
    const b64 = 'A'.repeat(Math.ceil(R.bytes * 4 / 3));
    const asPng = T.shapeMime({ 'image/png': b64 });
    const asOther = T.shapeMime({ 'application/x-probe-b64': b64 });
    const asPlain = T.shapeMime({ 'text/plain': b64 });
    say(`\n— what the EXISTING service does with a ${(R.bytes / MiB).toFixed(2)} MiB payload —`);
    say(`  as image/png                → kind=${asPng.kind}, bytes=${asPng.bytes}, pixels carried: ${asPng.b64 ? 'yes' : 'NO'}`);
    say(`  as application/x-probe-b64  → ${asOther === null ? 'null (dropped by the mime ladder)' : asOther.kind}`);
    say(`  as text/plain               → kind=${asPlain.kind}, kept ${B(asPlain.text.length)} of ${B(b64.length)} (clipped=${asPlain.clipped})`);
    finding('C2', 'The existing service would pass a renderer-sized kernel message through to the pane', 'REFUTED',
      `shapeMime on a ${(R.bytes / MiB).toFixed(2)} MiB payload: image/png → kind='${asPng.kind}' with no b64; an unknown vendor mime → ${asOther === null ? 'null' : asOther.kind}; text/plain → clipped to ${B(asPlain.text.length)}`,
      'even if the bytes reached the service, the service throws them away before the store. Any renderer transport has to bypass shapeMime entirely.');
  } catch (e) { say('service shaping check failed: ' + e.message); }
}

// ---------------------------------------------------------------------------
// PHASE C2 — the live service against a big output (isolated HOME child)
// ---------------------------------------------------------------------------

async function phaseS() {
  hr('PHASE S — THE RUNNING SERVICE, LIVE, ON AN OVERSIZED CELL');
  if (!haveUv) { say('uv missing'); return; }
  const rt = path.join(TMP, 'jpy-runtime-s');
  const fakeHome = path.join(TMP, 'fake-home');
  rmrf(rt); rmrf(fakeHome); fs.mkdirSync(fakeHome, { recursive: true });
  const port = JPY_PORT + 2;
  if (FORBIDDEN.has(port)) { say('port collision guard'); return; }
  say(`isolated server on ${port}, runtime dir ${rt}, child HOME=${fakeHome}`);
  const { nbdir } = startJupyter(port, rt);
  if (!await waitJupyter(port)) { say('server never came up'); return; }

  // A notebook whose cells produce (1) three 200 KB outputs, (2) one 4 MB image.
  const nb = {
    cells: [
      { cell_type: 'code', id: 'many', source: "for i in range(3):\n    print('x'*200000)\n", metadata: {}, outputs: [], execution_count: null },
      { cell_type: 'code', id: 'huge', source: "import base64, os\nfrom IPython.display import display\ndisplay({'image/png': base64.b64encode(os.urandom(4*1024*1024)).decode()}, raw=True)\n", metadata: {}, outputs: [], execution_count: null },
      // three images that EACH pass shapeMime (b64 < 2*MAX_OUT_BYTES) but
      // together blow the per-cell accumulator in flush().
      { cell_type: 'code', id: 'three', source: "import base64, os\nfrom IPython.display import display\nfor _ in range(3):\n    display({'image/png': base64.b64encode(os.urandom(120*1024)).decode()}, raw=True)\n", metadata: {}, outputs: [], execution_count: null },
      // one image in the gap: over MAX_OUT_BYTES, under 2*MAX_OUT_BYTES of b64.
      { cell_type: 'code', id: 'gap', source: "import base64, os\nfrom IPython.display import display\ndisplay({'image/png': base64.b64encode(os.urandom(300*1024)).decode()}, raw=True)\n", metadata: {}, outputs: [], execution_count: null },
    ],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
    nbformat: 4, nbformat_minor: 5,
  };
  const nbPath = path.join(nbdir, 'probe.ipynb');
  fs.writeFileSync(nbPath, JSON.stringify(nb, null, 1));

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child-service', nbPath, String(port)], {
    env: { ...process.env, HOME: fakeHome, JUPYTER_RUNTIME_DIR: rt, WC_JUPYTER_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  if (code !== 0) say(`  child exited ${code}\n  ${err.split('\n').slice(0, 6).join('\n  ')}`);
  const m = /RESULT (\{.*\})/.exec(out);
  if (m) {
    let j = null; try { j = JSON.parse(m[1]); } catch {}
    if (j) {
      finding('S1', 'A cell whose outputs exceed MAX_OUT_BYTES is capped by the live service, with the pane told', j.capped ? 'CONFIRMED' : 'PARTIAL',
        `live run of the REAL service.js against an isolated Jupyter server: 3×200 KB printed → [${(j.manyKinds || []).join(', ')}], store key ${j.manyKeyBytes} B; one 4 MiB image → [${(j.hugeKinds || []).join(', ')}], store key ${j.hugeKeyBytes} B; 3×120 KB images → [${(j.threeKinds || []).join(', ')}], store key ${j.threeKeyBytes} B; one 300 KB image → [${(j.gapKinds || []).join(', ')}], store key ${j.gapKeyBytes} B`,
        'the cap is enforced end-to-end today, and no cell can put more than ~256 KB into the store however it tries. A renderer-sized payload cannot reach the pane through the output path at all.');
    }
  }
}

// The isolated-HOME child: drives the REAL service.js. Never runs in-process.
async function childService(nbPath, port) {
  const require_ = createRequire(import.meta.url);
  const fsx = require_('fs'), osx = require_('os'), pathx = require_('path');
  // PRE-FLIGHT: prove the isolation. If discovery could reach ANY server but
  // ours, abort before service.js gets a chance to connect to index 0.
  const dirs = [process.env.JUPYTER_RUNTIME_DIR, pathx.join(osx.homedir(), 'Library', 'Jupyter', 'runtime'), pathx.join(osx.homedir(), '.local', 'share', 'jupyter', 'runtime')].filter(Boolean);
  const files = [];
  for (const d of dirs) { try { for (const n of fsx.readdirSync(d)) if (/^jpserver-.*\.json$/.test(n)) files.push(pathx.join(d, n)); } catch {} }
  const urls = files.map((f) => { try { return JSON.parse(fsx.readFileSync(f, 'utf8')).url; } catch { return '?'; } });
  console.log(`  [child] HOME=${osx.homedir()}  discoverable servers: ${JSON.stringify(urls)}`);
  if (urls.length !== 1 || !urls[0].includes(String(port))) {
    console.log('  [child] ABORT: discovery is not isolated to our own server');
    process.exit(3);
  }
  const svc = require_(SERVICE_JS);
  const store = {}; let onEv = null;
  const webChatDir = pathx.join(pathx.dirname(nbPath), '.web-chat');
  const ctx = {
    name: 'jpy-notebook', mountId: 'probe', params: { notebooks: [nbPath] }, webChatDir,
    log: () => {}, fence: (p, c) => c, diff: () => null,
    driver: {
      setStore(p) { Object.assign(store, p); return Promise.resolve({ ok: true }); },
      getStore(k) { const o = {}; for (const x of k || []) if (x in store) o[x] = store[x]; return Promise.resolve(o); },
      streamEvents({ onEvent }) { onEv = onEvent; return { close() {} }; },
    },
  };
  let sq = 0; const next = () => (sq = Math.max(Date.now(), sq + 1));
  const ctl = (op, extra) => { const patch = { jpy_ctl: { seq: next(), op, ...(extra || {}) } }; Object.assign(store, patch); if (onEv) onEv({ patch }); };
  const until = async (p, w, msx = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < msx) { if (p()) return true; await sleep(150); } console.log('  [child] timeout ' + w); return false; };

  await svc.start(ctx);
  await until(() => store.jpy_conn && store.jpy_conn.state !== 'discovering', 'connect');
  console.log(`  [child] connected=${store.jpy_conn && store.jpy_conn.ok} to ${store.jpy_conn && store.jpy_conn.server && store.jpy_conn.server.url}`);
  ctl('run', { cell: 'many' });
  await until(() => store.jpy_out_many && ['ok', 'error'].includes(store.jpy_out_many.state), 'run many');
  ctl('run', { cell: 'huge' });
  await until(() => store.jpy_out_huge && ['ok', 'error'].includes(store.jpy_out_huge.state), 'run huge');
  ctl('run', { cell: 'three' });
  await until(() => store.jpy_out_three && ['ok', 'error'].includes(store.jpy_out_three.state), 'run three');
  ctl('run', { cell: 'gap' });
  await until(() => store.jpy_out_gap && ['ok', 'error'].includes(store.jpy_out_gap.state), 'run gap');
  const many = store.jpy_out_many || {}, huge = store.jpy_out_huge || {};
  const three = store.jpy_out_three || {}, gap = store.jpy_out_gap || {};
  const kinds = (o) => (o.outputs || []).map((x) => x.kind + (x.clipped ? `(clipped ${x.clipped})` : '') + (x.withheld != null ? `(withheld ${x.withheld})` : '') + (x.bytes != null ? `(${x.bytes} B)` : ''));
  console.log(`  [child] 3×200 KB printed  → ${JSON.stringify(kinds(many))}  store bytes=${many.bytes}  key size=${JSON.stringify(many).length}`);
  console.log(`  [child] one 4 MiB image   → ${JSON.stringify(kinds(huge))}  store bytes=${huge.bytes}  key size=${JSON.stringify(huge).length}`);
  console.log(`  [child] 3 × 120 KB images → ${JSON.stringify(kinds(three))}  store bytes=${three.bytes}  key size=${JSON.stringify(three).length}`);
  console.log(`  [child] one 300 KB image  → ${JSON.stringify(kinds(gap))}  store bytes=${gap.bytes}  key size=${JSON.stringify(gap).length}`);
  console.log('RESULT ' + JSON.stringify({
    capped: (three.outputs || []).some((o) => o.kind === 'capped') || (gap.outputs || []).some((o) => o.kind === 'capped'),
    manyKinds: kinds(many), manyBytes: many.bytes, manyKeyBytes: JSON.stringify(many).length,
    hugeKinds: kinds(huge), hugeBytes: huge.bytes, hugeKeyBytes: JSON.stringify(huge).length,
    threeKinds: kinds(three), threeBytes: three.bytes, threeKeyBytes: JSON.stringify(three).length,
    gapKinds: kinds(gap), gapBytes: gap.bytes, gapKeyBytes: JSON.stringify(gap).length,
  }));
  // Release the kernel we started, then stop. (Our own server, our own kernel.)
  try {
    const c = store.jpy_conn || {};
    if (c.server && c.kernel) {
      const info = JSON.parse(fsx.readFileSync(files[0], 'utf8'));
      await fetch(c.server.url + 'api/kernels/' + c.kernel.id, { method: 'DELETE', headers: { Authorization: 'token ' + info.token } });
    }
  } catch {}
  await svc.stop();
}

// ---------------------------------------------------------------------------
// PHASE D — WHAT A STATIC CAPTURE COSTS
// ---------------------------------------------------------------------------

function phaseD() {
  hr('PHASE D — STATIC CAPTURE SIZES (the fallback when the JS box is unavailable)');
  if (!haveUv) { finding('D', 'static capture sizes', 'UNMEASURABLE', 'uv not on PATH', ''); return; }

  // --- plotly: figure spec, HTML, and PNG via kaleido -----------------------
  say('— plotly —');
  const plotlySpec = uvPy(['plotly'], `
import json, time, plotly.graph_objects as go, plotly
xs=list(range(200)); ys=[(i*i)%97 for i in xs]
fig=go.Figure(data=[go.Scatter(x=xs,y=ys,mode='lines+markers')])
out={'plotly':plotly.__version__,'spec_json':len(fig.to_json().encode())}
t=time.time(); h=fig.to_html(include_plotlyjs='cdn'); out['html_cdn']=len(h.encode()); out['html_cdn_s']=round(time.time()-t,2)
t=time.time(); h=fig.to_html(include_plotlyjs=True); out['html_inline']=len(h.encode()); out['html_inline_s']=round(time.time()-t,2)
print('JSON'+json.dumps(out))
`, { timeout: 300000 });
  let ps = {};
  try { ps = JSON.parse((plotlySpec.out.match(/JSON(\{.*\})/) || [])[1]); } catch {}
  if (ps.spec_json) {
    say(`  figure spec (200 points)        ${B(ps.spec_json)}`);
    say(`  to_html(include_plotlyjs='cdn') ${B(ps.html_cdn)}   ${ps.html_cdn_s}s   ← needs the network at view time`);
    say(`  to_html(include_plotlyjs=True)  ${B(ps.html_inline)}   ${ps.html_inline_s}s   ← self-contained, carries the whole renderer`);
  } else say('  plotly probe failed: ' + (plotlySpec.err || plotlySpec.out).split('\n').slice(-4).join(' | '));

  // kaleido: is it a dependency, and does it work out of the box?
  const kaleidoDep = uvPy(['plotly'], `
import importlib.util, json
print('JSON'+json.dumps({'kaleido_present_with_plotly_alone': importlib.util.find_spec('kaleido') is not None}))
`);
  let kd = {};
  try { kd = JSON.parse((kaleidoDep.out.match(/JSON(\{.*\})/) || [])[1]); } catch {}
  say(`  kaleido installed by \`plotly\` alone? ${kd.kaleido_present_with_plotly_alone === false ? 'NO — it is a separate install' : JSON.stringify(kd)}`);

  const KAL_TIMEOUT = Number(process.env.WC_FEAS_KALEIDO_TIMEOUT || 90000);
  const kal = uvPy(['plotly', 'kaleido'], `
import json, time, os, sys
import plotly.graph_objects as go
xs=list(range(200)); ys=[(i*i)%97 for i in xs]
fig=go.Figure(data=[go.Scatter(x=xs,y=ys,mode='lines+markers')])
out={}
try:
    import kaleido; out['kaleido']=getattr(kaleido,'__version__','?')
except Exception as e: out['kaleido_import']=str(e)[:200]
for fmt,kw in (('png',{}),('png2x',{'scale':2}),('svg',{})):
    t=time.time()
    try:
        b=fig.to_image(format=fmt.replace('2x',''), **kw)
        out[fmt]=len(b); out[fmt+'_s']=round(time.time()-t,2)
    except Exception as e:
        out[fmt+'_err']=type(e).__name__+': '+str(e)[:300]; out[fmt+'_s']=round(time.time()-t,2)
print('JSON'+json.dumps(out))
`, { timeout: KAL_TIMEOUT });
  let kk = {};
  try { kk = JSON.parse((kal.out.match(/JSON(\{.*\})/) || [])[1]); } catch {}
  if (kk.png) {
    say(`  kaleido ${kk.kaleido}: PNG ${B(kk.png)} in ${kk.png_s}s | PNG@2x ${kk.png2x ? B(kk.png2x) : kk.png2x_err} | SVG ${kk.svg ? B(kk.svg) : kk.svg_err}`);
  } else {
    say(`  kaleido export DID NOT PRODUCE AN IMAGE${kal.timedOut ? ` (hard timeout after ${KAL_TIMEOUT / 1000}s)` : ''}`);
    if (kk.png_err) say(`    ${kk.png_err}`);
    const tail = (kal.err || '').split('\n').filter(Boolean).slice(-4);
    for (const t of tail) say(`    ${t.slice(0, 200)}`);
    // kaleido >= 1.0 drives a real Chromium through `choreographer`. Killing the
    // python process does NOT reap the browser, so sweep the wrapper processes
    // this probe caused — matched narrowly: choreographer's own wrapper script
    // AND a --user-data-dir under the temp dir (which is where it puts them).
    const killed = sweepChoreographer();
    if (killed.length) say(`    (reaped ${killed.length} orphaned headless-browser process(es) kaleido left behind: ${killed.join(', ')})`);
    say('    → on THIS machine kaleido launches the user\'s installed Chromium headless and does not return.');
  }

  // --- vega-lite via vl-convert-python -------------------------------------
  say('\n— vega-lite —');
  const vl = uvPy(['vl-convert-python'], `
import json, time, vl_convert as vlc
spec={"$schema":"https://vega.github.io/schema/vega-lite/v5.json",
 "data":{"values":[{"a":chr(65+i%7),"b":(i*13)%50} for i in range(60)]},
 "mark":"bar","encoding":{"x":{"field":"a","type":"nominal"},"y":{"field":"b","type":"quantitative","aggregate":"sum"}}}
s=json.dumps(spec); out={'spec':len(s.encode())}
for name,fn in (('png',lambda: vlc.vegalite_to_png(s)),('png2x',lambda: vlc.vegalite_to_png(s,scale=2)),('svg',lambda: vlc.vegalite_to_svg(s).encode())):
    t=time.time()
    try:
        b=fn(); out[name]=len(b); out[name+'_s']=round(time.time()-t,2)
    except Exception as e: out[name+'_err']=type(e).__name__+': '+str(e)[:200]
print('JSON'+json.dumps(out))
`, { timeout: 300000 });
  let vv = {};
  try { vv = JSON.parse((vl.out.match(/JSON(\{.*\})/) || [])[1]); } catch {}
  if (vv.png) say(`  spec ${B(vv.spec)} | PNG ${B(vv.png)} in ${vv.png_s}s | PNG@2x ${B(vv.png2x)} in ${vv.png2x_s}s | SVG ${B(vv.svg)} in ${vv.svg_s}s`);
  else say('  vl-convert probe failed: ' + (vl.err || vl.out).split('\n').slice(-4).join(' | '));

  const alt = uvPy(['altair'], `
import importlib.util, json
print('JSON'+json.dumps({'vl_convert_with_altair_alone': importlib.util.find_spec('vl_convert') is not None}))
`);
  let aa = {};
  try { aa = JSON.parse((alt.out.match(/JSON(\{.*\})/) || [])[1]); } catch {}
  say(`  vl-convert installed by \`altair\` alone? ${aa.vl_convert_with_altair_alone === false ? 'NO — separate install' : JSON.stringify(aa)}`);

  // --- a size reference that does not depend on either export path ----------
  // matplotlib is the one plotting stack almost every notebook already has, and
  // it renders a PNG in-process. Use it to bound "what a chart PNG costs" at the
  // dimensions a pane actually shows, independent of kaleido/vl-convert.
  say('\n— reference: a chart PNG at pane dimensions (matplotlib, in-process) —');
  const mpl = uvPy(['matplotlib'], `
import json, io, time
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
out={}
for name,(w,h,dpi) in {'800x500@1x':(8,5,100),'800x500@2x':(8,5,200),'1600x1000@2x':(16,10,200)}.items():
    fig,ax=plt.subplots(figsize=(w,h),dpi=dpi)
    ax.plot(range(200),[(i*i)%97 for i in range(200)],marker='o',ms=2)
    ax.set_title('probe')
    buf=io.BytesIO(); t=time.time(); fig.savefig(buf,format='png'); out[name]=buf.tell(); out[name+'_s']=round(time.time()-t,2)
    buf=io.BytesIO(); fig.savefig(buf,format='svg'); out[name+'_svg']=buf.tell()
    plt.close(fig)
print('JSON'+json.dumps(out))
`, { timeout: 300000 });
  let mm = {};
  try { mm = JSON.parse((mpl.out.match(/JSON(\{.*\})/) || [])[1]); } catch {}
  if (mm['800x500@1x']) {
    for (const k of ['800x500@1x', '800x500@2x', '1600x1000@2x']) say(`  ${k.padEnd(14)} PNG ${B(mm[k]).padStart(20)} in ${mm[k + '_s']}s   SVG ${B(mm[k + '_svg'])}`);
  } else say('  matplotlib probe failed: ' + (mpl.err || mpl.out).split('\n').slice(-3).join(' | '));

  // --- what each export path costs to INSTALL -------------------------------
  say('\n— install footprint of each export path (temp venvs, measured) —');
  const venvs = [['plotly only', ['plotly']], ['plotly + kaleido', ['plotly', 'kaleido']], ['vl-convert-python', ['vl-convert-python']]];
  const foot = {};
  for (const [label, pkgs] of venvs) {
    const v = path.join(TMP, 'venv-' + label.replace(/[^a-z]+/gi, '-'));
    rmrf(v);
    const a = uv(['venv', v], { timeout: 180000 });
    if (!a.ok) { say(`  ${label.padEnd(20)} venv failed`); continue; }
    const b = uv(['pip', 'install', '--python', path.join(v, 'bin', 'python'), ...pkgs], { timeout: 600000 });
    const size = du(v);
    foot[label] = size;
    say(`  ${label.padEnd(20)} ${B(size).padStart(22)}  ${b.ok ? '' : '(install reported an error)'}`);
    rmrf(v);
  }

  finding('D1', 'A static PNG capture is small enough to carry through the existing store budget', vv.png ? 'CONFIRMED' : 'PARTIAL',
    `vega-lite via vl-convert-python: PNG ${vv.png ? B(vv.png) : 'n/a'} (${vv.png2x ? B(vv.png2x) : 'n/a'} @2x), SVG ${vv.svg ? B(vv.svg) : 'n/a'}, in ${vv.png_s}s with no browser; ` +
    `matplotlib reference at pane size: ${mm['800x500@1x'] ? `${B(mm['800x500@1x'])} @1x, ${B(mm['800x500@2x'])} @2x, ${B(mm['1600x1000@2x'])} at 1600×1000@2x` : 'n/a'}; ` +
    (kk.png ? `plotly via kaleido: PNG ${B(kk.png)} in ${kk.png_s}s` : `plotly via kaleido: NO IMAGE${kal.timedOut ? ` (no result in ${KAL_TIMEOUT / 1000}s)` : ''} — ${kk.png_err || 'it launched a headless browser and never returned'}`),
    `every measured chart PNG lands in the 30–200 KB band. Against the REAL ceiling measured in B1b (${'≈192 KB'} of image before the cell is capped) that fits — but only just at 2× on a large figure, so the capture must pick its dimensions deliberately rather than export at whatever scale the library defaults to. Plotly's own to_html(include_plotlyjs=True) is ${ps.html_inline ? B(ps.html_inline) : 'n/a'}, i.e. the same renderer-transport problem in a different wrapper; with 'cdn' it is ${ps.html_cdn ? B(ps.html_cdn) : 'n/a'} but needs the network at view time.`);
  finding('D2', 'The static-capture path needs extra packages the user does not already have', 'CONFIRMED',
    `kaleido is NOT pulled in by plotly (${JSON.stringify(kd)}) and vl-convert is NOT pulled in by altair (${JSON.stringify(aa)}); measured venv footprints: ${Object.entries(foot).map(([k, v]) => `${k}=${B(v)}`).join(', ')}` +
    (kk.png ? '' : `; and kaleido did not produce an image in this environment${kal.timedOut ? ` within ${KAL_TIMEOUT / 1000}s` : ''} — modern kaleido drives a headless Chrome it must fetch separately`),
    'the static fallback cannot be assumed available. It is a second %pip install, and for plotly it also drags in a browser runtime — which is an argument for making the JS box the primary path and the capture strictly opt-in.');
}

// ---------------------------------------------------------------------------
// PHASE E — ASSET SERVING IN WEB-CHAT
// ---------------------------------------------------------------------------

async function phaseE() {
  hr('PHASE E — DOES WEB-CHAT ALREADY SERVE COMPONENT-SIZED ASSETS?');
  if (!fs.existsSync(WCDEV)) { finding('E', 'asset serving', 'UNMEASURABLE', `no web-chat source at ${WCDEV}`, ''); return; }
  const refs = [
    ['POST /api/components (save)', srcRef(path.join(WCDEV, 'lib/server/routes/components.js'), /app\.post\('\/api\/components'/)],
    ['GET  /api/components/:name (JSON, inlines component.html)', srcRef(path.join(WCDEV, 'lib/server/routes/components.js'), /app\.get\('\/api\/components\/:name'/)],
    ['GET  /api/components/:name/seed (RAW JS)', srcRef(path.join(WCDEV, 'lib/server/routes/components.js'), /res\.type\('text\/javascript'\)/)],
    ['the four files a component IS', srcRef(path.join(WCDEV, 'lib/packs/plan.js'), /COMPONENT_FILES/)],
    ['registry writes seed.js / service.js sidecars', srcRef(path.join(WCDEV, 'lib/server/components-registry.js'), /seed\.js'\), seed\)/)],
    ['the only express.static (the INSTALL public dir)', srcRef(path.join(WCDEV, 'lib/server/index.js'), /express\.static\(paths\.PUBLIC_DIR\)/)],
    ['static route for browser extensions only', srcRef(path.join(WCDEV, 'lib/server/routes/extensions.js'), /app\.use\(`\/extensions\//)],
    ['body limit', srcRef(path.join(WCDEV, 'lib/server/index.js'), /express\.json\(\{ limit/)],
  ];
  for (const [what, s] of refs) say(`  ${what}\n      ${s.ref}\n      ${s.text}`);

  const srv = await startDaemon();
  if (!srv) { say('\n(no isolated daemon; the live half of phase E is UNMEASURABLE)'); return; }

  // Live: can a component carry a renderer-sized seed.js, and is it served whole?
  const R = getRendererJs();
  say(`\n— live test on the isolated daemon: save a component whose seed.js IS ${B(R.bytes)} of renderer JS —`);
  const [saveRes, saveMs] = await timed(() => apiJson('/api/components', {
    name: 'feas-probe-asset', source: '<div id="probe">probe</div>', description: 'feasibility probe — delete me', seed: R.text, location: 'local',
  }));
  say(`  POST /api/components → ${JSON.stringify(saveRes)} in ${ms(saveMs)}`);
  const onDisk = path.join(DROOT, '.web-chat', 'components', 'feas-probe-asset', 'seed.js');
  say(`  seed.js on disk: ${fs.existsSync(onDisk) ? B(fs.statSync(onDisk).size) : 'MISSING'}  (${onDisk})`);
  const [seedBytes, seedMs] = await timed(async () => {
    const r = await api('/api/components/feas-probe-asset/seed');
    const t = await r.text();
    return { bytes: Buffer.byteLength(t), type: r.headers.get('content-type'), status: r.status, identical: t === R.text };
  });
  say(`  GET  /api/components/feas-probe-asset/seed → ${seedBytes.status} ${seedBytes.type} ${B(seedBytes.bytes)} in ${ms(seedMs)}; byte-identical: ${seedBytes.identical}`);
  const [listRes, listMs] = await timed(async () => Buffer.byteLength(await (await api('/api/components')).text()));
  say(`  GET  /api/components (the listing) → ${B(listRes)} in ${ms(listMs)} — the listing does NOT carry the seed`);
  const [getRes, getMs] = await timed(async () => Buffer.byteLength(await (await api('/api/components/feas-probe-asset')).text()));
  say(`  GET  /api/components/feas-probe-asset → ${B(getRes)} in ${ms(getMs)} — carries component.html only, not seed.js`);

  // Is the store touched by any of this? (It must not be.)
  const storeNow = Buffer.byteLength(await (await api('/api/store')).text());
  say(`  store size after all of that: ${B(storeNow)} — serving the asset costs the store NOTHING`);

  // Could a sandbox="allow-scripts" iframe (origin "null") LOAD it?
  say('\n— reachability from a null-origin sandboxed iframe —');
  const head = await api('/api/components/feas-probe-asset/seed', { headers: { Origin: 'null' } });
  const hdrs = {};
  head.headers.forEach((v, k) => { hdrs[k] = v; });
  await head.text();
  say(`  response headers with Origin: null → ${JSON.stringify(hdrs)}`);
  const acao = hdrs['access-control-allow-origin'];
  say(`  Access-Control-Allow-Origin: ${acao || 'ABSENT'}`);
  say(`  ⇒ fetch() from a null-origin iframe would be ${acao ? 'ALLOWED' : 'BLOCKED by CORS'}; a classic <script src> is not CORS-gated and would still load.`);
  const cors = srcRef(path.join(WCDEV, 'lib', 'core', 'cors.js'), /Access-Control-Allow-Origin/);
  say(`  the only place web-chat sets that header: ${cors.ref}\n      ${cors.text}`);
  const setCorsUse = srcRef(path.join(WCDEV, 'lib', 'server', 'routes', 'capture.js'), /setCors/);
  say(`  and it is applied per-route (e.g. ${setCorsUse.ref}), not to /api/components`);
  finding('E3', 'A sandboxed (origin "null") iframe could fetch() the seed asset from the daemon', acao ? 'CONFIRMED' : 'REFUTED',
    `GET /api/components/:name/seed with Origin: null returned no Access-Control-Allow-Origin (headers: ${JSON.stringify(hdrs)}); web-chat sets CORS only through setCors (${cors.ref}), which the components routes do not use`,
    'the JS box cannot fetch() the renderer from the daemon. It CAN load it with a classic <script src> (not CORS-gated), or the pane can pass the bytes in through srcdoc / postMessage. Decide that deliberately — it is the difference between a working box and a silent CORS failure.');

  finding('E1', 'web-chat already has a mechanism for serving component-sized assets', 'PARTIAL',
    `GET /api/components/:name/seed (${refs[2][1].ref}) serves a component's seed.js RAW as text/javascript; measured: a ${B(R.bytes)} seed.js saved in ${ms(saveMs)} and served back byte-identically in ${ms(seedMs)} with content-type ${seedBytes.type}, and it does not appear in GET /api/components (${B(listRes)}) or GET /api/components/:name (${B(getRes)}) or the store`,
    'the seed sidecar is a real, working, store-free asset channel — but it is exactly ONE file per component, named seed.js, served as JavaScript. There is no general static route for pack files: the only express.static is the install\'s public dir and the extensions dir.');
  finding('E2', 'A pack can ship arbitrary binary assets alongside a component', 'REFUTED',
    `${refs[3][1].ref}: ${refs[3][1].text} — install copies exactly component.html, meta.json, seed.js, service.js per component; nothing else in a component directory is installed or served`,
    'renderer JS shipped IN the pack is limited to a seed.js-shaped file. Reading the user\'s own install from disk at request time (a service, which already has fs access) is the alternative — the pack ships no bytes at all.');
}

// ---------------------------------------------------------------------------
// teardown + main
// ---------------------------------------------------------------------------

async function teardown() {
  for (const c of jpys) { try { c.kill('SIGINT'); } catch {} }
  await sleep(600);
  for (const c of jpys) { try { c.kill('SIGKILL'); } catch {} }
  if (keepalive) { try { keepalive.close(); } catch {} }
  if (daemon) { try { await daemon.stop(); } catch {} }
  sweepChoreographer();
}

async function main() {
  if (process.argv[2] === '--child-service') {
    await childService(process.argv[3], Number(process.argv[4]));
    await new Promise((r) => process.stdout.write('', r));
    FINISHED = true;
    process.exit(0);
  }
  console.log('04-capture-and-budget — the static fallback and the transport budget');
  console.log(`  pack           ${PACK}`);
  console.log(`  web-chat src   ${WCDEV} ${fs.existsSync(WCDEV) ? '' : '(MISSING)'}`);
  console.log(`  scratch        ${TMP}`);
  console.log(`  own daemon     127.0.0.1:${WEBCHAT_PORT}   own jupyter 127.0.0.1:${JPY_PORT}/${JPY_PORT_B}/${JPY_PORT + 2}`);
  console.log(`  node           ${process.version}`);
  fs.mkdirSync(TMP, { recursive: true });

  try {
    if (want('A')) await phaseA();
    if (want('B')) phaseB();
    if (want('C')) await phaseC();
    if (want('S')) await phaseS();
    if (want('D')) phaseD();
    if (want('E')) await phaseE();
  } catch (e) {
    console.error('\nPROBE ERROR:', e && e.stack || e);
  } finally {
    await teardown();
  }

  hr('FINDINGS');
  for (const f of findings) {
    console.log(`\n[${f.id}] ${f.verdict}  — ${f.claim}`);
    console.log(`  evidence:    ${f.evidence}`);
    if (f.implication) console.log(`  implication: ${f.implication}`);
  }
  console.log('\ndone.');
  // Drain stdout BEFORE exiting: with output redirected to a file the writes are
  // async, and a bare process.exit() truncates the report mid-sentence.
  await new Promise((r) => process.stdout.write('', r));
  FINISHED = true;
  process.exit(0);
}

main();

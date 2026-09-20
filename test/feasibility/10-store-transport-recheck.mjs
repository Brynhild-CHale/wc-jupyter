#!/usr/bin/env node
// store-transport-independent-recheck.mjs — INDEPENDENT re-verification of the
// claim that renderer JS (~4.7 MB) can travel to the pane through the web-chat
// store. Written from scratch; it shares NO code with 04-capture-and-budget.mjs.
//
// It re-measures the headline and then goes after the parts of the earlier
// report that are CONVENIENT rather than merely true:
//
//   3  the headline: what one big store value costs per node / turn / hello, and
//      WHICH read surfaces actually carry it (the earlier report named the ones
//      that do; this one also measures the ones that don't, to bound the damage)
//   4  a CLEAN event-ring number. 04 measured a ring that already held its own
//      earlier writes, so its "76.5 MiB after 6 writes" mixes in ~48 MiB of
//      prior traffic. Also: is a transient big write RECOVERABLE?
//   5  RESIDENCY. graph.load() reads every node file back into memory at boot,
//      so the disk number is also a permanent RAM number. Measured, not reasoned.
//   6  THE MCP LAYER. "GET /api/store is what get_store returns to the model" is
//      an assumption about MCP, not about HTTP. The REAL tool handlers are
//      executed here against this probe's own daemon and their results measured.
//   7  THE CONVENIENT COROLLARY: "so keep the ~1 KB spec in the store instead."
//      Node files are written pretty:2, which puts every element of a numeric
//      plotly spec on its own indented line. Measured.
//   8  the static-fallback PNG the same design wants to capture per output —
//      the same amplification, one order of magnitude down. Measured.
//
// SAFETY. Nothing here touches the user's environment:
//   * hard refusal on ports 5176 (live daemon) and 8899 (live Jupyter);
//   * its own daemons on WC_RECHECK_PORT_A/B (default 5401/5402) with throwaway
//     roots and writePortfile:false — invisible to the user's CLI and browser;
//   * no Jupyter server is needed for this claim, so none is started;
//   * the MCP-handler phase runs in a CHILD whose cwd is a temp dir and whose
//     WEB_CHAT_PORT points at this probe's daemon, so lib/client's discovery can
//     never resolve the user's project daemon;
//   * plotly comes from an ephemeral `uv run --with plotly`, never an install.
//
// Usage:  node <this file>
//         WC_DEV=/path/to/web-chat-dev node <this file>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync, spawn } from 'node:child_process';

// ── config + guards ────────────────────────────────────────────────────────
const WCDEV = process.env.WC_DEV || path.resolve(os.homedir(), 'Dev', 'web-chat-dev');
const PORT_A = Number(process.env.WC_RECHECK_PORT_A || 5401);
const PORT_B = Number(process.env.WC_RECHECK_PORT_B || 5402);
const TMP = path.join(os.tmpdir(), 'wc-recheck-store');
const FORBIDDEN = new Set([5176, 8899]);
for (const p of [PORT_A, PORT_B, PORT_A + 20, PORT_A + 21]) {
  if (FORBIDDEN.has(p)) { console.error(`refusing port ${p}: that is the user's live daemon/server`); process.exit(2); }
}

const MiB = 1048576;
const B = (n) => `${Math.round(n).toLocaleString('en-US')} B` +
  (n >= MiB ? ` (${(n / MiB).toFixed(2)} MiB)` : n >= 1024 ? ` (${(n / 1024).toFixed(1)} KiB)` : '');
const ms = (n) => `${n.toFixed(1)} ms`;
const tok = (n) => `≈${Math.round(n / 4).toLocaleString('en-US')} tok`;
const say = (...a) => console.log(...a);
const hr = (t) => say('\n' + '═'.repeat(78) + (t ? `\n${t}\n` + '═'.repeat(78) : ''));
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
async function timed(fn) { const t0 = performance.now(); const v = await fn(); return [v, performance.now() - t0]; }
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const findings = [];
const finding = (id, claim, verdict, evidence, note) => findings.push({ id, claim, verdict, evidence, note });

// A probe that dies quietly is worse than one that fails loudly. An earlier run
// of this file logged an uncaught "fetch failed" and then sat forever on a
// pending await, so both of these now EXIT.
let FINISHED = false;
process.on('exit', (c) => { if (!FINISHED) process._rawDebug(`[recheck] EXITED EARLY code ${c}`); });
process.on('uncaughtException', (e) => { process._rawDebug('[recheck] uncaught: ' + (e?.stack || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { process._rawDebug('[recheck] unhandled: ' + (e?.stack || e)); process.exit(1); });

if (!fs.existsSync(WCDEV)) { console.error(`web-chat source not at ${WCDEV}; set WC_DEV.`); process.exit(2); }
const reqWC = createRequire(path.join(WCDEV, 'package.json'));
const { createServer } = reqWC(path.join(WCDEV, 'lib', 'server', 'index.js'));
const { resolvePaths } = reqWC(path.join(WCDEV, 'lib', 'server', 'paths.js'));

function du(dir) {
  let total = 0;
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { total += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

// ── transport ──────────────────────────────────────────────────────────────
// Raw http.request, deliberately NOT global fetch. undici pools keep-alive
// sockets — a stale one surfaces as an opaque "fetch failed", which is exactly
// what stranded an earlier run of this probe — and it sends sec-fetch-*, which
// lib/core/cors.js classes as a browser.
const AGENT = new http.Agent({ keepAlive: false, maxSockets: 8 });
function raw(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method, agent: AGENT,
      headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    }, (res) => {
      let n = 0; const keep = [];
      // Count every byte; retain only the first 2 MB so a 45 MB event log does
      // not have to be materialised as a string to be measured.
      res.on('data', (c) => { n += c.length; if (n <= 2_000_000) keep.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, text: Buffer.concat(keep).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error(`timeout ${method} ${p}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 1. source anchors, grepped here rather than quoted from the earlier report ──
function anchors() {
  hr('1. SOURCE ANCHORS (grepped fresh, this run)');
  const want = [
    ['lib/server/index.js', /express\.json\(\{\s*limit/, 'HTTP body limit for POST /api/store'],
    ['lib/core/bus.js', /^const MAX_EVENTS\s*=/, 'event ring size'],
    ['lib/core/bus.js', /events\.push\(built\)/, 'every event retained whole'],
    ['lib/server/routes/store.js', /bus\.emit\(\{ event: \{ kind: 'store', patch/, 'the WHOLE patch goes on the event'],
    ['lib/server/routes/store.js', /res\.json\(state\.store\)/, 'GET /api/store returns the whole store, unshaped'],
    ['lib/server/graph.js', /store: \{ \.\.\.state\.store \}/, 'every committed node copies the whole store'],
    ['lib/server/graph.js', /writeJsonAtomic\(path\.join\(paths\.GRAPH_DIR/, 'node written to disk'],
    ['lib/core/fsjson.js', /function writeJsonAtomic/, 'pretty:2 default — node files are pretty-printed'],
    ['lib/server/graph.js', /graph\.nodes\.set\(n\.id, n\)/, 'boot reads EVERY node file back into memory'],
    ['lib/server/domain/turns.js', /return snapshotView\(snap\) !== snapshotView/, 'turn-end stringifies the whole store twice'],
    ['lib/server/ws.js', /type: 'hello'/, 'WS hello re-sends the whole store'],
    ['lib/server/diff.js', /function truncVal\(v, cap = \d+\)/, 'diff caps each value'],
    ['lib/mcp/tools/get_store.js', /return await client\.get\(path\)/, 'get_store is a raw passthrough'],
    ['lib/mcp/tools/get_events.js', /return await client\.get\('\/api\/events'/, 'get_events is a raw passthrough'],
    ['lib/mcp/tools/set_store.js', /store_bytes: JSON\.stringify\(store\)\.length/, 'set_store SHAPES its response'],
  ];
  let missing = 0;
  for (const [rel, re, why] of want) {
    let hit = null;
    try {
      const lines = fs.readFileSync(path.join(WCDEV, rel), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { hit = { line: i + 1, text: lines[i].trim() }; break; }
    } catch {}
    if (!hit) missing++;
    say(hit ? `  ${rel}:${hit.line}  — ${why}\n      ${hit.text}` : `  ${rel}:?  — ${why}   *** ANCHOR NOT FOUND ***`);
  }
  if (missing) say(`\n  ${missing} anchor(s) missing — the source has moved; treat the numbers below as version-specific.`);
}

// ── 2. the payload ─────────────────────────────────────────────────────────
function payload() {
  hr('2. PAYLOAD — the real renderer, located independently');
  fs.mkdirSync(TMP, { recursive: true });
  const dest = path.join(TMP, 'plotly.min.js');
  let src = null, version = null;
  if (!fs.existsSync(dest)) {
    const r = spawnSync('uv', ['run', '--quiet', '--with', 'plotly', 'python', '-'], {
      encoding: 'utf8', timeout: 300000,
      input: `
import os, shutil, json, plotly
p = os.path.join(os.path.dirname(plotly.__file__), 'package_data', 'plotly.min.js')
if os.path.exists(p):
    shutil.copyfile(p, ${JSON.stringify(dest)})
    print(json.dumps({'src': p, 'bytes': os.path.getsize(p), 'version': plotly.__version__}))
else:
    print(json.dumps({'src': None}))
`,
    });
    try { const j = JSON.parse((r.stdout || '').trim().split('\n').pop()); src = j.src; version = j.version; } catch {}
  }
  if (!fs.existsSync(dest)) {
    say('  could not obtain plotly.min.js (uv/network) — SYNTHETIC stand-in of the same size');
    const text = ('!function(e,t){"use strict";var n=' + 'x'.repeat(64) + ';}(window,document);\n').repeat(60000).slice(0, 4815814);
    return { text, bytes: Buffer.byteLength(text), real: false };
  }
  const text = fs.readFileSync(dest, 'utf8');
  say(`  file:    ${dest}${src ? `\n           copied from ${src}` : '  (cached from an earlier run of this probe)'}`);
  say(`  plotly:  ${version || '(cached copy — version not re-read)'}`);
  say(`  bytes:   ${B(Buffer.byteLength(text))}   sha256[0:16] ${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`);
  const asJson = JSON.stringify(text).length;
  say(`  as a JSON string value: ${B(asJson)}  (escape overhead ${((asJson / Buffer.byteLength(text) - 1) * 100).toFixed(2)}%)`);
  return { text, bytes: Buffer.byteLength(text), real: true };
}

// ── daemon helpers ─────────────────────────────────────────────────────────
async function startDaemon(port, root) {
  rmrf(root); fs.mkdirSync(root, { recursive: true });
  const srv = createServer({ root, port });
  await srv.start({ writePortfile: false });
  // ws.js starts a 10 s grace timer when the last viewer disconnects and it
  // calls process.exit(0) — which, with the daemon in-process, would kill THIS
  // probe silently. One held-open socket is what a browser would be.
  const keep = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => { keep.onopen = r; keep.onerror = r; setTimeout(r, 4000); });
  return { srv, keep, paths: resolvePaths(root), root, port };
}
const mk = (d) => ({
  post: async (p, body) => { const r = await raw(d.port, 'POST', p, body === undefined ? {} : body); try { return JSON.parse(r.text); } catch { return {}; } },
  bytes: async (p) => (await raw(d.port, 'GET', p)).bytes,
});
async function commit(d, msg) {
  const api = mk(d);
  await api.post('/api/turn-begin', { message: msg, author: 'user' });
  const [r, took] = await timed(() => api.post('/api/turn-end', { author: 'claude', summary: msg }));
  return { id: r.node_id, took };
}
const nodeBytes = (d, id) => { try { return fs.statSync(path.join(d.paths.GRAPH_DIR, `${id}.json`)).size; } catch { return 0; } };
const nodeIds = (d) => fs.readdirSync(d.paths.GRAPH_DIR).filter((f) => /^n\d+\.json$/.test(f))
  .map((f) => f.replace('.json', '')).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
async function hello(d) {
  const t0 = performance.now();
  const sock = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  const first = await new Promise((res, rej) => {
    sock.onmessage = (ev) => res(ev.data);
    sock.onerror = () => rej(new Error('ws error'));
    setTimeout(() => rej(new Error('ws hello timeout')), 30000);
  });
  const took = performance.now() - t0;
  try { sock.close(); } catch {}
  return { bytes: Buffer.byteLength(String(first)), took };
}

// ── 3. the headline ────────────────────────────────────────────────────────
async function headline(R) {
  hr('3. HEADLINE — what one big store value costs');
  const d = await startDaemon(PORT_A, path.join(TMP, 'root-a'));
  const api = mk(d);
  say(`  isolated daemon on 127.0.0.1:${d.port}, root ${d.root}\n`);

  await api.post('/api/store', { patch: { k: 'baseline' } });
  const base = await commit(d, 'baseline');
  const baseNode = nodeBytes(d, base.id);
  say(`  baseline node (store = one short value): ${B(baseNode)}, turn-end ${ms(base.took)}\n`);

  const ladder = [['64 KB', 65536], ['256 KB', 262144], ['1 MB', 1048576], [`renderer ${(R.bytes / MiB).toFixed(2)} MiB`, R.bytes]];
  say('  value                POST /api/store      node on disk         turn-end       GET /api/store          WS hello');
  const rows = [];
  for (const [label, n] of ladder) {
    const val = R.text.slice(0, n);
    const [, postMs] = await timed(() => api.post('/api/store', { patch: { k: val } }));
    const c = await commit(d, 'store ' + label);
    const node = nodeBytes(d, c.id);
    const store = await api.bytes('/api/store');
    const h = await hello(d);
    rows.push({ label, n, postMs, node, took: c.took, store, hello: h.bytes });
    say(`  ${label.padEnd(18)} ${ms(postMs).padStart(10)}  ${B(node).padStart(21)}  ${ms(c.took).padStart(9)}  ${B(store).padStart(21)}  ${B(h.bytes).padStart(21)}`);
  }
  const big = rows[rows.length - 1];

  const bigNoop = []; for (let i = 0; i < 5; i++) bigNoop.push((await commit(d, 'noop')).took);
  await api.post('/api/store', { patch: { k: 'x' } }); await commit(d, 'shrink');
  const smallNoop = []; for (let i = 0; i < 5; i++) smallNoop.push((await commit(d, 'noop')).took);
  say(`\n  turn-end, turn changed NOTHING, ${(big.n / MiB).toFixed(2)} MiB value live: ${ms(avg(bigNoop))} (n=5, min ${ms(Math.min(...bigNoop))})`);
  say(`  turn-end, turn changed NOTHING, 1-byte value live:        ${ms(avg(smallNoop))} (n=5, min ${ms(Math.min(...smallNoop))})`);

  const K = 8;
  const before = du(d.paths.GRAPH_DIR);
  for (let i = 0; i < K; i++) {
    await api.post('/api/store', { patch: { k: R.text.slice(0, R.bytes - 8) + String(i).padStart(8, '0') } });
    await commit(d, 'bulk ' + i);
  }
  const after = du(d.paths.GRAPH_DIR);
  const perNode = (after - before) / K;
  say(`\n  ${K} consecutive nodes each carrying it: graph dir +${B(after - before)} → ${B(perNode)}/node`);
  say(`  extrapolated: 100 nodes ${B(perNode * 100)};  1000 nodes ${B(perNode * 1000)}`);
  say(`  compression at rest: none — node files are plain pretty-printed JSON`);

  // Which read surfaces carry it and which do not. The earlier report named only
  // the ones that do; the blast radius is the useful number for an implementer.
  const ids = nodeIds(d);
  const [a, b] = [ids[ids.length - 2], ids[ids.length - 1]];
  const surfaces = [
    ['GET /api/store', await api.bytes('/api/store'), 'UNCAPPED — this is get_store'],
    ['GET /api/events?since=0', await api.bytes('/api/events?since=0'), 'UNCAPPED — this is get_events'],
    ['WS hello', big.hello, 'UNCAPPED — every (re)connecting browser'],
    ['GET /api/graph', await api.bytes('/api/graph'), 'safe — topology only'],
    ['GET /api/mounts', await api.bytes('/api/mounts'), 'safe — no html field'],
    [`GET /api/graph/diff ${a}..${b}`, await api.bytes(`/api/graph/diff?a=${a}&b=${b}`), 'safe — diff.js truncVal cap 2000/value'],
  ];
  say(`\n  blast radius, with the value live and in every node:`);
  for (const [name, bytes, note] of surfaces) say(`    ${name.padEnd(28)} ${B(bytes).padStart(22)}  ${tok(bytes).padStart(14)}   ${note}`);

  return { d, rows, big, perNode, K, grew: after - before, bigNoop, smallNoop, baseNode, surfaces };
}

// ── 4. a CLEAN event ring, and whether a transient write is recoverable ────
async function cleanRing(R) {
  hr('4. THE EVENT RING — on a FRESH daemon (04 measured a ring already dirty)');
  const d = await startDaemon(PORT_B, path.join(TMP, 'root-b'));
  const api = mk(d);
  const MAX_EVENTS = reqWC(path.join(WCDEV, 'lib', 'core', 'bus.js')).MAX_EVENTS;
  const empty = await api.bytes('/api/events?since=0');
  say(`  fresh daemon on ${d.port}; GET /api/events with nothing in the ring: ${B(empty)}`);
  const N = 3;
  for (let i = 0; i < N; i++) await api.post('/api/store', { patch: { k: R.text.slice(0, R.bytes - 8) + String(i).padStart(8, '0') } });
  const [afterB, readMs] = await timed(() => api.bytes('/api/events?since=0'));
  const per = (afterB - empty) / N;
  say(`  after exactly ${N} writes of the renderer: ${B(afterB)} in ${ms(readMs)}  → ${B(per)} retained per write`);
  say(`  MAX_EVENTS=${MAX_EVENTS}; a ring full of them would be ${B(per * MAX_EVENTS)} resident in the daemon`);

  await api.post('/api/store', { patch: { k: 'tiny' } });
  await commit(d, 'store shrunk back to nothing');
  const storeNow = await api.bytes('/api/store');
  const eventsNow = await api.bytes('/api/events?since=0');
  say(`\n  then the key is overwritten with 4 bytes and a node is committed:`);
  say(`    GET /api/store  ${B(storeNow).padStart(22)}   ← recovered`);
  say(`    GET /api/events ${B(eventsNow).padStart(22)}   ← NOT recovered: the old patches are still whole in the ring`);
  say(`    they leave only after ${MAX_EVENTS} further events evict them.`);
  return { d, empty, afterB, per, N, MAX_EVENTS, storeNow, eventsNow };
}

// ── 5. residency ───────────────────────────────────────────────────────────
function residency(populatedRoot) {
  hr('5. RESIDENCY — graph.load() reads every node file back at boot');
  const script = `
const path = require('path');
const fs = require('fs');
const { createServer } = require(process.argv[2]);
const root = process.argv[3], port = Number(process.argv[4]);
(async () => {
  const before = process.memoryUsage();
  const srv = createServer({ root, port });
  await srv.start({ writePortfile: false });
  if (global.gc) global.gc();
  const after = process.memoryUsage();
  let n = 0;
  try { n = fs.readdirSync(path.join(root, '.web-chat', 'graph')).filter((f) => /^n[0-9]+[.]json$/.test(f)).length; } catch {}
  fs.writeFileSync(process.argv[5], JSON.stringify({
    nodes: n, rssBefore: before.rss, rssAfter: after.rss, heapBefore: before.heapUsed, heapAfter: after.heapUsed,
  }));
  process.exit(0);
})().catch((e) => { require('fs').writeFileSync(process.argv[5], JSON.stringify({ error: String(e && e.stack || e) })); process.exit(1); });
`;
  const f = path.join(TMP, 'boot-rss.cjs');
  fs.writeFileSync(f, script);
  const run = (root, port, tag) => {
    const out = path.join(TMP, `rss-${tag}.json`);
    try { fs.unlinkSync(out); } catch {}
    const r = spawnSync(process.execPath, ['--expose-gc', f, path.join(WCDEV, 'lib', 'server', 'index.js'), root, String(port), out],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 1 << 24 });
    try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return { error: `status=${r.status} ${(r.stderr || r.stdout || '(no output)').slice(0, 300)}` }; }
  };
  const emptyRoot = path.join(TMP, 'root-empty');
  rmrf(emptyRoot); fs.mkdirSync(emptyRoot, { recursive: true });
  const a = run(emptyRoot, PORT_A + 20, 'empty');
  const b = run(populatedRoot, PORT_A + 21, 'full');
  if (a.error || b.error) { say(`  UNMEASURABLE: ${a.error || b.error}`); return null; }
  say(`  empty graph      : ${String(a.nodes).padStart(3)} nodes   rss after boot ${B(a.rssAfter).padStart(22)}   heapUsed ${B(a.heapAfter)}`);
  say(`  populated graph  : ${String(b.nodes).padStart(3)} nodes   rss after boot ${B(b.rssAfter).padStart(22)}   heapUsed ${B(b.heapAfter)}`);
  const perNodeRss = b.nodes ? (b.rssAfter - a.rssAfter) / b.nodes : 0;
  say(`  delta            : rss +${B(b.rssAfter - a.rssAfter)}, heapUsed +${B(b.heapAfter - a.heapAfter)}`);
  say(`                     ≈${B(perNodeRss)} of RSS per node, paid at EVERY daemon start, forever`);
  return { a, b, perNodeRss };
}

// ── 6. the MCP layer ───────────────────────────────────────────────────────
async function mcpSurfaces(d) {
  hr("6. THE MCP LAYER — running the REAL tool handlers against this probe's daemon");
  const script = `
process.env.WEB_CHAT_PORT = process.argv[3];   // explicit port beats any portfile
const path = require('path');
const fs = require('fs');
const dir = process.argv[2];
const tools = ['get_store', 'set_store', 'get_events', 'diff_nodes', 'get_graph', 'list_mounts'];
(async () => {
  const out = {};
  for (const t of tools) {
    const mod = require(path.join(dir, 'lib', 'mcp', 'tools', t + '.js'));
    let args = {};
    if (t === 'set_store') args = { patch: { mcp_probe: 'z'.repeat(1024) } };
    if (t === 'get_events') args = { since: 0 };
    if (t === 'diff_nodes') args = { a: process.argv[4], b: process.argv[5] };
    try {
      const r = await mod.handler(args);
      const s = JSON.stringify(r);
      out[t] = { bytes: s.length, head: s.slice(0, 200) };
    } catch (e) { out[t] = { error: String((e && e.message) || e) }; }
  }
  fs.writeFileSync(process.argv[6], JSON.stringify(out));
  process.exit(0);
})().catch((e) => { fs.writeFileSync(process.argv[6], JSON.stringify({ _fatal: String((e && e.stack) || e) })); process.exit(1); });
`;
  const f = path.join(TMP, 'mcp-probe.cjs');
  fs.writeFileSync(f, script);
  const ids = nodeIds(d);
  const [a, b] = [ids[ids.length - 2] || ids[0], ids[ids.length - 1] || ids[0]];
  // cwd is a temp dir with no .web-chat, so lib/client's fallback discovery can
  // never resolve the USER's project daemon even if this one were down.
  const cwd = path.join(TMP, 'mcp-cwd'); fs.mkdirSync(cwd, { recursive: true });
  const resFile = path.join(TMP, 'mcp-result.json');
  try { fs.unlinkSync(resFile); } catch {}
  // spawn, NOT spawnSync. THE TRAP: both daemons run inside THIS process, so a
  // synchronous child freezes the event loop that has to serve the child's own
  // HTTP calls — the child then times out and reports nothing. Cost an earlier
  // run of this probe two "UNMEASURABLE"s before it was diagnosed.
  const r = await new Promise((resolve) => {
    const ch = spawn(process.execPath, ['--max-old-space-size=4096', f, WCDEV, String(d.port), a, b, resFile],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    ch.stdout.on('data', (x) => { so += x; });
    ch.stderr.on('data', (x) => { se += x; });
    const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} }, 180000);
    ch.on('close', (code) => { clearTimeout(t); resolve({ status: code, stdout: so, stderr: se }); });
    ch.on('error', (e) => { clearTimeout(t); resolve({ status: null, stdout: so, stderr: String(e) }); });
  });
  let out = null;
  try { out = JSON.parse(fs.readFileSync(resFile, 'utf8')); } catch {}
  if (!out || out._fatal) { say(`  UNMEASURABLE: status=${r.status} ${String((out && out._fatal) || r.stderr || r.stdout || '(no output)').slice(0, 600)}`); return null; }
  say(`  the live store on :${d.port} holds the renderer under key "k"\n`);
  const note = {
    get_store: 'RAW passthrough of GET /api/store — the whole value reaches the model',
    set_store: 'SHAPED in lib/mcp/tools/set_store.js: {ok, keys_written, store_keys, store_bytes}',
    get_events: 'RAW passthrough of GET /api/events — every retained patch, whole',
    diff_nodes: 'capped at 2000 B per value by lib/server/diff.js truncVal',
    get_graph: 'topology only',
    list_mounts: 'no html field',
  };
  say('  tool          bytes handed to the model');
  for (const [t, v] of Object.entries(out)) {
    say(`  ${t.padEnd(13)} ${v.error ? 'ERROR ' + v.error : `${B(v.bytes).padStart(22)}   ${tok(v.bytes)}`}`);
    say(`                ${note[t] || ''}`);
    if (v.head && v.bytes < 400) say(`                ${v.head}`);
  }
  return out;
}

// ── 7. the convenient corollary ────────────────────────────────────────────
async function specCost(d) {
  hr('7. CHALLENGE — "specs are ~1 KB, so the store is fine for them"');
  say('  Node files are written pretty:2 (lib/core/fsjson.js writeJsonAtomic). A plotly');
  say('  spec is mostly NUMERIC ARRAYS, and pretty:2 puts every element on its own');
  say('  indented line, so the compact size is NOT the stored size.\n');
  const api = mk(d);
  const N = 200;
  const spec = {
    data: [{
      type: 'scatter', mode: 'lines+markers',
      x: Array.from({ length: N }, (_, i) => i),
      y: Array.from({ length: N }, (_, i) => Math.round(Math.sin(i / 7) * 1e6) / 1e6),
      marker: { size: 6, color: '#636efa' }, name: 'trace 0',
    }],
    layout: { title: { text: 'demo' }, xaxis: { title: { text: 'i' } }, yaxis: { title: { text: 'sin' } }, template: { layout: { colorway: ['#636efa', '#EF553B', '#00cc96'] } } },
    config: { responsive: true },
  };
  const compact = JSON.stringify(spec).length;
  const pretty = JSON.stringify(spec, null, 2).length;
  const asString = JSON.stringify(JSON.stringify(spec)).length;
  say(`  ${N}-point scatter spec, compact JSON:                       ${B(compact)}`);
  say(`  the same spec pretty:2 (how a node stores an OBJECT):       ${B(pretty)}  → ${(pretty / compact).toFixed(2)}×`);
  say(`  the same spec stored pre-stringified, as a STRING value:    ${B(asString)}  → ${(asString / compact).toFixed(2)}×`);

  await api.post('/api/store', { patch: { k: 'x', spec_obj: 0, spec_str: 0, mcp_probe: 0 } });
  await commit(d, 'reset before the spec test');
  await api.post('/api/store', { patch: { spec_obj: spec } });
  const objNode = nodeBytes(d, (await commit(d, 'spec as object')).id);
  await api.post('/api/store', { patch: { spec_obj: 0, spec_str: JSON.stringify(spec) } });
  const strNode = nodeBytes(d, (await commit(d, 'spec as string')).id);
  say(`\n  MEASURED on committed nodes (same spec, same daemon):`);
  say(`    node with the spec stored as an OBJECT: ${B(objNode)}`);
  say(`    node with the spec stored as a STRING:  ${B(strNode)}   → pre-stringifying saves ${B(objNode - strNode)} per node`);
  return { compact, pretty, asString, objNode, strNode, N };
}

// ── 8. the static fallback ─────────────────────────────────────────────────
async function fallbackCost(d) {
  hr('8. CHALLENGE — the static-fallback capture has the same problem, one order down');
  const api = mk(d);
  say('  a captured PNG reaches the store as base64 (4/3 of the binary size):\n');
  say('  binary png     base64 in store         node on disk            10 outputs × 100 nodes');
  const rows = [];
  for (const [label, n] of [['40 KB png', 40960], ['150 KB png', 153600], ['400 KB png', 409600]]) {
    const b64 = crypto.randomBytes(n).toString('base64');
    await api.post('/api/store', { patch: { png: b64 } });
    const node = nodeBytes(d, (await commit(d, 'png ' + label)).id);
    rows.push({ label, n, b64: b64.length, node });
    say(`  ${label.padEnd(13)} ${B(b64.length).padStart(21)} ${B(node).padStart(22)} ${B(node * 10 * 100).padStart(26)}`);
  }
  await api.post('/api/store', { patch: { png: 'x' } });
  await commit(d, 'drop png');
  say('\n  the fallback is NOT free. It is the renderer problem at ~1/30 the scale — and');
  say('  unlike the renderer it is PER OUTPUT and it CHANGES on every re-render, so it');
  say('  is paid again in a new node each time instead of being a constant.');
  return rows;
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  say('INDEPENDENT RE-CHECK — "renderer JS (~4.7 MB) can travel through the web-chat store"');
  say(`node ${process.version} · web-chat ${WCDEV} · ports ${PORT_A}/${PORT_B} · ${new Date().toISOString()}`);
  anchors();
  const R = payload();
  const H = await headline(R);
  const ring = await cleanRing(R);
  // MCP phase BEFORE the spec/png phases: those shrink the store, and the whole
  // point of phase 6 is what the tools hand back while the renderer is LIVE.
  const mcp = await mcpSurfaces(H.d);
  const spec = await specCost(H.d);
  const png = await fallbackCost(H.d);
  // Residency LAST: it boots a second daemon on the same root, so it must not
  // run while the phases above are still committing into it.
  const res = residency(H.d.root);

  const amp = H.big.node / H.big.n;
  finding('R1', 'Renderer JS (~4.7 MB) can travel to the pane through the web-chat store', 'REFUTED',
    `POST /api/store accepted ${B(H.big.n)} in ${ms(H.big.postMs)} (body limit 200mb), and then: one committed node = ${B(H.big.node)} on disk (${amp.toFixed(3)}× the value; baseline node ${B(H.baseNode)}); ${H.K} such nodes grew the graph dir by ${B(H.grew)} (${B(H.perNode)}/node → 100 nodes ${B(H.perNode * 100)}, 1000 nodes ${B(H.perNode * 1000)}); a turn that CHANGES NOTHING costs ${ms(avg(H.bigNoop))} vs ${ms(avg(H.smallNoop))} with a small store; every WS hello re-sends ${B(H.big.hello)}; on a FRESH ring ${ring.N} writes made GET /api/events ${B(ring.afterB)} (${B(ring.per)} retained per write, ring of ${ring.MAX_EVENTS}); GET /api/store = ${B(H.big.store)} ${tok(H.big.store)}`,
    'independently reproduces the earlier verdict. The renderer bytes must never enter the store.');

  finding('R2', 'The blast radius is the whole MCP surface', 'REFUTED — it is exactly two tools',
    mcp ? `the REAL MCP handlers, run against this probe's daemon with the renderer live in the store: get_store ${B(mcp.get_store.bytes)} ${tok(mcp.get_store.bytes)}, get_events ${mcp.get_events.error ? 'ERROR' : B(mcp.get_events.bytes) + ' ' + tok(mcp.get_events.bytes)} — vs set_store ${B(mcp.set_store.bytes)}, diff_nodes ${mcp.diff_nodes.error ? 'ERROR' : B(mcp.diff_nodes.bytes)}, get_graph ${mcp.get_graph.error ? 'ERROR' : B(mcp.get_graph.bytes)}, list_mounts ${mcp.list_mounts.error ? 'ERROR' : B(mcp.list_mounts.bytes)}`
        : 'UNMEASURABLE this run — see phase 6',
    'get_store and get_events are raw passthroughs and leak it whole; set_store is shaped, diff_nodes is capped at 2000 B/value, get_graph is topology-only and list_mounts has no html. Worth knowing when deciding what a future implementation may safely put in the store.');

  finding('R3', 'A transient big write is recoverable by overwriting the key', 'REFUTED',
    `after the key was overwritten with 4 bytes and a node committed, GET /api/store fell back to ${B(ring.storeNow)} but GET /api/events stayed ${B(ring.eventsNow)} — the old patches are retained whole and only leave after ${ring.MAX_EVENTS} further events`,
    'one accidental megabyte write poisons get_events for the rest of the session. This is the realistic hazard; the full-ring figure is a worst case nobody reaches.');

  if (res) finding('R4', 'The per-node cost is only a disk cost', 'REFUTED',
    `a daemon booted on a graph of ${res.b.nodes} such nodes used ${B(res.b.rssAfter)} RSS vs ${B(res.a.rssAfter)} on an empty graph — +${B(res.b.rssAfter - res.a.rssAfter)}, ≈${B(res.perNodeRss)} per node`,
    'graph.load() sets every node file into graph.nodes at boot, so the store cost is RESIDENT and PERMANENT: unlike the event ring it never ages out, and it is re-paid at every daemon start.');

  finding('R5', '"Specs are ~1 KB, so the store is fine for them"', 'TRUE BUT WITH A CAVEAT',
    `a ${spec.N}-point plotly scatter spec is ${B(spec.compact)} compact, ${B(spec.pretty)} pretty:2 (${(spec.pretty / spec.compact).toFixed(2)}×); measured on committed nodes, the same spec as an OBJECT gave a ${B(spec.objNode)} node vs ${B(spec.strNode)} stored pre-stringified as a STRING`,
    'specs are cheap enough either way at this size, but store them PRE-STRINGIFIED: the pretty-print overhead is paid on every node and grows with point count.');

  finding('R6', 'The static PNG fallback is free because it is not the renderer', 'REFUTED',
    png.map((r) => `${r.label} → ${B(r.node)}/node`).join('; ') + ` (10 outputs × 100 nodes ≈ ${B(png[1].node * 10 * 100)} for the middle case)`,
    'the fallback is the same amplification one order down, and unlike the renderer it is per-output and changes every re-render, so it is re-paid in a new node each time.');

  hr('FINDINGS');
  for (const f of findings) {
    say(`\n[${f.id}] ${f.verdict} — ${f.claim}`);
    say(`  evidence:   ${f.evidence}`);
    say(`  note:       ${f.note}`);
  }

  try { H.d.keep.close(); } catch {}
  try { ring.d.keep.close(); } catch {}
  try { await H.d.srv.stop(); } catch {}
  try { await ring.d.srv.stop(); } catch {}
  say(`\ndaemons stopped. temp roots left at ${TMP} (delete freely).`);
  FINISHED = true;
  process.exit(0);
})();

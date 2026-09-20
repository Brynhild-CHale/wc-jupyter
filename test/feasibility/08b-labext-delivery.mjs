// 08b-labext-delivery.mjs — WILL THE USER'S OWN SERVER HAND OUT THE RENDERER BYTES?
//
// 08 found something the "JS box" design depends on and that a previous probe
// reported the other way round:
//
//   a bare `python -m jupyter_server` (no jupyterlab installed) answers
//   GET /labextensions/jupyterlab-plotly/static/remoteEntry.<hash>.js
//   with 404 — token or no token. The prebuilt extension is on disk in
//   sys.prefix/share/jupyter/labextensions, and the server still does not serve it.
//
// The obvious hypothesis: the /labextensions/ route belongs to jupyterlab_server /
// the lab app, not to jupyter_server. This probe tests exactly that, by running the
// SAME request against a real `jupyter lab` in an env that has jupyterlab + plotly.
//
// It also measures the terms of delivery, which is what a JS box actually needs:
//   - does it need the token, and does a ?token= query param work (a <script src>
//     cannot set an Authorization header)
//   - what content-type comes back, and is X-Content-Type-Options set (a wrong
//     type + nosniff would make <script src> refuse the file)
//   - is there an Access-Control-Allow-Origin (needed for fetch() from origin
//     "null", NOT needed for a classic <script src>)
//
// SAFETY: own server, own port (default 8936, never 8899/8888/5176), own runtime
// dir, killed on the way out.
//
// Run:  node test/feasibility/08b-labext-delivery.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '08b-labext-delivery.results.json');
const WANT = Number(process.env.JPY_PROBE_PORT || 8936);
const FORBIDDEN = new Set([8888, 8899, 5173, 5174, 5175, 5176]);
const TOKEN = 'probe' + Math.random().toString(36).slice(2, 12);
let PORT = WANT, BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const oneline = (s, n = 110) => String(s).replace(/\s+/g, ' ').slice(0, n);
const H = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const R = { meta: {}, requests: [], checks: [], notes: [] };
let fails = 0;
const ok = (l, c, d) => { if (!c) fails++; R.checks.push({ label: l, pass: !!c, detail: d === undefined ? null : String(d).slice(0, 300) }); console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d !== undefined ? '  -> ' + oneline(d, 120) : ''}`); };
const fact = (l, v) => { R.notes.push({ label: l, value: String(v) }); console.log(`  FACT  ${pad(l, 40)} -> ${oneline(v, 130)}`); };

const portFree = (p) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  const done = (f) => { try { s.destroy(); } catch {} res(f); };
  s.setTimeout(700);
  s.once('connect', () => done(false));
  s.once('error', () => done(true));
  s.once('timeout', () => done(false));
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-jpy-labext-'));
const RUNTIME = path.join(ROOT, 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
let server = null;
const stop = () => {
  if (!server) return;
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  try { server.kill('SIGTERM'); } catch {}
};
process.on('SIGINT', () => { stop(); process.exit(130); });

const PKGS = ['jupyterlab', 'plotly'];

async function probe(url, init, label) {
  const t0 = Date.now();
  let row = { label, url, ...(init && init.headers && init.headers.Authorization ? { auth: 'token header' } : {}) };
  try {
    const r = await fetch(url, init);
    const body = await r.arrayBuffer();
    row = {
      ...row, status: r.status, ms: Date.now() - t0, bytes: body.byteLength,
      contentType: r.headers.get('content-type'),
      nosniff: r.headers.get('x-content-type-options'),
      acao: r.headers.get('access-control-allow-origin'),
      cacheControl: r.headers.get('cache-control'),
      head: Buffer.from(body.slice(0, 90)).toString('utf8').replace(/\s+/g, ' '),
    };
  } catch (e) { row = { ...row, error: String(e && e.message || e) }; }
  R.requests.push(row);
  console.log(`  ${pad(label, 34)} ${pad(row.status ?? row.error, 6)} ${pad(row.bytes === undefined ? '' : kb(row.bytes), 11)} ct=${pad(row.contentType || '-', 30)} nosniff=${pad(row.nosniff || '-', 8)} acao=${row.acao || '-'}`);
  return row;
}

const t00 = Date.now();
try {
  H('0 — WHAT IS ON DISK (same package set the server will run)');
  if (FORBIDDEN.has(WANT)) throw new Error('refusing a reserved port');
  for (let p = WANT; p < WANT + 12; p++) { if (!FORBIDDEN.has(p) && await portFree(p)) { PORT = p; BASE = `http://127.0.0.1:${p}/`; break; } }
  fact('probe port', PORT);

  const py = `
import os, sys, json
lab = os.path.join(sys.prefix, 'share', 'jupyter', 'labextensions')
out = {'prefix': sys.prefix, 'labext_root': lab, 'exists': os.path.isdir(lab), 'files': []}
if out['exists']:
    for dp, _dn, fn in os.walk(lab):
        for f in fn:
            p = os.path.join(dp, f)
            out['files'].append({'rel': os.path.relpath(p, lab), 'bytes': os.path.getsize(p)})
    out['files'].sort(key=lambda d: -d['bytes'])
    out['total'] = sum(f['bytes'] for f in out['files'])
try:
    import jupyterlab, jupyter_server, plotly
    out['versions'] = {'jupyterlab': jupyterlab.__version__, 'jupyter_server': jupyter_server.__version__, 'plotly': plotly.__version__}
except Exception as e:
    out['versions'] = str(e)
print('PROBE_JSON ' + json.dumps(out))
`;
  const args = ['run', '--no-project'];
  for (const p of PKGS) args.push('--with', p);
  const listing = await new Promise((res, rej) => {
    const c = spawn('uv', [...args, 'python', '-c', py], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    c.stdout.on('data', (d) => { o += d; });
    c.stderr.on('data', (d) => { e += d; });
    c.on('close', (code) => {
      const line = o.split('\n').find((l) => l.startsWith('PROBE_JSON '));
      line ? res(JSON.parse(line.slice(11))) : rej(new Error('listing failed (' + code + '): ' + e.slice(-500)));
    });
  });
  R.meta.disk = { ...listing, files: (listing.files || []).slice(0, 10) };
  fact('versions', JSON.stringify(listing.versions));
  fact('labextensions on disk', `${listing.exists ? (listing.files || []).length + ' files, ' + kb(listing.total || 0) : 'MISSING'} at ${listing.labext_root}`);
  for (const f of (listing.files || []).slice(0, 5)) console.log(`        ${pad(kb(f.bytes), 11)} ${f.rel}`);

  const plotlyFiles = (listing.files || []).filter((f) => f.rel.startsWith('jupyterlab-plotly/'));
  const remote = plotlyFiles.find((f) => /remoteEntry.*\.js$/.test(f.rel));
  const chunk = plotlyFiles.find((f) => /static\/\d+\.[0-9a-f]+\.js$/.test(f.rel)) || plotlyFiles.sort((a, b) => b.bytes - a.bytes)[0];
  ok('the plotly labextension is on disk where the claim says', !!remote, remote && remote.rel + ' ' + kb(remote.bytes));

  H('1 — A REAL `jupyter lab` SERVER');
  server = spawn('uv', [...args, 'jupyter', 'lab', '--no-browser', `--port=${PORT}`,
    '--ServerApp.ip=127.0.0.1', `--ServerApp.token=${TOKEN}`, `--ServerApp.root_dir=${ROOT}`,
    '--ServerApp.open_browser=False', '--ServerApp.disable_check_xsrf=True'],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JUPYTER_RUNTIME_DIR: RUNTIME } });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 180000) {
    try { const r = await fetch(BASE + 'api/status', { headers: { Authorization: 'token ' + TOKEN } }); if (r.ok) { up = true; break; } } catch {}
    if (server.exitCode !== null) throw new Error('server died:\n' + log.slice(-1200));
    await sleep(400);
  }
  if (!up) throw new Error('jupyter lab never came up:\n' + log.slice(-1200));
  fact('jupyter lab up in', `${((Date.now() - t0) / 1000).toFixed(1)}s`);

  H('2 — THE SAME REQUEST THAT 404-ed ON BARE jupyter_server');
  const rel = remote ? remote.rel : 'jupyterlab-plotly/static/remoteEntry.js';
  const url = BASE + 'labextensions/' + rel;
  const withHeader = await probe(url, { headers: { Authorization: 'token ' + TOKEN } }, 'with Authorization header');
  const noAuth = await probe(url, {}, 'with NO credentials at all');
  const queryTok = await probe(url + '?token=' + TOKEN, {}, 'with ?token= query param');
  const bogus = await probe(BASE + 'labextensions/does-not-exist/static/x.js', {}, 'a path that should 404');
  const labApi = await probe(BASE + 'lab/api/extensions', { headers: { Authorization: 'token ' + TOKEN } }, 'lab/api/extensions');

  // A 404 may be my URL rather than the server's behaviour. Ask the server what
  // URLs IT uses: the /lab page names every federated extension asset it loads.
  H('2b — WHAT URLs DOES THE LAB PAGE ITSELF USE?');
  let labHtml = '';
  try { labHtml = await (await fetch(BASE + 'lab?token=' + TOKEN)).text(); } catch (e) { labHtml = ''; }
  const found = [...new Set([...labHtml.matchAll(/[\w./-]*labextensions\/[\w./@-]+/g)].map((m) => m[0]))];
  fact('/lab page bytes', labHtml.length);
  fact('labextension-ish URLs in the lab page', found.slice(0, 6).join(' | ') || 'NONE');
  let apiBody = '';
  try { apiBody = await (await fetch(BASE + 'lab/api/extensions', { headers: { Authorization: 'token ' + TOKEN } })).text(); } catch {}
  R.meta.lab_api_extensions = apiBody.slice(0, 2000);
  fact('lab/api/extensions body', oneline(apiBody, 300));
  const fromPage = found.find((u) => /plotly/.test(u)) || found[0];
  let pageUrl = null;
  if (fromPage) {
    pageUrl = await probe(BASE + fromPage.replace(/^\/+/, ''), {}, 'URL taken from the lab page');
  }
  // and the pattern jupyterlab_server actually registers, spelled a few ways
  const spellings = remote ? [
    'labextensions/' + rel,
    'lab/extensions/' + rel,
    'static/labextensions/' + rel,
    'labextensions/' + rel.split('/')[0] + '/package.json',
  ] : [];
  const tried = [];
  for (const sp of spellings) tried.push(await probe(BASE + sp, {}, oneline(sp, 32)));
  // Whichever spelling works, re-ask it the questions a JS box actually cares about.
  const live = tried.find((r) => r.status === 200 && /javascript|ecmascript/i.test(r.contentType || ''));
  let liveTok = null, liveChunk = null;
  if (live) {
    const prefix = live.url.slice(BASE.length).replace(rel, '');
    liveTok = await probe(live.url + '?token=' + TOKEN, {}, 'working URL + ?token=');
    if (chunk) liveChunk = await probe(BASE + prefix + chunk.rel, {}, 'the 4.6 MB chunk, working URL');
  }

  H('3 — VERDICTS');
  ok('a real `jupyter lab` DOES serve the prebuilt extension bytes at SOME URL',
    !!live, live ? `${live.label} -> HTTP ${live.status}, ${kb(live.bytes || 0)}, ${live.contentType}` : 'no spelling of the URL returned JS');
  fact('THE URL THAT WORKS', live ? '/' + live.url.slice(BASE.length) : 'none found');
  ok('the spelling /labextensions/<pkg>/static/<file> does NOT work here',
    withHeader.status === 404, `HTTP ${withHeader.status} ${withHeader.contentType} (jupyterlab ${JSON.stringify(listing.versions && listing.versions.jupyterlab)})`);
  ok('the working URL needs NO token (a <script src> can just load it)',
    !!(live && live.status === 200), live && `HTTP ${live.status} with no credentials sent`);
  if (liveTok) ok('...and tolerates a ?token= query param as well',
    liveTok.status === 200, `HTTP ${liveTok.status}`);
  ok('a nonexistent labextension path 404s (so the 200 is not a catch-all)',
    bogus.status === 404, `HTTP ${bogus.status}`);
  if (liveChunk) ok('the multi-MB chunk is served whole at the working URL',
    liveChunk.status === 200 && liveChunk.bytes === chunk.bytes,
    `HTTP ${liveChunk.status}, ${kb(liveChunk.bytes || 0)} vs ${kb(chunk.bytes)} on disk`);
  ok('content-type is JavaScript (a <script src> will accept it under nosniff)',
    /javascript|ecmascript/i.test((live && live.contentType) || ''), live && live.contentType);
  fact('Access-Control-Allow-Origin', ((live && live.acao) || 'ABSENT') + '  (needed for fetch() from origin "null"; NOT needed for <script src>)');
  fact('X-Content-Type-Options', (live && live.nosniff) || 'absent');
  fact('remoteEntry head', (live && live.head) || withHeader.head);
  fact('lab/api/extensions', `HTTP ${labApi.status}, ${kb(labApi.bytes || 0)}`);

} catch (e) {
  fails++;
  console.error('\n!! PROBE ABORTED: ' + (e && e.stack || e));
  R.abort = String(e && e.message || e);
} finally {
  H('CLEANUP');
  stop();
  await sleep(800);
  console.log(`  jupyter lab on :${PORT} stopped; port free: ${await portFree(PORT)}`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  R.meta.ms = Date.now() - t00;
  R.meta.fails = fails;
  fs.writeFileSync(RESULTS, JSON.stringify(R, null, 2));
  console.log(`  wrote ${RESULTS}`);
  console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}  in ${(R.meta.ms / 1000).toFixed(1)}s`);
  process.exit(0);
}

#!/usr/bin/env node
// 01-server-assets.mjs — FEASIBILITY PROBE (not a test suite).
//
// Measures what a running Jupyter server will actually hand to a sandboxed
// <iframe sandbox="allow-scripts"> ("the JS box"), and on what terms.
//
//   Q1  Are labextension assets served WITHOUT the token?  (the load-bearing one:
//       this pack's invariant is that the token never leaves the host, so if these
//       need auth the JS box cannot fetch them at all.)
//   Q2  Same for /static/lab/..., with /api/contents as an auth-required control
//       that proves the no-token result is meaningful.
//   Q3  Which CORS/security headers come back, and which transport they permit —
//       a null-origin fetch() needs CORS, a <script src> does not.
//   Q4  What is actually inside a prebuilt labextension: a standalone UMD bundle,
//       or module-federation only (remoteEntry + chunks)? What is the contract?
//   Q5  Can the server reach arbitrary files inside an installed Python package
//       (plotly/package_data/plotly.min.js)? If not, what transports remain?
//   Q6  (added) Does an extension installed AFTER boot get served with no restart,
//       and does it matter which Python env it landed in? (%pip install from chat.)
//
// Runs the same battery against THREE server shapes, because they do not behave
// the same and the differences are themselves findings:
//   BREW   /opt/homebrew/bin/jupyter        jupyterlab 4.6.3, jupyter_server 2.21.0
//   LABENV throwaway uv env, `jupyter lab`  jupyterlab 4.6.3, jupyter_server 2.21.1
//   BARE   throwaway uv env, `jupyter server` — jupyter_server only, NO jupyterlab.
//          This is the shape of the server the pack is actually attached to today.
//
// Self-contained and re-runnable. Starts its own `jupyter lab` on PORT (default
// 8911) in its own /tmp workdir with its own JUPYTER_RUNTIME_DIR, so it never
// appears in `jupyter server list` and cannot be picked up by anyone's pane.
// Kills every server it starts, including on Ctrl-C.
//
//   node test/feasibility/01-server-assets.mjs
//   PORT=8911 WORK=/tmp/wc-jpy-feas-01 ONLY=labenv node test/feasibility/01-server-assets.mjs
//
// Takes ~2 min on a cold machine (it builds three uv envs), ~50 s warm.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT  = String(process.env.PORT || 8911);
const WORK  = process.env.WORK || '/tmp/wc-jpy-feas-01';
const BREW  = process.env.JUPYTER || '/opt/homebrew/bin/jupyter';
const ONLY  = process.env.ONLY || '';           // '', 'brew', 'labenv', 'bare'
const TOKEN = 'feas01tok' + '0'.repeat(20);
const BAD   = 'deadbeef'.repeat(4);
const BASE  = `http://127.0.0.1:${PORT}`;

// Ports belonging to the user's live environment. Never bind or touch these.
for (const p of ['8899', '5176']) {
  if (PORT === p) { console.error(`refusing to bind ${p}: live environment`); process.exit(2); }
}

const line = (s = '') => console.log(s);
const pad  = (s, n) => String(s).padEnd(n);
const rule = (t) => { line(); line('='.repeat(80)); line(t); line('='.repeat(80)); };
const sub  = (t) => { line(); line('-- ' + t + ' ' + '-'.repeat(Math.max(0, 74 - t.length))); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const FIND = [];
const record = (q, claim, verdict, evidence) => { FIND.push({ q, claim, verdict, evidence }); };

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------
const SRVDATA = path.join(WORK, 'srvdata');        // JUPYTER_PATH given to the server
const SRVEXT  = path.join(SRVDATA, 'labextensions');
const PKGENV  = path.join(WORK, 'venv');           // plotly lives here: "the kernel's env"
const LABENV  = path.join(WORK, 'labenv');         // a second, current jupyterlab
const BAREENV = path.join(WORK, 'bareenv');        // jupyter_server with NO jupyterlab
const ROOT    = path.join(WORK, 'root');           // ServerApp.root_dir
const RUNTIME = path.join(WORK, 'runtime');        // private -> no jpserver-*.json leak
const CONFIG  = path.join(WORK, 'config');
const DATA    = path.join(WORK, 'data');

const have = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
const py   = (venv) => path.join(venv, 'bin', 'python');

function uvEnv(dir, pkgs) {
  if (fs.existsSync(py(dir))) return true;
  if (!have('uv')) return false;
  line(`  uv venv ${dir} + ${pkgs.join(' ')} ...`);
  const a = spawnSync('uv', ['venv', dir, '--python', '3.12'], { encoding: 'utf8' });
  if (a.status !== 0) { line('    FAILED: ' + (a.stderr || '').trim().slice(0, 300)); return false; }
  const b = spawnSync('uv', ['pip', 'install', '--python', py(dir), ...pkgs], { encoding: 'utf8' });
  if (b.status !== 0) { line('    FAILED: ' + (b.stderr || '').trim().slice(0, 300)); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const auth = (t) => (t ? { Authorization: 'token ' + t } : {});
async function GET(url, { token, headers, method = 'GET', range, cap = 400 } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method, redirect: 'manual',
      headers: { ...auth(token), ...(range ? { Range: range } : {}), ...(headers || {}) },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      status: r.status, bytes: buf.length, ms: Date.now() - t0,
      h: Object.fromEntries(r.headers.entries()),
      text: buf.toString('utf8', 0, Math.min(buf.length, cap)),
    };
  } catch (e) { return { status: 0, bytes: 0, ms: Date.now() - t0, h: {}, err: String(e?.message || e), text: '' }; }
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------
const CHILDREN = new Set();
const killAll = () => { for (const c of CHILDREN) { try { c.kill('SIGKILL'); } catch {} } CHILDREN.clear(); };
process.on('SIGINT',  () => { killAll(); process.exit(130); });
process.on('SIGTERM', () => { killAll(); process.exit(143); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); killAll(); process.exit(1); });

async function startServer(jupyterBin, extraArgs = [], subcmd = 'lab') {
  const env = {
    ...process.env,
    JUPYTER_PATH: SRVDATA,
    JUPYTER_RUNTIME_DIR: RUNTIME,
    JUPYTER_CONFIG_DIR: CONFIG,
    JUPYTER_DATA_DIR: DATA,
    PYDEVD_DISABLE_FILE_VALIDATION: '1',
  };
  const args = [
    subcmd, '--no-browser',
    '--ServerApp.ip=127.0.0.1',
    `--ServerApp.port=${PORT}`,
    '--ServerApp.port_retries=0',
    `--IdentityProvider.token=${TOKEN}`,
    '--ServerApp.password=',
    `--ServerApp.root_dir=${ROOT}`,
    '--ServerApp.open_browser=False',
    ...extraArgs,
  ];
  const child = spawn(jupyterBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  CHILDREN.add(child);
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const handle = {
    child, pid: child.pid, get log() { return log; },
    async stop() {
      CHILDREN.delete(child);
      try { child.kill('SIGTERM'); } catch {}
      for (let i = 0; i < 20; i++) { if (child.exitCode !== null || child.signalCode) break; await sleep(200); }
      try { child.kill('SIGKILL'); } catch {}
      await sleep(400);
    },
  };
  for (let i = 0; i < 120; i++) {
    const r = await GET(BASE + '/api/status', { token: TOKEN });
    if (r.status === 200) return handle;
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  line('SERVER DID NOT COME UP; log tail:');
  line(log.split('\n').slice(-20).map(l => '  ' + l).join('\n'));
  await handle.stop();
  return null;
}

// ---------------------------------------------------------------------------
// 0. setup
// ---------------------------------------------------------------------------
rule('0. SETUP');
for (const d of [SRVEXT, ROOT, RUNTIME, CONFIG, DATA]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'control.txt'), 'inside the server root dir\n');

const PKGENV_OK = uvEnv(PKGENV, ['plotly']);
const LABENV_OK = uvEnv(LABENV, ['jupyterlab']);
const BARE_OK   = uvEnv(BAREENV, ['jupyter_server']);
const PKG_EXT   = path.join(PKGENV, 'share', 'jupyter', 'labextensions');
const SITE_PKGS = (() => {
  const libs = path.join(PKGENV, 'lib');
  for (const d of fs.existsSync(libs) ? fs.readdirSync(libs) : []) {
    const sp = path.join(libs, d, 'site-packages');
    if (fs.existsSync(path.join(sp, 'plotly'))) return sp;
  }
  return null;
})();
const PLOTLY_MIN = SITE_PKGS ? path.join(SITE_PKGS, 'plotly', 'package_data', 'plotly.min.js') : null;
const PLOTLY_EXT = path.join(PKG_EXT, 'jupyterlab-plotly');
const PLOTLY_PJ  = fs.existsSync(path.join(PLOTLY_EXT, 'package.json'))
  ? JSON.parse(fs.readFileSync(path.join(PLOTLY_EXT, 'package.json'), 'utf8')) : null;
const REMOTE_ENTRY = PLOTLY_PJ?.jupyterlab?._build?.load || 'static/remoteEntry.js';

line(`workdir        ${WORK}`);
line(`JUPYTER_PATH   ${SRVDATA}   (its labextensions/ is emptied before each suite)`);
line(`plotly env     ${PKGENV}  ${PKGENV_OK ? 'ok' : 'MISSING'}`);
if (PKGENV_OK) {
  const v = spawnSync(py(PKGENV), ['-c', 'import plotly;print(plotly.__version__)'], { encoding: 'utf8' });
  line(`  plotly       ${(v.stdout || '').trim()}   labextensions: ${fs.existsSync(PKG_EXT) ? fs.readdirSync(PKG_EXT).join(',') : '(none)'}`);
  line(`  _build.load  ${REMOTE_ENTRY}`);
}
line(`lab env        ${LABENV}  ${LABENV_OK ? 'ok' : 'MISSING'}`);

function versionsOf(jupyterBin) {
  const shebang = fs.readFileSync(jupyterBin, 'utf8').split('\n')[0].replace('#!', '').trim();
  const r = spawnSync(shebang, ['-c',
    'import tornado,jupyter_server,sys;'
    + 'jl="NOT-INSTALLED"\n'
    + 'try:\n import jupyterlab; jl=jupyterlab.__version__\n'
    + 'except Exception: pass\n'
    + 'jls="NOT-INSTALLED"\n'
    + 'try:\n import jupyterlab_server; jls=jupyterlab_server.__version__\n'
    + 'except Exception: pass\n'
    + 'print(tornado.version, jupyter_server.__version__, jl, jls, sys.prefix)'], { encoding: 'utf8' });
  const [tornado, js, jl, jls, prefix] = (r.stdout || '').trim().split(' ');
  return { shebang, tornado, jupyter_server: js, jupyterlab: jl, jupyterlab_server: jls, prefix };
}

const SUITES = [];
if (fs.existsSync(BREW) && ONLY !== 'labenv') SUITES.push({ name: 'BREW', bin: BREW });
if (LABENV_OK && ONLY !== 'brew') SUITES.push({ name: 'LABENV', bin: path.join(LABENV, 'bin', 'jupyter') });
if (BARE_OK && (ONLY === '' || ONLY === 'bare')) SUITES.push({ name: 'BARE', bin: path.join(BAREENV, 'bin', 'jupyter'), subcmd: 'server' });

line(`bare env       ${BAREENV}  ${BARE_OK ? 'ok' : 'MISSING'}   (jupyter_server, NO jupyterlab — the shape of the user's live 8899 server)`);
for (const s of SUITES) { s.v = versionsOf(s.bin); line(`suite ${pad(s.name, 7)} ${s.bin}  [jupyter ${s.subcmd || 'lab'}]\n         tornado ${s.v.tornado} · jupyter_server ${s.v.jupyter_server} · jupyterlab ${s.v.jupyterlab} · jupyterlab_server ${s.v.jupyterlab_server}`); }

// ---------------------------------------------------------------------------
// the battery
// ---------------------------------------------------------------------------
async function suite(S) {
  const tag = S.name;
  rule(`SUITE ${tag}  —  jupyter ${S.subcmd || 'lab'}  ·  tornado ${S.v.tornado} · jupyter_server ${S.v.jupyter_server} · jupyterlab ${S.v.jupyterlab} · jupyterlab_server ${S.v.jupyterlab_server}`);

  // reset: the server's search path must start without the extension
  for (const n of fs.readdirSync(SRVEXT)) fs.rmSync(path.join(SRVEXT, n), { recursive: true, force: true });

  const srv = await startServer(S.bin, [], S.subcmd || 'lab');
  if (!srv) { record(tag, 'server boots', 'UNMEASURABLE', 'jupyter lab did not come up on ' + PORT); return; }
  line(`up: pid ${srv.pid} on ${BASE}`);
  line(`runtime dir (private, so the live pane cannot discover us): ${fs.readdirSync(RUNTIME).join(', ')}`);

  try {
    // ---- where do labextensions actually live in the URL space? -------------
    sub('URL space: where the server says federated extensions are served from');
    const labPage = await fetch(BASE + '/lab', { headers: auth(TOKEN) }).then(r => r.text()).catch(() => '');
    const pc = (labPage.match(/id="jupyter-config-data"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
    let cfg = {};
    try { cfg = JSON.parse(pc || '{}'); } catch {}
    for (const k of ['baseUrl', 'fullStaticUrl', 'fullLabextensionsUrl', 'fullThemesUrl', 'appUrl']) {
      if (cfg[k] !== undefined) line('  ' + pad(k, 24) + cfg[k]);
    }
    const EXT_BASE = (cfg.fullLabextensionsUrl || '/lab/extensions').replace(/\/$/, '');
    const EXT = (rel) => `${BASE}${EXT_BASE}/jupyterlab-plotly/${rel}`;
    const labStatic = (() => {
      const m = labPage.match(/\/static\/lab\/[A-Za-z0-9._\-\/]+\.js/);
      return m ? BASE + m[0] : null;
    })();
    line('  ' + pad('extension asset base', 24) + EXT_BASE + (cfg.fullLabextensionsUrl ? '' : '   <- DEFAULT GUESS: the /lab page gave no page_config'));
    record(tag, 'this server exposes a federated-labextension asset route at all',
      cfg.fullLabextensionsUrl ? 'CONFIRMED' : 'REFUTED',
      `jupyterlab_server ${S.v.jupyterlab_server}; /lab page_config fullLabextensionsUrl = ${cfg.fullLabextensionsUrl || 'ABSENT'}`);
    line('  ' + pad('a real /static/lab file', 24) + (labStatic || '(not found in the page)'));

    // ---- Q6a: installed in a DIFFERENT env than the server -----------------
    sub('Q6a. plotly installed in an env the server does NOT search');
    const q6a = await GET(EXT(REMOTE_ENTRY));
    line(`  GET ${EXT_BASE}/jupyterlab-plotly/${REMOTE_ENTRY}  ->  ${q6a.status}`);
    record(tag + '/Q6a', 'a labextension in a Python env outside the server\'s jupyter_path is served',
      q6a.status === 200 ? 'CONFIRMED' : 'REFUTED',
      `plotly only in ${PKGENV}; server JUPYTER_PATH=${SRVDATA} -> HTTP ${q6a.status}`);

    // ---- Q6b: hot pickup ----------------------------------------------------
    sub('Q6b. drop it into a dir the server DOES search, no restart (what %pip does)');
    let q6b = { status: 0 };
    if (fs.existsSync(PLOTLY_EXT)) {
      fs.cpSync(PLOTLY_EXT, path.join(SRVEXT, 'jupyterlab-plotly'), { recursive: true });
      await sleep(300);
      q6b = await GET(EXT(REMOTE_ENTRY));
      line(`  copied -> ${SRVEXT}/jupyterlab-plotly  (pid ${srv.pid} never restarted)`);
      line(`  GET same url -> ${q6b.status}  ${q6b.bytes.toLocaleString()} bytes`);
      record(tag + '/Q6b', 'an extension appearing in the search path AFTER boot is served with no restart',
        q6b.status === 200 ? 'CONFIRMED' : 'REFUTED',
        `copied while pid ${srv.pid} ran -> HTTP ${q6b.status}, ${q6b.bytes} bytes`);
    } else record(tag + '/Q6b', 'hot pickup', 'UNMEASURABLE', 'no jupyterlab-plotly to copy');

    // ---- Q1 + Q2: the token matrix -----------------------------------------
    sub('Q1/Q2. token matrix');
    const TARGETS = [
      [`labextension remoteEntry`, EXT(REMOTE_ENTRY)],
      [`labextension package.json`, EXT('package.json')],
      [`WRONG prefix /labextensions/`, `${BASE}/labextensions/jupyterlab-plotly/${REMOTE_ENTRY}`],
      [`/static/lab app bundle`, labStatic],
      [`/static/favicons/favicon.ico`, `${BASE}/static/favicons/favicon.ico`],
      [`/api/status (open by design)`, `${BASE}/api/status`],
      [`/api/contents CONTROL`, `${BASE}/api/contents/control.txt`],
      [`/api/kernelspecs CONTROL`, `${BASE}/api/kernelspecs`],
    ].filter(([, u]) => !!u);
    const VARIANTS = [
      ['no auth', {}],
      ['bad hdr', { token: BAD }],
      ['good hdr', { token: TOKEN }],
      ['bad ?token', { q: 'token=' + BAD }],
      ['good ?token', { q: 'token=' + TOKEN }],
    ];
    line();
    line('  ' + pad('TARGET', 32) + VARIANTS.map(v => pad(v[0], 13)).join(''));
    const M = {};
    for (const [name, url] of TARGETS) {
      const row = [];
      for (const [, o] of VARIANTS) {
        const u = o.q ? url + (url.includes('?') ? '&' : '?') + o.q : url;
        const r = await GET(u, { token: o.token });
        row.push(String(r.status) + (r.h.location ? '→' + String(r.h.location).slice(0, 7) : ''));
      }
      M[name] = row;
      line('  ' + pad(name, 32) + row.map(s => pad(s, 13)).join(''));
    }
    line('  (0 = transport error · 3xx→ = redirect target)');

    const ext = M['labextension remoteEntry'];
    record(tag + '/Q1', 'labextension assets are served with NO token',
      ext[0] === '200' ? 'CONFIRMED' : (ext[2] === '200' ? 'REFUTED' : 'REFUTED'),
      `no auth -> ${ext[0]} · bad token -> ${ext[1]} · good token -> ${ext[2]} · bad ?token= -> ${ext[3]} · good ?token= -> ${ext[4]}`);
    const ctl = M['/api/contents CONTROL'];
    record(tag + '/Q2', 'the control holds: /api/contents on the same server DOES require auth',
      ctl[0] !== '200' && ctl[2] === '200' ? 'CONFIRMED' : 'REFUTED',
      `/api/contents no auth -> ${ctl[0]} · bad token -> ${ctl[1]} · good token -> ${ctl[2]} · good ?token= -> ${ctl[4]}`);
    const ls = M['/static/lab app bundle'];
    if (ls) record(tag + '/Q2', '/static/lab/... is served with NO token',
      ls[0] === '200' ? 'CONFIRMED' : 'REFUTED', `no auth -> ${ls[0]} · good token -> ${ls[2]}`);
    const wrong = M['WRONG prefix /labextensions/'];
    record(tag + '/Q1', 'the asset path is /labextensions/<name>/... (a common assumption)',
      wrong[0] === '200' ? 'CONFIRMED' : 'REFUTED',
      `/labextensions/... -> ${wrong[0]}; the real base is ${EXT_BASE}`);

    // ---- Q3: headers --------------------------------------------------------
    sub('Q3. headers on a labextension asset, and which transport they permit');
    const INTEREST = ['content-type', 'access-control-allow-origin', 'access-control-allow-credentials',
      'access-control-allow-methods', 'access-control-allow-headers', 'x-content-type-options',
      'cache-control', 'etag', 'last-modified', 'content-length', 'accept-ranges',
      'content-security-policy', 'x-frame-options', 'vary'];
    const dump = (label, r) => {
      line();
      line('  ' + label + '  ->  HTTP ' + r.status + (r.err ? ' ERR ' + r.err : ''));
      for (const k of INTEREST) if (r.h[k] !== undefined) line('      ' + pad(k + ':', 34) + r.h[k]);
      const rest = Object.keys(r.h).filter(k => !INTEREST.includes(k));
      if (rest.length) line('      (also: ' + rest.join(', ') + ')');
    };
    const U = EXT(REMOTE_ENTRY);
    const plain   = await GET(U);
    const nullOrg = await GET(U, { headers: { Origin: 'null', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'cross-site' } });
    const asScript= await GET(U, { headers: { Origin: 'null', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Site': 'cross-site' } });
    const preflt  = await GET(U, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' } });
    dump('plain GET, no Origin', plain);
    dump('GET with Origin: null   (a sandboxed iframe fetch())', nullOrg);
    dump('GET as <script src>     (no-cors, Dest: script)', asScript);
    dump('OPTIONS preflight from Origin: null', preflt);

    const acao = nullOrg.h['access-control-allow-origin'];
    record(tag + '/Q3', 'a null-origin iframe can READ the asset with fetch() (needs CORS)',
      (acao === '*' || acao === 'null') ? 'CONFIRMED' : 'REFUTED',
      `Origin: null -> HTTP ${nullOrg.status}, access-control-allow-origin: ${acao === undefined ? 'ABSENT' : acao}; preflight OPTIONS -> ${preflt.status}`);
    record(tag + '/Q3', 'a null-origin iframe can EXECUTE the asset via <script src> (no CORS needed)',
      asScript.status === 200 && /javascript|ecmascript/i.test(String(asScript.h['content-type'] || '')) ? 'CONFIRMED' : 'REFUTED',
      `HTTP ${asScript.status}, content-type: ${asScript.h['content-type']}, x-content-type-options: ${asScript.h['x-content-type-options'] || 'absent'}, cache-control: ${asScript.h['cache-control'] || 'absent'}`);

    sub('content-type by file kind');
    for (const rel of ['static/style.js', 'package.json', 'static/third-party-licenses.json', 'install.json']) {
      const r = await GET(EXT(rel));
      line('  ' + pad(rel, 36) + pad(r.status, 6) + (r.h['content-type'] || '(none)'));
    }

    sub('the CORS knobs and their defaults on this server');
    {
      const r = spawnSync(S.v.shebang, ['-c',
        'from jupyter_server.serverapp import ServerApp as S;'
        + 'print("ServerApp.allow_origin       =", repr(S.allow_origin.default_value));'
        + 'print("ServerApp.allow_origin_pat   =", repr(S.allow_origin_pat.default_value));'
        + 'print("ServerApp.allow_credentials  =", repr(S.allow_credentials.default_value));'
        + 'print("ServerApp.disable_check_xsrf =", repr(S.disable_check_xsrf.default_value))'], { encoding: 'utf8' });
      line((r.stdout || r.stderr || '').trimEnd().split('\n').map(l => '  ' + l).join('\n'));
    }

    sub('why no token is needed: the handler class opts out of auth');
    {
      const r = spawnSync(S.v.shebang, ['-c',
        'import inspect, jupyter_server.base.handlers as h;'
        + 'print(h.__file__);'
        + 'src=inspect.getsource(h.FileFindHandler);'
        + 'print("\\n".join(l for l in src.split(chr(10)) if "allow_unauthenticated" in l or "def get" in l or "def head" in l or "TODO" in l))'], { encoding: 'utf8' });
      line((r.stdout || r.stderr || '').trimEnd().split('\n').map(l => '  ' + l).join('\n'));
    }

    // ---- Q4: what is in the extension --------------------------------------
    sub('Q4. what is actually in the prebuilt labextension');
    const DIR = path.join(SRVEXT, 'jupyterlab-plotly');
    if (fs.existsSync(DIR)) {
      const walk = (d, pre = '') => fs.readdirSync(d).flatMap(n => {
        const p = path.join(d, n), st = fs.statSync(p);
        return st.isDirectory() ? walk(p, pre + n + '/') : [[pre + n, st.size]];
      });
      const files = walk(DIR).sort((a, b) => b[1] - a[1]);
      line('  ' + pad('FILE', 46) + 'BYTES');
      for (const [f, s] of files) line('  ' + pad(f, 46) + s.toLocaleString());
      line('  ' + pad(`TOTAL (${files.length} files)`, 46) + files.reduce((a, b) => a + b[1], 0).toLocaleString());

      const pj = JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));
      line();
      line('  package.json  name/version   ' + pj.name + ' @ ' + pj.version);
      line('  package.json  main           ' + pj.main);
      line('  package.json  jupyterlab     ' + JSON.stringify(pj.jupyterlab));
      line('  package.json  sharedPackages ' + (pj.jupyterlab?.sharedPackages ? JSON.stringify(pj.jupyterlab.sharedPackages) : 'ABSENT'));
      line('  package.json  dependencies   ' + JSON.stringify(pj.dependencies || {}));

      line();
      line('  classify every .js by its first bytes:');
      const kinds = [];
      for (const [f] of files.filter(([f]) => f.endsWith('.js'))) {
        const head = fs.readFileSync(path.join(DIR, f), 'utf8').slice(0, 300).replace(/\s+/g, ' ');
        let kind = 'unknown';
        if (/^var\s+_JUPYTERLAB\b/.test(head)) kind = 'MODULE-FEDERATION container';
        else if (/(self|globalThis|window)\.(webpackChunk|rspackChunk)/.test(head)) kind = 'FEDERATED CHUNK (needs container)';
        else if (/typeof exports\s*==\s*["']object["']|define\.amd/.test(head)) kind = 'UMD (standalone)';
        else if (head.trim().length < 200) kind = 'stub/generated';
        kinds.push([f, kind]);
        line('    ' + pad(f, 44) + kind);
        line('      ' + head.slice(0, 140));
      }
      record(tag + '/Q4', 'a prebuilt labextension contains a plain UMD/IIFE bundle a bare <script src> could run',
        kinds.some(([, k]) => k === 'UMD (standalone)') ? 'CONFIRMED' : 'REFUTED',
        kinds.map(([f, k]) => `${f}=${k}`).join(' · '));
      record(tag + '/Q4', 'the prebuilt labextension is webpack/rspack module federation only',
        kinds.some(([, k]) => k === 'MODULE-FEDERATION container') ? 'CONFIRMED' : 'REFUTED',
        `_build.load=${pj.jupyterlab?._build?.load} · mimeExtension=${pj.jupyterlab?.mimeExtension} · sharedPackages=${pj.jupyterlab?.sharedPackages ? 'present' : 'ABSENT'}`);

      line();
      line('  the container\'s runtime contract (grep of remoteEntry):');
      const re = fs.readFileSync(path.join(DIR, REMOTE_ENTRY), 'utf8');
      const exposed = [...new Set([...re.matchAll(/"(\.\/[A-Za-z0-9_\-]+)":/g)].map(m => m[1]))];
      line('    global name        ' + (re.match(/^var\s+(\w+)/) || [])[1]);
      line('    exposed modules    ' + (exposed.join(', ') || '(none found)'));
      line('    needs init(scope)  ' + (/init:\s*\w|\.I\(/.test(re) ? 'yes — container.init(shareScope) before get()' : 'not detected'));
      line('    chunk url template ' + ((re.match(/\.u\s*=\s*\w+=>[^,;]{0,70}/) || ['(not found)'])[0]));
      line('    publicPath         ' + (/\.p\s*=/.test(re) ? 'set at load time (derived from the script URL)' : 'not detected'));
    } else record(tag + '/Q4', 'inspect a prebuilt labextension', 'UNMEASURABLE', 'extension not present');

    // ---- Q5: arbitrary package files ---------------------------------------
    sub('Q5. can the server reach arbitrary files inside an installed Python package?');
    if (PLOTLY_MIN && fs.existsSync(PLOTLY_MIN)) {
      line(`  target: ${PLOTLY_MIN}  (${fs.statSync(PLOTLY_MIN).size.toLocaleString()} bytes)`);
      const rel = path.relative(SRVEXT, PLOTLY_MIN);
      const tries = [
        ['traversal via extensions url', `${BASE}${EXT_BASE}/${rel}`],
        ['traversal, encoded',           `${BASE}${EXT_BASE}/${encodeURIComponent(rel)}`],
        ['traversal via /static/lab',    `${BASE}/static/lab/${rel}`],
        ['/files/ no token',             `${BASE}/files/${path.relative(ROOT, PLOTLY_MIN)}`],
        ['/files/ with token',           `${BASE}/files/${path.relative(ROOT, PLOTLY_MIN)}?token=${TOKEN}`],
        ['/api/contents absolute path',  `${BASE}/api/contents${PLOTLY_MIN}?token=${TOKEN}`],
        ['/api/contents ../ escape',     `${BASE}/api/contents/${path.relative(ROOT, PLOTLY_MIN)}?token=${TOKEN}`],
      ];
      const served = [];
      for (const [label, url] of tries) {
        const r = await GET(url);
        if (r.status === 200) served.push(label);
        line('  ' + pad(label, 32) + pad('HTTP ' + r.status, 11) + String(url).replace(BASE, '').slice(0, 78));
      }
      record(tag + '/Q5', 'the server serves arbitrary files from inside an installed Python package',
        served.length ? 'CONFIRMED' : 'REFUTED',
        served.length ? 'via ' + served.join(', ') : tries.map(t => t[0]).join(', ') + ' — all non-200');

      line();
      line('  what DOES work: put the file where the server already looks');
      const SHIM = path.join(SRVEXT, 'wc-assets', 'static');
      fs.mkdirSync(SHIM, { recursive: true });
      const copied = path.join(SHIM, 'plotly.min.js');
      const linkF  = path.join(SHIM, 'plotly.link.js');
      const linkD  = path.join(SRVEXT, 'wc-linked');
      try { fs.copyFileSync(PLOTLY_MIN, copied); } catch (e) { line('    copy failed: ' + e.message); }
      try { fs.rmSync(linkF, { force: true }); fs.symlinkSync(PLOTLY_MIN, linkF); } catch (e) { line('    file symlink failed: ' + e.message); }
      try { fs.rmSync(linkD, { recursive: true, force: true }); fs.symlinkSync(path.dirname(PLOTLY_MIN), linkD); } catch (e) { line('    dir symlink failed: ' + e.message); }
      await sleep(200);
      const rc = await GET(`${BASE}${EXT_BASE}/wc-assets/static/plotly.min.js`);
      const rf = await GET(`${BASE}${EXT_BASE}/wc-assets/static/plotly.link.js`);
      const rd = await GET(`${BASE}${EXT_BASE}/wc-linked/plotly.min.js`);
      line('    ' + pad('real copy in the ext dir', 32) + 'HTTP ' + pad(rc.status, 5) + pad(rc.bytes.toLocaleString() + ' B', 12) + 'ct=' + (rc.h['content-type'] || '-'));
      line('    ' + pad('FILE symlink -> site-packages', 32) + 'HTTP ' + pad(rf.status, 5) + pad(rf.bytes.toLocaleString() + ' B', 12) + 'ct=' + (rf.h['content-type'] || '-'));
      line('    ' + pad('DIR symlink -> site-packages', 32) + 'HTTP ' + pad(rd.status, 5) + pad(rd.bytes.toLocaleString() + ' B', 12) + 'ct=' + (rd.h['content-type'] || '-'));
      if (rc.status === 200) line('    served copy begins: ' + rc.text.replace(/\s+/g, ' ').slice(0, 120));
      record(tag + '/Q5', 'a real COPY placed in a labextensions dir is served, no restart',
        rc.status === 200 ? 'CONFIRMED' : 'REFUTED', `HTTP ${rc.status}, ${rc.bytes} bytes, content-type ${rc.h['content-type']}`);
      record(tag + '/Q5', 'a SYMLINK from a labextensions dir out to site-packages is served',
        rf.status === 200 && rd.status === 200 ? 'CONFIRMED' : (rf.status === 200 || rd.status === 200 ? 'PARTIAL' : 'REFUTED'),
        `file symlink -> HTTP ${rf.status}; dir symlink -> HTTP ${rd.status}`);
      fs.rmSync(path.join(SRVEXT, 'wc-assets'), { recursive: true, force: true });
      fs.rmSync(linkD, { recursive: true, force: true });
    } else record(tag + '/Q5', 'arbitrary package files', 'UNMEASURABLE', 'plotly.min.js not found on disk');

    // ---- extra: the big chunk ----------------------------------------------
    sub('EXTRA. the 4.8 MB federated chunk over the wire');
    {
      const sdir = path.join(SRVEXT, 'jupyterlab-plotly', 'static');
      const chunk = fs.existsSync(sdir) ? fs.readdirSync(sdir).find(f => /^\d+\.[a-f0-9]+\.js$/.test(f)) : null;
      if (chunk) {
        const u = `${BASE}${EXT_BASE}/jupyterlab-plotly/static/${chunk}`;
        const hd = await GET(u, { method: 'HEAD' });
        const g  = await GET(u, { headers: { Origin: 'null' }, cap: 0 });
        const rg = await GET(u, { range: 'bytes=0-99' });
        const vq = await GET(u + '?v=' + (chunk.split('.')[1] || '1'));
        line('  HEAD                 -> ' + hd.status + '  content-length=' + (hd.h['content-length'] || '-'));
        line('  GET (Origin: null)   -> ' + g.status + '  ' + g.bytes.toLocaleString() + ' bytes in ' + g.ms + ' ms  acao=' + (g.h['access-control-allow-origin'] || 'ABSENT'));
        line('  GET Range 0-99       -> ' + rg.status + '  ' + rg.bytes + ' bytes  content-range=' + (rg.h['content-range'] || 'ABSENT'));
        line('  GET ?v=<hash>        -> ' + vq.status + '  cache-control=' + (vq.h['cache-control'] || '-'));
        // cache-control: no-cache means the browser MUST revalidate. Whether that
        // costs 4.8 MB or 0 bytes on every pane load depends on this 304.
        const lm = hd.h['last-modified'];
        const rv = await GET(u, { headers: lm ? { 'If-Modified-Since': lm } : {} });
        line('  GET If-Modified-Since -> ' + rv.status + '  ' + rv.bytes.toLocaleString() + ' bytes'
          + '  (etag=' + (hd.h.etag || 'ABSENT — jupyter_server sets compute_etag()->None') + ')');
        record(tag + '/EXTRA', 'a repeat load of the 4.8 MB chunk revalidates to 304 instead of re-downloading',
          rv.status === 304 ? 'CONFIRMED' : 'REFUTED',
          `cache-control ${g.h['cache-control']}, no etag; If-Modified-Since: ${lm} -> HTTP ${rv.status}, ${rv.bytes} bytes`);
        record(tag + '/EXTRA', 'the multi-MB federated chunk transfers fine over the unauthenticated route',
          g.status === 200 ? 'CONFIRMED' : 'REFUTED',
          `${chunk}: HTTP ${g.status}, ${g.bytes} bytes in ${g.ms} ms, cache-control ${g.h['cache-control']}`);
      } else line('  (no chunk found)');
    }

    // ---- error log sanity ---------------------------------------------------
    const errs = (srv.log.match(/Uncaught exception[^\n]*/g) || []);
    if (errs.length) {
      sub('server-side exceptions raised while probing');
      const seen = new Set();
      for (const e of errs) { if (!seen.has(e)) { seen.add(e); line('  ' + e.trim()); } }
      const attr = (srv.log.match(/^\s*(\w+Error: .*)$/m) || [])[1];
      if (attr) line('  ' + attr.trim());
      record(tag, 'the server serves its own static assets without raising',
        'REFUTED', `${errs.length} uncaught exception(s); first: ${(attr || errs[0]).trim().slice(0, 160)}`);
    } else {
      record(tag, 'the server serves its own static assets without raising', 'CONFIRMED', 'no uncaught exceptions in the server log during the battery');
    }
  } finally {
    await srv.stop();
    line();
    line(`stopped pid ${srv.pid}; port ${PORT} listening? ` +
      (spawnSync('sh', ['-c', `lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | tail -n +2`], { encoding: 'utf8' }).stdout.trim() || 'no'));
  }
}

for (const S of SUITES) await suite(S);

// ---------------------------------------------------------------------------
// remediation probe: what allow_origin='*' changes (one extra boot)
// ---------------------------------------------------------------------------
if (SUITES.length) {
  const S = SUITES.filter(x => (x.subcmd || 'lab') === 'lab').pop() || SUITES[SUITES.length - 1];
  rule(`REMEDIATION PROBE (${S.name}): --ServerApp.allow_origin='*'`);
  const srv = await startServer(S.bin, ["--ServerApp.allow_origin=*"], S.subcmd || 'lab');
  if (srv) {
    try {
      const EXT_BASE = '/lab/extensions';
      const u = `${BASE}${EXT_BASE}/jupyterlab-plotly/${REMOTE_ENTRY}`;
      const r = await GET(u, { headers: { Origin: 'null' } });
      const a = await GET(`${BASE}/api/status`, { headers: { Origin: 'null' } });
      line('  labextension asset, Origin: null -> HTTP ' + r.status
        + '  acao=' + (r.h['access-control-allow-origin'] || 'ABSENT')
        + '  acac=' + (r.h['access-control-allow-credentials'] || 'ABSENT'));
      line('  /api/status,       Origin: null -> HTTP ' + a.status
        + '  acao=' + (a.h['access-control-allow-origin'] || 'ABSENT'));
      record('REMEDIATION', "allow_origin='*' makes labextension assets readable by a null-origin fetch()",
        (r.h['access-control-allow-origin'] === '*' || r.h['access-control-allow-origin'] === 'null') ? 'CONFIRMED' : 'REFUTED',
        `asset acao=${r.h['access-control-allow-origin'] || 'ABSENT'} (HTTP ${r.status}); /api/status acao=${a.h['access-control-allow-origin'] || 'ABSENT'} (HTTP ${a.status})`);
    } finally { await srv.stop(); }
  }
}

// ---------------------------------------------------------------------------
rule('SUMMARY — every line below is a measurement from this run');
for (const f of FIND) {
  line(`[${pad(f.verdict, 12)}] ${f.q}`);
  line(`               ${f.claim}`);
  line(`               ${f.evidence}`);
}
rule('DONE');
line('workdir kept for inspection: ' + WORK);
killAll();
process.exit(0);

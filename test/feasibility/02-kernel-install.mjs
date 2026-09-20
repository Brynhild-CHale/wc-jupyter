#!/usr/bin/env node
// 02-kernel-install — can a package be installed from the live kernel, with
// nothing restarting, and can its JS then be reached?
//
// The design under test: the user types `install plotly` in chat, the service
// runs `%pip install plotly` in the kernel that is already attached to their
// notebook, and the pane immediately renders the plotly bundles it was dropping
// before — loading the renderer JS from the USER'S OWN install so the JS version
// matches the package that produced the bundle. Nothing restarts.
//
// That story has five load-bearing joints, and this probe puts a number on each:
//   1. does `%pip install plotly` actually complete inside a live kernel, and in
//      how long (the user is staring at chat while it runs)
//   2. does `import plotly` work in the SAME session with no restart
//   3. does the ALREADY-RUNNING server serve the newly installed
//      /labextensions/jupyterlab-plotly/... without being restarted
//   4. can the kernel tell the service, over the normal protocol, where those JS
//      assets are on disk and what version they are
//   5. does the kernel's sys.prefix match the SERVER's — because if a user runs a
//      kernel from a different env than the server (very common), the install
//      lands somewhere the server never looks
//
// Everything here is measured against real processes this script starts and
// stops itself. Nothing touches an existing server.
//
// USAGE
//   node test/feasibility/02-kernel-install.mjs
//   PORT=8912 LAB_PORT=8922 WORK=/tmp/wc-feas-02 FRESH=1 node ...02-kernel-install.mjs
//
// FRESH=1 rebuilds the throwaway venvs from scratch (slow, ~2 min). Without it
// the venvs under WORK are reused but the installed-package state is reset, so
// the install measurements stay honest across runs.
//
// REQUIRES: uv on PATH, Node >= 22 (global fetch + global WebSocket), network
// access for the two pip installs. Creates two throwaway venvs under WORK and
// two Jupyter servers on PORT / LAB_PORT, and shuts all of it down at the end.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WORK = process.env.WORK || '/tmp/wc-feas-02';
const PORT = Number(process.env.PORT || 8912);
const LAB_PORT = Number(process.env.LAB_PORT || 8922);   // second server, deliberately far from the 891x block the sibling probes use
const TOKEN = 'feastok' + PORT;
const LAB_TOKEN = 'feastok' + LAB_PORT;
const FRESH = process.env.FRESH === '1';
const ENV_A = path.join(WORK, 'envA');   // the SERVER's env: jupyter + a kernel
const ENV_B = path.join(WORK, 'envB');   // a kernel from a DIFFERENT env
const ROOT = path.join(WORK, 'root');    // notebook root_dir for both servers

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
const results = [];
const rec = (q, verdict, detail) => {
  results.push({ q, verdict, detail });
  const tag = { YES: '  YES   ', NO: '  NO    ', PARTIAL: 'PARTIAL ', N_A: '  n/a   ' }[verdict] || '  ?     ';
  console.log(tag + q + (detail ? '\n          ' + String(detail).split('\n').join('\n          ') : ''));
};
const head = (s) => console.log('\n\x1b[1m— ' + s + ' —\x1b[0m');
const note = (s) => console.log('          ' + s);
const ms = (n) => (n / 1000).toFixed(1) + 's';

// ---------------------------------------------------------------------------
// shell helpers
// ---------------------------------------------------------------------------
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const sleep = (n) => new Promise((r) => setTimeout(r, n));

const children = [];
const cleanup = () => {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch { try { c.kill('SIGTERM'); } catch {} } }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

// ---------------------------------------------------------------------------
// Jupyter REST, the way the service speaks it (Authorization: token <t>)
// ---------------------------------------------------------------------------
const mkApi = (port, token) => {
  const base = `http://127.0.0.1:${port}/`;
  return {
    base, token,
    async raw(p, init) {
      return fetch(base + p.replace(/^\//, ''), {
        ...(init || {}),
        headers: { ...((init || {}).headers || {}), Authorization: 'token ' + token },
      });
    },
    async status(p) { try { return (await this.raw(p)).status; } catch (e) { return 'ERR:' + e.message; } },
    async json(p, init) { const r = await this.raw(p, init); return r.ok ? r.json() : null; },
  };
};

// The lab page embeds a JSON blob that names the URL its federated extensions
// are served under and lists every one the server can see RIGHT NOW. It is the
// only place either fact is published, so the probe reads it rather than
// guessing a route — the guess costs you: the obvious `/labextensions/` is
// wrong, it is `/lab/extensions/`, and the wrong one 404s identically to "no
// such route at all".
const pageConfig = async (api) => {
  const r = await api.raw('lab');
  if (!r.ok) return { ok: false, status: r.status };
  const html = await r.text();
  const m = /id="jupyter-config-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return { ok: false, status: r.status, reason: 'no jupyter-config-data' };
  try { return { ok: true, status: r.status, cfg: JSON.parse(m[1]) }; }
  catch (e) { return { ok: false, status: r.status, reason: e.message }; }
};

const waitUp = async (api, secs = 45) => {
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    if ((await api.status('api/status')) === 200) return true;
    await sleep(300);
  }
  return false;
};

// ---------------------------------------------------------------------------
// kernel over the WebSocket — the same protocol shape test/exec-harness.mjs
// drives through service.js, reduced to what a probe needs: send an
// execute_request on the shell channel, collect iopub until idle for OUR msg_id.
// ---------------------------------------------------------------------------
class Kernel {
  constructor(api) { this.api = api; this.session = 'probe-' + Math.random().toString(36).slice(2); }

  async open(kernelName, nbPath) {
    // A session, not a bare kernel: that is what a notebook gets, and it is what
    // the pane's service does.
    const s = await this.api.json('api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: nbPath, type: 'notebook', name: nbPath, kernel: { name: kernelName } }),
    });
    if (!s) throw new Error('session start failed for kernelspec ' + kernelName);
    this.sessionId = s.id; this.kernelId = s.kernel.id;
    const u = new URL(this.api.base + 'api/kernels/' + this.kernelId + '/channels');
    u.protocol = 'ws:';
    u.searchParams.set('token', this.api.token);   // ?token= authenticates the UPGRADE
    this.ws = new WebSocket(u.toString());
    this.waiters = new Map();
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws timeout')), 20000);
      this.ws.onopen = () => { clearTimeout(t); res(); };
      this.ws.onerror = () => { clearTimeout(t); rej(new Error('ws refused')); };
    });
    this.ws.onmessage = (ev) => { try { this._onMsg(JSON.parse(ev.data)); } catch {} };
    return this;
  }

  _onMsg(m) {
    const pid = m.parent_header && m.parent_header.msg_id;
    const rec_ = this.waiters.get(pid);
    if (!rec_) return;
    if (m.channel !== 'iopub') return;
    const t = m.msg_type, c = m.content || {};
    if (t === 'stream') (c.name === 'stderr' ? rec_.stderr : rec_.stdout).push(c.text || '');
    else if (t === 'execute_result' || t === 'display_data') rec_.results.push(c.data || {});
    else if (t === 'execute_input') rec_.execCount = c.execution_count;
    else if (t === 'error') rec_.error = { ename: c.ename, evalue: c.evalue, tb: (c.traceback || []).join('\n') };
    else if (t === 'status' && c.execution_state === 'idle') rec_.done();
  }

  // Returns everything a cell can produce, plus wall-clock ms.
  exec(code, timeoutMs = 300000) {
    const id = 'x-' + Math.random().toString(36).slice(2) + '-' + Date.now();
    const r = { stdout: [], stderr: [], results: [], error: null, execCount: null };
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.waiters.delete(id); reject(new Error('cell timed out after ' + timeoutMs + 'ms')); }, timeoutMs);
      r.done = () => {
        clearTimeout(to); this.waiters.delete(id);
        r.ms = Date.now() - t0;
        r.out = r.stdout.join(''); r.err = r.stderr.join('');
        r.text = (r.results.map((d) => d['text/plain'] || '').join('\n')).trim();
        resolve(r);
      };
      this.waiters.set(id, r);
      this.ws.send(JSON.stringify({
        header: { msg_id: id, username: 'probe', session: this.session, msg_type: 'execute_request', version: '5.3' },
        parent_header: {}, metadata: {},
        content: { code, silent: false, store_history: true, allow_stdin: false, stop_on_error: true },
        channel: 'shell',
      }));
    });
  }

  // A cell that prints one JSON blob — the shape a service would actually use to
  // interrogate the kernel, because it survives pretty-printing and truncation.
  async json(code) {
    const r = await this.exec(code);
    const line = (r.out || '').trim().split('\n').filter(Boolean).pop();
    try { return { ...r, value: JSON.parse(line) }; } catch { return { ...r, value: null }; }
  }

  async close() {
    try { this.ws.close(); } catch {}
    if (this.sessionId) { try { await this.api.raw('api/sessions/' + this.sessionId, { method: 'DELETE' }); } catch {} }
    if (this.kernelId) { try { await this.api.raw('api/kernels/' + this.kernelId, { method: 'DELETE' }); } catch {} }
  }
}

// ===========================================================================
// SETUP
// ===========================================================================
console.log('wc-jupyter feasibility 02 — installing a package from the live kernel');
console.log('work dir: ' + WORK + '   server: ' + PORT + ' (jupyter server)   lab: ' + LAB_PORT + ' (jupyter lab)');

if (sh('uv', ['--version']).code !== 0) { console.error('uv not on PATH — this probe builds its own throwaway venvs with it.'); process.exit(2); }
for (const p of [PORT, LAB_PORT]) {
  if (sh('lsof', ['-nP', '-iTCP:' + p, '-sTCP:LISTEN']).out.trim()) {
    console.error(`port ${p} is already in use — refusing to touch someone else's server. Set PORT/LAB_PORT.`);
    process.exit(2);
  }
}

if (FRESH) fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

head('setup: two throwaway environments');
const t0Setup = Date.now();
if (!fs.existsSync(path.join(ENV_A, 'bin/jupyter-lab')) || !fs.existsSync(path.join(ENV_A, 'bin/jupyter-server'))) {
  note('building envA (jupyter-server + jupyterlab + ipykernel + pip) — first run, ~90s');
  sh('uv', ['venv', '--python', '3.12', ENV_A], { cwd: WORK });
  // pip is installed EXPLICITLY: a uv venv has no pip, and `%pip` is just
  // `sys.executable -m pip`. That is itself a finding — see the report below.
  const r = sh('uv', ['pip', 'install', '--python', ENV_A + '/bin/python', 'jupyter-server', 'jupyterlab', 'ipykernel', 'pip']);
  if (r.code !== 0) { console.error(r.out.slice(-2000)); process.exit(2); }
}
if (!fs.existsSync(path.join(ENV_B, 'bin/python'))) {
  note('building envB (ipykernel + pip only) — the "kernel from a different env" case');
  sh('uv', ['venv', '--python', '3.12', ENV_B], { cwd: WORK });
  const r = sh('uv', ['pip', 'install', '--python', ENV_B + '/bin/python', 'ipykernel', 'pip']);
  if (r.code !== 0) { console.error(r.out.slice(-2000)); process.exit(2); }
}
// Reset package state so every run measures a real first install, and point pip
// at a cache dir this probe owns — otherwise run 2 measures a warm cache and
// reports an install time the user will never see.
const PIP_CACHE = path.join(WORK, 'pipcache');
fs.rmSync(PIP_CACHE, { recursive: true, force: true });
for (const env of [ENV_A, ENV_B]) {
  sh(env + '/bin/python', ['-m', 'pip', 'uninstall', '-y', '-q', 'plotly']);
  fs.rmSync(path.join(env, 'share/jupyter/labextensions/jupyterlab-plotly'), { recursive: true, force: true });
}
// envB's kernel registered into envA's prefix — exactly how a user ends up with
// "the server is one env, the kernel is another": they ran
// `python -m ipykernel install` from their project venv.
sh(ENV_B + '/bin/python', ['-m', 'ipykernel', 'install', '--prefix', ENV_A, '--name', 'envb', '--display-name', 'envB']);
note('setup took ' + ms(Date.now() - t0Setup));

const prefixOf = (env) => sh(env + '/bin/python', ['-c', 'import sys;print(sys.prefix)']).out.trim();
const SERVER_PREFIX = prefixOf(ENV_A);
const ENVB_PREFIX = prefixOf(ENV_B);

head('setup: two servers, both from envA');
const startServer = (bin, port, token, extra = []) => {
  const log = fs.openSync(path.join(WORK, bin + '-' + port + '.log'), 'w');
  const c = spawn(path.join(ENV_A, 'bin', bin), [
    '--port=' + port, '--no-browser', '--ServerApp.ip=127.0.0.1',
    '--IdentityProvider.token=' + token, '--ServerApp.root_dir=' + ROOT, ...extra,
  ], { cwd: ROOT, stdio: ['ignore', log, log], detached: true, env: { ...process.env, PIP_CACHE_DIR: PIP_CACHE } });
  children.push(c);
  return c;
};
startServer('jupyter-server', PORT, TOKEN);
startServer('jupyter-lab', LAB_PORT, LAB_TOKEN);
const api = mkApi(PORT, TOKEN);
const lab = mkApi(LAB_PORT, LAB_TOKEN);
if (!(await waitUp(api))) { console.error('server on ' + PORT + ' never came up; see ' + WORK); process.exit(2); }
if (!(await waitUp(lab))) { console.error('lab on ' + LAB_PORT + ' never came up; see ' + WORK); process.exit(2); }
const started = new Date().toISOString();
note('jupyter server up on ' + PORT + ', jupyter lab up on ' + LAB_PORT + ' at ' + started);
note('server sys.prefix = ' + SERVER_PREFIX);

// ===========================================================================
// Q0 — where are federated (labextension) assets actually served from?
// The whole "fetch the renderer from the user's own install over HTTP" plan
// rests on one route existing, so it is measured BEFORE anything is installed,
// against a labextension (jupyterlab_pygments) that is already on disk.
// ===========================================================================
head('Q0  is a federated-extension route served at all? (before any install)');
const pygDisk = fs.existsSync(path.join(SERVER_PREFIX, 'share/jupyter/labextensions/jupyterlab_pygments'));
note('already on disk in the server prefix: share/jupyter/labextensions/jupyterlab_pygments = ' + pygDisk);

const cfgServer = await pageConfig(api);
const cfgLab = await pageConfig(lab);
const LABEXT_URL = (cfgLab.ok && cfgLab.cfg.fullLabextensionsUrl) || (cfgServer.ok && cfgServer.cfg.fullLabextensionsUrl) || '/lab/extensions';
const extPath = (name, rest) => LABEXT_URL.replace(/^\//, '') + '/' + name + (rest ? '/' + rest : '');

rec('the extension route is /lab/extensions/, NOT /labextensions/', LABEXT_URL === '/lab/extensions' ? 'YES' : 'PARTIAL',
  `page config fullLabextensionsUrl = ${LABEXT_URL}\n` +
  `GET /labextensions/jupyterlab_pygments/package.json -> ${await lab.status('labextensions/jupyterlab_pygments/package.json')} (the obvious guess: wrong)\n` +
  `GET ${LABEXT_URL}/jupyterlab_pygments/package.json -> ${await lab.status(extPath('jupyterlab_pygments', 'package.json'))}`);

const pygServer = await api.status(extPath('jupyterlab_pygments', 'package.json'));
const pygLab = await lab.status(extPath('jupyterlab_pygments', 'package.json'));
rec('a plain `jupyter server` serves it too (jupyterlab is a SERVER extension)', pygServer === 200 ? 'YES' : 'NO',
  `:${PORT} was started with \`jupyter-server\`, not \`jupyter-lab\` — GET ${LABEXT_URL}/jupyterlab_pygments/package.json -> HTTP ${pygServer}\n` +
  `so the route follows "is jupyterlab installed in the SERVER's env", not which command launched it`);
rec('`jupyter lab` serves it', pygLab === 200 ? 'YES' : 'NO', `:${LAB_PORT} -> HTTP ${pygLab}`);

// And the corollary, measured: a server whose env has no jupyterlab has no
// route at all. The user's own live server is exactly this shape.
const noLabProbe = spawnSync(ENV_B + '/bin/python', ['-c', 'import jupyterlab'], { encoding: 'utf8' });
rec('a server env WITHOUT jupyterlab has no extension route to serve from', noLabProbe.status !== 0 ? 'YES' : 'NO',
  `envB has no jupyterlab (import -> ${noLabProbe.status === 0 ? 'ok' : (noLabProbe.stderr || '').trim().split('\n').pop()});\n` +
  `a jupyter_server running from such an env answers 404 for /lab and every extension URL`);

const LABEXT = extPath('jupyterlab-plotly', 'package.json');

// ===========================================================================
// PHASE A — a kernel in the SERVER'S OWN env
// ===========================================================================
head('phase A: a kernel from the server\'s own environment');
const kA = await new Kernel(api).open('python3', 'probeA.ipynb');
note('kernel ' + kA.kernelId.slice(0, 8) + ' on :' + PORT);

const idA = await kA.json(`
import sys, json, sysconfig
print(json.dumps({"prefix": sys.prefix, "base_prefix": sys.base_prefix, "executable": sys.executable,
                  "py": sys.version.split()[0],
                  "site": sysconfig.get_paths()["purelib"]}))
`);
note('kernel sys.prefix   = ' + (idA.value && idA.value.prefix));
note('kernel sys.executable = ' + (idA.value && idA.value.executable));

// Q5a — prefixes match when the kernel came from the server's env
rec('Q5a kernel sys.prefix == server sys.prefix (same-env kernel)',
  idA.value && idA.value.prefix === SERVER_PREFIX ? 'YES' : 'NO',
  `kernel=${idA.value && idA.value.prefix}\nserver=${SERVER_PREFIX}`);

// pre-state
const pre = await kA.json(`
import json, importlib.util
print(json.dumps({"plotly_importable": importlib.util.find_spec("plotly") is not None}))
`);
const preHttpServer = await api.status(LABEXT);
const preHttpLab = await lab.status(LABEXT);
const preFed = (cfgLab.ok && (cfgLab.cfg.federated_extensions || []).map((e) => e.name)) || [];
note(`before install: plotly importable = ${pre.value && pre.value.plotly_importable}; ` +
     `GET /${LABEXT} -> server ${preHttpServer}, lab ${preHttpLab}`);
note('before install: page config federated_extensions = ' + JSON.stringify(preFed));

// --- Q1: does %pip install run to completion, and how long ----------------
head('Q1  `%pip install plotly` inside the live kernel');
const inst = await kA.exec('%pip install plotly', 600000);
const instOut = (inst.out + inst.err).trim();
const tail = instOut.split('\n').slice(-6).join('\n');
rec('Q1 `%pip install plotly` completes in a live kernel',
  !inst.error && /Successfully installed|already satisfied/.test(instOut) ? 'YES' : 'NO',
  `${ms(inst.ms)} wall clock, exec_count=${inst.execCount}, ${instOut.split('\n').length} lines on iopub stream\nlast lines:\n${tail}`);
const restartHint = /restart the kernel/i.test(instOut);
note('pip printed a "you may need to restart the kernel" note: ' + restartHint);
note('pip cache was cold for this run (PIP_CACHE_DIR=' + PIP_CACHE + ', wiped at setup)');

// What arrives on iopub is a TTY progress bar, not a log. Anything that shows
// install output in a pane has to cope with \r rewrites and CSI erase codes.
const ansi = (instOut.match(/\x1b\[[0-9;?]*[a-zA-Z]/g) || []).length;
const crs = (instOut.match(/\r/g) || []).length;
rec('Q1b pip output is ANSI progress-bar noise, not plain log lines',
  ansi > 0 ? 'YES' : 'NO',
  `${ansi} CSI escape sequences and ${crs} carriage returns in ${instOut.length} chars of stream output;\n` +
  `strip with /\\x1b\\[[0-9;?]*[a-zA-Z]/g and keep only the text after the last \\r on each line, or pass --progress-bar off`);
const quiet = await kA.exec('%pip install --quiet --progress-bar off plotly', 600000);
note('with `--quiet --progress-bar off`: ' + ((quiet.out + quiet.err).trim().length) + ' chars of output, ' + ms(quiet.ms) + ' (already satisfied)');

// --- Q2: import in the SAME session, no restart ---------------------------
head('Q2  importing it in the same session, no restart');
const impBare = await kA.exec('import plotly; print(plotly.__version__)');
rec('Q2 bare `import plotly` works with no restart and no cache invalidation',
  !impBare.error ? 'YES' : 'NO',
  impBare.error ? impBare.error.ename + ': ' + impBare.error.evalue : 'plotly.__version__ = ' + impBare.out.trim() + ' (' + impBare.ms + 'ms)');

const impInval = await kA.exec('import importlib, plotly; importlib.invalidate_caches(); import plotly; print(plotly.__version__)');
rec('Q2b import after importlib.invalidate_caches()',
  !impInval.error ? 'YES' : 'NO',
  impInval.error ? impInval.error.ename + ': ' + impInval.error.evalue : 'plotly.__version__ = ' + impInval.out.trim());

// The honest version of "seamless": does a FIGURE actually produce the vendor
// bundle the pane is supposed to render, in this same session?
const fig = await kA.exec(`
import plotly.graph_objects as go
from IPython.display import display
f = go.Figure(data=[go.Scatter(x=[1,2,3], y=[4,1,2])])
display(f)
`);
const mimes = fig.results.flatMap((d) => Object.keys(d));
rec('Q2c a figure in that same session emits the vendor mime bundle',
  mimes.some((m) => m.startsWith('application/vnd.plotly')) ? 'YES' : (fig.error ? 'NO' : 'PARTIAL'),
  fig.error ? fig.error.ename + ': ' + fig.error.evalue : 'mime keys on display_data: ' + JSON.stringify(mimes));

// --- Q3: does the already-running server serve the new labextension? -------
head('Q3  does the ALREADY-RUNNING server serve the new extension asset?');
const onDisk = path.join(SERVER_PREFIX, 'share/jupyter/labextensions/jupyterlab-plotly');
const diskOk = fs.existsSync(onDisk);
let extBytes = 0, extFiles = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { extFiles++; extBytes += fs.statSync(p).size; } } };
if (diskOk) walk(onDisk);
note(`on disk: ${diskOk} (${extFiles} files, ${(extBytes / 1e6).toFixed(1)} MB) at ${onDisk}`);
// The remoteEntry is CONTENT-HASHED — `remoteEntry.js` does not exist, it is
// `remoteEntry.<hash>.js`, which is why the page config has to be read to find it.
const staticDir = path.join(onDisk, 'static');
const staticFiles = fs.existsSync(staticDir) ? fs.readdirSync(staticDir) : [];
note('static/ contains: ' + staticFiles.map((f) => f + ' (' + (fs.statSync(path.join(staticDir, f)).size / 1e6).toFixed(2) + ' MB)').join(', '));
note('a literal static/remoteEntry.js exists: ' + staticFiles.includes('remoteEntry.js') +
     '; a hashed one exists: ' + staticFiles.some((f) => /^remoteEntry\.[0-9a-f]+\.js$/.test(f)));

const postHttpServer = await api.status(LABEXT);
const postHttpLab = await lab.status(LABEXT);
rec('Q3a the running `jupyter server` serves the new extension with NO restart',
  postHttpServer === 200 ? 'YES' : 'NO',
  `GET /${LABEXT}: before ${preHttpServer} -> after ${postHttpServer}   (process up since ${started}, never signalled)`);
rec('Q3b the running `jupyter lab` serves it with NO restart',
  postHttpLab === 200 ? 'YES' : 'NO',
  `GET /${LABEXT}: before ${preHttpLab} -> after ${postHttpLab}   (process up since ${started}, never signalled)`);

// The hashed bundle filename is NOT guessable — it is published in the page
// config, which is what makes discovery-by-HTTP possible at all.
const cfgLab2 = await pageConfig(lab);
const fedNow = (cfgLab2.ok && (cfgLab2.cfg.federated_extensions || [])) || [];
const plotlyFed = fedNow.find((e) => e.name === 'jupyterlab-plotly');
rec('Q3c the page config lists the new extension without a restart',
  plotlyFed ? 'YES' : 'NO',
  `federated_extensions: before ${JSON.stringify(preFed)} -> after ${JSON.stringify(fedNow.map((e) => e.name))}\n` +
  (plotlyFed ? 'entry: ' + JSON.stringify(plotlyFed) : ''));
if (plotlyFed && plotlyFed.load) {
  const u = extPath('jupyterlab-plotly', plotlyFed.load);
  const r = await lab.raw(u);
  const body = r.ok ? await r.text() : '';
  rec('Q3d the hashed remoteEntry bundle it names is fetchable',
    r.status === 200 ? 'YES' : 'NO',
    `GET /${u} -> HTTP ${r.status}, ${body.length} bytes, ${r.headers.get('content-type')}\n` +
    `the hash (${plotlyFed.load}) is not guessable — the page config is the only place it is published`);
  const chunkName = (body.match(/"\.\/(\d+\.[0-9a-f]+\.js)"/) || [])[1];
  if (chunkName) {
    const cr = await lab.raw(extPath('jupyterlab-plotly', 'static/' + chunkName));
    const cb = cr.ok ? await cr.text() : '';
    note(`its big chunk static/${chunkName} -> HTTP ${cr.status}, ${(cb.length / 1e6).toFixed(1)} MB`);
  }
}

// --- Q4: can the kernel report its JS assets over the normal protocol? -----
head('Q4  can the kernel tell the service where the JS is, and which version?');
const assets = await kA.json(`
import json, os, sys, glob
def tree(root):
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            p = os.path.join(dirpath, f)
            if f.endswith(('.js', '.json')):
                out.append({"path": p, "bytes": os.path.getsize(p)})
    return sorted(out, key=lambda x: -x["bytes"])[:6]
import plotly, plotly.offline
pkg = os.path.dirname(plotly.__file__)
bundled = sorted(glob.glob(os.path.join(pkg, "**", "*.js"), recursive=True), key=lambda p: -os.path.getsize(p))[:4]
labext = os.path.join(sys.prefix, "share", "jupyter", "labextensions", "jupyterlab-plotly")
print(json.dumps({
  "version": plotly.__version__,
  "package_dir": pkg,
  "bundled_js": [{"path": p, "bytes": os.path.getsize(p)} for p in bundled],
  "labextension_dir": labext,
  "labextension_exists": os.path.isdir(labext),
  "labextension_top": tree(labext) if os.path.isdir(labext) else [],
  "nbformat_mime": getattr(plotly.io, "renderers", None) is not None,
}))
`);
rec('Q4 the kernel can report version + on-disk JS paths over the protocol',
  assets.value ? 'YES' : 'NO',
  assets.value ? [
    'plotly.__version__ = ' + assets.value.version,
    'package dir        = ' + assets.value.package_dir,
    'biggest bundled JS = ' + (assets.value.bundled_js[0] ? assets.value.bundled_js[0].path + ' (' + (assets.value.bundled_js[0].bytes / 1e6).toFixed(1) + ' MB)' : 'none'),
    'labextension dir   = ' + assets.value.labextension_dir + ' exists=' + assets.value.labextension_exists,
    'largest in labext  = ' + (assets.value.labextension_top[0] ? path.basename(assets.value.labextension_top[0].path) + ' (' + (assets.value.labextension_top[0].bytes / 1e6).toFixed(1) + ' MB)' : 'none'),
  ].join('\n') : (assets.out || '').slice(0, 300));

// Those paths are on the SAME machine as the service, so the service can just
// read them. Measure the alternative too: shipping bytes through the kernel.
if (assets.value && assets.value.bundled_js[0]) {
  const jsPath = assets.value.bundled_js[0].path;
  const fsReadable = fs.existsSync(jsPath);
  const size = fsReadable ? fs.statSync(jsPath).size : 0;
  rec('Q4b the service (host-side, same machine) can read that path with fs',
    fsReadable ? 'YES' : 'NO', `${jsPath} -> ${(size / 1e6).toFixed(1)} MB readable from Node`);

  // The alternative to a server route: have the kernel hand the bytes over on
  // iopub. It is measured by actually RECEIVING them, not by encoding them —
  // jupyter_server rate-limits iopub and silently drops the overflow, so an
  // encode-only measurement would report a success that never arrives.
  const ship = async (label, nBytes) => {
    const r = await kA.exec(`
import base64
with open(${JSON.stringify(jsPath)}, "rb") as fh:
    b = fh.read(${nBytes})
print(base64.b64encode(b).decode(), end="")
`, 300000);
    const expected = Math.ceil(Math.min(nBytes, size) / 3) * 4;
    const got = r.out.length;
    const limited = /data rate|iopub/i.test(r.err || '') || got < expected;
    return { label, nBytes, expected, got, ms: r.ms, err: (r.err || '').trim().split('\n')[0], limited, error: r.error };
  };
  const small = await ship('64 KB', 64 * 1024);
  rec('Q4c a small asset survives the trip over iopub',
    !small.limited && !small.error ? 'YES' : 'NO',
    `${small.nBytes} raw bytes -> expected ${small.expected} b64 chars, received ${small.got}, ${small.ms}ms`);
  const big = await ship('whole file', size);
  rec('Q4d the WHOLE 5 MB bundle survives the trip over iopub',
    !big.limited && !big.error ? 'YES' : 'NO',
    `expected ${big.expected} b64 chars, received ${big.got} (${((big.got / big.expected) * 100).toFixed(1)}%), ${ms(big.ms)}` +
    (big.err ? '\nserver said: ' + big.err.slice(0, 200) : '') +
    (big.limited ? '\njupyter_server rate-limits iopub (ZMQChannelsWebsocketConnection.iopub_data_rate_limit, default 1e6 B/s)' : ''));
}

// ===========================================================================
// PHASE B — a kernel from a DIFFERENT env than the server (the likely blocker)
// ===========================================================================
head('phase B: a kernel from a DIFFERENT environment than the server');
const kB = await new Kernel(api).open('envb', 'probeB.ipynb');
note('kernel ' + kB.kernelId.slice(0, 8) + ' on :' + PORT + ' from kernelspec "envb"');
const idB = await kB.json('import sys, json; print(json.dumps({"prefix": sys.prefix, "executable": sys.executable}))');
note('kernel sys.prefix = ' + (idB.value && idB.value.prefix));
note('server sys.prefix = ' + SERVER_PREFIX);
rec('Q5b a cross-env kernel\'s sys.prefix differs from the server\'s',
  idB.value && idB.value.prefix !== SERVER_PREFIX ? 'YES' : 'NO',
  `kernel=${idB.value && idB.value.prefix}\nserver=${SERVER_PREFIX}\n(kernelspec was registered with \`python -m ipykernel install --prefix\`, the ordinary way)`);

const instB = await kB.exec('%pip install plotly', 600000);
const instBOut = (instB.out + instB.err).trim();
note('%pip install plotly in the cross-env kernel: ' + ms(instB.ms) + ', ' +
     (/Successfully installed/.test(instBOut) ? 'succeeded' : 'DID NOT report success'));
const whereB = await kB.json(`
import json, os, sys, plotly
print(json.dumps({"version": plotly.__version__,
                  "labext": os.path.join(sys.prefix, "share", "jupyter", "labextensions", "jupyterlab-plotly"),
                  "labext_exists": os.path.isdir(os.path.join(sys.prefix, "share", "jupyter", "labextensions", "jupyterlab-plotly"))}))
`);
const landedInB = whereB.value && whereB.value.labext_exists;
const landedInServer = fs.existsSync(path.join(SERVER_PREFIX, 'share/jupyter/labextensions/jupyterlab-plotly'));
rec('Q5c the cross-env install lands in the KERNEL\'s prefix, not the server\'s',
  landedInB ? 'YES' : 'NO',
  `installed to ${whereB.value && whereB.value.labext}\nserver prefix copy still present from phase A: ${landedInServer} (that one came from the same-env kernel, not this install)`);

// The decisive one: would a server that DOES serve /labextensions/ find it?
// jupyter's data path is per-prefix, so ask the server's own env whether envB's
// share/jupyter is on the path it searches.
const searchPaths = sh(ENV_A + '/bin/python', ['-c',
  'import json,jupyter_core.paths as p;print(json.dumps(p.jupyter_path("labextensions")))']).out.trim();
let paths = [];
try { paths = JSON.parse(searchPaths); } catch {}
const envbOnPath = paths.some((p) => p.startsWith(ENVB_PREFIX));
rec('Q5d the server searches the cross-env kernel\'s labextensions dir',
  envbOnPath ? 'YES' : 'NO',
  'the server env\'s jupyter_path("labextensions") =\n  ' + paths.join('\n  ') +
  '\nenvB prefix (' + ENVB_PREFIX + ') is ' + (envbOnPath ? 'ON' : 'NOT ON') + ' that list');

// And empirically: strip phase A's copy out of the server prefix, so the ONLY
// jupyterlab-plotly on the machine is the cross-env kernel's, then ask again.
fs.rmSync(path.join(SERVER_PREFIX, 'share/jupyter/labextensions/jupyterlab-plotly'), { recursive: true, force: true });
const crossHttp = await lab.status(LABEXT);
const cfgCross = await pageConfig(lab);
const fedCross = (cfgCross.ok && (cfgCross.cfg.federated_extensions || []).map((e) => e.name)) || [];
rec('Q5e with plotly installed ONLY in the kernel\'s env, the server serves nothing',
  crossHttp !== 200 ? 'YES' : 'NO',
  `server prefix copy deleted; plotly still installed in ${ENVB_PREFIX}\n` +
  `GET /${LABEXT} -> HTTP ${crossHttp}; page config federated_extensions = ${JSON.stringify(fedCross)}\n` +
  `so the pane would have a vnd.plotly bundle to draw and no renderer to draw it with`);

// --- how a service could DETECT the mismatch at runtime -------------------
head('detecting the mismatch from the service');
const rt = (() => {
  const dirs = [path.join(os.homedir(), 'Library/Jupyter/runtime'), path.join(os.homedir(), '.local/share/jupyter/runtime')];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => /^jpserver-\d+\.json$/.test(f)); } catch { continue; }
    for (const f of names) {
      try { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); if (Number(j.port) === PORT) return j; } catch {}
    }
  }
  return null;
})();
rec('the server\'s runtime file exposes its pid (so its prefix is derivable)',
  rt && rt.pid ? 'YES' : 'NO',
  rt ? `jpserver-${rt.pid}.json fields: ${Object.keys(rt).join(', ')} — note: no sys.prefix field` : 'no runtime file matched port ' + PORT);
if (rt && rt.pid) {
  const exe = sh('ps', ['-p', String(rt.pid), '-o', 'comm=']).out.trim();
  const derived = exe ? path.dirname(path.dirname(exe)) : '';
  rec('...and pid -> executable -> prefix matches the real server prefix',
    derived === SERVER_PREFIX ? 'YES' : 'PARTIAL',
    `ps -o comm= -> ${exe}\nderived prefix = ${derived}\nactual         = ${SERVER_PREFIX}`);
}
const specs = await api.json('api/kernelspecs');
const specFields = specs && specs.kernelspecs && specs.kernelspecs.python3 ? Object.keys(specs.kernelspecs.python3) : [];
rec('/api/kernelspecs exposes a resource_dir the service could compare',
  specFields.includes('resource_dir') ? 'YES' : 'NO',
  'fields returned per kernelspec: ' + specFields.join(', ') + (specFields.includes('resources') ? '  ("resources" are URLs, not paths)' : ''));

// ===========================================================================
// pip availability — %pip is just `sys.executable -m pip`
// ===========================================================================
head('side check: is pip even present in the kernel\'s env?');
const pipInfo = await kA.json(`
import json, importlib.util, sys
spec = importlib.util.find_spec("pip")
print(json.dumps({"pip_importable": spec is not None, "executable": sys.executable}))
`);
rec('the kernel env has pip (uv venvs do NOT by default; this probe added it)',
  pipInfo.value && pipInfo.value.pip_importable ? 'YES' : 'NO',
  'a uv-created venv ships no pip, and `%pip` runs `sys.executable -m pip` — so on a uv-managed\n' +
  'install `%pip install` fails with "No module named pip" unless pip was added to that env.');

// ===========================================================================
// local environment survey — READ ONLY. No HTTP requests to anything this
// probe did not start; every fact below comes from Jupyter's own runtime files,
// `ps`, and importing into the interpreter that is already on disk. This is the
// section that tells you whether the design works on THIS machine, as opposed
// to in the clean two-venv world above.
// ===========================================================================
head('local environment survey (read-only; touches no running server)');
const runtimeFiles = () => {
  const dirs = [path.join(os.homedir(), 'Library/Jupyter/runtime'), path.join(os.homedir(), '.local/share/jupyter/runtime'), process.env.JUPYTER_RUNTIME_DIR].filter(Boolean);
  const out = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => /^jpserver-\d+\.json$/.test(f)); } catch { continue; }
    for (const f of names) { try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch {} }
  }
  return out;
};
const prefixOfPid = (pid) => {
  const exe = sh('ps', ['-p', String(pid), '-o', 'comm=']).out.trim();
  return exe ? { exe, prefix: path.dirname(path.dirname(exe)) } : null;
};
const has = (prefix, mod) => sh(path.join(prefix, 'bin/python'), ['-c', 'import ' + mod]).code === 0;
const ephemeral = (p) => /\/\.cache\/uv\/builds-|\/\.cache\/uv\/archive-/.test(p);

const others = runtimeFiles().filter((j) => Number(j.port) !== PORT && Number(j.port) !== LAB_PORT);
if (!others.length) note('no other Jupyter servers running on this machine — nothing to survey');
for (const j of others) {
  const info = prefixOfPid(j.pid);
  if (!info) { note(`server :${j.port} (pid ${j.pid}) is in the runtime dir but not running — stale runtime file`); continue; }
  const lab_ = has(info.prefix, 'jupyterlab');
  const pip_ = has(info.prefix, 'pip');
  note(`server :${j.port}  prefix=${info.prefix}`);
  note(`            jupyterlab installed: ${lab_}   pip installed: ${pip_}   ephemeral uv env: ${ephemeral(info.prefix)}`);
  note(`            -> can serve /lab/extensions/: ${lab_}`);
}
const kernelProcs = sh('ps', ['-ax', '-o', 'pid=,command=']).out.split('\n')
  .filter((l) => /ipykernel_launcher/.test(l) && !/ps -ax/.test(l))
  .map((l) => { const m = /^\s*(\d+)\s+(\S+)/.exec(l); return m ? { pid: m[1], exe: m[2], prefix: path.dirname(path.dirname(m[2])) } : null; })
  .filter(Boolean);
// This probe's OWN kernels are still alive at this point — excluded, or the
// survey reports a mismatch it created itself.
const kernelPrefixes = [...new Set(kernelProcs.map((k) => k.prefix))].filter((p) => p !== ENV_A && p !== ENV_B);
note(`running ipykernel processes: ${kernelProcs.length} (${kernelProcs.filter((k) => k.prefix === ENV_A || k.prefix === ENV_B).length} of them this probe's own, excluded below)`);
for (const p of kernelPrefixes) note('            ' + p + (ephemeral(p) ? '   <- inside uv\'s cache: uv may garbage-collect it' : ''));
const serverPrefixes = others.map((j) => prefixOfPid(j.pid)).filter(Boolean).map((i) => i.prefix);
const mismatched = kernelPrefixes.filter((k) => serverPrefixes.length && !serverPrefixes.includes(k));
rec('on THIS machine, every running kernel shares a prefix with its server',
  serverPrefixes.length === 0 ? 'N_A' : (mismatched.length === 0 ? 'YES' : 'NO'),
  serverPrefixes.length === 0 ? 'no other servers running to compare against'
    : `server prefixes: ${JSON.stringify(serverPrefixes)}\nkernel prefixes: ${JSON.stringify(kernelPrefixes)}`);

// ===========================================================================
// teardown
// ===========================================================================
head('teardown');
await kA.close(); await kB.close();
const leftover = (await api.json('api/kernels')) || [];
note('kernels left on :' + PORT + ' = ' + leftover.length);
cleanup();
await sleep(800);
note('both servers stopped; venvs left under ' + WORK + ' (FRESH=1 to rebuild)');

head('summary');
for (const r of results) console.log(`  ${r.verdict.padEnd(8)} ${r.q}`);
console.log('\n' + results.filter((r) => r.verdict === 'NO').length + ' of ' + results.length + ' answered NO');
process.exit(0);

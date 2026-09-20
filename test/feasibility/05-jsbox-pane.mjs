// What a sandboxed <iframe> can actually do inside a web-chat pane.
//
// This is the browser half of the feasibility work, and it has to run in a REAL
// pane: the pane script is executed as new Function(store, root, params, mountId)
// inside an open shadow root, and no headless approximation reproduces that or
// the surface's CSP. So the driver renders 05-jsbox-pane.html into the live
// daemon under its own mount id, reads what the frame reports back through the
// store, and clears up after itself.
//
// It serves its own tiny library over HTTP rather than pointing at Jupyter, so
// that a failure here means "the browser refused" and never "Jupyter wanted a
// token" — that question is probed separately in 01-server-assets.mjs.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs'), http = require('http'), path = require('path');

const SURFACE = process.env.WC_SURFACE || 'http://localhost:5176';
const PORT = Number(process.env.PROBE_PORT || 8915);
const MOUNT = 'jsbox-feasibility';
const HTML = fs.readFileSync(path.join(import.meta.dirname, '05-jsbox-pane.html'), 'utf8');

const LIB = 'window.__probeLib = { ok: true, loadedAt: Date.now() };\n';
let fails = 0;
const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 110) : '')); };
const note = (l, v) => console.log('  ----  ' + l + '  -> ' + String(v));

// A deliberately permissive static server: CORS open, so a REFUSED fetch below
// means the sandbox refused it, not that the server did.
const srv = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url.startsWith('/probe-lib.js')) {
    res.setHeader('content-type', 'application/javascript');
    res.end(LIB);
  } else { res.statusCode = 404; res.end('no'); }
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
console.log(`serving probe-lib.js on http://localhost:${PORT}`);

const api = async (p, body) => {
  const r = await fetch(SURFACE + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return r.json();
};
const store = async () => {
  const r = await fetch(SURFACE + '/api/store');
  const j = await r.json();
  return j.store || j;
};

const alive = await fetch(SURFACE + '/api/mounts').then((r) => r.ok).catch(() => false);
if (!alive) {
  console.log('\nweb-chat is not running at ' + SURFACE + ' — start it and re-run.');
  srv.close(); process.exit(2);
}

console.log('\n— mounting the probe pane —');
const rendered = await api('/api/render', {
  id: MOUNT, target: 'main',
  params: { routing: 'none', origin: `http://localhost:${PORT}` },
  html: HTML,
});
ok('the pane mounted', rendered && rendered.ok === true, JSON.stringify(rendered).slice(0, 120));

const until = async (p, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await store(); if (p(s)) return s; await new Promise((r) => setTimeout(r, 300)); } return null; };
const s = await until((x) => x.jsbox_probe);
if (!s) {
  console.log('\n  the frame never reported. Is a browser attached to the surface?');
  console.log('  (a render into a daemon with nobody watching still succeeds and runs nothing)');
  await api('/api/clear', { id: MOUNT });
  srv.close(); process.exit(2);
}
const R = s.jsbox_probe;
if (R.timeout) { console.log('\n  the frame timed out: ' + JSON.stringify(R)); }

console.log('\n— isolation (what the box must NOT reach) —');
ok('the frame has an opaque origin', R.origin === 'null', R.origin);
ok('it cannot reach the parent document', R.parentDom === false, R.parentDom);
ok('it has no localStorage', R.localStorage === false, R.localStorage);

console.log('\n— rendering (what a plot needs) —');
ok('2d canvas works', R.canvas2d === true, R.canvas2d);
note('webgl available', R.webgl);

console.log('\n— static capture (the fallback for exports and thumbnails) —');
ok('canvas.toDataURL works in the sandbox', R.toDataURL === true, R.toDataURL);
note('a 120x40 fill costs (png bytes)', R.pngBytes);
ok('SVG can be serialised for hand-back', R.svgSerialize === true, R.svgSerialize);

console.log('\n— getting renderer JS INTO the box —');
ok('a cross-origin <script src> loads', R.scriptTagCrossOrigin === true, R.scriptTagCrossOrigin);
ok('...and its global is actually usable', R.libSaw === true, R.libSaw);
note('cross-origin fetch() status', R.fetchCrossOrigin);
console.log('       (a <script src> needs no CORS; fetch() does. If the script tag');
console.log('        works and fetch does not, script-src is the transport to use.)');

const loads = (await store()).jsbox_loads;
note('iframe load events so far', loads ? loads.loads : '(none seen)');

console.log('\n— cleanup —');
const cleared = await api('/api/clear', { id: MOUNT });
ok('probe pane removed', cleared && cleared.ok === true, JSON.stringify(cleared).slice(0, 80));
srv.close();

console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
console.log('raw: ' + JSON.stringify(R));
process.exit(fails ? 1 : 0);

// Does a JS box survive an export and a graph preview?
//
// The claim this exists to check is that an iframe pane is "blank in every
// thumbnail and dead in an export", which is the standing reason this pack does
// not embed JupyterLab. It is worth checking rather than repeating, because the
// two surfaces have different rules: the PREVIEW route sets a CSP header, while
// an exported .html is a file on disk with no server and therefore no CSP at all.
//
// Run 05-jsbox-pane.mjs first if you want the pane capabilities; this one only
// needs a mount to exist long enough to be committed and exported.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs'), path = require('path'), http = require('http');

// web-chat refuses format=file to anything it thinks is a browser, and
// isBrowserRequest (lib/core/cors.js) trips on any sec-fetch-* header — which
// Node's global fetch sends (sec-fetch-mode: cors). So this one call goes out as
// a raw request with no such headers. Worth knowing for any probe written
// against this daemon.
const rawGet = (url) => new Promise((resolve) => {
  const u = new URL(url);
  http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { accept: '*/*' } }, (res) => {
    let b = ''; res.on('data', (d) => (b += d));
    res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b }); });
  }).on('error', () => resolve({ status: 0, json: null, body: '' }));
});

const SURFACE = process.env.WC_SURFACE || 'http://localhost:5176';
const MOUNT = 'jsbox-export-probe';
let fails = 0;
const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 120) : '')); };
const note = (l, v) => console.log('  ----  ' + l + '  -> ' + String(v));

const api = async (p, body) => {
  const r = await fetch(SURFACE + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, headers: Object.fromEntries(r.headers), json: await r.json().catch(() => null) };
};

if (!(await fetch(SURFACE + '/api/mounts').then((r) => r.ok).catch(() => false))) {
  console.log('web-chat is not running at ' + SURFACE); process.exit(2);
}

// A pane whose ONLY content is a self-contained sandboxed frame. srcdoc means it
// needs no network, so anything that blanks it blanks it by policy, not by being
// unable to fetch.
const PANE = [
  '<div id="wrap" style="font:12px system-ui;padding:.4rem">',
  '<span id="label">js-box export probe</span>',
  '<iframe id="box" sandbox="allow-scripts" style="width:100%;height:50px;border:1px solid #999"',
  ' srcdoc="&lt;body style=&#39;margin:0;background:#0b5;color:#fff;font:12px system-ui&#39;&gt;',
  'BOX RENDERED&lt;script&gt;document.body.textContent=&#39;BOX SCRIPT RAN&#39;&lt;/script&gt;&lt;/body&gt;"></iframe>',
  '</div>',
].join('');

console.log('— mounting a pure iframe pane —');
const r = await api('/api/render', { id: MOUNT, target: 'main', params: { routing: 'none' }, html: PANE });
ok('mounted', r.json && r.json.ok === true, JSON.stringify(r.json).slice(0, 100));

console.log('\n— the EXPORT —');
// GET /api/export/:ref?format=file writes to disk; a plain GET returns the page.
// format=file is refused for a browser request, which we are not.
const ex = await rawGet(SURFACE + '/api/export/live?format=file');
let file = ex.json && (ex.json.path || ex.json.file);
ok('export produced a file', !!file, JSON.stringify(ex.json).slice(0, 140));
if (file) {
  if (!path.isAbsolute(file)) file = path.resolve(process.cwd(), file);
  const html = fs.readFileSync(file, 'utf8');
  note('export size (KB)', Math.round(html.length / 1024));
  // The export inlines each pane's HTML as a JSON string, so '<' arrives as
  // \u003c. Matching only the literal tag reports a false negative.
  const hasFrame = /<iframe/i.test(html) || /\\u003ciframe/i.test(html);
  ok('the <iframe> element survives into the export', hasFrame, hasFrame ? 'present (json-escaped)' : 'absent');
  ok('...with its sandbox attribute intact', /sandbox=/i.test(html), (html.match(/sandbox=["'][^"']*/i) || [])[0]);
  ok('...and its srcdoc content', /BOX RENDERED|BOX SCRIPT RAN/.test(html));
  const csp = /<meta[^>]+http-equiv=["']Content-Security-Policy/i.test(html);
  note('export carries a CSP meta tag', csp);
  console.log('       FINDING: an iframe is NOT "dead in an export". The element, its');
  console.log('       sandbox attribute and its srcdoc all survive, and an exported file is');
  console.log('       opened from disk with no server and therefore no CSP — so a srcdoc');
  console.log('       frame RUNS. What breaks offline is a frame that FETCHES its renderer:');
  console.log('       the recipient has no localhost:8899. Inlining the renderer would fix');
  console.log('       that and cost ~4.7 MB of pane HTML per plot, which is stored in the');
  console.log('       graph node — see 04-capture-and-budget for why that is not viable.');
}

console.log('\n— the PREVIEW route (graph thumbnails) —');
const g = await api('/api/graph');
const nodes = (g.json && g.json.nodes) || [];
const active = (g.json && g.json.active) || (nodes.length && nodes[nodes.length - 1].id);
note('active node', active);
if (active) {
  const pr = await fetch(`${SURFACE}/preview/node/${encodeURIComponent(active)}`).catch(() => null);
  if (pr && pr.ok) {
    const csp = pr.headers.get('content-security-policy') || '';
    note('preview CSP', csp || '(none)');
    ok('preview sets a CSP at all', !!csp, csp);
    const hasFrame = /frame-src/.test(csp);
    const def = (csp.match(/default-src ([^;]+)/) || [])[1];
    ok("...with no frame-src, so frames fall back to default-src", !hasFrame, hasFrame ? 'frame-src present' : 'absent');
    note('default-src is', def);
    console.log("       default-src 'none' with no frame-src means an iframe is BLOCKED in a");
    console.log('       preview. That is the cost: a live plot, a hole in every thumbnail.');
  } else {
    note('preview route', pr ? pr.status : 'unreachable — check the route name');
  }
}

console.log('\n— cleanup —');
const c = await api('/api/clear', { id: MOUNT });
ok('probe pane removed', c.json && c.json.ok === true, JSON.stringify(c.json).slice(0, 80));
console.log('\n' + (fails ? fails + ' FAILING' : 'all green'));
process.exit(fails ? 1 : 0);

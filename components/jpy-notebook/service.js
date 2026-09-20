// Host-side service for the jpy-notebook component — the only service in
// wc-jupyter. Two halves, and they are independent:
//
//   READ  — an .ipynb is JSON (nbformat v4), so the whole read half is
//           JSON.parse plus a switch on cell_type. No Python, no Jupyter, no
//           npm. A notebook with no kernel still renders completely.
//   RUN   — the Jupyter Server REST + WebSocket kernel protocol, spoken with
//           Node's global fetch and global WebSocket (Node >= 22). Zero
//           dependencies, which is mandatory: a component installs exactly four
//           files and nothing resolves from node_modules here.
//
// THIS SERVICE WRITES NOTEBOOK FILES. That is the blast radius of the trust
// approval it asks for, and it is stated first because the approval prompt is
// the user's consent moment:
//   - it READS the .ipynb paths named in `params`;
//   - it WRITES those same files, but only ever through the Jupyter contents
//     API of a server the user is already running, never by writing the file
//     directly, and only ever the `source` of cells — outputs and every other
//     field are round-tripped from the originally parsed notebook untouched;
//   - it opens a socket to that Jupyter server and can execute code on its
//     kernel, which is the user's own interpreter with the user's permissions.
// A notebook held truncated is refused for both saving and running rather than
// written back, and a save is refused outright when the file changed on disk.
//
// WHY THE TOKEN IS NOT A PARAM AND NOT A CONTROL VALUE
// ----------------------------------------------------
// The pane's only channel to this service is the shared store, and the store is
// copied into every committed graph node, echoed into the event ring, and
// re-sent on every WS hello. A token typed into a pane and written to `jpy_ctl`
// would therefore be persisted to disk in the graph. It is also wrong as a
// param, because params are part of the trust fingerprint — a new token would
// re-prompt `claude-web-chat trust` in the terminal every time it rotated.
//
// So neither. This service DISCOVERS running servers from Jupyter's own runtime
// directory (the `jpserver-*.json` files behind `jupyter server list`), keeps
// the tokens host-side, and publishes only a url + a label. The pane connects by
// INDEX. No secret ever enters the store.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Ops that are safe to replay after a respawn or a node navigation, because they
// only change what is being LOOKED AT. Everything else (run, run-all, restart,
// interrupt) mutates kernel state and is refused below the start-time floor.
// Ops safe to replay after a respawn or a node navigation, because they only
// change what is being LOOKED AT. `connect` is deliberately NOT here: it shared
// a case body with `discover`, so a persisted {op:'discover', index:N} replayed
// above the start-time floor on every respawn — silently re-anchoring which
// server was connected AND starting a kernel that nothing ever deleted.
const VIEW_OPS = new Set(['set-tab', 'reload', 'discover', 'browse', 'open']);

// Per-cell output budget. The store is snapshotted into every committed node, so
// this is a hard cap rather than an advisory one — and when it bites, the pane
// is told it bit rather than silently showing less than the kernel produced.
const MAX_OUT_BYTES = 256 * 1024;   // per cell, across all its outputs
const MAX_STREAM_CHARS = 40000;     // per cell, stdout+stderr combined
const KERNEL_WATCH_MS  = 10000;     // how often to ask whether a running cell's kernel still exists
// PER CELL, and deliberately not a per-notebook budget. The original drained:
// each cell was sliced against what was LEFT, so once it hit zero every later
// cell became the empty string with truncated=true. That alone was survivable
// while the pane was read-only; combined with a save it erased the tail of the
// notebook, and a reload then read those empty cells back as ordinary short
// ones, destroying the only evidence. A per-cell cap bounds one pathological
// cell without ever touching its neighbours.
const MAX_CELL_SOURCE_CHARS = 100000;

let stream = null;
let pollTimer = null;
let ws = null;
let stopped = false;
let flushAll = null;

// ---------------------------------------------------------------------------
// nbformat
// ---------------------------------------------------------------------------

// nbformat stores multiline fields as EITHER a string OR a list of lines that
// are joined with '' — NOT with '\n'. The lines already carry their own
// newlines. Joining with '\n' double-spaces every notebook in existence, which
// is the classic first bug of every hand-rolled .ipynb reader.
function joinSource(v) {
  if (v == null) return '';
  return Array.isArray(v) ? v.join('') : String(v);
}

// nbformat 4.5 gives every cell an `id`; 4.0-4.4 do not. Synthesise a stable one
// from the index so `jpy_out_<id>` keys survive a reload of the same file.
function cellId(cell, i) {
  const raw = cell && typeof cell.id === 'string' && cell.id ? cell.id : 'c' + i;
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || ('c' + i);
}

// Returns BOTH our projection and the original parsed JSON. The raw object is
// what a save writes back: this reader deliberately models only what the pane
// renders — it drops cell metadata, attachments, notebook metadata beyond the
// kernelspec, nbformat_minor and other cells' output structure. Serialising our
// projection would silently destroy all of that, so a save mutates the raw
// object's cells[i].source and nothing else.
function readNotebook(abs) {
  let nb;
  try {
    nb = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { error: e && e.code === 'ENOENT' ? 'not-found' : 'unreadable', detail: String((e && e.message) || e) };
  }
  if (!nb || !Array.isArray(nb.cells)) return { error: 'not-a-notebook', detail: 'no cells array — nbformat v4 expected' };
  const cells = nb.cells.map((c, i) => {
    let source = joinSource(c.source);
    let source_truncated = false;
    if (source.length > MAX_CELL_SOURCE_CHARS) {
      source = source.slice(0, MAX_CELL_SOURCE_CHARS);
      source_truncated = true;
    }
    return {
      id: cellId(c, i),
      index: i,
      type: c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'raw' ? 'raw' : 'code',
      source,
      source_truncated,
      exec_count: c.execution_count == null ? null : c.execution_count,
      // Outputs saved IN THE FILE, shown until the cell is run live.
      saved_outputs: Array.isArray(c.outputs) ? c.outputs.map(fromFileOutput).filter(Boolean) : [],
    };
  });
  const lang = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.language)
    || (nb.metadata && nb.metadata.language_info && nb.metadata.language_info.name) || 'python';
  const kernelName = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.name) || 'python3';
  // Cells are identified by ID, never by position. An insert or a delete
  // invalidates every later index, and a save that mapped cell->raw by index
  // after a structural change would write each cell's text into its neighbour.
  const rawOf = new Map();
  cells.forEach((c, i) => rawOf.set(c.id, nb.cells[i]));
  return { cells, lang, kernelName, nbformat: nb.nbformat || 4, minor: nb.nbformat_minor || 0, raw: nb, rawOf };
}

// A saved output in the FILE uses the same mime-bundle shape as a live iopub
// message, with `output_type` instead of `msg_type`.
function fromFileOutput(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.output_type === 'stream') return shapeStream(o.name, joinSource(o.text));
  if (o.output_type === 'error') return shapeError(o.ename, o.evalue, o.traceback);
  if (o.output_type === 'execute_result' || o.output_type === 'display_data') return shapeMime(o.data, o.metadata);
  return null;
}

// ---------------------------------------------------------------------------
// Output shaping — what the pane receives, already safe to insert
// ---------------------------------------------------------------------------

function clip(s, max) {
  const str = String(s == null ? '' : s);
  return str.length > max ? { text: str.slice(0, max), clipped: str.length } : { text: str, clipped: 0 };
}

function shapeStream(name, text) {
  const c = clip(text, MAX_STREAM_CHARS);
  return { kind: 'stream', name: name === 'stderr' ? 'stderr' : 'stdout', text: c.text, clipped: c.clipped };
}

function shapeError(ename, evalue, traceback) {
  const tb = Array.isArray(traceback) ? traceback.join('\n') : String(traceback || '');
  const c = clip(tb, MAX_STREAM_CHARS);
  return { kind: 'error', ename: String(ename || 'Error'), evalue: String(evalue || ''), traceback: c.text, clipped: c.clipped };
}

// The mime ladder, richest first. Each entry is something the pane can render
// without a bundler and without executing anything the notebook authored.
const MIME_LADDER = [
  'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif',
  'text/html', 'text/markdown', 'application/json', 'text/plain',
];

function shapeMime(data, metadata) {
  if (!data || typeof data !== 'object') return null;
  // Rendered but NEVER executed. JupyterLab does the same for application/
  // javascript; ipywidgets need a live comm channel the pane has no transport
  // for, so both fall back to their text/plain repr with a badge.
  const inert = [];
  if (data['application/javascript']) inert.push('application/javascript');
  for (const k of Object.keys(data)) if (k.startsWith('application/vnd.jupyter.widget')) inert.push(k);

  for (const mime of MIME_LADDER) {
    const v = data[mime];
    if (v == null) continue;
    if (mime === 'image/svg+xml') {
      const c = clip(joinSource(v), MAX_OUT_BYTES);
      return { kind: 'svg', svg: sanitizeHtml(c.text), clipped: c.clipped, inert };
    }
    if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif') {
      const b64 = String(Array.isArray(v) ? v.join('') : v).replace(/\s+/g, '');
      if (b64.length > MAX_OUT_BYTES * 2) return { kind: 'too-big', mime, bytes: Math.round(b64.length * 0.75), inert };
      return { kind: 'image', mime, b64, bytes: Math.round(b64.length * 0.75), inert };
    }
    if (mime === 'text/html') {
      const c = clip(joinSource(v), MAX_OUT_BYTES);
      return { kind: 'html', html: sanitizeHtml(c.text), plain: joinSource(data['text/plain'] || ''), clipped: c.clipped, inert };
    }
    if (mime === 'text/markdown') {
      const c = clip(joinSource(v), MAX_OUT_BYTES);
      return { kind: 'markdown', text: c.text, clipped: c.clipped, inert };
    }
    if (mime === 'application/json') {
      let pretty = '';
      try { pretty = JSON.stringify(v, null, 2); } catch { pretty = String(v); }
      const c = clip(pretty, MAX_OUT_BYTES);
      return { kind: 'json', text: c.text, clipped: c.clipped, inert };
    }
    const c = clip(joinSource(v), MAX_STREAM_CHARS);
    return { kind: 'text', text: c.text, clipped: c.clipped, inert };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML sanitiser — REBUILD, don't filter
// ---------------------------------------------------------------------------
//
// A cell's text/html is authored by whatever the notebook imported, so it is
// untrusted markup heading for a shadow root inside a page that can reach the
// daemon's own API. Filtering markup is a losing game; REBUILDING it is not.
// This walks the input and emits a fresh tree containing only allowlisted tags
// and NO attributes at all, which is the same technique web-chat's own capture
// sanitiser uses for arbitrary web pages.
//
// The shape this exists for is a pandas DataFrame, measured from a live kernel:
//   <div><style scoped>…</style><table border="1" class="dataframe">
//     <thead><tr style="text-align: right;"><th></th><th>city</th>…
// The <style>, the border, the class and the inline style all vanish; the table
// structure survives and is styled by the pane with --wc-* tokens, which is also
// what makes it look like the surface instead of like 2011.
const ALLOWED = new Set([
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'p', 'div', 'span', 'br', 'hr', 'pre', 'code', 'kbd', 'samp',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
// Dropped WITH their contents — a <style> block would leak the notebook's CSS
// into the pane, and a <script> is the whole reason this function exists.
const DROP_TREE = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'svg', 'math', 'template', 'form', 'input', 'button', 'select', 'textarea']);

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A small forward tokenizer. It never evaluates and never builds a DOM; it emits
// only tags it recognises, with every attribute discarded.
function sanitizeHtml(html) {
  const src = String(html == null ? '' : html);
  const out = [];
  const openStack = [];
  let i = 0;
  let dropDepth = 0;
  let dropTag = null;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { if (!dropDepth) out.push(escapeHtml(src.slice(i))); break; }
    if (lt > i && !dropDepth) out.push(escapeHtml(src.slice(i, lt)));
    // A `<` only opens a tag when a letter, `/` or `!` follows it. Anything
    // else is ordinary TEXT — a cell printing `5 < 10` is the common case, and
    // treating it as a tag would swallow the real `</td>` that closes the row.
    if (!/[A-Za-z!\/]/.test(src[lt + 1] || '')) {
      if (!dropDepth) out.push(escapeHtml('<'));
      i = lt + 1;
      continue;
    }
    const gt = src.indexOf('>', lt);
    // An unterminated tag at the end of input: escape what is left rather than
    // breaking, which would silently drop it.
    if (gt === -1) { if (!dropDepth) out.push(escapeHtml(src.slice(lt))); break; }
    const raw = src.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!raw || raw.startsWith('!')) continue;            // comments, doctype
    const closing = raw.startsWith('/');
    const name = (closing ? raw.slice(1) : raw).split(/[\s/>]/)[0].toLowerCase();
    if (!name) continue;

    if (dropDepth) {
      if (name === dropTag) dropDepth += closing ? -1 : 1;
      if (dropDepth <= 0) { dropDepth = 0; dropTag = null; }
      continue;
    }
    if (DROP_TREE.has(name)) {
      if (!closing && !raw.endsWith('/')) { dropDepth = 1; dropTag = name; }
      continue;
    }
    if (!ALLOWED.has(name)) continue;                      // unknown tag: drop the TAG, keep its text
    if (name === 'br' || name === 'hr' || name === 'col') { out.push('<' + name + '>'); continue; }
    if (closing) {
      const at = openStack.lastIndexOf(name);
      if (at === -1) continue;                             // stray close
      while (openStack.length > at) out.push('</' + openStack.pop() + '>');
    } else if (!raw.endsWith('/')) {
      openStack.push(name);
      out.push('<' + name + '>');
    }
  }
  while (openStack.length) out.push('</' + openStack.pop() + '>');
  return out.join('');
}

// ---------------------------------------------------------------------------
// Server discovery — where the tokens live, and where they stay
// ---------------------------------------------------------------------------

function runtimeDirs() {
  const dirs = [];
  if (process.env.JUPYTER_RUNTIME_DIR) dirs.push(process.env.JUPYTER_RUNTIME_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Library', 'Jupyter', 'runtime'));
  dirs.push(path.join(home, '.local', 'share', 'jupyter', 'runtime'));
  if (process.env.XDG_RUNTIME_DIR) dirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'jupyter'));
  return [...new Set(dirs)];
}

// Each running server drops a jpserver-<pid>.json carrying its url and token —
// the same file `jupyter server list` reads. A stale file whose process is gone
// is filtered by actually probing the url, not by trusting the pid.
async function discoverServers() {
  const found = [];
  for (const dir of runtimeDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^jpserver-.*\.json$/.test(n)) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        if (!info || !info.url) continue;
        found.push({ url: String(info.url).replace(/\/+$/, '/'), token: String(info.token || ''), root: info.root_dir || info.notebook_dir || '', pid: info.pid || null, file: n });
      } catch {}
    }
  }
  const live = [];
  for (const s of found) {
    try {
      const r = await fetch(s.url + 'api/status', { headers: authHeaders(s.token), signal: AbortSignal.timeout(2500) });
      if (r.ok) live.push(s);
    } catch {}
  }
  return live;
}

// The scheme word is `token`, NOT `Bearer`. A token-authenticated request also
// bypasses Jupyter's XSRF check entirely, so no cookie jar and no _xsrf scrape —
// verified against a live server: unauthenticated /api/kernels answers 403 and
// this answers 201.
function authHeaders(token) {
  return token ? { Authorization: 'token ' + token } : {};
}

// A new cell, valid for the notebook's own nbformat minor version.
//   - 4.5+ REQUIRES a unique `id` on every cell, so a cell inserted into such a
//     notebook is minted one. The spec's pattern is ^[a-zA-Z0-9-_]+$, 1-64
//     characters; 'u' + 8 hex sits well inside it and cannot collide with the
//     synthetic 'c<index>' ids this reader makes for id-less cells.
//   - 4.0-4.4 have NO id field, and adding one produces a file those readers
//     reject, so a cell inserted into an older notebook gets none and the file
//     stays at the version the user had.
// A code cell needs execution_count and outputs; markdown and raw must carry
// neither, which is exactly what nbformat's validator checks.
function mintId() { return 'u' + crypto.randomBytes(4).toString('hex'); }

function newRawCell(type, minor) {
  const kind = type === 'markdown' ? 'markdown' : type === 'raw' ? 'raw' : 'code';
  const cell = { cell_type: kind, metadata: {}, source: '' };
  if (kind === 'code') { cell.execution_count = null; cell.outputs = []; }
  if ((minor || 0) >= 5) cell.id = mintId();
  return cell;
}

// ---------------------------------------------------------------------------
// The journal — undo's home, and the reason autosave is safe to turn on
// ---------------------------------------------------------------------------
//
// It lives on HOST DISK, under ctx.webChatDir, copying the layout the file-editor
// builtin already uses (an index plus one blob per version). Disk is the only
// home that survives everything this pane does not control: a re-render, a `[`
// keystroke wiping every pane, the service being stopped when its pane leaves
// the active node, the last browser disconnecting, and a daemon restart. A
// pane-held undo stack survives none of those.
//
// A version is a FULL snapshot of the projection's {id, type, source}. The
// alternative — storing only the changed cells plus an order vector — is
// cheaper per step, but every step then has to be independently invertible and
// each one is a chance to be subtly wrong. Snapshots are trivially correct, and
// bounded here by a version cap and a byte budget rather than by cleverness.
const JOURNAL_MAX_VERSIONS = 60;
const JOURNAL_MAX_BYTES = 24 * 1024 * 1024;
const VERSION_RE = /^v\d+$/;   // the id shape, checked before any read-back

function journalDir(webChatDir, abs) {
  return path.join(webChatDir, 'jpy-history', crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16));
}

function readIndex(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); return Array.isArray(j.versions) ? j : { versions: [] }; }
  catch { return { versions: [] }; }
}

function writeIndex(dir, idx) {
  const tmp = path.join(dir, 'index.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(idx));
  fs.renameSync(tmp, path.join(dir, 'index.json'));   // atomic, so a crash never leaves a half-written index
}

// Append a version and return its rev. Prunes oldest-first to stay inside both
// caps. Never throws into the caller: a journal that cannot be written must not
// stop the user editing, it must only stop undo from promising more than it has.
function journalAppend(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const idx = readIndex(dir);
    // Never append a version identical to the tail. Boot seals unconditionally
    // and the journal outlives the process, so without this every respawn added
    // a duplicate — leaving can_undo true and the first press a silent no-op
    // that still rewrote the file and moved its mtime.
    if (idx.versions.length) {
      const tail = idx.versions[idx.versions.length - 1];
      try {
        const prev = JSON.parse(fs.readFileSync(path.join(dir, tail.id + '.json'), 'utf8'));
        if (JSON.stringify(prev.cells) === JSON.stringify(entry.cells)) return tail.rev;
      } catch {}
    }
    const rev = (idx.versions.length ? idx.versions[idx.versions.length - 1].rev : 0) + 1;
    const id = 'v' + rev;
    const body = JSON.stringify({ rev, ...entry });
    fs.writeFileSync(path.join(dir, id + '.json'), body);
    idx.versions.push({ rev, id, ts: entry.ts, op: entry.op, label: entry.label, bytes: body.length });
    let total = idx.versions.reduce((n, v) => n + (v.bytes || 0), 0);
    while (idx.versions.length > JOURNAL_MAX_VERSIONS || (total > JOURNAL_MAX_BYTES && idx.versions.length > 1)) {
      const gone = idx.versions.shift();
      total -= gone.bytes || 0;
      try { fs.unlinkSync(path.join(dir, gone.id + '.json')); } catch {}
    }
    writeIndex(dir, idx);
    return rev;
  } catch { return null; }
}

// Read one version back. The id shape is checked AND the id must be listed in
// the index — the same two-step the file-editor builtin uses, so a crafted
// control value cannot walk this into an arbitrary file read.
function journalRead(dir, rev) {
  try {
    const idx = readIndex(dir);
    const hit = idx.versions.find((v) => v.rev === Number(rev));
    if (!hit || !VERSION_RE.test(hit.id)) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, hit.id + '.json'), 'utf8'));
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Saving — through the Jupyter contents API, never by writing the file
// ---------------------------------------------------------------------------
//
// A notebook the user may also have open in JupyterLab must not be written
// behind that server's back. PUT /api/contents/<path> lets the server own the
// write, so an open Lab session sees the change the way it expects to.
//
// The cost is a real constraint rather than a detail: the contents API can only
// address files under the server's own root_dir. params.notebooks takes absolute
// paths anywhere, so a notebook outside that root is readable and runnable but
// NOT saveable, and it must say so rather than fail at the moment of saving.
function contentsPathFor(server, abs) {
  if (!server || !server.root) return null;
  const rel = path.relative(server.root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// The DIRECTORY form. contentsPathFor refuses an empty relative path because a
// FILE is never the root — but a directory can be, and browsing the server root
// is the common case, so '' is a valid answer here and null still means outside.
function contentsDirFor(server, abs) {
  if (!server || !server.root) return null;
  const rel = path.relative(server.root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

async function fetchMeta(server, cpath) {
  const r = await fetch(server.url + 'api/contents/' + cpath.split('/').map(encodeURIComponent).join('/') + '?content=0',
    { headers: authHeaders(server.token) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function putNotebook(server, cpath, raw) {
  const r = await fetch(server.url + 'api/contents/' + cpath.split('/').map(encodeURIComponent).join('/'), {
    method: 'PUT',
    headers: { ...authHeaders(server.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'notebook', format: 'json', content: raw }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

// ---------------------------------------------------------------------------
// Kernel client
// ---------------------------------------------------------------------------

// A BARE kernel: nothing on the server records what it is for, so nothing can
// ever find it again. That is the whole leak — every connect made one and
// orphaned the last. Kept only for a notebook the contents API cannot address,
// where there is no path to key a session on.
async function startKernel(server, kernelName) {
  const r = await fetch(server.url + 'api/kernels', {
    method: 'POST',
    headers: { ...authHeaders(server.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: kernelName || 'python3' }),
  });
  if (!r.ok) throw new Error('kernel start failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

// ---- sessions: Jupyter's own record of which kernel belongs to which notebook
// This is the only handle that outlives our process, which is what makes a
// kernel re-findable after a respawn instead of abandoned. It is also what
// JupyterLab reads, so a notebook driven from this pane shows up there as
// running rather than as an anonymous kernel nobody claims.

async function listSessions(server) {
  try {
    const r = await fetch(server.url + 'api/sessions', { headers: authHeaders(server.token) });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

// A session can outlive its kernel — the server was restarted, or the kernel
// died. Adopting one of those is WORSE than having none: the pane reports
// connected, opens a socket against an id the server no longer routes, and
// every cell sits at In [*] forever. So the id is always verified.
async function kernelAlive(server, id) {
  if (!id) return false;
  try {
    const r = await fetch(server.url + 'api/kernels/' + encodeURIComponent(id), { headers: authHeaders(server.token) });
    if (!r.ok) return false;
    const k = await r.json();
    return !!(k && k.id) && k.execution_state !== 'dead';
  } catch { return false; }
}

async function deleteSession(server, id) {
  if (!id) return;
  try {
    await fetch(server.url + 'api/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders(server.token) });
  } catch {}
}

async function createSession(server, cpath, kernelName) {
  const r = await fetch(server.url + 'api/sessions', {
    method: 'POST',
    headers: { ...authHeaders(server.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: cpath, type: 'notebook', name: cpath.split('/').pop() || cpath,
      kernel: { name: kernelName || 'python3' },
    }),
  });
  if (!r.ok) throw new Error('session start failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

function wsUrl(server, kernelId) {
  const u = new URL(server.url + 'api/kernels/' + kernelId + '/channels');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // ?token= authenticates the UPGRADE itself — verified against a live Jupyter
  // Server 2.21.1. Requesting NO subprotocol keeps us on the legacy protocol,
  // i.e. plain JSON text frames rather than the v1 binary offset layout.
  if (server.token) u.searchParams.set('token', server.token);
  return u.toString();
}

function msg(msgType, content, session) {
  const id = msgType + '-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  return {
    id,
    frame: JSON.stringify({
      header: { msg_id: id, username: 'web-chat', session, msg_type: msgType, version: '5.3' },
      parent_header: {}, metadata: {}, content, channel: 'shell',
    }),
  };
}

module.exports = {
  async start(ctx) {
    // Module-level lifecycle state is reset here so start() is RE-ENTRANT. The
    // daemon forks a fresh child per spawn, so in production this is always
    // already clean — but stop() sets `stopped` and nothing cleared it, which
    // left the control FIFO permanently drained-out for any caller that starts
    // the service twice in one process (the pack's own test harnesses do).
    stopped = false;
    if (stream) { try { stream.close(); } catch {} stream = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }

    // The control cursor's floor. The pane stamps `seq: Date.now()` at click
    // time, so anything at or below our start time is by construction a
    // PERSISTED write resurrected by node navigation, not a live click. Running
    // a cell must never replay that way; looking at a tab may.
    const startedAt = Date.now();
    let lastCtlSeq = startedAt;
    let seq = 0;

    const paths = Array.isArray(ctx.params && ctx.params.notebooks) ? ctx.params.notebooks : [];

    // THE CONSENT BOUNDARY for anything the PANE names. It must be fully
    // determined by a value already in the trust key — the project root, or a
    // param printed on the terminal's `params:` line. A boundary discovered at
    // runtime is not consent, which is why this is NOT the connected server's
    // root_dir: that is pane-selected through the server picker and appears
    // nowhere in the fingerprint, so one `jupyter lab ~` would silently widen
    // the boundary to $HOME while the approval still read notebooks=[...].
    // Same shape as the file-editor builtin, whose default is likewise cwd.
    const openDisabled = (ctx.params && ctx.params.open_root) === false;
    const openRoot = openDisabled ? null
      : (ctx.params && typeof ctx.params.open_root === 'string' && ctx.params.open_root
        ? path.resolve(process.cwd(), ctx.params.open_root)
        : process.cwd());

    // Every pane-supplied path goes through here before it reaches fs or the
    // contents API. ctx.fence refuses a lexical ../.. AND a symlink resolving
    // out of the tree — the contents API's own check is purely lexical and does
    // not realpath, so it is not a substitute.
    const fenced = (p) => {
      if (openDisabled || !openRoot) return null;
      const raw = String(p == null ? '' : p);
      if (!raw || raw.indexOf('\\') >= 0) return null;
      const abs = path.isAbsolute(raw) ? raw : path.join(openRoot, raw);
      try { return ctx.fence(openRoot, path.relative(openRoot, abs) || '.'); } catch { return null; }
    };
    const tabs = [];
    let conn = { ok: false, state: 'disconnected', servers: [], server: null, kernel: null, error: null, hint: null };
    let servers = [];
    let server = null;
    let kernel = null;
    let session = 'web-chat-' + Math.random().toString(36).slice(2);
    let activeId = null;

    const push = (patch) => { try { ctx.driver.setStore(patch); } catch (e) { ctx.log('store write failed: ' + e.message); } };
    const pushConn = () => push({ jpy_conn: { seq: ++seq, ...conn } });
    // Source is published ONCE per cell per file-state, never in response to a
    // keystroke: the pane owns the live buffer and never reads the echo for a
    // cell it has touched, so echoing on edit was pure cost. One batched write,
    // and only for the tab on screen — params.notebooks allows twelve, and
    // carrying all of them would put every notebook in every committed node.
    let srcTab = null;
    const pushSrc = (t) => {
      const patch = {};
      if (srcTab && srcTab !== t.id) {
        const old = tabs.find((x) => x.id === srcTab);
        for (const c of (old && old.cells) || []) patch['jpy_src_' + c.id] = null;
      }
      for (const c of t.cells || []) patch['jpy_src_' + c.id] = { source: c.source, truncated: !!c.source_truncated };
      srcTab = t.id;
      push(patch);
    };

    let notice = null;   // { seq, op, reason } — refusals ride jpy_nb rather than a key of their own
    const refuse = (op, reason) => { notice = { seq: ++seq, op, reason }; pushNb(); };
    let save = { state: 'idle', path: null, at: null, error: null };
    const pushSave = () => push({ jpy_save: { seq: ++seq, ...save } });
    const pushNb = () => push({
      jpy_nb: {
        seq: ++seq,
        active: activeId,
        open_root: openRoot,
        notice: notice,
        tabs: tabs.map((t) => ({
          id: t.id, name: t.name, path: t.path, lang: t.lang,
          error: t.error || null, detail: t.detail || null,
          // `raw` never leaves the service: it is the whole notebook, and the
          // store is copied into every committed graph node.
          dirty: [...(t.dirty || [])],
          saveable: t.saveable !== false,
          save_hint: t.save_hint || null,
          // STRUCTURE ONLY. Source moved to per-cell jpy_src_<id> keys because
          // this object was republished on every applied edit and the whole
          // store is copied into every committed graph node, appended whole to
          // the 1000-slot event ring and re-sent on every WS hello. `head` is
          // the first non-blank line, which is all jpy-run ever needed, so it
          // never has to subscribe to source at all.
          cells: (t.cells || []).map((c) => ({
            id: c.id, type: c.type, exec_count: c.exec_count,
            len: (c.source || '').length,
            head: ((c.source || '').split('\n').find((l) => l.trim()) || '').slice(0, 120),
            truncated: !!c.source_truncated,
          })),
        })),
      },
    });

    // --- load the notebooks (no kernel involved) ---------------------------
    // The live tab set, persisted beside the journal so a runtime-opened tab
    // survives the service being stopped when its pane leaves the active node —
    // otherwise every navigation would silently close the user's tabs.
    const tabsFile = path.join(ctx.webChatDir || process.cwd(), 'jpy-tabs',
      crypto.createHash('sha1').update(String(ctx.mountId || 'jpy')).digest('hex').slice(0, 16) + '.json');
    const readOpen = () => {
      try { const j = JSON.parse(fs.readFileSync(tabsFile, 'utf8')); return Array.isArray(j.paths) ? j.paths : []; } catch { return []; }
    };
    const writeOpen = () => {
      try {
        fs.mkdirSync(path.dirname(tabsFile), { recursive: true });
        fs.writeFileSync(tabsFile, JSON.stringify({ paths: tabs.filter((t) => !t.error).map((t) => t.path), active: activeId }));
      } catch {}
    };

    const MAX_TABS = 12;

    const loadTabs = (list) => {
      const use = Array.isArray(list) ? list : paths;
      tabs.length = 0;
      use.forEach((p, i) => {
        const id = 't' + i;
        const name = path.basename(String(p));
        if (!path.isAbsolute(String(p))) {
          tabs.push({ id, name, path: String(p), error: 'not-absolute', detail: 'notebooks[] takes absolute paths; the daemon cwd is not where notebooks live.' });
          return;
        }
        const nb = readNotebook(String(p));
        if (nb.error) tabs.push({ id, name, path: String(p), error: nb.error, detail: nb.detail });
        else tabs.push({
          id, name, path: String(p), lang: nb.lang, kernelName: nb.kernelName, cells: nb.cells,
          raw: nb.raw, rawOf: nb.rawOf, minor: nb.minor, dirty: new Set(), mtime: null,
          jdir: journalDir(ctx.webChatDir || process.cwd(), String(p)),
          rev: 0, cursor: 0, sealTimer: null, firstEditAt: 0, lastSaveMs: 0, nextSaveFloor: 0,
          // Per-cell undo needs its own walk position per cell, or repeated taps
          // toggle between two values instead of walking back. cellUndo answers
          // 'is the button live' without re-reading the journal.
          cellCursor: new Map(), cellUndo: new Map(), prevSnap: null,
          // REDO is an in-memory stack, not a journal walk. Every cell-undo seals
          // a new version, so the versions created by walking BACK sit after the
          // originals chronologically — a forward walk re-encounters the walk's
          // own history and never exhausts. A stack of the values undone away
          // from is exact, and it is what every editor actually means by redo.
          // It is session state on purpose: redo does not survive a respawn.
          cellRedo: new Map(),
        });
      });
      if (!tabs.length) tabs.push({ id: 't0', name: '(no notebooks)', path: '', error: 'no-notebooks', detail: openDisabled ? 'Pass params.notebooks: an array of absolute .ipynb paths. Opening more at runtime is disabled by open_root:false.' : 'Nothing open. Use + to open or create a notebook.' });
      const want = ctx.params && ctx.params.active ? String(ctx.params.active) : null;
      const match = want ? tabs.find((t) => t.path === want || t.name === want) : null;
      if (want && !match) conn.hint = 'active "' + want + '" matched no tab; opened the first instead.';
      activeId = (match || tabs[0]).id;
      // Saved outputs from the FILE, so a notebook reads completely before any
      // kernel exists. A live run replaces these per cell.
      for (const t of tabs) {
        for (const c of t.cells || []) {
          if (c.saved_outputs && c.saved_outputs.length) {
            push({ ['jpy_out_' + c.id]: { seq: ++seq, state: 'saved', outputs: c.saved_outputs, exec_count: c.exec_count } });
          }
          delete c.saved_outputs; // published per cell; keep jpy_nb to structure only
        }
      }
    };

    // --- kernel acquisition ------------------------------------------------
    // Find the kernel this pane already has on this server before making one.
    //
    // Preference is: a live session for the ACTIVE notebook, then a live session
    // for any other notebook we have open, then a new session for the active
    // one. The second rung is what makes this leak-free across a respawn — the
    // active tab can differ from the one that was active when we last connected,
    // and keying only on the active tab would abandon the kernel we already had
    // and start another. The pane runs one kernel for all its tabs either way,
    // so which of its notebooks names the session is cosmetic.
    let nbSession = null;
    const acquireKernel = async (pick, active) => {
      // Contents paths, active first — a session can only be keyed on a path the
      // contents API can address.
      const wanted = [];
      const add = (t) => {
        if (!t || t.error) return;
        const cp = contentsPathFor(pick, t.path);
        if (cp && !wanted.includes(cp)) wanted.push(cp);
      };
      add(active);
      for (const t of tabs) add(t);

      nbSession = null;
      if (wanted.length) {
        const sessions = await listSessions(pick);
        for (const cp of wanted) {
          const found = sessions.find((x) => x && x.path === cp);
          if (!found) continue;
          if (await kernelAlive(pick, found.kernel && found.kernel.id)) {
            nbSession = found;
            ctx.log && ctx.log('adopted kernel ' + found.kernel.id + ' from session for ' + cp);
            return found.kernel;
          }
          // Its kernel is gone. Clear the record rather than adopting a corpse,
          // or we would reconnect to this same dead id on every respawn.
          await deleteSession(pick, found.id);
        }
        const made = await createSession(pick, wanted[0], (active && active.kernelName) || 'python3');
        nbSession = made;
        return made.kernel;
      }

      // No tab the contents API can address, so there is no path to key a
      // session on. This one is unfindable and WILL be orphaned on the next
      // respawn — the notebook is outside the server root, which is the same
      // reason it cannot be saved.
      return startKernel(pick, (active && active.kernelName) || 'python3');
    };

    // --- connect -----------------------------------------------------------
    const connect = async (index) => {
      conn.error = null;
      servers = await discoverServers();
      conn.servers = servers.map((s, i) => ({ index: i, url: s.url, root: s.root }));
      if (!servers.length) {
        conn.ok = false; conn.state = 'no-server';
        conn.hint = 'No running Jupyter server found. Start one with `jupyter server --no-browser` (or open JupyterLab) and press Rescan. Its token is read from Jupyter\'s own runtime file — you never have to paste it.';
        pushConn(); return;
      }
      const pick = servers[Number.isInteger(index) && servers[index] ? index : 0];
      server = pick;
      conn.server = { url: pick.url, root: pick.root };
      try {
        const active = tabs.find((t) => t.id === activeId);
        kernel = await acquireKernel(pick, active);
        conn.kernel = { id: kernel.id, name: kernel.name };
        await openSocket();
        conn.ok = true; conn.state = 'connected'; conn.hint = null;
        await deriveSaveability(pick);
        pushNb();
      } catch (e) {
        conn.ok = false; conn.state = 'error'; conn.error = String((e && e.message) || e);
      }
      pushConn();
    };

    // Per-tab: can this file be addressed by the contents API, is it held
    // truncated, and what is the server's current mtime for it (the staleness
    // baseline). Shared by connect and reload — reload used to skip it, which
    // left every tab with mtime:null and the conflict guard switched off.
    const deriveSaveability = async (pick) => {
      for (const t of tabs) {
        if (t.error) continue;
        const cpath = contentsPathFor(pick, t.path);
        t.cpath = cpath;
        t.saveable = !!cpath;
        t.save_hint = cpath ? null
          : 'Outside the Jupyter server root (' + (pick.root || '?') + '): readable and runnable, but not saveable. Start a server whose root contains it, or move the file.';
        // A truncated buffer must never reach the file: saving would write the
        // truncation back and erase the rest of that cell.
        const cut = (t.cells || []).filter((c) => c.source_truncated);
        if (cut.length) {
          t.saveable = false;
          t.save_hint = cut.length + ' cell(s) exceed the ' + MAX_CELL_SOURCE_CHARS +
            '-character per-cell limit and are held truncated, so this notebook is read-only here — saving would write the truncation back. Edit those cells in Jupyter instead.';
        }
        if (t.saveable && cpath) { try { t.mtime = (await fetchMeta(pick, cpath)).last_modified; } catch {} }
      }
    };

    const openSocket = () => new Promise((resolve, reject) => {
      // Detach the old socket BEFORE closing it. onclose treats a close as a
      // lost connection — it marks the pane disconnected and settles every
      // running cell — and replacing the socket deliberately is not that. The
      // `ws === sock` guard below is what tells the two apart, so the old
      // socket has to stop being `ws` first.
      const old = ws;
      ws = null;
      try { if (old) old.close(); } catch {}
      const sock = new WebSocket(wsUrl(server, kernel.id));
      let settled = false;
      sock.onopen = () => { settled = true; ws = sock; resolve(); };
      sock.onerror = () => { if (!settled) { settled = true; reject(new Error('kernel websocket refused the upgrade')); } };
      sock.onclose = () => {
        if (ws === sock && !stopped) {
          ws = null; conn.ok = false; conn.state = 'disconnected';
          // Whatever was running is not coming back on a socket that is gone.
          abortRuns('KernelDisconnected', 'The connection to the kernel closed while this cell was running, so its result is lost.');
          conn.hint = 'The kernel socket closed. Press Reconnect.'; pushConn();
        }
      };
      sock.onmessage = (ev) => { try { onIopub(JSON.parse(ev.data)); } catch {} };
      setTimeout(() => { if (!settled) { settled = true; reject(new Error('kernel websocket timed out')); } }, 15000);
    });

    // --- execution ---------------------------------------------------------
    // msg_id -> the cell it belongs to, plus the accumulator for its outputs.
    const pending = new Map();

    const flush = (rec) => {
      let bytes = 0;
      const outputs = [];
      for (const o of rec.outputs) {
        const size = JSON.stringify(o).length;
        if (bytes + size > MAX_OUT_BYTES) { outputs.push({ kind: 'capped', withheld: rec.outputs.length - outputs.length, limit: MAX_OUT_BYTES }); break; }
        bytes += size; outputs.push(o);
      }
      push({ ['jpy_out_' + rec.cellId]: { seq: ++seq, state: rec.state, outputs, exec_count: rec.execCount, bytes } });
    };

    // Settle every cell in flight and free the run queue.
    //
    // There was exactly ONE way out of a run — iopub idle for that cell's
    // msg_id — and a kernel that dies never sends one. So the cell stayed at
    // In [*] for ever, `running` stayed true, and every later run queued behind
    // it and wrote NOTHING to the store: the user pressed Run and the pane did
    // not so much as acknowledge it, while the banner still said kernel ready.
    // Everything that can end a run without an idle comes through here.
    const abortRuns = (ename, evalue) => {
      const hit = [...pending.values()];
      pending.clear();
      queue.length = 0;
      running = false;
      stopWatch();
      for (const rec of hit) {
        rec.state = 'error';
        rec.outputs.push({ kind: 'error', ename, evalue, traceback: '' });
        flush(rec);
      }
      return hit.length;
    };

    // Belt and braces for a death that announces NOTHING — no lifecycle status,
    // no socket close. Only a DEFINITIVE answer counts: a 404 from the server,
    // or an explicit 'dead'. Anything uncertain — a throw, a 5xx, a timeout — is
    // read as still alive, because a network blip must never be able to kill
    // someone's three-hour cell. It runs only while a cell is in flight and
    // clears itself the moment nothing is, so an idle pane costs nothing.
    let watchTimer = null;
    const stopWatch = () => { if (watchTimer) { clearInterval(watchTimer); watchTimer = null; } };
    const kernelGone = async () => {
      if (!server || !kernel) return false;
      try {
        const r = await fetch(server.url + 'api/kernels/' + encodeURIComponent(kernel.id), { headers: authHeaders(server.token) });
        if (r.status === 404) return true;
        if (!r.ok) return false;
        const k = await r.json();
        return !!(k && k.execution_state === 'dead');
      } catch { return false; }
    };
    const armWatch = () => {
      if (watchTimer || stopped) return;
      watchTimer = setInterval(async () => {
        if (stopped || !pending.size) { stopWatch(); return; }
        if (!(await kernelGone())) return;
        const n = abortRuns('KernelGone', 'The kernel is no longer running, so this cell\'s result is lost.');
        if (n) {
          conn.ok = false; conn.state = 'error';
          conn.error = 'The kernel is gone.';
          conn.hint = 'Press Restart to start a new one.';
          pushConn();
        }
        stopWatch();
      }, KERNEL_WATCH_MS);
      // Never hold the process open for a poll.
      if (watchTimer.unref) watchTimer.unref();
    };

    function onIopub(m) {
      const parent = m && m.parent_header && m.parent_header.msg_id;
      const rec = parent && pending.get(parent);
      // A kernel-lifecycle status belongs to NO cell: it arrives with an empty
      // parent_header, so it has to be read before the per-cell guard below,
      // which used to drop it. It is the only thing the server says when a
      // kernel dies under a running cell — jupyter_server auto-restarts it and
      // broadcasts 'restarting' while the socket stays open, so without this
      // nothing ever learns the result is not coming.
      if (!rec && m && m.channel === 'iopub' && m.msg_type === 'status') {
        const st = m.content && m.content.execution_state;
        if (st === 'restarting' || st === 'autorestarting' || st === 'dead') {
          const n = abortRuns('KernelRestarted',
            'The kernel ' + (st === 'dead' ? 'died' : 'restarted') + ' while this cell was running, so its result is lost. ' +
            'The kernel is fresh — anything the notebook had defined is gone. Re-run the cells you need.');
          if (n) {
            conn.hint = 'The kernel restarted mid-run, so ' + n + ' cell(s) were stopped. Its state is gone; re-run what you need.';
            pushConn();
          }
          return;
        }
      }
      if (!rec) return;
      if (m.channel === 'iopub') {
        if (m.msg_type === 'stream') {
          const last = rec.outputs[rec.outputs.length - 1];
          const shaped = shapeStream(m.content.name, joinSource(m.content.text));
          // Coalesce consecutive same-stream chunks host-side, so a chatty loop
          // is one store write per flush rather than one per chunk.
          if (last && last.kind === 'stream' && last.name === shaped.name && !last.clipped) {
            const merged = clip(last.text + shaped.text, MAX_STREAM_CHARS);
            last.text = merged.text; last.clipped = merged.clipped;
          } else rec.outputs.push(shaped);
        } else if (m.msg_type === 'execute_input') {
          // THE execution count. execute_input is broadcast at the START of every
          // execution and always carries it — which is why JupyterLab can show
          // In [5] the moment a cell begins.
          //
          // It used to be read off execute_result instead, and that is emitted
          // ONLY when a cell's last statement produces a value. So a cell that
          // just printed, or only called display(), or raised, finished with a
          // blank In [ ] for ever — and the cells that did get a number looked
          // like "only the first two ran". display_data has no execution_count
          // at all in the protocol, so naming it there was always a no-op.
          if (m.content && m.content.execution_count != null) rec.execCount = m.content.execution_count;
        } else if (m.msg_type === 'execute_result' || m.msg_type === 'display_data') {
          if (m.content && m.content.execution_count != null) rec.execCount = m.content.execution_count;
          const shaped = shapeMime(m.content.data, m.content.metadata);
          if (shaped) rec.outputs.push(shaped);
        } else if (m.msg_type === 'error') {
          rec.outputs.push(shapeError(m.content.ename, m.content.evalue, m.content.traceback));
          rec.state = 'error';
        } else if (m.msg_type === 'status') {
          // THE COMPLETION PREDICATE. iopub idle for OUR msg_id — never
          // execute_reply, which is measured to arrive BEFORE the idle and so
          // truncates trailing output if you finish on it.
          if (m.content.execution_state === 'idle') {
            if (rec.state === 'busy') rec.state = 'ok';
            pending.delete(parent);
            flush(rec);
            runNext();
            return;
          }
        }
        if (Date.now() - rec.lastFlush > 200) { rec.lastFlush = Date.now(); flush(rec); }
      }
    }

    const queue = [];
    let running = false;

    const runNext = () => {
      running = false;
      const next = queue.shift();
      if (next) execute(next);
    };

    function execute(cellId_) {
      if (running) { queue.push(cellId_); return; }
      const tab = tabs.find((t) => t.id === activeId);
      const cell = tab && (tab.cells || []).find((c) => c.id === cellId_);
      if (!cell || cell.type !== 'code') { runNext(); return; }
      if (cell.source_truncated) {
        // Running a prefix of someone's code is worse than not running it: the
        // first half of a cell can drop a table, write a file or spend money,
        // with no sign that the rest was never sent.
        push({ ['jpy_out_' + cellId_]: { seq: ++seq, state: 'error', outputs: [{
          kind: 'error', ename: 'TruncatedSource',
          evalue: 'This cell is held truncated (over ' + MAX_CELL_SOURCE_CHARS + ' characters), so only part of it is loaded. Running it would execute a prefix of your code.',
          traceback: '' }] } });
        runNext(); return;
      }
      if (!ws || !conn.ok) {
        push({ ['jpy_out_' + cellId_]: { seq: ++seq, state: 'error', outputs: [{ kind: 'error', ename: 'NotConnected', evalue: 'Connect to a Jupyter server first.', traceback: '' }] } });
        return;
      }
      running = true;
      const m = msg('execute_request', { code: cell.source, silent: false, store_history: true, allow_stdin: false, stop_on_error: true }, session);
      const rec = { cellId: cellId_, outputs: [], state: 'busy', execCount: null, lastFlush: 0 };
      pending.set(m.id, rec);
      armWatch();
      flush(rec);
      try { ws.send(m.frame); } catch (e) {
        pending.delete(m.id);
        rec.state = 'error';
        rec.outputs = [shapeError('SendFailed', String((e && e.message) || e), [])];
        flush(rec); runNext();
      }
    }

    // --- structural operations ------------------------------------------
    // Each mutates the PROJECTION (t.cells) only. The raw notebook is rebuilt
    // from it by id at save time, so a structural change is never half-applied
    // to the file: either the save runs and writes the whole new order, or it
    // does not and the file is exactly as it was.
    const findTab = (id) => tabs.find((x) => x.id === (id || activeId));

    // Shared by the `open` op and by `new`'s follow-up. Calling it directly
    // rather than enqueueing a synthetic control write keeps the seq cursor
    // untouched — a synthetic op with a large seq advanced lastCtlSeq past every
    // real one, so every later user action was silently refused.
    const openPath = async (p) => {
      if (openDisabled) { refuse('open', 'open-disabled'); return; }
      const abs = fenced(p);
      if (!abs) { refuse('open', 'outside-boundary'); return; }
      if (!/\.ipynb$/i.test(abs)) { refuse('open', 'not-a-notebook'); return; }
      const already = tabs.find((t) => t.path === abs);
      // Idempotent: opening something already open just selects it, which is what
      // makes this replay-safe. It must never create.
      if (already) { activeId = already.id; pushNb(); pushSrc(already); writeOpen(); return; }
      if (tabs.filter((t) => !t.error).length >= MAX_TABS) { refuse('open', 'tab-cap'); return; }
      const keep = tabs.filter((t) => !t.error).map((t) => t.path);
      loadTabs(keep.concat([abs]));
      if (server && conn.ok) await deriveSaveability(server);
      const t = tabs.find((x) => x.path === abs);
      if (t) { activeId = t.id; seal(t, 'open', 'the file as opened'); }
      pushNb();
      if (t && !t.error) pushSrc(t);
      writeOpen();
    };

    const freshCellId = (t) => {
      const taken = new Set((t.cells || []).map((c) => c.id));
      let id = mintId();
      while (taken.has(id)) id = mintId();
      return id;
    };

    // A deleted cell's jpy_out_<id> would otherwise sit in the store forever and
    // be copied into every committed node. Null is the closest thing to a delete
    // the store offers (the key still reads back, but it stops carrying bytes).
    const dropOutputs = (ids) => {
      if (!ids.length) return;
      const patch = {};
      for (const id of ids) patch['jpy_out_' + id] = null;
      push(patch);
    };

    const insertCell = (t, anchorId, where, type) => {
      const id = freshCellId(t);
      const cell = { id, type: type === 'markdown' ? 'markdown' : type === 'raw' ? 'raw' : 'code', source: '', source_truncated: false, exec_count: null };
      const at = anchorId ? (t.cells || []).findIndex((c) => c.id === anchorId) : -1;
      const pos = at < 0 ? (t.cells || []).length : (where === 'before' ? at : at + 1);
      t.cells.splice(pos, 0, cell);
      // The raw cell must carry the SAME id as the projection. newRawCell mints
      // its own, so overwrite it: otherwise the file gets one id, the store keys
      // (jpy_out_<id>) use another, and after a save-and-reload the cell's
      // outputs and dirty state are orphaned against an id that no longer exists.
      const rawNew = newRawCell(cell.type, t.minor);
      if (rawNew.id) rawNew.id = id;
      t.rawOf.set(id, rawNew);
      (t.dirty = t.dirty || new Set()).add(id);
      return cell;
    };

    const deleteCell = (t, cellId_) => {
      const at = (t.cells || []).findIndex((c) => c.id === cellId_);
      if (at < 0) return null;
      const [gone] = t.cells.splice(at, 1);
      t.rawOf.delete(gone.id);
      (t.dirty = t.dirty || new Set()).add('*');
      dropOutputs([gone.id]);
      return gone;
    };

    const moveCell = (t, cellId_, to) => {
      const at = (t.cells || []).findIndex((c) => c.id === cellId_);
      if (at < 0) return false;
      const dest = Math.max(0, Math.min((t.cells.length - 1), Number(to)));
      if (!Number.isFinite(dest) || dest === at) return false;
      const [c] = t.cells.splice(at, 1);
      t.cells.splice(dest, 0, c);
      (t.dirty = t.dirty || new Set()).add('*');
      return true;
    };

    // Changing type REBUILDS the raw cell rather than mutating it, because the
    // per-type field sets are disjoint: a markdown cell carrying execution_count
    // or outputs fails nbformat validation, and a code cell without them does
    // too. Metadata is carried across; attachments are NOT, because a code cell
    // has nowhere to put them — so markdown->code is refused when any exist
    // rather than silently dropping the user's embedded images.
    const setCellType = (t, cellId_, type) => {
      const cell = (t.cells || []).find((c) => c.id === cellId_);
      if (!cell) return { ok: false, reason: 'no such cell' };
      const want = type === 'markdown' ? 'markdown' : type === 'raw' ? 'raw' : 'code';
      if (cell.type === want) return { ok: true };
      const old = t.rawOf.get(cell.id) || {};
      if (want === 'code' && old.attachments && Object.keys(old.attachments).length) {
        return { ok: false, reason: 'this cell has ' + Object.keys(old.attachments).length + ' attachment(s), which a code cell cannot hold — remove them first' };
      }
      const next = newRawCell(want, t.minor);
      if (old.id) next.id = old.id;
      next.metadata = old.metadata || {};
      next.source = cell.source;
      t.rawOf.set(cell.id, next);
      cell.type = want;
      cell.exec_count = null;
      (t.dirty = t.dirty || new Set()).add(cell.id);
      if (want !== 'code') dropOutputs([cell.id]);
      return { ok: true };
    };

    // --- journal + autosave ----------------------------------------------
    const SEAL_IDLE_MS = 1200;      // seal a burst this long after typing stops
    const SEAL_CEILING_MS = 15000;  // ...and at least this often while it continues

    const snapshotOf = (t) => (t.cells || []).map((c) => ({ id: c.id, type: c.type, source: c.source }));

    const pushHist = (t) => {
      const idx = readIndex(t.jdir);
      const revs = idx.versions.map((v) => v.rev);
      const at = t.cursor || (revs.length ? revs[revs.length - 1] : 0);
      const i = revs.indexOf(at);
      const prev = i > 0 ? idx.versions[i - 1] : null;
      const nextV = i >= 0 && i < revs.length - 1 ? idx.versions[i + 1] : null;
      push({ jpy_hist: {
        seq: ++seq, tab: t.id, rev: at, depth: revs.length,
        can_undo: !!prev, can_redo: !!nextV,
        cells: Object.fromEntries(t.cellUndo),
        cells_redo: Object.fromEntries([...t.cellRedo].filter(([, v]) => v && v.length).map(([k, v]) => [k, v.length])),
        undo_label: prev ? (idx.versions[i] && idx.versions[i].label) || 'the last change' : null,
        redo_label: nextV ? nextV.label || 'the next change' : null,
      } });
    };

    // Seal the current buffer as a journal version. This is what makes autosave
    // safe: the version exists on disk BEFORE the file is written, so an undo
    // always has somewhere to go back to even if the save itself then fails.
    const seal = (t, op, label) => {
      if (t.sealTimer) { clearTimeout(t.sealTimer); t.sealTimer = null; }
      t.firstEditAt = 0;
      const snap = snapshotOf(t);
      const rev = journalAppend(t.jdir, { ts: Date.now(), op, label, cells: snap });
      if (rev) {
        // Diff against the previous sealed snapshot to learn which cells have a
        // prior value to go back to. O(cells), and no journal re-reads.
        // A cell-undo seals too, but its handler has ALREADY worked out what is
        // available in both directions for the cell it moved — by probing the
        // journal it had just walked. Re-deriving here would clobber that with
        // 'this cell changed, so it can be undone', which is how a walk to the
        // far end still reported more history behind it.
        if (t.prevSnap && t.rev && rev !== t.rev && op !== 'cell-undo') {
          const was = new Map(t.prevSnap.map((c) => [c.id, c.source]));
          for (const c of snap) {
            if (was.has(c.id) && was.get(c.id) !== c.source) {
              t.cellUndo.set(c.id, t.rev);
              if (op === 'edit') {
                t.cellCursor.delete(c.id);   // typing re-aims the walk at the head
                t.cellRedo.delete(c.id);     // ...and typing discards the redo stack
              }
            }
          }
        }
        t.rev = rev; t.cursor = rev; t.prevSnap = snap;
      }
      pushHist(t);
      return rev;
    };

    // Typing schedules a seal; a deliberate action forces one. The ceiling stops
    // a long uninterrupted burst from going unsealed indefinitely.
    const scheduleSeal = (t, label) => {
      if (!t.firstEditAt) t.firstEditAt = Date.now();
      if (t.sealTimer) clearTimeout(t.sealTimer);
      const overdue = Date.now() - t.firstEditAt >= SEAL_CEILING_MS;
      const fire = () => { seal(t, 'edit', label || 'typing'); autosave(t); };
      if (overdue) { fire(); return; }
      t.sealTimer = setTimeout(fire, SEAL_IDLE_MS);
      if (t.sealTimer.unref) t.sealTimer.unref();
    };

    // Autosave proper. The floor copies JupyterLab's own rule — the next save
    // may not start until 10x the last one's duration has passed — so a slow
    // server cannot queue saves behind themselves.
    const autosave = (t) => {
      if (t.saveable === false) { save = { state: 'unsaveable', path: t.path, at: null, error: t.save_hint || null }; pushSave(); return; }
      const wait = Math.max(0, t.nextSaveFloor - Date.now());
      if (wait > 0) { setTimeout(() => saveTab(t.id), wait); return; }
      saveTab(t.id);
    };

    // Flush anything pending — used on tab switch and on stop(), where an
    // unsealed burst would otherwise be the one thing autosave loses.
    const flushTab = async (t) => {
      if (!t || t.error) return;
      if (t.sealTimer || t.firstEditAt) { seal(t, 'edit', 'typing'); await saveTab(t.id); }
    };

    // Move the buffer to a journal version. This is the ONLY undo transport,
    // and it is idempotent on purpose: `undo` as a delta op would over-rewind if
    // a click were duplicated or a message lost, whereas 'be at rev 14' means
    // the same thing however many times it arrives.
    const gotoRev = (t, rev) => {
      const v = journalRead(t.jdir, rev);
      if (!v || !Array.isArray(v.cells)) return false;
      const byId = new Map((t.cells || []).map((c) => [c.id, c]));
      t.cells = v.cells.map((snap) => {
        const live = byId.get(snap.id);
        if (live) { live.source = snap.source; live.type = snap.type; return live; }
        // A cell that was deleted and is now coming back needs a raw record
        // again; its outputs are NOT restored, because an output asserts a
        // kernel state that undo cannot make true again.
        if (!t.rawOf.get(snap.id)) {
          const rc = newRawCell(snap.type, t.minor);
          if (rc.id) rc.id = snap.id;
          t.rawOf.set(snap.id, rc);
        }
        return { id: snap.id, type: snap.type, source: snap.source, source_truncated: false, exec_count: null };
      });
      t.cursor = Number(rev);
      t.dirty = new Set(t.cells.map((c) => c.id));
      return true;
    };

    const stepRev = (t, dir) => {
      const idx = readIndex(t.jdir);
      const revs = idx.versions.map((v) => v.rev);
      const at = revs.indexOf(t.cursor || t.rev);
      if (at < 0) return null;
      const target = at + dir;
      if (target < 0 || target >= revs.length) return null;
      return revs[target];
    };

    // An edit changes only the in-memory buffer. Nothing touches disk until a
    // save, and a save is refused below the start-time floor like any other
    // mutating op: a persisted 'save' resurrected by graph navigation must
    // never write a file.
    const applyEdit = (cellId_, source) => {
      if (typeof source !== 'string') return false;
      const t = tabs.find((x) => x.id === activeId);
      const cell = t && (t.cells || []).find((c) => c.id === cellId_);
      if (!cell || cell.source === source) return false;
      cell.source = source;
      (t.dirty = t.dirty || new Set()).add(cell.id);
      return true;
    };

    // One save per tab at a time. saveTab awaits a GET for the baseline and then
    // a PUT; two overlapping runs both read the PRE-write mtime, both write, and
    // whichever returns last installs the baseline — which can leave the
    // staleness check permanently convinced the file moved under it. A trailing
    // flag coalesces the requests that arrive while one is in flight, so the
    // last intent still reaches disk exactly once.
    const saving = new Map();   // tabId -> true while in flight
    const savePending = new Set();
    const saveTab = async (tabId) => {
      const t = tabs.find((x) => x.id === (tabId || activeId));
      if (!t || t.error || !t.raw) return;
      if (saving.get(t.id)) { savePending.add(t.id); return; }
      saving.set(t.id, true);
      try { await saveTabInner(t); } finally {
        saving.delete(t.id);
        if (savePending.delete(t.id)) await saveTab(t.id);
      }
    };

    const saveTabInner = async (t) => {
      save = { state: 'saving', path: t.path, at: null, error: null };
      pushSave();
      const t0 = Date.now();
      const fail = (state, error) => { save = { state, path: t.path, at: null, error }; pushSave(); };
      if (!server || !conn.ok) return fail('error', 'Not connected to a Jupyter server. Saving goes through its contents API.');
      const cpath = t.cpath || contentsPathFor(server, t.path);
      if (!cpath) return fail('unsaveable', t.save_hint || 'outside the Jupyter server root');
      // Checked again here rather than trusted from the flag: this is the last
      // point before bytes reach the file, and every other guard is advisory.
      const truncated = (t.cells || []).filter((c) => c.source_truncated);
      if (truncated.length) {
        return fail('unsaveable', 'Refusing to save: ' + truncated.length + ' cell(s) are held truncated, and writing them back would erase the rest of those cells.');
      }
      try {
        // Jupyter does no optimistic concurrency here, so compare mtimes
        // ourselves rather than silently clobbering an edit made elsewhere.
        const meta = await fetchMeta(server, cpath);
        if (t.mtime && meta.last_modified && meta.last_modified !== t.mtime) {
          return fail('stale', 'The file changed on disk since it was opened. Reload to pick up that version; saving now would overwrite it.');
        }
        // Mutate the ORIGINAL parsed notebook, never a rebuild of our
        // projection: cell metadata, attachments, notebook metadata,
        // nbformat_minor and other cells' outputs all live in `raw` and must
        // survive a save untouched.
        // Rebuild the raw cell list FROM the projection's order, looking each
        // cell up by id. This is what makes insert/delete/move safe: position is
        // derived from the model rather than assumed to match it, and a cell the
        // user never touched is still the exact object read from the file, so its
        // metadata, attachments and outputs ride through untouched.
        t.raw.cells = (t.cells || []).map((cell) => {
          const rawCell = t.rawOf.get(cell.id) || newRawCell(cell.type, t.minor);
          rawCell.source = cell.source;
          t.rawOf.set(cell.id, rawCell);
          return rawCell;
        });
        const res = await putNotebook(server, cpath, t.raw);
        const wrote = new Set(t.dirty || []);
        t.lastSaveMs = Date.now() - t0;
        t.nextSaveFloor = Date.now() + Math.min(10 * t.lastSaveMs, 30000);
        t.mtime = res.last_modified || null;
        t.dirty = new Set();
        // Republish the source of everything this save wrote, BEFORE announcing
        // 'saved'. Increment 3 stopped echoing source on every keystroke, which
        // was right, but left jpy_src_ holding the text from LOAD time — so the
        // pane, which drops its own buffer the moment it sees 'saved', fell back
        // to that stale value and the cell visibly reverted to its original
        // contents on the next render. Order matters: src first, then the state
        // that tells the pane it is safe to stop trusting its own buffer.
        const saved = {};
        for (const cell of t.cells || []) {
          if (!wrote.has(cell.id)) continue;
          saved['jpy_src_' + cell.id] = { source: cell.source, truncated: !!cell.source_truncated };
        }
        if (Object.keys(saved).length) push(saved);
        save = { state: 'saved', path: t.path, at: Date.now(), error: null };
        pushSave(); pushNb();
      } catch (e) {
        // Jupyter puts the actionable text in the body's `message`; putNotebook
        // already folds the body into the Error, so surface it verbatim.
        fail('error', String((e && e.message) || e));
      }
    };

    const control = async (kind) => {
      if (!server || !kernel) return;
      try {
        await fetch(server.url + 'api/kernels/' + kernel.id + '/' + kind, { method: 'POST', headers: authHeaders(server.token) });
        // Not pending.clear(): that dropped the in-flight record on the floor
        // and left its cell at In [*] with nothing ever coming to replace it.
        if (kind === 'restart') {
          abortRuns('KernelRestarted', 'The kernel was restarted while this cell was running, so its result is lost.');
          // ...and REBIND the socket. A restart replaces the kernel process; the
          // existing socket stays open and readyState 1, but it is attached to
          // something that no longer exists, so the next execute_request is
          // accepted and simply never answered — the next cell you run hangs at
          // In [*] for ever. Measured: without this, a run 2s after a restart
          // gets a busy flush and then nothing, indefinitely. (An AUTO-restart
          // after a crash does not need this; the server rebinds that one
          // itself, which is why only the deliberate path was broken.)
          try {
            await openSocket();
          } catch (e) {
            conn.ok = false; conn.state = 'error';
            conn.error = 'Reconnecting after the restart failed: ' + String((e && e.message) || e);
            conn.hint = 'Press Reconnect.';
            pushConn();
          }
        }
      } catch (e) { ctx.log(kind + ' failed: ' + e.message); }
    };

    // --- control key -------------------------------------------------------
    // Control ops are ENQUEUED, never dispatched straight from the SSE handler.
    // applyCtl advances the seq cursor before its own awaits, and the handler
    // called it unawaited, so two ops that both await (connect, save) could
    // interleave — one reading state the other was halfway through changing.
    // A single worker draining a FIFO makes ordering a property of the design
    // rather than of timing.
    const ctlQueue = [];
    let ctlDraining = false;
    const enqueueCtl = (c) => {
      ctlQueue.push(c);
      if (ctlDraining) return;
      ctlDraining = true;
      (async () => {
        while (ctlQueue.length && !stopped) {
          const next = ctlQueue.shift();
          try { await applyCtl(next); } catch (e) { ctx.log('ctl ' + (next && next.op) + ' failed: ' + ((e && e.message) || e)); }
        }
        ctlDraining = false;
      })();
    };

    const applyCtl = async (c) => {
      if (!c || typeof c !== 'object') return;   // the poll enqueues whatever the key holds, including nothing
      const s = Number(c.seq);
      if (!Number.isFinite(s) || s <= lastCtlSeq) return;
      // A mutating op stamped at or before our start is a resurrected write, not
      // a click. Looking is replayable; running is not.
      if (s <= startedAt && !VIEW_OPS.has(c.op)) return;
      lastCtlSeq = s;
      switch (c.op) {
        case 'set-tab': {
          const t = tabs.find((x) => x.id === c.id);
          if (t) { const prevTab = findTab(); if (prevTab && prevTab.id !== t.id) await flushTab(prevTab); activeId = t.id; pushNb(); if (!t.error) { pushSrc(t); pushHist(t); } writeOpen(); }
          break;
        }
        case 'reload': {
          // loadTabs() builds FRESH tab objects, so cpath / saveable / mtime —
          // all derived inside connect() — would be lost, and the staleness
          // guard is truthiness-gated on mtime, so a null baseline silently
          // disables conflict detection entirely. Re-derive them here.
          loadTabs(tabs.filter((t) => !t.error).map((t) => t.path));
          if (server && conn.ok) await deriveSaveability(server);
          // A reload RESOLVES a 'stale' — the file on disk is now what we hold,
          // and mtime has just been re-derived. Leaving the state alone kept the
          // "changed on disk — choose" chip armed after the very action that
          // answered it, still offering to discard edits that no longer conflict.
          // revert already does this; reload did not.
          { const t0 = tabs.find((x) => x.id === activeId);
            save = { state: 'idle', path: (t0 && t0.path) || null, at: null, error: null }; pushSave(); }
          pushNb();
          { const t0 = tabs.find((x) => x.id === activeId); if (t0 && !t0.error) { srcTab = null; pushSrc(t0); } }
          break;
        }
        // Rescan only. Never connects, never starts a kernel.
        case 'discover': {
          servers = await discoverServers();
          conn.servers = servers.map((sv, i) => ({ index: i, url: sv.url, root: sv.root }));
          pushConn();
          break;
        }
        case 'connect': {
          // Land edits on the OLD server before the base moves, and do not leave
          // queued cells wedged in 'busy' against a kernel that is going away.
          if (server && conn.ok) { try { await flushAll(); } catch {} }
          abortRuns('KernelDisconnected', 'The kernel connection was replaced while this cell was running, so its result is lost.');
          const old = server && kernel ? { s: server, k: kernel } : null;
          await connect(c.index);
          if (old && (!kernel || old.k.id !== kernel.id)) {
            try { await fetch(old.s.url + 'api/kernels/' + old.k.id, { method: 'DELETE', headers: authHeaders(old.s.token) }); } catch {}
          }
          break;
        }
        case 'edit': {
          // Deliberately publishes NOTHING. The pane owns the live buffer and
          // tracks its own dirty state, so a keystroke needs no store write at
          // all — and every store write is copied into each committed graph
          // node and appended whole to the 1000-slot event ring. The dirty set
          // in jpy_nb is refreshed on the next deliberate action (run, save, a
          // structural change), which is when it is actually read.
          if (applyEdit(c.cell, c.source)) {
            const t = findTab();
            if (t) scheduleSeal(t, 'typing in ' + c.cell);
          }
          break;
        }
        case 'run': {
          // A run may carry the edited buffer, so 'run what I am looking at'
          // needs neither a save first nor an extra round trip.
          // Republish when the run carried an edit, or the pane never learns
          // the cell is dirty and the Save button stays disabled.
          if (typeof c.source === 'string' && applyEdit(c.cell, c.source)) {
            pushNb();
            const t = findTab();
            // Seal and save ALONGSIDE the run, never before it: a save is a
            // round trip to the server and running is what the user asked for.
            if (t) { seal(t, 'edit', 'run ' + c.cell); autosave(t); }
          }
          execute(String(c.cell || ''));
          break;
        }
        case 'save': await saveTab(c.id); break;
        case 'browse': {
          // A directory listing for the picker. Fenced first, then read through
          // the contents API so it works for a server whose files are not local.
          if (openDisabled) { refuse('browse', 'open-disabled'); break; }
          if (!server || !conn.ok) { refuse('browse', 'no-server'); break; }
          const abs = fenced(c.dir == null ? openRoot : c.dir);
          if (!abs) { refuse('browse', 'outside-boundary'); break; }
          const cpath = contentsDirFor(server, abs);
          if (cpath == null) { refuse('browse', 'outside-server-root'); break; }
          try {
            const r = await fetch(server.url + 'api/contents/' + cpath.split('/').filter(Boolean).map(encodeURIComponent).join('/'),
              { headers: authHeaders(server.token) });
            if (!r.ok) { refuse('browse', 'http-' + r.status); break; }
            const model = await r.json();
            const entries = (model.content || [])
              .filter((e) => e.type === 'directory' || (e.type === 'notebook') || /\.ipynb$/.test(e.name || ''))
              .map((e) => ({ name: e.name, path: path.join(abs, e.name), dir: e.type === 'directory' }))
              .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)))
              .slice(0, 300);
            const up = path.dirname(abs);
            push({ jpy_browse: { seq: ++seq, dir: abs, up: (fenced(up) && up !== abs) ? up : null, entries } });
          } catch (e) { refuse('browse', String((e && e.message) || e).slice(0, 80)); }
          break;
        }
        case 'open': await openPath(c.path); break;
        case 'new': {
          // NOT replay-safe: it CREATES A FILE, and a resurrected create would
          // spray notebooks into the user's directory on every node jump.
          if (openDisabled) { refuse('new', 'open-disabled'); break; }
          if (!server || !conn.ok) { refuse('new', 'no-server'); break; }
          const dirAbs = fenced(c.dir == null ? openRoot : c.dir);
          if (!dirAbs) { refuse('new', 'outside-boundary'); break; }
          const dirC = contentsDirFor(server, dirAbs);
          if (dirC == null) { refuse('new', 'outside-server-root'); break; }
          const safeName = String(c.name || '').replace(/[^A-Za-z0-9._ -]/g, '').trim();
          const leaf = (safeName ? safeName.replace(/\.ipynb$/i, '') : 'Untitled') + '.ipynb';
          const target = (dirC ? dirC + '/' : '') + leaf;
          const enc = (p2) => p2.split('/').filter(Boolean).map(encodeURIComponent).join('/');
          try {
            const probe = await fetch(server.url + 'api/contents/' + enc(target) + '?content=0', { headers: authHeaders(server.token) });
            if (probe.ok) { refuse('new', 'exists'); break; }
            // Created through the contents API, never through fs — which keeps
            // the promise that this service writes notebooks only via Jupyter.
            const seedNb = { cells: [{ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: '', id: mintId() }],
              metadata: { kernelspec: { name: 'python3', language: 'python', display_name: 'Python 3' } }, nbformat: 4, nbformat_minor: 5 };
            const put = await fetch(server.url + 'api/contents/' + enc(target), {
              method: 'PUT', headers: { ...authHeaders(server.token), 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'notebook', format: 'json', content: seedNb }) });
            if (!put.ok) { refuse('new', 'http-' + put.status); break; }
            await openPath(path.join(dirAbs, leaf));
          } catch (e) { refuse('new', String((e && e.message) || e).slice(0, 80)); }
          break;
        }
        case 'close': {
          const t = tabs.find((x) => x.id === c.id);
          if (!t) break;
          // Flush FIRST — the same guard stop() runs — so closing never discards
          // a pending burst. And refuse once when those edits have nowhere to go.
          if (t.dirty && t.dirty.size && t.saveable === false) { refuse('close', 'dirty-unsaveable'); t.saveable = false; break; }
          try { await flushTab(t); } catch {}
          const drop = {};
          for (const cell of t.cells || []) { drop['jpy_src_' + cell.id] = null; drop['jpy_out_' + cell.id] = null; }
          if (Object.keys(drop).length) push(drop);
          const keep = tabs.filter((x) => !x.error && x.id !== t.id).map((x) => x.path);
          loadTabs(keep);
          if (server && conn.ok) await deriveSaveability(server);
          const first = tabs.find((x) => !x.error) || tabs[0];
          activeId = first ? first.id : null;
          pushNb();
          if (first && !first.error) pushSrc(first);
          writeOpen();
          break;
        }
        case 'cell-undo': {
          // Undo MY LAST CHANGE TO THIS CELL — cell-scoped, source only. Never
          // the cell's type, never structural. Wiring a per-cell button to the
          // plain `undo` op would rewind every cell, because a journal version
          // is a whole-document snapshot.
          const t = findTab(c.tab);
          if (!t || t.error) break;
          // The live buffer rides inline, exactly as `run` does, so this never
          // depends on a separate `edit` write arriving first.
          if (typeof c.source === 'string') applyEdit(c.cell, c.source);
          if (t.sealTimer || t.firstEditAt) seal(t, 'edit', 'typing');
          const cell = (t.cells || []).find((x) => x.id === c.cell);
          if (!cell || cell.source_truncated) break;
          const dir = Number(c.dir) === 1 ? 1 : -1;

          if (dir === 1) {
            const stack = t.cellRedo.get(cell.id);
            if (!stack || !stack.length) { pushHist(t); break; }
            const next = stack.pop();
            if (!stack.length) t.cellRedo.delete(cell.id);
            t.cellUndo.set(cell.id, t.cursor);   // whatever we are leaving is undoable again
            // Re-aim the backward walk at the HEAD. It was left pointing at the
            // far end of the walk back, so the next undo searched behind the
            // oldest value, found nothing, and appeared to do nothing.
            t.cellCursor.delete(cell.id);
            cell.source = next;
            (t.dirty = t.dirty || new Set()).add(cell.id);
            seal(t, 'cell-undo', 'redo in one cell');
            push({ ['jpy_src_' + cell.id]: { source: cell.source, truncated: false } });
            pushNb(); autosave(t);
            break;
          }

          const idx = readIndex(t.jdir);
          const revs = idx.versions.map((v) => v.rev);
          const from = Number.isFinite(Number(c.rev)) ? Number(c.rev)
            : (t.cellCursor.has(cell.id) ? t.cellCursor.get(cell.id) : t.cursor);
          let at = revs.indexOf(from);
          if (at < 0) at = revs.length - 1;
          let hit = null;
          // Walk for the nearest version where THIS cell differs. Skipping
          // equal values is what makes a duplicated click a no-op.
          for (let i = at + dir; i >= 0 && i < revs.length; i += dir) {
            const v = journalRead(t.jdir, revs[i]);
            if (!v) continue;
            const e2 = (v.cells || []).find((x) => x.id === cell.id);
            if (e2 && e2.source !== cell.source) { hit = { rev: revs[i], source: e2.source }; break; }
          }
          if (!hit) { pushHist(t); break; }
          // Push what we are leaving onto the redo stack before replacing it.
          const stack = t.cellRedo.get(cell.id) || [];
          stack.push(cell.source);
          t.cellRedo.set(cell.id, stack);
          cell.source = hit.source;
          (t.dirty = t.dirty || new Set()).add(cell.id);
          t.cellCursor.set(cell.id, hit.rev);
          // Probe one step FURTHER back so the button disables on the last step
          // rather than after a click that does nothing. The walk is already
          // loaded, so this costs one read.
          let more = null;
          for (let i = revs.indexOf(hit.rev) - 1; i >= 0; i--) {
            const v2 = journalRead(t.jdir, revs[i]);
            if (!v2) continue;
            const e3 = (v2.cells || []).find((x) => x.id === cell.id);
            if (e3 && e3.source !== hit.source) { more = revs[i]; break; }
          }
          if (more != null) t.cellUndo.set(cell.id, more);
          else t.cellUndo.delete(cell.id);
          seal(t, 'cell-undo', (dir < 0 ? 'undo' : 'redo') + ' in one cell');
          // ONE key, not pushSrc(t), which republishes every cell of the tab.
          push({ ['jpy_src_' + cell.id]: { source: cell.source, truncated: false } });
          pushNb(); autosave(t);
          break;
        }
        case 'goto-rev': case 'undo': case 'redo': {
          const t = findTab(c.tab);
          if (!t || t.error) break;
          // Seal anything unsealed first, so an undo made mid-burst does not
          // silently discard what was typed since the last version.
          if (t.sealTimer || t.firstEditAt) seal(t, 'edit', 'typing');
          const target = c.op === 'goto-rev' ? Number(c.rev) : stepRev(t, c.op === 'undo' ? -1 : 1);
          if (target == null || !gotoRev(t, target)) { pushHist(t); break; }
          pushNb(); pushSrc(t); pushHist(t);
          autosave(t);
          break;
        }
        case 'insert': {
          const t = findTab(c.tab);
          if (t && !t.error) { const nc = insertCell(t, c.cell, c.where === 'before' ? 'before' : 'after', c.type); pushNb(); push({ ['jpy_src_' + nc.id]: { source: '', truncated: false } }); seal(t, 'insert', 'insert a ' + (c.type || 'code') + ' cell'); autosave(t); }
          break;
        }
        case 'delete': {
          const t = findTab(c.tab);
          if (t && !t.error && (t.cells || []).length > 1) { if (deleteCell(t, c.cell)) { pushNb(); push({ ['jpy_src_' + c.cell]: null }); seal(t, 'delete', 'delete a cell'); autosave(t); } }
          break;
        }
        case 'move': {
          const t = findTab(c.tab);
          if (t && !t.error && moveCell(t, c.cell, c.to)) { pushNb(); seal(t, 'move', 'move a cell'); autosave(t); }
          break;
        }
        case 'set-type': {
          const t = findTab(c.tab);
          if (t && !t.error) {
            const r = setCellType(t, c.cell, c.type);
            if (!r.ok && r.reason) { save = { state: 'error', path: t.path, at: null, error: r.reason }; pushSave(); }
            else { pushNb(); seal(t, 'set-type', 'change a cell to ' + c.type); autosave(t); }
          }
          break;
        }
        case 'revert': {
          const t = tabs.find((x) => x.id === (c.id || activeId));
          if (t && t.raw) {
            (t.cells || []).forEach((cell) => {
              cell.source = joinSource((t.rawOf.get(cell.id) || {}).source);
            });
            t.dirty = new Set();
            save = { state: 'idle', path: t.path, at: null, error: null };
            pushSave(); pushNb(); pushSrc(t);
          }
          break;
        }
        case 'run-all': {
          const t = tabs.find((x) => x.id === activeId);
          for (const cell of (t && t.cells) || []) {
            if (cell.type !== 'code') continue;
            // execute() refuses these individually; skipping here keeps a
            // truncated cell from silently halting the rest of the run.
            if (cell.source_truncated) { ctx.log('run-all: skipping truncated cell ' + cell.id); continue; }
            queue.push(cell.id);
          }
          if (!running) runNext();
          break;
        }
        case 'interrupt': queue.length = 0; await control('interrupt'); break;
        case 'restart': await control('restart'); break;
        default: break;
      }
    };

    flushAll = async () => { for (const t of tabs) { try { await flushTab(t); } catch {} } };

    // --- boot --------------------------------------------------------------
    {
      // params.notebooks is the seed; the sidecar is what the user actually had
      // open. Union, params first, de-duplicated by path.
      const seen = new Set();
      const union = [];
      for (const p of paths.concat(readOpen())) {
        const k = String(p);
        if (seen.has(k)) continue;
        seen.add(k); union.push(k);
      }
      loadTabs(union.slice(0, MAX_TABS));
    }
    pushNb();
    { const t0 = tabs.find((x) => x.id === activeId); if (t0 && !t0.error) { pushSrc(t0); seal(t0, 'open', 'the file as opened'); } }
    conn.state = 'discovering'; pushConn();
    await connect(undefined).catch((e) => ctx.log('connect: ' + e.message));

    try { enqueueCtl((await ctx.driver.getStore(['jpy_ctl'])).jpy_ctl); } catch {}

    try {
      stream = ctx.driver.streamEvents({
        kinds: ['store'],
        onEvent: (e) => { if (e && e.patch && e.patch.jpy_ctl) enqueueCtl(e.patch.jpy_ctl); },
        onError: () => {}, onClose: () => {},
      });
    } catch {}

    // The SSE stream has no auto-reconnect and is not live during the spawn
    // window, so re-read the control key on a slow poll: a write missed either
    // way self-heals instead of stranding the pane.
    pollTimer = setInterval(async () => {
      if (stopped) return;
      try { enqueueCtl((await ctx.driver.getStore(['jpy_ctl'])).jpy_ctl); } catch {}
    }, 4000);
    if (pollTimer.unref) pollTimer.unref();
  },

  async stop() {
    // Flush before tearing down: the supervisor allows about two seconds, and an
    // unsealed typing burst is precisely what autosave would otherwise lose.
    try { if (typeof flushAll === 'function') await flushAll(); } catch {}
    stopped = true;
    if (stream) { try { stream.close(); } catch {} stream = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
  },
};

// Pure helpers, exposed only when the pack's own tests ask for them. The daemon
// calls start/stop and nothing else; this costs the runtime nothing.
if (process.env.WC_JUPYTER_TEST) {
  module.exports.__test = { sanitizeHtml, joinSource, cellId, shapeMime, shapeStream, shapeError, readNotebook };
}

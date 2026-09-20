// Shut down the kernel a harness started.
//
// service.js starts a FRESH kernel on every connect and never shuts one down —
// deliberately, because a kernel has to outlive a service respawn or navigating
// the graph would wipe the user's variables. The consequence is that every
// harness run leaves an idle kernel behind on the dev server, and they
// accumulate: this suite put 171 of them on one server before it started
// refusing to start a 172nd with HTTP 500, which surfaced as every kernel-backed
// suite failing at once for no reason visible in the diff.
//
// A harness's kernel is always its own (startKernel always POSTs a new one), so
// deleting the id in jpy_conn can never touch a kernel a pane is using.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('fs'), path = require('path'), os = require('os');

// Same discovery the service does, and for the same reason: the token lives in
// Jupyter's runtime file and must not be passed around any other way.
function runtimeDirs() {
  return [
    path.join(os.homedir(), 'Library/Jupyter/runtime'),
    path.join(os.homedir(), '.local/share/jupyter/runtime'),
    process.env.JUPYTER_RUNTIME_DIR,
  ].filter(Boolean);
}

export function serverToken(url) { return tokenFor(url); }

function tokenFor(url) {
  for (const dir of runtimeDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => /^jpserver-\d+\.json$/.test(f)); } catch { continue; }
    for (const f of names) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j.url && url && String(j.url).replace(/\/$/, '') === String(url).replace(/\/$/, '')) return j.token || '';
      } catch {}
    }
  }
  return null;
}

export async function shutdownKernel(conn) {
  const id = conn && conn.kernel && conn.kernel.id;
  const url = conn && conn.server && conn.server.url;
  if (!id || !url) return false;
  const token = tokenFor(url);
  if (token == null) return false;
  try {
    const r = await fetch(url + 'api/kernels/' + id, {
      method: 'DELETE',
      headers: token ? { Authorization: 'token ' + token } : {},
    });
    return r.ok || r.status === 404;
  } catch { return false; }
}

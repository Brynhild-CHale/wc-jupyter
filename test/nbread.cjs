// Read a JSON file that something else is actively writing.
//
// Every harness polls the notebook while the SERVICE is writing it back through
// Jupyter's contents API. A read that lands inside that write sees a partial or
// empty file and JSON.parse throws — which showed up as a suite failing once and
// passing on rerun, i.e. as noise indistinguishable from a real regression.
// Retrying here is strictly better than teaching each assertion to tolerate a
// half-written file, because the assertions are about the SETTLED contents.
//
// Atomics.wait is the sleep: these harnesses are synchronous inside until()
// loops, so there is no await to hang a timer on. Node permits it on the main
// thread (browsers do not).
const fs = require('fs');
const SLOT = new Int32Array(new SharedArrayBuffer(4));

module.exports = function readJson(p, tries = 40, everyMs = 10) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) {
      last = e;
      // A missing file is a rename window, a bad parse is a partial read; both
      // are transient. Anything else (EACCES, EISDIR) is not, so do not mask it.
      if (!(e instanceof SyntaxError) && e.code !== 'ENOENT') throw e;
      Atomics.wait(SLOT, 0, 0, everyMs);
    }
  }
  throw last;
};

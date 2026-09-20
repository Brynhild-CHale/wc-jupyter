# Tests

Ten suites. None of them needs the web-chat daemon, a browser, or a trust approval —
the harnesses drive `service.js` directly with a synthetic `ctx` matching the one
`lib/server/service-runner.js` builds, and `pane-test.cjs` runs the pane script against a
DOM small enough to fit in one file.

| file | needs | what it pins |
|---|---|---|
| `pane-test.cjs` | nothing | The pane script under `dom-shim.cjs`: that a re-render **reuses** each `<textarea>` rather than replacing it (which is what preserves native ⌘Z), never writes to a focused cell, keeps DOM order, unsubscribes a removed cell, and that two notebooks with colliding cell ids never share a buffer. |
| `format-harness.mjs` | a Jupyter server | nbformat's awkward corners, read off `test-fixtures/sample.ipynb`: list-form source joins with `''` and not `'\n'`, a cell with no `id` gets a stable one, outputs saved in the file render before anything runs, and a save rewrites only the cell that changed. |
| `save-harness.mjs` | a Jupyter server | Edit → run the edited buffer → save. The round trip preserves attachments, cell metadata, raw cells, notebook metadata and `nbformat_minor`, and an external edit is refused as `stale` rather than clobbered. |
| `trunc-harness.mjs` | a Jupyter server | A notebook held truncated is refused for **both** saving and running. A data-loss regression test: the per-cell budget used to drain, so a save wrote empty strings over the tail of the notebook. |
| `struct-harness.mjs` | a Jupyter server | Insert / delete / move / set-type, and that a save maps cells **by id** so an insert cannot write one cell's text into its neighbour. Also that 4.5 notebooks get ids on new cells and 4.0–4.4 notebooks do **not**. |
| `journal-harness.mjs` | a Jupyter server | The on-disk edit journal: sealing, dedupe against the tail, the version and byte caps, and that a structural change seals immediately rather than waiting for the idle timer. |
| `cellundo-harness.mjs` | a Jupyter server | Per-cell undo rewinds **one** cell and leaves its neighbours alone; redo is a session stack that exhausts at the head and is cleared by typing. |
| `tabs-harness.mjs` | a Jupyter server | Runtime tabs: browse, open, new, close — and that every pane-supplied path goes through the fence, including one that escapes with `..` and one reached by symlink. |
| `kernel-harness.mjs` | a Jupyter server | That connecting **re-finds** the kernel it already has through a Jupyter session rather than starting another, across respawns and across a change of active tab, and that a session whose kernel died is never adopted. |
| `exec-harness.mjs` | a Jupyter server | Every cell that runs gets an `In [n]`, whatever it ends with — expression, print, `display()`, assignment, exception. Counts ascend, a re-run advances only that cell, and a restart resets to 1. |

## Running them

```sh
node test/run-all.mjs          # everything
node test/pane-test.cjs        # the one that needs nothing
```

Nine of the ten need a Jupyter server. Any one will do — the pack finds it through
Jupyter's own runtime files, so there is no token to configure:

```sh
uv run --with jupyter-server --with ipykernel --with pandas \
  python -m jupyter_server --no-browser --port=8899 --ServerApp.root_dir=/tmp/wc-jpy-live &
```

## Two things to know before you change them

**`JPY_FIXTURES` must be inside the server's `root_dir`.** It defaults to
`/tmp/wc-jpy-live` and the harnesses write their notebooks there. Point it somewhere the
contents API cannot address and the suites will fail at saving rather than at reading —
that is the product behaving correctly, not the tests breaking.

**Release every kernel you start.** `service.js` starts one per connect and deliberately
never shuts one down, because a kernel has to outlive a service respawn or navigating the
graph would wipe the user's variables. Nothing else reclaims them, so a harness that starts
the service must tear it down with `stopSvc()` (`shutdownKernel` + `svc.stop`) and not with
`svc.stop()` alone. One start is one kernel: `tabs-harness` starts three times, and when it
released only one it leaked two per run — invisible until the server hit its ceiling and
began refusing new kernels with HTTP 500, which presents as every kernel-backed suite
failing at once for no reason visible in the diff. A full run should net **zero**:

```sh
curl -s "http://localhost:8899/api/kernels?token=$TOK" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'
```

Fixtures are seeded fresh per run by `fixtures.mjs`, so the suites are portable and start
from the same state every time. `test-fixtures/sample.ipynb` is the one committed notebook,
used by `format-harness.mjs`.

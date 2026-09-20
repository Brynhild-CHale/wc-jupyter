# Feasibility probes

These are **not** tests of shipped behaviour. They validate the assumptions behind a
*proposed* feature — rendering Jupyter's vendor mime bundles (plotly, vega/altair, bokeh)
inside a sandboxed `<iframe>` fed from the user's own install — so that whoever implements
it starts from measurements instead of from reasoning.

Nothing here is wired into `test/run-all.mjs`. The main suite must stay green and fast;
these are slow, need a live browser or their own Jupyter servers, and several of them
install packages into throwaway environments.

**Read `FINDINGS.md` first.** It is the output that matters — the scripts exist so the
findings can be re-checked rather than believed.

| probe | needs | answers |
|---|---|---|
| `01-server-assets.mjs` | its own Jupyter on :8911 | Will a Jupyter server hand a JS box the renderer bytes, and on what terms — token, CORS, and what is actually inside a prebuilt labextension. |
| `02-kernel-install.mjs` | its own Jupyter on :8912 | Does `%pip install` in a live kernel work with nothing restarting, and does the already-running server then serve the new extension. |
| `03-mime-bundles.mjs` | its own Jupyter on :8913 | What plotly / altair / bokeh / matplotlib / ipywidgets actually emit, key by key, with sizes. |
| `04-capture-and-budget.mjs` | its own daemon + Jupyter | What the store and the kernel channel can carry, and what a static capture costs. |
| `05-jsbox-pane.mjs` | **a browser on the web-chat surface** | What a sandboxed iframe can do inside a real pane: isolation, canvas, capture, and how renderer JS can get in. |
| `06-export-preview.mjs` | the web-chat daemon | Whether a JS box survives an export and a graph preview. |
| `08-plotly-selfsufficiency.mjs` | its own Jupyter + headless Chrome | The end-to-end proof: serve plotly's own bundled JS, load it into a null-origin iframe, draw the vendor payload, and count off-origin requests. |
| `08b-labext-delivery.mjs` | its own Jupyter | What a prebuilt labextension actually contains and what serving it would require. |
| `09-restart-race.mjs` | a Jupyter server | Not a pass/fail test — reports how often a Restart under a running cell leaves the next run hung. Run it before and after touching the restart path. |

Agent-written probes are verbose by design — they print the source lines they measured
against, so a reader can check the claim without trusting the script. `01`–`04` were written
and first run by subagents; their headline claims were independently re-run before being
recorded in `FINDINGS.md`.

## Running them

```sh
node test/feasibility/05-jsbox-pane.mjs      # needs a browser actually watching
node test/feasibility/06-export-preview.mjs
node test/feasibility/01-server-assets.mjs   # starts and stops its own server
```

`05` renders a pane into the live daemon and clears it again. A render into a daemon with
no browser attached still succeeds and runs nothing, so if it reports that the frame never
answered, open the surface first (`claude-web-chat open`) and re-run.

The two `*.results.json` files are the raw measurements from the run recorded in
`FINDINGS.md`, kept because they are the densest reference an implementer has. They contain
absolute paths from the machine they were measured on — those are provenance, not
configuration; re-run the probe to get your own.

## Two traps these probes hit, worth knowing before you write another

**Node's global `fetch` counts as a browser.** `isBrowserRequest` (`lib/core/cors.js`)
returns true for any `sec-fetch-*` header, and undici sends `sec-fetch-mode: cors`. Routes
gated on it — `GET /api/export/:ref?format=file` is one — refuse it. Use a raw
`http.request` with a plain `accept` header, as `06` does.

**Probes leak servers if they crash.** `04` aborts with `EADDRINUSE` if a previous run's
daemon is still up. Before re-running the set, check for strays:
`for p in 5399 8911 8912 8913 8914 8974; do lsof -nP -iTCP:$p -sTCP:LISTEN; done`

**An export JSON-encodes pane HTML.** A `<` arrives as `<`, so grepping the export for
a literal tag reports a false negative. Match both forms.

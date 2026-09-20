# Rendering vendor mime output in a JS box — what is actually true

Measured on 2026-09-20 against live servers and a live browser. Every line below came from
something that ran; where a probe could not settle a question it says so. Nothing here is
implemented — this exists so that whoever implements it starts from measurements.

Re-verify with the probes in this directory (`README.md` says what each one needs).

Every headline claim was independently re-measured by a second probe that shared no code with
the first. **Three of twelve came back qualified**, and two of those hit the *summary* rather
than the measurement — a single server row written up as if it held everywhere. Where that
happened it is called out inline. Read the verdict column, not the section title.

**Versions this was measured on.** `jupyter_server` 2.21.1 and 2.21.0, `jupyterlab` 4.6.3,
`tornado` 6.5.10 / 6.5.9, `nbconvert` 7.17.1, `plotly` 7.1.0 (plotly.js 4.1.1), `altair`
6.3.0 / 5.5.0 / 4.2.2, `bokeh` 3.10.0, `ipywidgets` 8.x, Node 24/26, Chrome.

---

## The short version

The JS box itself is **not the problem** — it works, it is properly isolated, and a
cross-origin `<script src>` will load a renderer into it. The problem is **getting the
renderer bytes to it**, and every route the design assumed turns out to be closed:

1. The renderer cannot travel through the **store** (it would put ~1.2M tokens into a single
   `get_store`).
2. It cannot travel through the **kernel** without chunking (a 4.96 MB payload is *silently
   discarded* by the iopub rate limit).
3. It cannot be **fetched from the Jupyter server** on this machine at all. The route belongs
   to `jupyterlab_server`, and of the three server shapes measured only a healthy Lab install
   serves it: the live pane's bare server 404s and the brew install 500s on every static file.
4. Even where that route exists, what it serves is a **module-federation container**, not a
   library — loading it defines `rspackChunkjupyterlab_plotly`, not `window.Plotly`.

The one transport that is measured working end to end: **the service reads the JS off disk at
the path the kernel reports, and serves it itself.** That is the thing to design first — and
it is confirmed all the way to pixels in a real browser (§7): plotly's own bundled
`plotly.min.js` is a plain UMD, a null-origin iframe loads it with `<script src>`, and the
vendor payload alone draws with **zero** off-origin requests.

---

## 1. The JS box (`05-jsbox-pane.mjs`, run in a real pane)

| claim | verdict | measured |
|---|---|---|
| A sandboxed iframe runs JS inside a pane | **CONFIRMED** | `script: true` |
| It is isolated from the surface | **CONFIRMED** | `origin: "null"`, `parentDom: false`, `localStorage: false` |
| It can draw | **CONFIRMED** | `canvas2d: true`, `webgl: true` |
| It can produce a static capture | **CONFIRMED** | `toDataURL: true`; a 120×40 fill = 278 B PNG |
| SVG can be handed back to the parent | **CONFIRMED** | `XMLSerializer` works |
| A cross-origin `<script src>` loads and its global is usable | **CONFIRMED** | `scriptTagCrossOrigin: true`, `libSaw: true` |

`sandbox="allow-scripts"` **without** `allow-same-origin` is what produces the opaque origin.
Do not add `allow-same-origin`: with both flags the frame can reach back into the parent and
the isolation is gone.

## 2. Exports and previews (`06-export-preview.mjs`)

**A correction to an earlier assumption.** "An iframe is dead in an export" is **false**.

| claim | verdict | measured |
|---|---|---|
| The `<iframe>` survives into an export | **CONFIRMED** | present, `sandbox` intact, `srcdoc` intact |
| An export carries a CSP | **REFUTED** | no CSP meta tag; a file opened from disk has no CSP header either |
| A preview blocks frames | **CONFIRMED** | `default-src 'none'`, **no** `frame-src`, so frames fall back to `'none'` |

So a **srcdoc** frame *runs* in an export. What breaks offline is a frame that *fetches* its
renderer — the recipient has no localhost. Graph thumbnails are the real loss, and they are
lost unconditionally.

Gotcha for anyone writing a probe: the export JSON-encodes pane HTML, so `<iframe` appears as
`<iframe`. Grepping for the literal tag reports a false negative.

## 3. Serving assets from Jupyter (`01-server-assets.mjs`)

**This section was corrected after independent re-verification.** The first pass recorded
"extension assets are served without a token — CONFIRMED, 200 on all five token variants".
That generalised **one server shape into all of them**. Measured across three, on
`/lab/extensions/jupyterlab-plotly/static/remoteEntry.<hash>.js`, all five token variants
(none / bad header / good header / bad `?token=` / good `?token=`):

| server shape | result |
|---|---|
| `jupyterlab` 4.6.3 + `jupyter_server` 2.21.1 + `tornado` 6.5.10 | **200** ×5 — the claim holds here |
| brew: `jupyterlab` 4.6.3 + `jupyter_server` 2.21.0 + `tornado` 6.5.9 | **500** ×5 |
| bare `jupyter_server` 2.21.1, no jupyterlab (**the live pane's server**) | **404** ×5 |

So the transport works on a *healthy Lab install* and on nothing else. Treat "assets are
reachable" as a runtime probe, not an assumption.

| claim | verdict | measured |
|---|---|---|
| Served without a token, **where the route exists at all** | **CONFIRMED** | cold process, first-ever request, raw `http` with only `accept`/`host` → 200, `application/javascript`, body starts `var _JUPYTERLAB;` |
| `--ServerApp.allow_unauthenticated_access=False` closes it | **REFUTED** | still 200. The `@allow_unauthenticated` decorator beats the trait — verified the trait *is* effective elsewhere (on the bare server it flipped a 404 into `302 → /login`). More config-robust than first recorded. |
| The path is `/labextensions/<name>/...` | **REFUTED** | 404 everywhere. It is `/lab/extensions/<name>/...`, and it is **base_url-relative**: under `--ServerApp.base_url=/jpy/`, `/jpy/lab/extensions/…` → 200 and `/lab/extensions/…` → 404 |
| A null-origin frame can `fetch()` the asset | **REFUTED** | 200 but `access-control-allow-origin` absent (`allow_origin` defaults to `''`); OPTIONS preflight → 405 |
| A null-origin frame can `<script src>` it | **CONFIRMED** | 200, `application/javascript`, `nosniff` satisfied |
| A prebuilt labextension contains a UMD bundle | **REFUTED** | 6 files, 4,856,975 B; `remoteEntry` is a federation container, the 4.8 MB chunk only pushes onto `rspackChunkjupyterlab_plotly` |
| The server serves files from inside a Python package | **REFUTED** | no route to `plotly/package_data/plotly.min.js` |

**The JS box can never be an iframe pointed *at* Jupyter.** Jupyter responses carry
`content-security-policy: frame-ancestors 'self'`, so a frame whose `src` is a Jupyter URL is
refused. The box must be `srcdoc` (or a blob) that pulls the script in — which is what the
rest of this document assumes, but it is a constraint rather than a preference.

**The brew install is broken, and precisely.** `FileFindHandler` 500s on every static file —
even `/static/favicons/favicon.ico`, so JupyterLab itself will not load. Pinned by a
five-cell matrix:

| `jupyter_server` | `tornado` | static |
|---|---|---|
| 2.21.0 | 6.5.8 | OK |
| 2.21.0 | **6.5.9** | **BROKEN** — `AttributeError: 'FileFindHandler' object has no attribute 'allowed_symlink_directory'` |
| 2.21.0 | 6.5.10 | OK |
| 2.21.1 | 6.5.9 | OK |
| 2.21.1 | 6.5.10 | OK |

Exactly one broken pairing, and brew ships it. tornado ≥ 6.5.9 dereferences
`allowed_symlink_directory` in `validate_absolute_path`; `jupyter_server` 2.21.0's
`FileFindHandler.initialize` overrides `initialize` without calling `super()` and never sets
it. Remedy: bump tornado to 6.5.10 or `jupyter_server` to 2.21.1 inside
`/opt/homebrew/Cellar/jupyterlab/4.6.3/libexec`.

## 4. Installing from chat (`02-kernel-install.mjs`)

| claim | verdict | measured |
|---|---|---|
| `%pip install` runs in a live kernel over the normal protocol | **CONFIRMED** | completes; output arrives on iopub |
| `import` works in the **same session**, no restart | **CONFIRMED** | version readable immediately |
| A running server serves the new extension without restarting | **CONFIRMED** | *when the route exists at all* |
| The kernel can report asset paths and versions | **CONFIRMED** | this is how the service learns what to fetch |
| pip's iopub output is clean log text | **REFUTED** | needs handling, not printing |
| An install into the live kernel is durable | **REFUTED** | see blockers |

So the *seamless* half of the design holds: install and use, nothing restarts. It is the
**transport** that does not.

## 5. What the libraries actually emit (`03-mime-bundles.mjs`, `04-capture-and-budget.mjs`)

- **The spec is cheap; only the renderer is expensive.** A 200-point plotly figure spec is
  **1,324 B**. The renderer is 4.59 MiB. This asymmetry is the whole design.
- **plotly can inline its own renderer.** `plotly.io.renderers.default`:
  `"notebook"` → `text/html` of **4,816,074 B** (self-contained);
  `"notebook_connected"` → **319 B** (CDN reference). Both measured.
- **altair 6 changed the mime spelling.** 6.3.0 emits `application/vnd.vegalite.v6.json`
  (**dot**), 5.5.0 emits `...v5+json`, 4.2.2 `...v4+json`. Match
  `/application\/vnd\.(vegalite|vega)\.v(\d+)[.+]json/` or the feature ships broken for current
  altair.
- **bokeh has no data-only payload.** `vnd.bokehjs_exec.v0+json` measured **0 bytes**, metadata
  pointing at a sibling `application/javascript` (4,479 B) that *is* the document. Rendering
  bokeh from output means executing notebook-authored JS, not feeding JSON to a pinned renderer.
- **ipywidgets is out of reach from output alone.** `widget-view+json` is **83 bytes** of
  `{version_major, version_minor, model_id}`; the state arrives on separate `comm_open` messages
  (measured: 3, 1.0 KiB / 401 B / 736 B).
- Every vendor bundle alone → `shapeMime` returns **null** and the output is dropped. With a
  `text/plain` sibling it degrades to text. This is the bug the feature exists to fix.

## 6. The budgets (`04-capture-and-budget.mjs`)

**The store cannot carry the renderer. This is the decisive number:**

- One 4.70 MiB store value makes `GET /api/store` — which is what `get_store` returns **to the
  model** — **≈ 1,231,751 tokens**.
- Six writes of it made `GET /api/events` **76.53 MiB ≈ 20,061,185 tokens**.
- The whole store is copied into every committed graph node (`lib/server/graph.js:448`) and
  appended to a 1000-entry ring (`lib/core/bus.js:45`). A full ring of them ≈ **4.7 GB resident**.
- Nothing refuses the write: the body limit is 200 MB.

**The kernel cannot carry it unpaced.** `iopub_data_rate_limit` defaults to **1e6 B/s** over a
3 s window. 256 KB and 1 MB payloads deliver in ~5 ms and ~11 ms; a **4.96 MB payload is
silently discarded** — 6.6M base64 chars expected, **0 received**, `IOPub data rate exceeded.`
on stderr. Chunking works but puts a **>5 s floor** on a 5 MB bundle.

**The existing per-cell cap bites real figures.** `MAX_OUT_BYTES` = 262,144, applied per cell
across all outputs. Measured consequences:

- The real ceiling for a rendered image is **196,555 B of PNG** — `shapeMime` accepts up to
  393,216 B but `flush()` drops the whole record once it stringifies past 256 KiB.
- A 20,000-point plotly Scattergl spec is **267.5 KiB**; a 5,000-mark matplotlib SVG is
  **529.9 KiB**. Both already exceed the cap.

Settle the budget question — raise it, give vendor payloads their own, or downsample host-side
— before any renderer work is useful on real notebooks.

## 7. End-to-end, in a real browser (`08-plotly-selfsufficiency.mjs`)

A probe drove headless Chrome 151, served `plotly/package_data/plotly.min.js` off disk, and
loaded it into a null-origin sandboxed iframe, then **drew the figures**. The scatter case is
solid. "Self-sufficient" is *not* true unconditionally — geo traces are a hard counterexample,
below.

| claim | verdict | measured |
|---|---|---|
| `plotly.min.js` ships inside the installed package and is a plain UMD | **CONFIRMED** | 4,815,814 B, banner `plotly.js v4.1.1`, `looks_umd: true`, 6 `newPlot` hits |
| A null-origin iframe loads it cross-origin via `<script src>` | **CONFIRMED** | `typeof Plotly = object`, v4.1.1 |
| The vendor payload alone is enough to draw | **CONFIRMED** | title, width/height honoured; `data` alone draws with no `layout` |
| Drawing makes **zero** off-origin requests | **CONFIRMED** | none of 3 observed — no CDN, no fonts |
| The payload's top level is exactly `{data, layout}` | **CONFIRMED** | no `config` key |
| The inlined template is style, not structure | **CONFIRMED** | strip it and it still draws |
| A LaTeX title draws with no network | **CONFIRMED** | `$\alpha + \beta$` |
| The pane's ladder today renders nothing for it | **CONFIRMED** | no ladder key intersects the bundle |

**Two real caveats, both measured as failures:**

- **Geo plots phone home.** A `scattergeo` payload fetched
  `https://cdn.plot.ly/un/world_110m.json` — the topojson is **not** in the Python package or
  the labextension. So map figures either reach the network or do not draw. Decide that
  explicitly; everything else in plotly is self-contained.
- The `plotly_mimetype` renderer emits a byte-identical payload to the default (6.5 KiB), so
  there is nothing to gain by switching renderers — the spec is already what you want.

---

## Blockers, in the order they would stop you

1. **The live server has no asset route.** The pane is attached to a bare `jupyter_server`
   (no `jupyterlab`, no `jupyterlab_server`), and `/lab/extensions/...` is registered by
   `jupyterlab_server`. Every such URL 404s regardless of token. Serving from the user's own
   install has **no transport on the server this pack is attached to today**.
2. **The brew JupyterLab cannot serve any static asset.** `jupyter_server` 2.21.0 +
   `tornado` 6.5.9: `FileFindHandler.initialize()` does not set `allowed_symlink_directory`,
   which tornado ≥ 6.5.9 reads. Every `FileFindHandler` request **500s** — even
   `/static/favicons/favicon.ico`, so JupyterLab itself will not load from that install. Fixed
   in `jupyter_server` 2.21.1. **Anyone measuring against the brew install will read every
   result as a failure.**
3. **Kernel prefix ≠ server prefix.** A kernel registered with `--prefix` installs into a
   labextensions directory the server does not search. Measured: install succeeds, import
   succeeds, the figure emits its vendor mime, and the asset 404s — **no error anywhere in the
   chain**. Check the precondition instead of discovering it as a broken render.
4. **No CORS.** The box can only `<script src>`; it cannot read the bundle. So it cannot hash
   it, cannot show fetch progress, and cannot eval it in a controlled scope.
5. **This machine's env is ephemeral.** The live kernel/server run from a uv build env under
   `~/.cache/uv/builds-v0/`, subject to cache GC. An install from chat cannot honestly be
   called persistent here.

## The design these findings point to

- **Probe the transport at runtime, never assume it.** Whether assets are reachable depends on
  the server shape, the `base_url` and the `jupyter_server`/`tornado` pairing — three things
  that vary per machine and none of which the pack controls.
- **Transport: the service serves the bytes.** Ask the kernel for the on-disk path and version
  (`plotly/package_data/plotly.min.js`, 4.59 MiB, defines `window.Plotly`) and have the
  `jpy-notebook` service serve that file over its own route, then `<script src>` it into the
  box. This is the only path measured working end to end. It needs a new capability — reading a
  file outside `open_root` — so it must be explicit in the trust prompt.
- **Do not use the labextension.** It is federation-only; using it means implementing module
  federation *and* Lab's rendermime interfaces. The library bundle beside it is what you want.
- **Match mime types by regex, with the version captured**, and key the renderer on that
  version.
- **Keep the spec in the store, never the renderer.** Specs are ~1 KB; that is the thing the
  store is for.
- **Capture a static fallback** on render (`toDataURL` is confirmed working in the box) so
  thumbnails and exports show a picture rather than a hole.
- **Scope: plotly and vega only, to start.** bokeh needs an execution-trust decision;
  ipywidgets needs comm proxying and is a separate project.

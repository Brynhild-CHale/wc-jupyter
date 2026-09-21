# wc-jupyter

Jupyter notebooks on the [web-chat](https://github.com/Brynhild-CHale/claude-web-chat) surface.
One pane, several `.ipynb` files as tabs, every cell rendered natively — and cells runnable
against a Jupyter kernel you are already serving.

```js
use_component({
  name: 'jpy-notebook',
  id: 'jpy-notebook-main',
  params: { notebooks: ['/abs/path/analysis.ipynb'] },
  signals: [{ key: 'jpy_ask', wake: 'queue' }],
})
```

**v0.1.0.** Two components, thirteen test suites, zero dependencies.

## What it renders

| output | how it arrives |
|---|---|
| pandas DataFrames, any `text/html` | rebuilt from a tag allowlist, so it themes with the surface |
| matplotlib, any `image/png` | inline, with its pixel dimensions |
| `image/svg+xml` | as a `data:` URI in an `<img>` — it draws, and cannot execute |
| **plotly** | *interactive*, in a sandboxed frame — hover, zoom, pan |
| streams, ANSI colour, tracebacks | decoded, including the colours |
| `JSON`, `Markdown` (incl. tables), LaTeX | rendered, or the honest fallback when it cannot be |
| saved outputs already in the file | shown before any kernel exists |

Anything it cannot render is **named** rather than silently dropped.

## Try it

The pack carries a 25-cell demo notebook that exercises every one of those in a single
`Run All`:

```js
use_component({ name: 'jpy-notebook', id: 'jpy-notebook-main',
                params: { notebooks: [], open_root: '/tmp/scratch', renderers: true } })
set_store({ jpy_ctl: { seq: Date.now(), op: 'demo' } })
```

`demo/signal-quality.ipynb` is the readable copy. `demo/jpy-demo.skill.md` is an optional
skill — drop it at `.claude/skills/jpy-demo/SKILL.md` for a `/jpy-demo` command.

## Install

```sh
claude-web-chat pack install https://github.com/Brynhild-CHale/wc-jupyter
claude-web-chat trust jpy-notebook     # one-time, in a terminal
```

The trust step is not optional and not skippable from the browser: a service is host code,
and the pane that would ask for approval is the thing being approved. Consent is recorded per
(project, `service.js` contents, params) — so changing `notebooks` asks again, which is
correct, because it widens what the service reads.

## Two halves, independently useful

**Reading needs nothing installed.** An `.ipynb` is JSON, so the service parses it directly:
cells, markdown, and the outputs already saved in the file all render with no Python, no
Jupyter and no kernel anywhere.

**Running needs a Jupyter server you are already running.** Any one will do:

```sh
jupyter server --no-browser      # or just have JupyterLab open
```

**You never paste a token.** The service reads Jupyter's own runtime files — the
`jpserver-*.json` behind `jupyter server list` — and keeps the token host-side. That is a
design constraint rather than a convenience: the pane's only channel to the service is the
shared store, and the store is copied into every committed graph node. A token typed into a
pane would be written to disk in your graph.

## Interactive figures

plotly figures draw for real. The trick is that a figure is a **spec** plus a **renderer**,
and they cost wildly different amounts — a 200-point figure's spec is 1.3 KB, `plotly.min.js`
is 4.59 MiB. So the spec travels through the store and the renderer never does: the service
reads it out of the Python package that emitted the payload, serves it on loopback, and the
pane loads it into an `<iframe sandbox="allow-scripts">` with no `allow-same-origin` — an
opaque origin that cannot reach the pane, the store, cookies or storage.

Turn it on with `params.renderers: true`. It is a param rather than a toggle because params
are part of the consent key: enabling it re-asks for trust and the approval line says
`renderers=true`. What it widens is real — the service reads JavaScript from outside
`open_root`.

Installing a renderer does not require restarting anything:

```js
set_store({ jpy_ctl: { seq: Date.now(), op: 'install', package: 'plotly' } })
```

## Editing and saving

Cells are editable, insertable, movable and deletable, with per-cell undo and redo. Autosave
seals about a second after you stop typing.

**The service never writes a notebook file directly.** Saving goes through the Jupyter
contents API, so the server that may also have the file open owns the write. Only cell source
is saved — outputs are never written back. A notebook outside the server's `root_dir` is
readable and runnable but not saveable, and says so. A save is refused if the file changed on
disk, rather than clobbering someone else's edit.

## Limitations

- **ipywidgets do not work.** The output bundle is 83 bytes of `{model_id}`; every byte of
  state arrives on separate comm messages. Widgets render as their `repr` with a badge.
- **bokeh is not rendered.** Its payload is JavaScript to execute rather than data to draw,
  which is a different trust question.
- **vega/altair** has no renderer that ships with the Python package. Set
  `alt.renderers.enable('svg')` in your notebook and it renders as vector.
- **`application/javascript` outputs are never executed.**
- Graph thumbnails show a still image of an interactive figure, not the live frame.

More, with the measurements behind them, in [Known issues](docs/internals.md) and
[`test/feasibility/FINDINGS.md`](test/feasibility/FINDINGS.md).

## Layout

```
wc-jupyter/
├─ web-chat-pack.json
├─ SKILL.md                  # what Claude reads: triggers + the store contract
├─ demo/                     # the bundled notebook, and an optional /jpy-demo skill
├─ docs/internals.md         # how it works, and why
├─ components/
│  ├─ jpy-notebook/          # the pane + its host-side service
│  └─ jpy-run/               # a run console over the same store; no service
└─ test/                     # thirteen suites; see test/README.md
   └─ feasibility/           # probes + findings behind the interactive-figure design
```

Four files per component is web-chat's hard limit and there is no npm resolution, so
`service.js` is self-contained by necessity — the notebook reader, the kernel client and the
HTML sanitiser all live in it, with zero dependencies.

## Development

```sh
node test/run-all.mjs        # thirteen suites
node test/pane-test.cjs      # the one that needs nothing
```

Twelve of the thirteen need a Jupyter server; none needs the web-chat daemon, a browser, or a
trust approval. [`test/README.md`](test/README.md) says what each one pins.

## License

MIT

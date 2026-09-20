# wc-jupyter

Jupyter notebooks on the [web-chat](https://github.com/Brynhild-CHale/claude-web-chat)
surface. One pane, several `.ipynb` files as tabs, every cell rendered natively, and cells
runnable against a Jupyter kernel you are already serving.

**Status:** v0.1.0. Two components — `jpy-notebook`, which carries the pack's one service, and
`jpy-run`, a companion console that ships no service and reads the same store. Ten test suites,
none of which need the web-chat daemon or a trust approval.

## Two halves, independently useful

The **read** half needs nothing installed. An `.ipynb` is JSON, so the service parses it
directly — cells, markdown, and the outputs already saved in the file all render with no
Python, no Jupyter and no kernel anywhere.

The **run** half needs a Jupyter server you are running. It speaks the Jupyter Server REST
and kernel-WebSocket protocol from the host with **zero dependencies** — Node 22+ ships
global `fetch` and global `WebSocket`, which is the whole client.

## Install

```sh
claude-web-chat pack get <this repo>
claude-web-chat trust jpy-notebook     # one-time, in a terminal
```

The trust step is not optional and not skippable from the browser: a service is host code,
and the pane that would ask for approval is the thing being approved. Consent is recorded per
(project, `service.js` contents, params).

## Running cells

Start a server anywhere — the pack finds it:

```sh
jupyter server --no-browser          # or just have JupyterLab open
```

**You never paste a token.** The service reads Jupyter's own runtime files (the
`jpserver-*.json` behind `jupyter server list`) and keeps the token host-side. This is a
deliberate design choice rather than a convenience: the pane's only channel to the service is
the shared store, and the store is copied into every committed graph node and echoed into the
event ring. A token typed into a pane would be written to disk in your graph.

If nothing is running, the pane says so and offers **Rescan**.

## What it will not do

- **It never writes a notebook file directly.** Saving goes through the Jupyter contents API
  (`PUT /api/contents`), so the server that may also have the file open owns the write. Only
  cell source is saved; outputs are not written back. A notebook outside the server's
  `root_dir` is readable and runnable but not saveable, and says so.
- **It does not execute `application/javascript` outputs or ipywidgets.** Both render as
  inert source with a badge — widgets need a live comm channel a pane has no transport for.
- **It does not embed JupyterLab.** An iframe pane is blank in every graph thumbnail
  (`PREVIEW_CSP` is `default-src 'none'`) and dead in an export, and it loses its browsing
  context whenever a pane is rebuilt. The kernel lives host-side instead, so a pane teardown
  costs a repaint rather than your session.

## The kernel is acquired, not started

Connecting does **not** POST `api/kernels`. It asks for the Jupyter **session** that owns the
notebook and takes that session's kernel — a live session for the active notebook, else one for
any other open tab, else a new session. So a service respawn (which happens every time you
navigate the graph away and back) re-finds the kernel you already had, with your variables
still in it, instead of abandoning it and starting another.

A session is always verified before it is adopted: one can outlive its kernel, and adopting a
dead id gives a pane that reports connected, opens a socket the server will not route, and
leaves every cell at `In [*]` for ever.

The fix for a leak, but also better manners — JupyterLab pointed at the same server now shows
your notebook as *running* rather than showing an anonymous kernel nobody claims.

## Layout

```
wc-jupyter/
├─ web-chat-pack.json
├─ SKILL.md                      # the trigger sentence + the store contract
├─ README.md  LICENSE
├─ test-fixtures/sample.ipynb    # deliberately awkward: list-form source, an id-less cell
├─ test/                         # ten suites + a DOM shim; see test/README.md
└─ components/
   ├─ jpy-notebook/              # the service lives here
   │  ├─ component.html          # tabs, cells, ANSI decoder, markdown subset
   │  ├─ meta.json
   │  └─ service.js              # nbformat reader + kernel client + HTML rebuilder
   └─ jpy-run/                   # a console over the same store; no service
      ├─ component.html
      └─ meta.json
```

Four files per component is web-chat's hard limit and there is no npm resolution, so
`service.js` is self-contained by necessity — the notebook reader, the kernel client and the
HTML sanitiser all live in it, with zero dependencies.

## Tests

```sh
node test/run-all.mjs
```

Nine of the ten suites need a Jupyter server running (any one — the pack finds it). The tenth
runs the pane script against a DOM shim and needs nothing. `test/README.md` has the details,
including the one rule worth knowing before you add a suite: release every kernel you start.

## Known issues

Found by an audit of the kernel-protocol layer against the Jupyter messaging spec, each one
reproduced against a live kernel before being written down. None is fixed yet; they are here
rather than quiet.

- **A kernel that dies mid-execution hangs the pane silently.** The completion predicate is
  iopub `status{execution_state:'idle'}` for our `msg_id`, and a dead kernel never sends one —
  the server's `status{execution_state:'restarting'}` arrives with an *empty* parent_header and
  is dropped. So the cell sits at `In [*]` for ever, `running` stays true, and every later Run
  queues behind it and writes nothing at all. The connection banner still reads "kernel ready".
  Restart or Reconnect is the only way out, and nothing says so. This is the worst of the set:
  a segfault in a C extension, or an OOM kill, puts the pane here.
- **A tab switch during Run All runs cells against the wrong notebook.** Queued cells are
  resolved against whichever tab is active when each one dequeues, not the tab the run started
  on.
- **`image/svg+xml` output is always erased.** SVG sits first on the mime ladder, and the HTML
  rebuilder drops `<svg>` along with its whole subtree — so a plot rendered as SVG is chosen
  and then discarded, showing nothing rather than falling through to PNG.
- **An output whose mime bundle has no key the ladder knows is dropped silently**, both live
  and when read from the file.
- **`clear_output` is not handled**, so any progress-bar loop (tqdm, a manual
  `clear_output(wait=True)`) accumulates every frame instead of replacing it.
- **`update_display_data` is not handled**, so `display(..., display_id=...)` followed by
  `update_display` freezes at the first value.
- **Run All does not stop at the first error.** `stop_on_error: true` is set on the request but
  is inert, because cells are dispatched one at a time rather than queued on the kernel.
- **`text/html` that sanitises down to nothing renders as a blank box**, instead of falling
  back to the `text/plain` the shaper already computed for exactly this case.

## Notes for the next person

- A cell completes on iopub `status{execution_state:'idle'}` matching its `msg_id`, **not**
  on `execute_reply` — verified against Jupyter Server 2.21.1, where the reply lands first.
  Completing on the reply truncates trailing output.
- `?token=` authenticates the kernel **WebSocket upgrade**, not just HTTP — also verified
  against a live server. Requesting no subprotocol keeps the connection on plain JSON text
  frames rather than the v1 binary layout.
- The **execution count** comes from iopub `execute_input`, never from `execute_result`.
  `execute_input` is broadcast at the start of every execution and always carries it.
  `execute_result` carries one too, but a kernel emits that message only when a cell's last
  statement produces a *value* — so read it there and a cell that just printed, only called
  `display()`, or raised runs perfectly and keeps a blank `In [ ]` for ever.
- Cell `text/html` is **rebuilt** from an allowlist of tags with every attribute discarded,
  not filtered. A pandas DataFrame comes through as a clean table; its `<style scoped>` block,
  `border="1"` and `class="dataframe"` do not, which is what lets the pane style it with
  `--wc-*` tokens and look like the surface instead of like 2011.

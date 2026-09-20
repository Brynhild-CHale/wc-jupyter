---
name: wc-jupyter
description: Jupyter notebooks on the web-chat surface — one pane holding several .ipynb
  files as tabs, every cell and its real outputs rendered natively, and cells runnable
  against a Jupyter kernel the user is already serving. Two triggers, and the second is the
  one that gets missed. ONE — the user asks for it - "open this notebook", "what did that
  notebook produce", "run this cell", "re-run the notebook", "why is this cell failing", or
  they name a .ipynb. TWO — the user asks a question about an analysis whose answer is
  already sitting in a notebook they ran - what did the model score, how many rows survived
  the filter, what did that chart show. Reading `jpy_nb` and `jpy_out_<id>` gets you the
  cell's real output, including the saved outputs already in the file, which beats re-running
  their analysis from your own guess at their code. The read half needs NOTHING installed -
  an .ipynb is JSON and the service parses it directly, so a notebook renders completely with
  no Python, no Jupyter and no kernel anywhere. Only running cells needs a server. The
  notebooks are the `notebooks` param, an array of ABSOLUTE paths, because the daemon's cwd
  is essentially never where they live. The kernel connection is deliberately NOT a param and
  NOT a control value - the service discovers running servers from Jupyter's own runtime
  files, so no token ever enters the store or a committed graph node. Live, service-backed;
  the service reads the notebooks it is given AND writes cell source back to them through
  the Jupyter server's contents API, never by writing the file directly.
---

# wc-jupyter

One pane, several notebooks, real outputs, and a live kernel when you want one.

## What it is

`jpy-notebook` carries the pack's only service. `jpy-run` is a companion console that ships
no service of its own. It opens the
`.ipynb` files named in `params.notebooks` as tabs in a single pane, renders every cell,
and — once connected to a Jupyter server — runs them.

Both halves are independent, and that matters for what you can promise the user:

| half | needs | what it does |
|---|---|---|
| **read** | nothing at all | `.ipynb` is JSON. Cells, markdown, and the outputs already saved in the file render with no Python, no Jupyter, no kernel. |
| **run** | a Jupyter server the user is running | Executes cells over the kernel WebSocket and streams their output back into the pane. |

A notebook renders completely before any kernel exists. If the user only wants to *look*
at a notebook, nothing needs installing.

## The one thing to tell the user

A service is host code, so its first run waits on a **terminal** approval:

> Run `claude-web-chat trust jpy-notebook` in your terminal.

The pane can only name that command — it cannot grant it, because the component's own pane
script runs in the page being approved. **If you mount this pane and do not say the command,
the pane just sits there empty.** Consent is keyed to (project, `service.js` bytes, params),
so changing `notebooks` asks again — which is correct, since it widens what the service reads.

## Mounting it

```js
use_component({
  name: 'jpy-notebook',
  id: 'jpy-notebook-main',
  params: { notebooks: ['/abs/path/analysis.ipynb', '/abs/path/scratch.ipynb'] },
  signals: [{ key: 'jpy_ask', wake: 'queue' }],
})
```

`signals` goes **top-level**, not inside `params` — and `routing` goes **inside** `params`.
Putting either in the wrong place drops it with no error. `signals` on `use_component` only
works from web-chat **0.7.0**, which is why this pack's floor is `>=0.7.0`.

## `jpy-run` — the console

A compact execution console for a notebook **already open in a `jpy-notebook` pane**: kernel
controls, a per-cell run ledger (order, execution count, wall-clock duration, pass/fail), a
progress bar, and one-click re-run of whichever cells failed.

```js
use_component({
  name: 'jpy-run',
  id: 'jpy-run-main',
  params: { routing: 'none' },
})
```

Two things about it:

- **It ships no service and is inert alone.** It renders `jpy_conn`, `jpy_nb` and
  `jpy_out_<id>`, all published by `jpy-notebook`'s service, so a `jpy-notebook` pane must be
  on the **same graph node**. Without one it renders an explanation, not an empty console.
- **Mount it with `params.routing:'none'`.** A run console is the noisy-pane case — without
  it, every Run click coalesces into the queue rail as generic activity the user never asked
  to send. Note `routing` goes **inside** `params` while `signals` goes **top-level**.

Its durations are measured in the pane from the `jpy_out_<id>` transitions it observes, so
they are wall-clock from when that pane saw the cell go busy — close to the kernel's number,
but not the kernel's number. A cell already running when the pane mounts reports no duration
rather than a wrong one.

## Adding, deleting and moving cells

Each cell carries `↶` `↷` `↑` `↓` `To md`/`To py` and `Delete`; the rule between cells
becomes **+ code** / **+ markdown** on hover. That strip is sized to the buttons it holds
rather than to the rule — at hairline height they overhang it and collide with the cells on
either side, which reads as an affordance stuck to the wrong cell.

These change the in-memory notebook only — **the file changes on the next save**, which
rebuilds the cell list from the model *by id*. That is what makes insertion safe: position is
derived rather than assumed, so a cell's text can never land in its neighbour, and a cell you
never touched round-trips as the exact object read from the file.

Two format rules the pack honours so a notebook stays loadable elsewhere:

- **nbformat 4.5** requires a unique `id` per cell, so an inserted cell is minted one
  (`u` + 8 hex).
- **nbformat 4.0–4.4** have no `id` field at all. An inserted cell gets none, and the file
  stays at its own version — introducing ids there produces a file older readers reject.

Changing type rebuilds the cell for the target type, because the field sets are disjoint
(code needs `execution_count` and `outputs`; markdown and raw must have neither). Markdown →
code is **refused** when the cell has attachments rather than silently dropping your images.

## The kernel is acquired through a session, not started

Connecting does **not** POST `api/kernels`. It asks for the Jupyter **session** that owns the
notebook, and takes that session's kernel:

1. a live session for the **active** notebook, else
2. a live session for **any other open tab**, else
3. a new session for the active notebook.

Rung 2 is what makes a respawn leak-free. The active tab can differ from the one that was
active last time, and keying only on the active tab would abandon the kernel already open and
start another. The pane runs one kernel for all its tabs either way, so which of its notebooks
names the session is cosmetic.

**A session is always verified before it is adopted.** One can outlive its kernel — a crash, or
a server restart with sessions persisted — and adopting a dead id is worse than having no
session at all: the pane reports connected, opens a socket the server will not route, and every
cell sits at `In [*]` for ever. So the kernel id is fetched and checked (404, or
`execution_state === 'dead'`) and a session that fails is deleted rather than reused.

Why this matters: before it, every connect started a kernel and nothing ever reclaimed one. A
service respawns on every graph navigation away and back, so a dev server here reached **171
idle kernels** and then refused to start another with HTTP 500 — which presents as every
kernel-backed test failing at once, with nothing in the diff to explain it.
`test/kernel-harness.mjs` measures the server's kernel count across respawns; the whole suite
now nets zero.

Two things the fix also buys: the pane's kernel shows up in JupyterLab as **that notebook
running** rather than an anonymous kernel nobody claims, and reconnecting to a notebook you
were already running keeps your variables.

**`DELETE /api/kernels/<id>` is not a guaranteed process kill.** Deleting many at once leaves
some kernels half-shut-down: gone from the REST listing, process still alive, and Jupyter's
`KernelRestarter` still polling — so killing the process just brings it back two seconds
later. Only restarting the Jupyter server clears those.

## Opening, creating and closing notebooks

`+` beside the tab strip opens a picker: browse folders, click a notebook to open it, or name
one and **Create here**. `×` on a tab closes it. Tabs survive the service stopping and
restarting, so navigating the graph does not silently close your work.

**The boundary is `open_root`, and it is a consent boundary, not a convenience.** Every path
the pane names is put through the daemon's fence against it before it reaches the filesystem
or the Jupyter contents API.

| `open_root` | effect |
|---|---|
| omitted | the **project root** — already part of the trust key |
| an absolute path | that tree; it prints literally on the approval line |
| `false` | runtime opening disabled entirely |

Two things that look like they'd work and must not:

- **Never anchor the fence on the Jupyter server's `root_dir`.** It's chosen by the pane's
  server picker and appears nowhere in the trust fingerprint — one `jupyter lab ~` would
  silently widen the boundary to your home directory while the terminal still said
  `notebooks=[...]`.
- **The contents API is not a fence.** Jupyter's containment is purely lexical: it never calls
  `realpath`, so a symlink under `root_dir` pointing outside it is followed. Use the contents
  API for correctness; use `ctx.fence` for containment.

`browse` and `open` are replay-safe. **`new` creates a file and `close` removes a tab**, so
both are refused below the service's start-time floor — a resurrected `new` would otherwise
spray notebooks into your directory on every node jump.

## Store contract

| key | written by | what it is |
|---|---|---|
| `jpy_conn` | service | `{ok, state, servers[], server, kernel, error, hint}` — connection health and the discovered server list |
| `jpy_nb` | service | `{active, tabs:[{id, name, path, lang, saveable, save_hint, dirty[], cells:[{id, type, exec_count, len, head, truncated}]}]}` — **structure only, no source** |
| `jpy_src_<cellId>` | service | `{source, truncated}` — one key per cell, **active tab only**; the outgoing tab's keys are tombstoned on `set-tab` |
| `jpy_out_<cellId>` | service | `{state, outputs[], exec_count}` — one key per cell |
| `jpy_save` | service | `{state, path, at, error}` — `idle` / `saving` / `saved` / `stale` / `unsaveable` / `error` |
| `jpy_browse` | service | `{dir, up, entries[]}` — a transient directory listing for the picker |
| `jpy_hist` | service | `{rev, depth, can_undo, can_redo, cells:{id:rev}}` — counters and labels only |
| `jpy_ctl` | pane (or you) | the control key — **never wakes Claude** |
| `jpy_ask` | pane | the one declared signal, on "Ask Claude" |

Outputs and source are per-cell keys on purpose: store merges are a top-level `Object.assign`
with no append primitive, so a single key would resend everything on every change.

**Typing writes nothing to the store.** The pane owns the live buffer; the service publishes
source only when the *file* state changes — load, reload, revert, tab switch, and a save that
altered content. Measured on a 60-cell / 191 KB notebook: an edit used to cost ~205 KB of
store writes and now costs **0 bytes**. That matters because the whole store is copied into
every committed graph node, appended whole to the 1000-slot event ring, and re-sent on every
WS hello — so per-keystroke republishing was permanently inflating every node on disk.

Source is published for the **active tab only**. `params.notebooks` allows twelve, and
carrying all of them would put every open notebook into every committed node.

### Steering a live pane yourself

```js
set_store({ patch: { jpy_ctl: { seq: Date.now(), op: 'run-all' } } })
// `seq` must be STRICTLY GREATER than the last one the service applied. Date.now()
// is fine for a one-off steer, but two writes in the same millisecond collide and
// the second is dropped — which is exactly the bug that made the pane's own Save
// silently never work. If you send several ops, increment past the previous seq.
```

**`set_store` needs its `patch` wrapper.** The unwrapped form merges nothing and still
returns `ok:true` — a silent no-op.

Ops: `connect {index}`, `discover`, `set-tab {id}`, `run {cell}`, `run-all`, `interrupt`,
`restart`, `reload`. A write stamped at or before the service's start time is treated as a
resurrected value from an older graph node, so **navigating the graph never re-runs a cell** —
only `set-tab`, `reload` and `discover` replay.

## Editing, autosave and undo

Code cells are editable. **There is no Save button and no Revert button** — the notebook
autosaves and the undo history is the safety net.

- **Autosave** fires ~1.2s after you stop typing, with a 15s ceiling while typing continues.
  Structural changes (insert / delete / move / type change) save immediately. A run saves in
  parallel, never blocking execution. Tab switch and service shutdown flush first.
- **The status chip** sits where the two buttons were: `saved 14:22:07` normally, `3 unsaved`
  while a burst is pending, and a **clickable warning** when something failed — `⚠ save failed
  — retry`, `⚠ changed on disk — choose`, `⚠ not saving`. It is the only indicator that your
  typing is reaching disk, which is why it cannot go to zero: several of the service's refusal
  paths publish nothing at all.
- **Undo has two scopes, and buttons for each.** Every cell carries `↶` and `↷` — undo and
  redo for *that cell*, leaving its neighbours alone. The toolbar Undo/Redo walk the
  whole-document history: insertions, deletions, moves, type changes and sealed typing bursts.
  Both per-cell buttons disable themselves when there is nothing to do, from
  `jpy_hist.cells` / `jpy_hist.cells_redo`.
- **Per-cell undo walks the journal; per-cell redo is a session stack.** That asymmetry is
  deliberate. Every `cell-undo` seals a new version, so the versions created by walking *back*
  sit after the originals chronologically — a forward walk re-encounters the walk's own
  history and never exhausts. A stack of the values undone away from is exact. The cost is
  that **redo does not survive a service respawn**, which matches how editors behave; undo
  does, because it is on disk.
- **Keys mirror the buttons exactly.** ⌘/Ctrl+Z **inside** a cell sends per-cell undo;
  **outside** one it drives document history. ⌘/Ctrl+Shift+Z and Ctrl+Y redo. The binding
  requires a real modifier and matches the *physical* key (`e.code`), so non-Latin layouts
  work. The pane is `tabindex="-1"` and focuses itself on click — without that the shadow-root
  key listener only fires while a pane button happens to hold focus, which is the single
  biggest reason keyboard undo appeared unreliable.
- **In-cell ⌘Z is handled by the pane, not the browser.** Chrome's undo stack is per *frame*,
  not per textarea, so the native chord could rewind an edit in a different cell — or in the
  surface's own fields.
- **The history lives on host disk**, under `<webChatDir>/jpy-history/<hash>/`, because a
  pane-held stack dies to a `[` keystroke, a re-render, or the service stopping when its pane
  leaves the active node. Capped at 60 versions / 24 MB, pruned oldest-first.
- **Undo does not un-run a cell.** Restoring an old output would assert a kernel state that is
  no longer true, so outputs are left alone.

## Saving

Code cells are editable. A run carries the live buffer (`jpy_ctl {op:'run', cell, source}`),
so "run what I'm looking at" needs no save first. **⌘/Ctrl+Enter** runs the cell, **⌘/Ctrl+S**
saves, Tab inserts four spaces.

**Saving goes through Jupyter, not through the filesystem.** The service `PUT`s to
`/api/contents/<path>`, so a JupyterLab session with the same notebook open sees the change
properly. Three consequences to state plainly to the user:

1. **Saving needs a connected server.** The read half still needs nothing; saving does.
2. **The notebook must be under the server's `root_dir`.** One outside it reports
   `saveable:false` with a hint and the Save button is disabled — the contents API simply
   cannot address it. Start a server whose root contains the file, or move it.
3. **A save is refused if the file changed on disk.** Jupyter does no optimistic concurrency,
   so the service compares `last_modified` itself and reports `jpy_save.state:'stale'` rather
   than overwriting someone else's edit. Reload, then re-apply.

Only cell **source** is written. Outputs are never written back, and the service mutates the
originally parsed notebook rather than re-serialising its own model — so cell metadata,
attachments, raw cells, notebook metadata and `nbformat_minor` survive untouched.

### Markdown cells

Markdown and raw cells are editable, with an `Edit`/`Done` toggle, double-click on the
preview to edit, and Escape or ⌘/Ctrl+Enter to render.

**Editing is a latch, not a computed state.** A cell opens as an editor when it is empty —
which covers both a just-inserted cell and one emptied and clicked away from, neither of
which should be an invisible empty preview. But the rule cannot be re-evaluated on every
render: the first autosave republishes `jpy_src_`, which forces one, and a cell that just
stopped being empty would have the preview swapped in underneath the caret. So the pane
commits to editing on the way *in*, and only `Done` / Escape / ⌘Enter — or a type change —
takes it back out. Two consequences worth knowing:

- A markdown cell you emptied stays an editor, because it is still empty.
- `To py` then `To md` comes back **rendered**. The latch is per DOM node and a node outlives
  its type, so it is released whenever the cell is not markdown.

**Its editor is built inside a hidden container**, which is a trap for anything that measures.
The textarea auto-sizes to its content, and a measurement taken while the container is
`display:none` reads 0 — so the auto-sizer refuses to write a height it could not measure,
and `renderCells` re-measures on the transition out of hidden. Without both halves you get a
0px-tall textarea holding exactly the right text: focusable, typable, invisible.

## Known gaps

- **Restoring a deleted cell does not restore its outputs.** The source comes back; the output
  does not, for the same reason undo does not un-run a cell.
- **Cell ids are unique within a notebook, not across two of them.** `cellId()` synthesises
  `'c' + index` for a cell with no `id` — every cell of an nbformat 4.0–4.4 file — and two
  such notebooks both start at `c0`. Two copies of the same 4.5 notebook collide the same way,
  with real ids. The pane now drops every per-cell buffer on a tab switch, which closes the
  path that mattered: one notebook's unsaved text could otherwise be shown in another's cell
  and then run and saved into it. What is left is display-level — `jpy_out_<id>` and
  `jpy_src_<id>` are shared keys, so at load the second notebook's saved outputs land on the
  first one's keys, and closing one tab nulls keys the other still uses.
  **The real fix is in the service**, because those store keys are its to mint: namespace the
  projection id per file in `readNotebook` (a hash of the absolute path), keep it on the tab,
  and have inserts write only the bare id into the raw cell so the FILE is unchanged. That
  changes `service.js`, so it re-asks for trust, and it invalidates existing journals for a
  notebook (their snapshots hold the old bare ids) — worth doing deliberately, not as a
  drive-by.
- **A notebook the contents API cannot address gets a bare kernel, and that one does leak.**
  Kernel acquisition goes through Jupyter **sessions** (see below), which are keyed on a path
  inside the server root. A notebook outside it has no such path — the same reason it cannot
  be saved — so it falls back to a bare `api/kernels` POST that nothing can ever re-find.

## Things that will bite you

- **A cell is done on iopub `status{execution_state:'idle'}` for its `msg_id`, not on
  `execute_reply`.** Measured against a live kernel: the reply arrives *first*. Finishing on
  it truncates trailing output.
- **The execution count comes from `execute_input`, never from `execute_result`.**
  `execute_input` is broadcast at the START of every execution and always carries
  `execution_count` — it is why JupyterLab can show `In [5]` the moment a cell begins.
  `execute_result` carries one too, but a kernel emits that message ONLY when a cell's last
  statement produces a *value*. Read it there and a cell that just printed, only called
  `display()`, assigned a variable, or raised runs perfectly and keeps a blank `In [ ]`
  for ever. Across a mixed notebook that reads as "only the first couple of cells ran", which
  is how it was reported. `display_data` has no `execution_count` in the protocol at all,
  so testing for one there is always a no-op.
  `test/exec-harness.mjs` runs one cell per ending — expression, print, display, assignment,
  exception — because the two cells the older tests ran both happened to end in a bare
  expression, which is exactly the one shape that masked this.
- **nbformat multiline fields are a string OR a list joined with `''`** — not `'\n'`. The
  lines carry their own newlines.
- **The service writes notebooks, but only cell source, and only through Jupyter.** Outputs
  are never written back. It refuses to save a notebook it is holding truncated, and refuses
  when the file changed on disk — so "saved" is a claim you can repeat to the user, and
  anything else is on `jpy_save.state`.
- **`application/javascript` and ipywidgets are rendered inert**, with a badge. Widgets need
  a live comm channel the pane has no transport for.
- **Cell `text/html` is rebuilt, not filtered** — an allowlist of tags with every attribute
  dropped. A pandas DataFrame survives as a clean table; its `<style>` block does not.

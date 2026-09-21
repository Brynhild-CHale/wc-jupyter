---
name: jpy-demo
description: Show the wc-jupyter demo notebook on the web-chat surface — a signal-analysis notebook that exercises every output kind the pane can render (pandas tables, matplotlib PNG and SVG, interactive plotly, streamed output, ANSI colour, JSON, rendered Markdown with tables, a traceback, and two honest failures). Use when asked to demo wc-jupyter, show what the notebook pane can do, or check that rendering still works end to end.
---

# The wc-jupyter demo

The notebook is carried inside `jpy-notebook`'s `service.js`, so it ships with the pack and
needs no file on disk beforehand. The `demo` control op writes it into `open_root` and opens
it as a tab.

## Running it

1. **Check a Jupyter server is up.** The pack discovers it from Jupyter's own runtime files;
   there is no token to configure. If none is running:

   ```sh
   uv run --with jupyter-server --with ipykernel --with numpy --with pandas \
     --with matplotlib --with plotly \
     python -m jupyter_server --no-browser --port=8899 --ServerApp.root_dir=/tmp/wc-jpy-live
   ```

2. **Mount the pane with renderers on.** `renderers: true` is what lets the interactive
   plotly cells draw — it permits the service to read a renderer's JavaScript out of the
   kernel's site-packages and serve it on loopback, so it is part of the consent key and
   shows on the approval line.

   ```js
   use_component({
     name: 'jpy-notebook',
     id: 'jpy-notebook-main',
     params: { notebooks: [], open_root: '/tmp/wc-jpy-live', renderers: true },
     signals: [{ key: 'jpy_ask', wake: 'queue' }],
   })
   ```

3. **Tell the user the trust command** and wait for it. The pane sits empty until they run it:

   > Run `claude-web-chat trust jpy-notebook` in your terminal.

4. **Write and open the notebook** by setting the control key:

   ```js
   set_store({ jpy_ctl: { seq: Date.now(), op: 'demo' } })
   ```

   The service answers on `jpy_demo` with `{ state: 'ready', path, needs }`. `needs` lists the
   Python packages the notebook imports.

5. **Install anything missing** — into the live kernel, with nothing restarting:

   ```js
   set_store({ jpy_ctl: { seq: Date.now(), op: 'install', package: 'matplotlib' } })
   ```

   Watch `jpy_install` for `installed` / `unavailable` / `refused`. Renderer discovery re-runs
   automatically, so a fresh `plotly` becomes drawable in the same session.

6. **Run it**: `set_store({ jpy_ctl: { seq: Date.now(), op: 'run-all' } })`, then point the
   user at the pane rather than narrating what it shows.

## What to say about it

Two cells fail **on purpose** and are part of the demo, not a fault:

- a `ZeroDivisionError`-style traceback, to show errors render with their real stack
- `Math(...)` falling back to its `repr`, because `text/latex` is not on the mime ladder
- a fake vendor mime that is **named** rather than silently dropped

If plotly is not installed the interactive cells degrade to a repr with a badge saying which
renderer is missing. That is the designed behaviour — say so rather than treating it as a
break.

## If a cell sits at `In [*]`

Check `jpy_conn` first. A cell that never settles almost always means the kernel socket was
replaced mid-run; Restart clears it. `test/feasibility/09-restart-race.mjs` in the pack
characterises the remaining rate.

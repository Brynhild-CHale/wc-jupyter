const fs = require('fs');
const { mkEl, makeRoot, install } = require('./dom-shim.cjs');
install();

const path = require('path');
// Relative to THIS file, so the suite runs from any checkout and any cwd.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'components', 'jpy-notebook', 'component.html'), 'utf8');
const body = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

// A store with the same pub/sub contract the shell injects.
function makeStore() {
  const state = {}, subs = new Map();
  return {
    _state: state, _sent: [],
    get: (k) => (k === undefined ? { ...state } : state[k]),
    set(patch) { this._sent.push(patch); Object.assign(state, patch); for (const k of Object.keys(patch)) (subs.get(k) || []).forEach(f => f(patch[k])); },
    push(patch) { Object.assign(state, patch); for (const k of Object.keys(patch)) (subs.get(k) || []).forEach(f => f(patch[k])); },
    subscribe(k, fn) { if (!subs.has(k)) subs.set(k, new Set()); subs.get(k).add(fn); return () => subs.get(k).delete(fn); },
    _subCount: (k) => (subs.get(k) ? subs.get(k).size : 0),
  };
}

const IDS = ['tabs','run-all','interrupt','restart','save','revert','reload','save-state','dot','conn-text','conn-hint','servers','rescan','cells','tell','tell-note','tell-send','run-all-tell','undo','redo','choice','choice-text','choice-reload','choice-dismiss','addtab','picker','pk-up','pk-dir','pk-close','pk-list','pk-name','pk-new','pk-why'];
const root = makeRoot();
for (const id of IDS) root._register(id, mkEl(id === 'servers' ? 'select' : 'div'));
const store = makeStore();

new Function('store', 'root', 'params', 'mountId', body)(store, root, { notebooks: ['/x.ipynb'] }, 'jpy-notebook-main');

const cells = (n) => Array.from({ length: n }, (_, i) => ({ id: 'c' + i, type: 'code', head: 'line ' + i, len: 6, truncated: false, exec_count: null }));
// source now rides its own per-cell key, exactly as the service publishes it
const srcPatch = (cs, override) => { const p = {}; for (const c of cs) p['jpy_src_' + c.id] = { source: (override && override[c.id]) || ('line ' + c.id.slice(1)), truncated: false }; return p; };
const nbPatch = (cs) => ({ jpy_nb: { seq: 1, active: 't0', tabs: [{ id: 't0', name: 'x.ipynb', path: '/x.ipynb', cells: cs, saveable: true }] } });

let fails = 0;
const ok = (l, c, e) => { if (!c) fails++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (e !== undefined ? '  -> ' + String(e).slice(0, 90) : '')); };

const host = root.getElementById('cells');
store.push(srcPatch(cells(3)));
store.push(nbPatch(cells(3)));
const tas = () => host.children.filter(n => n.className && n.className.includes('cell')).map(w => (w.children.find(c => c.className === 'src') || { children: [] }).children.find(c => c.tagName === 'TEXTAREA')).filter(Boolean);

const firstPass = tas();
ok('renders one textarea per code cell', firstPass.length === 3, firstPass.length);
ok('textarea carries its cell id', firstPass[0].dataset.cell === 'c0', firstPass[0].dataset.cell);
ok('value seeded from source', firstPass[0].value === 'line 0', firstPass[0].value);

console.log('\n— THE UNDO PROPERTY: node identity across a re-render —');
store.push({ jpy_out_c1: { seq: 2, state: 'ok', outputs: [{ kind: 'stream', name: 'stdout', text: 'hi' }] } });
const secondPass = tas();
ok('same textarea OBJECT for c0 after an output tick', secondPass[0] === firstPass[0]);
ok('same textarea OBJECT for c1 (the cell that produced output)', secondPass[1] === firstPass[1]);
ok('same textarea OBJECT for c2', secondPass[2] === firstPass[2]);

console.log('\n— a focused cell is never written to —');
const ta = firstPass[0];
ta.value = 'the user is typing';
root.activeElement = ta;
store.push({ jpy_out_c2: { seq: 3, state: 'ok', outputs: [{ kind: 'stream', name: 'stdout', text: 'x' }] } });
ok('focused textarea keeps the typed value', ta.value === 'the user is typing', ta.value);
ok('and is still the same object', tas()[0] === ta);

console.log('\n— unfocused cells still take authoritative updates —');
root.activeElement = null;
store.push({ jpy_src_c2: { source: 'CHANGED ON DISK', truncated: false } });
ok('unfocused cell adopts the new source', tas()[2].value === 'CHANGED ON DISK', tas()[2].value);

console.log('\n— removing a cell unsubscribes it —');
const before = store._subCount('jpy_out_c2');
store.push(nbPatch(cells(2)));
ok('c2 was subscribed before removal', before === 1, before);
ok('c2 unsubscribed after removal', store._subCount('jpy_out_c2') === 0, store._subCount('jpy_out_c2'));
ok('two textareas remain', tas().length === 2, tas().length);

console.log('\n— ordering after an insertion —');
const five = cells(5);
store.push(srcPatch(five));
store.push(nbPatch(five));
const ids = tas().map(t => t.dataset.cell);
ok('DOM order matches notebook order', ids.join(',') === 'c0,c1,c2,c3,c4', ids.join(','));


console.log('\n— the chip replaces the two buttons —');
store.push({ jpy_save: { seq: 1, state: 'saved', at: Date.now(), path: '/x.ipynb' } });
const chip = root.getElementById('save-state');
ok('chip shows a saved time', /^saved \d/.test(chip.textContent), chip.textContent);
store.push({ jpy_save: { seq: 2, state: 'error', error: 'HTTP 500', path: '/x.ipynb' } });
ok('a failure is marked and clickable', chip.className.includes('bad') && typeof chip.onclick === 'function', chip.textContent);
store.push({ jpy_save: { seq: 3, state: 'stale', error: 'moved', path: '/x.ipynb' } });
ok('a conflict offers a choice', chip.textContent.includes('changed on disk'), chip.textContent);

console.log('\n— undo is scoped to focus —');
store.push({ jpy_hist: { seq: 1, rev: 3, depth: 4, can_undo: true, can_redo: false, undo_label: 'typing' } });
ok('undo enabled from jpy_hist', root.getElementById('undo').disabled === false);
ok('redo disabled from jpy_hist', root.getElementById('redo').disabled === true);
let sentBefore = store._sent.length;
// A BARE z must do nothing at all. It used to rewind the whole document in the
// one state where the binding was live (a focused pane button).
root.activeElement = null;
root.dispatch('keydown', { key: 'z', shiftKey: false, code: 'KeyZ' });
ok('a bare z does nothing (it used to rewind the document)', store._sent.length === sentBefore);

// Cmd/Ctrl+Z outside a cell drives DOCUMENT history.
root.dispatch('keydown', { key: 'z', shiftKey: false, code: 'KeyZ', metaKey: true });
let lastSent = store._sent[store._sent.length - 1];
ok('Cmd+Z outside a cell drives document undo', lastSent && lastSent.jpy_ctl && lastSent.jpy_ctl.op === 'undo', lastSent && lastSent.jpy_ctl && lastSent.jpy_ctl.op);

// Cmd/Ctrl+Z INSIDE a cell now routes to per-cell undo rather than deferring to
// the browser, whose undo stack is per-frame and can rewind a different cell.
const focusTa = tas()[0];
root.activeElement = focusTa;
root.dispatch('keydown', { key: 'z', shiftKey: false, code: 'KeyZ', metaKey: true });
lastSent = store._sent[store._sent.length - 1];
ok('Cmd+Z inside a cell sends cell-undo for that cell', lastSent && lastSent.jpy_ctl && lastSent.jpy_ctl.op === 'cell-undo' && lastSent.jpy_ctl.cell === focusTa.dataset.cell, lastSent && JSON.stringify(lastSent.jpy_ctl));

// Ctrl+Y is redo for Windows muscle memory.
root.activeElement = null;
root.dispatch('keydown', { key: 'y', code: 'KeyY', ctrlKey: true });
lastSent = store._sent[store._sent.length - 1];
ok('Ctrl+Y is redo', lastSent && lastSent.jpy_ctl && lastSent.jpy_ctl.op === 'redo', lastSent && lastSent.jpy_ctl && lastSent.jpy_ctl.op);

// The physical key is what matters, so a non-Latin layout still works.
sentBefore = store._sent.length;
root.dispatch('keydown', { key: 'я', code: 'KeyZ', metaKey: true });
ok('matches the PHYSICAL key, so non-Latin layouts work', store._sent.length > sentBefore);

console.log('\n— the cell-type toggle is a ROUND TRIP —');
const mixed = [
  { id: 'k0', type: 'code', head: 'x = 1', len: 5, truncated: false, exec_count: null },
  { id: 'k1', type: 'markdown', head: '# note', len: 6, truncated: false, exec_count: null },
];
store.push({ jpy_src_k0: { source: 'x = 1', truncated: false }, jpy_src_k1: { source: '# note', truncated: false } });
store.push({ jpy_nb: { seq: 9, active: 't0', tabs: [{ id: 't0', name: 'x.ipynb', path: '/x.ipynb', lang: 'python', saveable: true, cells: mixed }] } });
// Each cell renders THREE rows: the cell, a (hidden) output row that also
// carries className 'cell', and the insert gap. Select the real cell wraps by
// the fact that they contain a cellbar.
const rows = () => host.children.filter(n => (n.children || []).some(ch => ch.className === 'cellbar'));
const barFor = (i) => (rows()[i].children || []).find(ch => ch.className === 'cellbar');
const labels = (bar) => (bar ? bar.children.map(b => b.textContent) : []);
ok('a CODE cell has a bar offering To md', labels(barFor(0)).includes('To md'), labels(barFor(0)).join('|'));
ok('a MARKDOWN cell has a bar too (it had none before)', !!barFor(1), labels(barFor(1)).join('|'));
ok('and it offers the way back, named for the language', labels(barFor(1)).includes('To py'), labels(barFor(1)).join('|'));
const shown = (b) => (b ? b.children.filter(x => !x.hidden).map(x => x.textContent) : []);
ok('markdown cell shows no Run button', !shown(barFor(1)).includes('Run'), shown(barFor(1)).join('|'));
ok('...and the code cell above it does', shown(barFor(0)).includes('Run'), shown(barFor(0)).join('|'));

// flip k1 back to code and confirm the SAME node relabels rather than freezing
const beforeBar = barFor(1);
store.push({ jpy_nb: { seq: 10, active: 't0', tabs: [{ id: 't0', name: 'x.ipynb', path: '/x.ipynb', lang: 'python', saveable: true, cells: [mixed[0], { ...mixed[1], type: 'code' }] }] } });
ok('the same cell node was reused', barFor(1) === beforeBar);
ok('its label flipped to To md', labels(barFor(1)).includes('To md'), labels(barFor(1)).join('|'));

console.log('\n— markdown cells: editor vs preview —');
const mdCells = [
  { id: 'e0', type: 'markdown', head: '', len: 0, truncated: false, exec_count: null },
  { id: 'e1', type: 'markdown', head: '# filled', len: 8, truncated: false, exec_count: null },
  { id: 'e2', type: 'markdown', head: '# three', len: 24, truncated: false, exec_count: null },
];
store.push({ jpy_src_e0: { source: '', truncated: false }, jpy_src_e1: { source: '# filled', truncated: false },
             jpy_src_e2: { source: '# three\n\nlines of it' } });
store.push({ jpy_nb: { seq: 20, active: 't0', tabs: [{ id: 't0', name: 'x.ipynb', path: '/x.ipynb', lang: 'python', saveable: true, cells: mdCells }] } });
const wrapOf = (i) => rows()[i];
const partOf = (i, cls) => (wrapOf(i).children || []).find(ch => ch.className === cls);
ok('an EMPTY markdown cell shows the editor', partOf(0,'src') && partOf(0,'src').hidden === false, 'src.hidden=' + (partOf(0,'src')||{}).hidden);
ok('...and hides the empty preview', partOf(0,'md') && partOf(0,'md').hidden === true, 'md.hidden=' + (partOf(0,'md')||{}).hidden);
ok('a FILLED markdown cell shows the preview', partOf(1,'md') && partOf(1,'md').hidden === false, 'md.hidden=' + (partOf(1,'md')||{}).hidden);
ok('...and hides its editor', partOf(1,'src') && partOf(1,'src').hidden === true, 'src.hidden=' + (partOf(1,'src')||{}).hidden);
const mdBar = (i) => (wrapOf(i).children || []).find(ch => ch.className === 'cellbar');
const editBtn = (i) => (mdBar(i).children || []).find(b => b.textContent === 'Edit' || b.textContent === 'Done');
ok('a markdown cell offers an Edit toggle', !!editBtn(1), (mdBar(1).children||[]).map(b=>b.textContent).join('|'));
editBtn(1).onclick();
ok('Edit reveals the editor on the filled cell', partOf(1,'src').hidden === false);
ok('and the toggle now reads Done', editBtn(1).textContent === 'Done', editBtn(1).textContent);

// A rendered markdown cell builds its editor INSIDE a hidden container, so the
// frame that auto-sizes it measures 0 — and revealing it later changes no
// value, so nothing re-measures. The box was there, focusable, holding exactly
// the right text, and 0px tall.
console.log('\n— a revealed markdown editor has to be visible —');
global.__flushFrames();                      // the build frame lands while .src is hidden
const taOf = (i) => partOf(i,'src').children.find(x => x.tagName === 'TEXTAREA');
ok('auto-size while hidden does NOT write height:0px', taOf(2).style.height !== '0px', 'height=' + JSON.stringify(taOf(2).style.height));
editBtn(2).onclick();
ok('Edit reveals the editor', partOf(2,'src').hidden === false);
ok('...holding the cell source', taOf(2).value === '# three\n\nlines of it', JSON.stringify(taOf(2).value));
ok('...sized to its 3 lines, not collapsed', taOf(2).style.height === '54px', 'height=' + JSON.stringify(taOf(2).style.height));
editBtn(2).onclick();
ok('Done hides it again', partOf(2,'src').hidden === true);
taOf(2).style.height = '999px';        // make the stale value distinguishable
editBtn(2).onclick();
ok('and a second Edit re-measures rather than reusing a stale height', taOf(2).style.height === '54px', 'height=' + JSON.stringify(taOf(2).style.height));
editBtn(2).onclick();

// A new markdown cell shows the editor BECAUSE it is empty. The moment the user
// types, it is no longer empty — so the next render (and the first autosave
// forces one, by republishing jpy_src_) computed editing=false and swapped the
// preview in underneath the caret. The empty-cell rule has to be a latch.
console.log('\n— typing in a new markdown cell must not swap the preview in —');
store.push({ jpy_src_e3: { source: '', truncated: false } });
store.push({ jpy_nb: { seq: 21, active: 't0', tabs: [{ id: 't0', name: 'x.ipynb', path: '/x.ipynb', lang: 'python', saveable: true,
  cells: mdCells.concat([{ id: 'e3', type: 'markdown', head: '', len: 0, truncated: false, exec_count: null }]) }] } });
ok('a fresh markdown cell opens as an editor', partOf(3,'src').hidden === false, 'src.hidden=' + partOf(3,'src').hidden);
const newTa = partOf(3,'src').children.find(x => x.tagName === 'TEXTAREA');
newTa.focus();
newTa.value = '# typing here'; newTa.oninput();
// the autosave lands: the service writes the file and republishes the source
store.push({ jpy_src_e3: { source: '# typing here', truncated: false } });
ok('the editor is STILL on screen after the cell stops being empty', partOf(3,'src').hidden === false, 'src.hidden=' + partOf(3,'src').hidden);
ok('...and still holds the text', newTa.value === '# typing here', newTa.value);
ok('...and the preview stays out of the way', partOf(3,'md').hidden === true, 'md.hidden=' + partOf(3,'md').hidden);
const doneBtn = (mdBar(3).children || []).find(b => b.textContent === 'Done' || b.textContent === 'Edit');
ok('the toggle reads Done, so there is a way out', doneBtn.textContent === 'Done', doneBtn.textContent);
doneBtn.onclick();                       // with the caret still inside, as a user would
ok('Done renders it', partOf(3,'md').hidden === false && partOf(3,'src').hidden === true, 'md=' + partOf(3,'md').hidden + ' src=' + partOf(3,'src').hidden);
ok('and the rendered markdown is the typed text', partOf(3,'md').children.length > 0 && partOf(3,'md').textContent.includes('typing here'), partOf(3,'md').textContent);

// The editing latch is per NODE, and a node outlives its type. Converting away
// to code and back has to come back RENDERED, not as a raw editor holding the
// latch from whenever it was last edited.
console.log('\n— the edit latch is released by a type change —');
const tabWith = (seq, cells) => ({ jpy_nb: { seq, active: 't0', tabs: [{ id: 't0', name: 'x.ipynb', path: '/x.ipynb', lang: 'python', saveable: true, cells }] } });
const four = mdCells.concat([{ id: 'e3', type: 'markdown', head: '', len: 0, truncated: false, exec_count: null }]);
editBtn(3).onclick();                       // establish the state, do not inherit it
ok('the cell is mid-edit to start with', partOf(3,'src').hidden === false && editBtn(3).textContent === 'Done', 'src=' + partOf(3,'src').hidden + ' btn=' + editBtn(3).textContent);
store.push(tabWith(22, four.slice(0,3).concat([{ id: 'e3', type: 'code', head: '# typing here', len: 13, truncated: false, exec_count: null }])));
ok('To py gives a code editor', partOf(3,'src').hidden === false && partOf(3,'md').hidden === true);
store.push(tabWith(23, four.slice(0,3).concat([{ id: 'e3', type: 'markdown', head: '# typing here', len: 13, truncated: false, exec_count: null }])));
ok('To md comes BACK rendered, not as a raw editor', partOf(3,'md').hidden === false && partOf(3,'src').hidden === true, 'md=' + partOf(3,'md').hidden + ' src=' + partOf(3,'src').hidden);
ok('and the Edit toggle is offered again', (mdBar(3).children || []).some(b => b.textContent === 'Edit'), (mdBar(3).children||[]).map(b=>b.textContent).join('|'));

console.log('\n— the per-cell undo button —');
const undoBtn = (i) => (mdBar(i).children || []).find(b => b.textContent === '\u21B6');
ok('every cell carries a per-cell undo button', !!undoBtn(0) && !!undoBtn(1));
ok('it is disabled when the cell has no history', undoBtn(1).disabled === true, undoBtn(1).disabled);
store.push({ jpy_hist: { seq: 5, rev: 4, depth: 5, can_undo: true, can_redo: false, cells: { e1: 3 } } });
ok('it goes live when jpy_hist says that cell has a prior value', undoBtn(1).disabled === false, undoBtn(1).disabled);
ok('a cell with no entry stays disabled', undoBtn(0).disabled === true, undoBtn(0).disabled);
const beforeSent = store._sent.length;
undoBtn(1).onclick();
const sent = store._sent[store._sent.length - 1];
ok('clicking it sends cell-undo for THAT cell', sent && sent.jpy_ctl && sent.jpy_ctl.op === 'cell-undo' && sent.jpy_ctl.cell === 'e1', sent && JSON.stringify(sent.jpy_ctl));
ok('and carries the live buffer inline', sent && typeof sent.jpy_ctl.source === 'string');

console.log('\n— the per-cell REDO button —');
const redoBtn = (i) => (mdBar(i).children || []).find(b => b.textContent === '\u21B7');
ok('every cell carries a redo button beside undo', !!redoBtn(0) && !!redoBtn(1));
ok('it sits immediately after undo', (() => { const cs = mdBar(1).children.map(b => b.textContent); return cs.indexOf('\u21B7') === cs.indexOf('\u21B6') + 1; })(), mdBar(1).children.map(b=>b.textContent).join('|'));
ok('disabled when the cell has nothing forward', redoBtn(1).disabled === true, redoBtn(1).disabled);
store.push({ jpy_hist: { seq: 6, rev: 4, depth: 5, can_undo: true, can_redo: true, cells: { e1: 3 }, cells_redo: { e1: 5 } } });
ok('enabled when cells_redo names it', redoBtn(1).disabled === false, redoBtn(1).disabled);
ok('a cell with no forward entry stays disabled', redoBtn(0).disabled === true, redoBtn(0).disabled);
redoBtn(1).onclick();
const rsent = store._sent[store._sent.length - 1];
ok('clicking it sends cell-undo with dir 1', rsent && rsent.jpy_ctl && rsent.jpy_ctl.op === 'cell-undo' && rsent.jpy_ctl.dir === 1 && rsent.jpy_ctl.cell === 'e1', rsent && JSON.stringify(rsent.jpy_ctl));

console.log('\n— the toolbar undo no longer repaints over itself —');
const ta0 = partOf(0,'src').children.find(x => x.tagName === 'TEXTAREA');
ta0.value = 'typed but not saved'; ta0.oninput();
root.getElementById('undo').onclick();
const undoSent = store._sent[store._sent.length - 1];
ok('toolbar undo sends undo', undoSent && undoSent.jpy_ctl && undoSent.jpy_ctl.op === 'undo', undoSent && undoSent.jpy_ctl && undoSent.jpy_ctl.op);
store.push({ jpy_src_e0: { source: 'RESTORED BY UNDO', truncated: false } });
ok('the restored text is NOT repainted with the stale buffer', ta0.value === 'RESTORED BY UNDO', ta0.value);

console.log('\n— typing then running must NOT revert the cell on screen —');
store.push({ jpy_src_r0: { source: 'original()', truncated: false } });
store.push({ jpy_nb: { seq: 30, active: 't0', tabs: [{ id: 't0', name: 'x.ipynb', path: '/x.ipynb', lang: 'python', saveable: true,
  cells: [{ id: 'r0', type: 'code', head: 'original()', len: 10, truncated: false, exec_count: null }] }] } });
const rTa = rows()[0].children.find(c => c.className === 'src').children.find(x => x.tagName === 'TEXTAREA');
ok('cell seeded from the file', rTa.value === 'original()', rTa.value);

// the user types, then runs
rTa.value = 'edited()'; rTa.oninput();
const runBtn = (rows()[0].children.find(c => c.className === 'cellbar').children || []).find(b => b.textContent === 'Run');
runBtn.onclick();
ok('the RUN carries the edited source', (() => { const l = store._sent[store._sent.length-1]; return l.jpy_ctl && l.jpy_ctl.op === 'run' && l.jpy_ctl.source === 'edited()'; })(), JSON.stringify(store._sent[store._sent.length-1].jpy_ctl));

// autosave completes. THIS is where the cell used to snap back to the old text:
// the pane cleared `edits` while jpy_src_ still held the load-time source.
store.push({ jpy_save: { seq: 40, state: 'saved', at: Date.now(), path: '/x.ipynb' } });
// jpy_save alone does not repaint. The revert surfaces on the NEXT render —
// and a run always produces one, because its output arrives on jpy_out_<id>.
store.push({ jpy_out_r0: { seq: 41, state: 'ok', outputs: [{ kind: 'stream', name: 'stdout', text: 'ran\n' }] } });
ok('the cell still shows what the user typed', rTa.value === 'edited()', rTa.value);

// ── found by the audit sweep, all four reproduced here before being fixed ──────

const only = (seq, cells) => store.push({ jpy_nb: { seq, active: 't1', tabs: [{ id: 't1', name: 'y.ipynb', path: '/y.ipynb', lang: 'python', saveable: true, cells }] } });
const rowAt = (i) => host.children.filter(n => (n.children || []).some(ch => ch.className === 'cellbar'))[i];
const part = (i, cls) => (rowAt(i).children || []).find(ch => ch.className === cls);
const bar = (i) => (rowAt(i).children || []).find(ch => ch.className === 'cellbar');
const btn = (i, ...txt) => (bar(i).children || []).find(b => txt.includes(b.textContent));

// jpy_nb and jpy_src_ are TWO pushes (pushNb and pushSrc), so a markdown cell is
// on screen for one render with no source yet. Latching "empty" there made the
// transient permanent: every markdown cell opened as a raw editor.
console.log('\n— the latch must not fire on a cell whose source has not arrived —');
only(50, [{ id: 'm1', type: 'markdown', head: '# later', len: 7, truncated: false, exec_count: null }]);
ok('with no source yet it shows the editor (it looks empty)', part(0,'src').hidden === false);
store.push({ jpy_src_m1: { source: '# later', truncated: false } });
ok('when the source lands it renders, it does NOT stay an editor', part(0,'md').hidden === false && part(0,'src').hidden === true, 'md=' + part(0,'md').hidden + ' src=' + part(0,'src').hidden);
ok('and the toggle offers Edit, not Done', btn(0,'Edit','Done').textContent === 'Edit', btn(0,'Edit','Done').textContent);

// isCode was read at BUILD time, so the Edit button was only ever appended to a
// cell that was markdown when its node was created. Same class of bug as the
// frozen "To md" label: a node outlives its type.
console.log('\n— a cell BUILT as code must be editable after To md —');
store.push({ jpy_src_m2: { source: 'x = 1', truncated: false } });
only(51, [{ id: 'm2', type: 'code', head: 'x = 1', len: 5, truncated: false, exec_count: null }]);
const codeNode = rowAt(0);
ok('it starts as a code cell', part(0,'src').hidden === false && btn(0,'Edit','Done').hidden === true && btn(0,'Run').hidden === false, 'edit.hidden=' + btn(0,'Edit','Done').hidden + ' run.hidden=' + btn(0,'Run').hidden);
only(52, [{ id: 'm2', type: 'markdown', head: 'x = 1', len: 5, truncated: false, exec_count: null }]);
ok('the same node was reused', rowAt(0) === codeNode);
ok('it now renders as markdown', part(0,'md').hidden === false, 'md=' + part(0,'md').hidden);
ok('and it HAS a visible Edit button', btn(0,'Edit','Done').hidden === false, 'edit.hidden=' + btn(0,'Edit','Done').hidden);
ok('...and stops offering Run, which markdown cannot do', btn(0,'Run').hidden === true, 'run.hidden=' + btn(0,'Run').hidden);
btn(0,'Edit','Done').onclick();
ok('which opens the editor with the text in it', part(0,'src').hidden === false && part(0,'src').children.find(x=>x.tagName==='TEXTAREA').value === 'x = 1');

// Notebook text is not trusted input: it arrives from whatever .ipynb was opened.
console.log('\n— a markdown link cannot smuggle a javascript: URL —');
store.push({ jpy_src_m3: { source: 'see [this](javascript:fetch("/x")) and [ok](https://example.com) and [rel](./a.png)', truncated: false } });
only(53, [{ id: 'm3', type: 'markdown', head: 'see', len: 40, truncated: false, exec_count: null }]);
const anchors = (el) => (el.children || []).flatMap(c => (c.tagName === 'A' ? [c] : anchors(c)));
const hrefs = anchors(part(0,'md')).map(a => a.href);
ok('the javascript: URL is not on any anchor', !hrefs.some(h => /javascript:/i.test(String(h))), JSON.stringify(hrefs));
ok('the https link survives', hrefs.includes('https://example.com'), JSON.stringify(hrefs));
ok('a relative link survives', hrefs.includes('./a.png'), JSON.stringify(hrefs));
ok('the suppressed link still shows its text', part(0,'md').textContent.includes('this'), part(0,'md').textContent);

// The service clears an output by publishing null for the key (a type change
// drops it, because outputs are not valid on a markdown cell).
console.log('\n— clearing an output has to clear it on screen —');
store.push({ jpy_src_m4: { source: 'print(1)', truncated: false } });
only(54, [{ id: 'm4', type: 'code', head: 'print(1)', len: 8, truncated: false, exec_count: 1 }]);
store.push({ jpy_out_m4: { seq: 1, state: 'ok', outputs: [{ kind: 'stream', name: 'stdout', text: 'one\n' }] } });
const outRow = () => host.children.find(n => n.className === 'cell' && (n.children||[]).some(c => (c.className||'').includes('out')));
ok('the output is on screen', !!outRow() && outRow().hidden === false);
store.push({ jpy_out_m4: null });
ok('and publishing null takes it away', !outRow() || outRow().hidden === true, outRow() && outRow().hidden);


// The note the user is typing TO CLAUDE was being deleted by the next render —
// and a render arrives on every output tick, so anything slower than a sentence
// was lost. It was a sibling in .cells, which reconciles by slot: unplaced
// children drift to the end and the trailing truncation removes them.
console.log('\n— the Ask Claude composer survives a re-render —');
store.push({ jpy_src_m5: { source: 'print(2)', truncated: false } });
only(55, [{ id: 'm5', type: 'code', head: 'print(2)', len: 8, truncated: false, exec_count: null }]);
btn(0,'Ask Claude').onclick();
const findComposer = () => {
  const walk = (n) => (n.className === 'composer' ? [n] : (n.children || []).flatMap(walk));
  return host.children.flatMap(walk)[0] || null;
};
ok('the composer opened', !!findComposer());
ok('...inside the cell, so it lines up with the source', findComposer().parentNode === rowAt(0), findComposer().parentNode && findComposer().parentNode.className);
const note = findComposer().children.find(x => x.tagName === 'TEXTAREA');
note.value = 'why is this slow?';
store.push({ jpy_out_m5: { seq: 9, state: 'ok', outputs: [{ kind: 'stream', name: 'stdout', text: '2\n' }] } });
ok('it is STILL there after an output arrives', !!findComposer());
ok('...and still holds the half-typed note', findComposer().children.find(x => x.tagName === 'TEXTAREA').value === 'why is this slow?', findComposer().children.find(x => x.tagName === 'TEXTAREA').value);
const beforeAsk = store._sent.length;
findComposer().children.find(x => x.textContent === 'Send').onclick();
const ask = store._sent[store._sent.length - 1];
ok('Send reaches jpy_ask with the note intact', ask && ask.jpy_ask && ask.jpy_ask.note === 'why is this slow?' && ask.jpy_ask.cell === 'm5', ask && JSON.stringify(ask.jpy_ask));
ok('and the composer closes', !findComposer());


// nbformat 4.0-4.4 has no cell ids, so service.js cellId() synthesises 'c' + index
// and TWO such notebooks both start at c0. Every per-cell map in the pane is keyed
// by that bare id.
console.log('\n— two notebooks with colliding cell ids must not share a buffer —');
const twoTabs = (active) => store.push({ jpy_nb: { seq: 60 + (active === 'ta' ? 0 : 1), active, tabs: [
  { id: 'ta', name: 'a.ipynb', path: '/a.ipynb', lang: 'python', saveable: true, cells: active === 'ta' ? [{ id: 'k0', type: 'code', head: '', len: 3, truncated: false, exec_count: null }] : [] },
  { id: 'tb', name: 'b.ipynb', path: '/b.ipynb', lang: 'python', saveable: true, cells: active === 'tb' ? [{ id: 'k0', type: 'code', head: '', len: 3, truncated: false, exec_count: null }] : [] },
] } });
twoTabs('ta');
store.push({ jpy_src_k0: { source: 'AAA', truncated: false } });
const anyTa = () => { const w = host.children.filter(n => (n.children||[]).some(c => c.className === 'cellbar'))[0];
  return ((w.children||[]).find(c => c.className === 'src').children||[]).find(x => x.tagName === 'TEXTAREA'); };
ok('notebook A shows its own source', anyTa().value === 'AAA', anyTa().value);
anyTa().value = 'UNSAVED EDIT IN A'; anyTa().oninput();
ok('and takes an unsaved edit', anyTa().value === 'UNSAVED EDIT IN A');
// the service publishes pushNb() BEFORE pushSrc(), so the switch is two writes
twoTabs('tb');
store.push({ jpy_src_k0: { source: 'BBB', truncated: false } });
ok("notebook B shows B's source, not A's unsaved buffer", anyTa().value === 'BBB', anyTa().value);
twoTabs('ta');
store.push({ jpy_src_k0: { source: 'AAA', truncated: false } });
ok('and back in A the file text is what shows', anyTa().value === 'AAA', anyTa().value);


// `hidden` is a UA-stylesheet rule and ANY author display: beats it. This pane
// sets display on .cell, .choice, .composer, .gap and .cellbar, and toggles
// hidden on two of them — so without an explicit override every output-less cell
// laid out an empty grid row and the stale-file band could not be dismissed.
// Asserted against the stylesheet text because a shim has no cascade.
console.log('\n— the stylesheet has to make [hidden] win —');
const CSS = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
const hiddenRule = CSS.match(/\[hidden\]\s*\{([^}]*)\}/);
ok('there is a [hidden] rule', !!hiddenRule, CSS.includes('[hidden]'));
ok('...and it is !important, or a display: below would outrank it', !!hiddenRule && /display\s*:\s*none\s*!important/.test(hiddenRule[1]), hiddenRule && hiddenRule[1].trim());
const setsDisplay = ['cell','choice','composer','gap','cellbar'].filter(c => {
  const m = CSS.match(new RegExp('\\.' + c + '\\s*\\{([^}]*)\\}'));
  return m && /(^|[;\s])display\s*:/.test(m[1]);
});
ok('the classes that would have defeated it are known', setsDisplay.length > 0, setsDisplay.join(','));
ok('...and the rule is declared before none of them matters (it is !important)', hiddenRule && hiddenRule[1].includes('!important'));

// Every handler built in buildCell closes over the cell object of the render
// that created the node — a snapshot. The node outlives the type.
console.log('\n— keyboard handlers follow the cell type, not the node age —');
only(56, [{ id: 'm6', type: 'code', head: 'y = 2', len: 5, truncated: false, exec_count: null }]);
store.push({ jpy_src_m6: { source: 'y = 2', truncated: false } });
const ta6 = () => part(0,'src').children.find(x => x.tagName === 'TEXTAREA');
let n0 = store._sent.length;
ta6().onkeydown({ key: 'Enter', metaKey: true, preventDefault(){} });
ok('as code, Cmd+Enter runs it', store._sent[store._sent.length-1].jpy_ctl.op === 'run', store._sent[store._sent.length-1].jpy_ctl.op);
only(57, [{ id: 'm6', type: 'markdown', head: 'y = 2', len: 5, truncated: false, exec_count: null }]);
btn(0,'Edit','Done').onclick();
n0 = store._sent.length;
ta6().onkeydown({ key: 'Enter', metaKey: true, preventDefault(){} });
ok('as markdown, Cmd+Enter renders instead of running', store._sent.length === n0 && part(0,'md').hidden === false, 'sent=' + (store._sent.length - n0) + ' md.hidden=' + part(0,'md').hidden);

// A tab switch now drops every per-cell map, so the outputs already published
// for the tab being returned to have to be re-seeded from the store.
console.log('\n— returning to a tab keeps its outputs —');
const twoB = (active) => store.push({ jpy_nb: { seq: 70 + (active === 'ua' ? 0 : 1), active, tabs: [
  { id: 'ua', name: 'p.ipynb', path: '/p.ipynb', lang: 'python', saveable: true, cells: active === 'ua' ? [{ id: 'p0', type: 'code', head: '', len: 3, truncated: false, exec_count: 1 }] : [] },
  { id: 'ub', name: 'q.ipynb', path: '/q.ipynb', lang: 'python', saveable: true, cells: active === 'ub' ? [{ id: 'q0', type: 'code', head: '', len: 3, truncated: false, exec_count: 1 }] : [] },
] } });
twoB('ua');
store.push({ jpy_src_p0: { source: 'p()', truncated: false }, jpy_out_p0: { seq: 3, state: 'ok', outputs: [{ kind: 'stream', name: 'stdout', text: 'P OUT\n' }] } });
const outText = () => host.children.filter(n => n.className === 'cell' && !n.hidden).map(n => n.textContent).join('|');
ok("tab P shows its output", outText().includes('P OUT'), outText());
twoB('ub');
store.push({ jpy_src_q0: { source: 'q()', truncated: false } });
ok("tab Q does not show P's output", !outText().includes('P OUT'), outText());
twoB('ua');
store.push({ jpy_src_p0: { source: 'p()', truncated: false } });
ok('...and coming back to P its output is still there', outText().includes('P OUT'), outText());

console.log('\n' + (fails ? fails + ' FAILING' : 'all green — textareas survive re-renders, so native undo survives with them'));
process.exit(fails ? 1 : 0);

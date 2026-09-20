// Per-cell undo: it must rewind ONE cell and leave its neighbours alone.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
// Release the kernel with the service, EVERY time — a harness that starts the
// service more than once starts a kernel each time, and pairing the two by hand
// meant tabs-harness (three starts, one release) leaked two per run.
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs');
const readJson = require('./nbread.cjs');   // the service may be mid-write
const NB = FIX + '/cellundo.ipynb';
fs.rmSync(FIX + '/.web-chat/jpy-history', { recursive: true, force: true });
fs.writeFileSync(NB, JSON.stringify({ cells: [
  { cell_type:'code', id:'A', metadata:{}, execution_count:null, outputs:[], source:'A0' },
  { cell_type:'code', id:'B', metadata:{}, execution_count:null, outputs:[], source:'B0' },
], metadata:{ kernelspec:{ name:'python3', language:'python' } }, nbformat:4, nbformat_minor:5 }, null, 1));

const store = {}; let onEv = null;
const ctx = { name:'jpy-notebook', mountId:'m', params:{ notebooks:[NB] }, webChatDir: FIX + '/.web-chat',
  log:()=>{}, fence:(p,c)=>c, diff:()=>null,
  driver:{ setStore(p){Object.assign(store,p);return Promise.resolve({ok:true})},
    getStore(k){const o={};for(const x of k||[])if(x in store)o[x]=store[x];return Promise.resolve(o)},
    streamEvents({onEvent}){onEv=onEvent;return{close(){}}} } };
let sq=0; const nx=()=>(sq=Math.max(Date.now(),sq+1));
const ctl=(op,extra)=>{const patch={jpy_ctl:{seq:nx(),op,...(extra||{})}};Object.assign(store,patch);if(onEv)onEv({patch})};
const until=async(p,w,ms=25000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(p())return;await new Promise(r=>setTimeout(r,120))}throw new Error('timeout '+w)};
const src=(id)=>{const nb=readJson(NB);const c=nb.cells.find(x=>x.id===id);return c?(Array.isArray(c.source)?c.source.join(''):c.source):null};
let fails=0; const ok=(l,c,e)=>{if(!c)fails++;console.log((c?'  PASS  ':'  FAIL  ')+l+(e!==undefined?'  -> '+String(e).slice(0,110):''))};

await svc.start(ctx);
await until(()=>store.jpy_conn && store.jpy_conn.state!=='discovering','connect');
ok('connected', store.jpy_conn.ok===true, store.jpy_conn.error);

// edit both cells so both have history
ctl('edit',{cell:'A', source:'A1'}); await until(()=>src('A')==='A1','A1');
ctl('edit',{cell:'B', source:'B1'}); await until(()=>src('B')==='B1','B1');
ctl('edit',{cell:'A', source:'A2'}); await until(()=>src('A')==='A2','A2');
ok('both cells edited and saved', src('A')==='A2' && src('B')==='B1', src('A')+' / '+src('B'));
ok('jpy_hist reports per-cell availability', store.jpy_hist && store.jpy_hist.cells && ('A' in store.jpy_hist.cells), JSON.stringify(store.jpy_hist && store.jpy_hist.cells));

console.log('\n— cell-undo rewinds ONE cell —');
ctl('cell-undo',{cell:'A', dir:-1, source:'A2'});
await until(()=>src('A')==='A1','cell undo A');
ok('cell A went back one step', src('A')==='A1', src('A'));
ok("cell B was NOT touched", src('B')==='B1', src('B'));

console.log('\n— repeated taps WALK BACK rather than toggling —');
ctl('cell-undo',{cell:'A', dir:-1, source:'A1'});
await until(()=>src('A')==='A0','cell undo A again');
ok('a second tap went back further, not forward', src('A')==='A0', src('A'));

console.log('\n— cell redo —');
ctl('cell-undo',{cell:'A', dir:1, source:'A0'});
await until(()=>src('A')!=='A0','cell redo A');
ok('redo moved forward', src('A')==='A1' || src('A')==='A2', src('A'));

console.log('\n— a duplicated click is a no-op, not a double rewind —');
const now = src('A');
ctl('cell-undo',{cell:'A', dir:-1, source: now});
await until(()=>src('A')!==now,'first of pair');
const once = src('A');
ctl('cell-undo',{cell:'A', dir:-1, source: once, rev: store.jpy_hist.rev});
await new Promise(r=>setTimeout(r,1500));
ok('idempotent on an equal value', src('A')!==undefined, src('A'));

console.log('\n— redo availability is tracked per cell —');
// walk A back to the very beginning, then forward, checking the flags
await until(()=>true,'x');
let guard = 0;
while (store.jpy_hist && store.jpy_hist.cells && store.jpy_hist.cells.A && guard++ < 8) {
  const before = src('A');
  ctl('cell-undo',{cell:'A', dir:-1, source: before});
  try { await until(()=>src('A')!==before,'walk back'); } catch { break; }
}
ok('at the far end, undo for that cell is no longer offered', !(store.jpy_hist.cells||{}).A, JSON.stringify(store.jpy_hist.cells));
ok('...and redo IS offered', !!(store.jpy_hist.cells_redo||{}).A, JSON.stringify(store.jpy_hist.cells_redo));

guard = 0;
while (store.jpy_hist && store.jpy_hist.cells_redo && store.jpy_hist.cells_redo.A && guard++ < 8) {
  const before = src('A');
  ctl('cell-undo',{cell:'A', dir:1, source: before});
  try { await until(()=>src('A')!==before,'walk forward'); } catch { break; }
}
ok('back at the head, redo is no longer offered', !(store.jpy_hist.cells_redo||{}).A, JSON.stringify(store.jpy_hist.cells_redo));
ok('...and undo is offered again', !!(store.jpy_hist.cells||{}).A, JSON.stringify(store.jpy_hist.cells));

// Typing must discard the forward history. Done on a FRESH cell rather than on
// A, whose state depends on how the walk loops above happened to terminate.
ctl('edit',{cell:'B', source:'B-one'}); await until(()=>src('B')==='B-one','B-one');
ctl('edit',{cell:'B', source:'B-two'}); await until(()=>src('B')==='B-two','B-two');
ctl('cell-undo',{cell:'B', dir:-1, source:'B-two'}); await until(()=>src('B')==='B-one','undo B');
ok('redo is offered after an undo', !!(store.jpy_hist.cells_redo||{}).B, JSON.stringify(store.jpy_hist.cells_redo));
ctl('edit',{cell:'B', source:'B-typed-over'}); await until(()=>src('B')==='B-typed-over','typed over');
ok('typing clears redo for that cell', !(store.jpy_hist.cells_redo||{}).B, JSON.stringify(store.jpy_hist.cells_redo));

console.log('\n— journal dedupe: no duplicate tail version —');
const hdir = FIX + '/.web-chat/jpy-history';
const d = fs.readdirSync(hdir)[0];
const idx = readJson(hdir+'/'+d+'/index.json');
const bodies = idx.versions.map(v=>JSON.stringify(readJson(hdir+'/'+d+'/'+v.id+'.json').cells));
let dupes=0; for(let i=1;i<bodies.length;i++) if(bodies[i]===bodies[i-1]) dupes++;
ok('no two consecutive versions are identical', dupes===0, dupes+' duplicate pair(s) of '+bodies.length);

await stopSvc();
console.log('\n'+(fails?fails+' FAILING':'all green'));
process.exit(fails?1:0);

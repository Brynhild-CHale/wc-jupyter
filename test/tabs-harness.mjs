// Runtime tabs: browse, open, new, close — and the fence that bounds them.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
// Release the kernel with the service, EVERY time — a harness that starts the
// service more than once starts a kernel each time, and pairing the two by hand
// meant tabs-harness (three starts, one release) leaked two per run.
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs'), path = require('path');
const readJson = require('./nbread.cjs');   // the service may be mid-write
const A = FIX + '/tabs-a.ipynb', B = FIX + '/tabs-b.ipynb';
fs.rmSync(FIX + '/.web-chat/jpy-tabs', { recursive: true, force: true });
for (const p of [A, B]) fs.writeFileSync(p, JSON.stringify({ cells:[{cell_type:'code',id:'x',metadata:{},execution_count:null,outputs:[],source:'# '+path.basename(p)}], metadata:{kernelspec:{name:'python3',language:'python'}}, nbformat:4, nbformat_minor:5 }, null, 1));
// a notebook OUTSIDE the boundary
fs.mkdirSync('/tmp/wc-jpy-outside', { recursive: true });
fs.writeFileSync('/tmp/wc-jpy-outside/secret.ipynb', JSON.stringify({ cells:[], metadata:{}, nbformat:4, nbformat_minor:5 }));

const store = {}; let onEv = null;
const mk = (extra) => ({ name:'jpy-notebook', mountId:'m1', params:{ notebooks:[A], ...(extra||{}) }, webChatDir: FIX + '/.web-chat',
  log:()=>{}, fence:(parent, child) => { const r = path.resolve(parent, child); return (r === parent || r.startsWith(parent + path.sep)) ? r : null; },
  diff:()=>null,
  driver:{ setStore(p){Object.assign(store,p);return Promise.resolve({ok:true})},
    getStore(k){const o={};for(const x of k||[])if(x in store)o[x]=store[x];return Promise.resolve(o)},
    streamEvents({onEvent}){onEv=onEvent;return{close(){}}} } });
let sq=0; const nx=()=>(sq=Math.max(Date.now(),sq+1));
const ctl=(op,extra)=>{const patch={jpy_ctl:{seq:nx(),op,...(extra||{})}};Object.assign(store,patch);if(onEv)onEv({patch})};
const until=async(p,w,ms=20000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(p())return;await new Promise(r=>setTimeout(r,120))}throw new Error('timeout '+w)};
const settle=(ms)=>new Promise(r=>setTimeout(r,ms||500));
const names=()=>((store.jpy_nb&&store.jpy_nb.tabs)||[]).filter(t=>!t.error).map(t=>t.name);
let fails=0; const ok=(l,c,e)=>{if(!c)fails++;console.log((c?'  PASS  ':'  FAIL  ')+l+(e!==undefined?'  -> '+String(e).slice(0,110):''))};

await svc.start(mk({ open_root: FIX }));
await until(()=>store.jpy_conn && store.jpy_conn.state!=='discovering','connect');
ok('connected', store.jpy_conn.ok===true, store.jpy_conn.error);
ok('starts with the params tab only', names().join(',')==='tabs-a.ipynb', names().join(','));
ok('open_root is published so the pane can show it', store.jpy_nb.open_root===FIX, store.jpy_nb.open_root);

console.log('\n— browse —');
ctl('browse',{}); await settle();
ok('browse listed the boundary directory', store.jpy_browse && store.jpy_browse.entries.length>0, store.jpy_browse && store.jpy_browse.entries.length);
ok('and only shows notebooks and directories', (store.jpy_browse.entries||[]).every(e=>e.dir||/\.ipynb$/.test(e.name)), (store.jpy_browse.entries||[]).slice(0,4).map(e=>e.name).join(','));

console.log('\n— open —');
ctl('open',{path:B}); await until(()=>names().length===2,'open B');
ok('a second tab opened', names().join(',').includes('tabs-b.ipynb'), names().join(','));
ctl('open',{path:B}); await settle();
ok('opening it again is idempotent, not a duplicate', names().filter(n=>n==='tabs-b.ipynb').length===1, names().join(','));

console.log('\n— the fence —');
ctl('open',{path:'/tmp/wc-jpy-outside/secret.ipynb'}); await settle();
ok('a path outside open_root is REFUSED', names().length===2 && store.jpy_nb.notice && store.jpy_nb.notice.reason==='outside-boundary', JSON.stringify(store.jpy_nb.notice));
ctl('open',{path: FIX + '/../wc-jpy-outside/secret.ipynb'}); await settle();
ok('and so is a traversal attempt', names().length===2, names().join(','));
ctl('open',{path: FIX + '/notes.txt'}); await settle();
ok('a non-notebook is refused', store.jpy_nb.notice && store.jpy_nb.notice.reason==='not-a-notebook', JSON.stringify(store.jpy_nb.notice));

console.log('\n— new —');
try { fs.unlinkSync(FIX + '/Fresh.ipynb'); } catch {}
ctl('new',{ name:'Fresh' }); await until(()=>names().includes('Fresh.ipynb'),'create Fresh');
ok('a new notebook was created and opened', names().includes('Fresh.ipynb'), names().join(','));
ok('it exists on disk', fs.existsSync(FIX + '/Fresh.ipynb'));
const fresh = readJson(FIX + '/Fresh.ipynb');
ok('and is a valid notebook with one empty code cell', fresh.nbformat===4 && fresh.cells.length===1 && fresh.cells[0].cell_type==='code', JSON.stringify(fresh.cells.length));
ctl('new',{ name:'Fresh' }); await settle();
ok('creating the same name again is refused', store.jpy_nb.notice && store.jpy_nb.notice.reason==='exists', JSON.stringify(store.jpy_nb.notice));

console.log('\n— persistence across a respawn —');
const openBefore = names().slice().sort().join(',');
await stopSvc();
for (const k of Object.keys(store)) delete store[k];
await svc.start(mk({ open_root: FIX }));
await until(()=>store.jpy_nb && names().length>0,'respawn');
await settle(30);   // the floor refuses ops stamped at or before startedAt
ok('runtime-opened tabs survived the restart', names().slice().sort().join(',')===openBefore, names().slice().sort().join(',')+'  vs  '+openBefore);

console.log('\n— close —');
ctl('close',{ id: (store.jpy_nb.tabs.find(t=>t.name==='Fresh.ipynb')||{}).id });
await until(()=>!names().includes('Fresh.ipynb'),'close Fresh');
ok('the tab closed', !names().includes('Fresh.ipynb'), names().join(','));
ok('its per-cell keys were tombstoned', Object.keys(store).some(k=>k.startsWith('jpy_src_') && store[k]===null));

console.log('\n— open_root:false disables the whole capability —');
await stopSvc();
for (const k of Object.keys(store)) delete store[k];
await svc.start(mk({ open_root: false }));
await until(()=>store.jpy_conn && store.jpy_conn.state!=='discovering','connect2');
await settle(30);
ctl('open',{path:B}); await settle();
ok('open is refused outright', store.jpy_nb.notice && store.jpy_nb.notice.reason==='open-disabled', JSON.stringify(store.jpy_nb.notice));
await stopSvc();

try { fs.unlinkSync(FIX + '/Fresh.ipynb'); } catch {}
console.log('\n'+(fails?fails+' FAILING':'all green'));
process.exit(fails?1:0);

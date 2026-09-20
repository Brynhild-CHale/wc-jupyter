// Journal, autosave and undo/redo, driven against a real Jupyter server.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shutdownKernel } = await import('./kernel-cleanup.mjs');
// Release the kernel with the service, EVERY time — a harness that starts the
// service more than once starts a kernel each time, and pairing the two by hand
// meant tabs-harness (three starts, one release) leaked two per run.
const stopSvc = async () => { await shutdownKernel(store.jpy_conn); await svc.stop(); };
const svc = require('../components/jpy-notebook/service.js');
// Fixture root — override with JPY_FIXTURES to run this anywhere.
const FIX = process.env.JPY_FIXTURES || '/tmp/wc-jpy-live';
const fs = require('fs'), path = require('path');
const readJson = require('./nbread.cjs');   // the service may be mid-write
const NB = FIX + '/journal.ipynb';
const HIST = FIX + '/.web-chat/jpy-history';

fs.rmSync(HIST, { recursive: true, force: true });
fs.writeFileSync(NB, JSON.stringify({ cells: [
  { cell_type:'code', id:'one', metadata:{}, execution_count:null, outputs:[], source:'original one' },
  { cell_type:'code', id:'two', metadata:{}, execution_count:null, outputs:[], source:'original two' },
], metadata:{ kernelspec:{ name:'python3', language:'python' } }, nbformat:4, nbformat_minor:5 }, null, 1));

const store = {}; let onEv = null;
const ctx = { name:'jpy-notebook', mountId:'m', params:{ notebooks:[NB] }, webChatDir:FIX + '/.web-chat',
  log:()=>{}, fence:(p,c)=>c, diff:()=>null,
  driver:{ setStore(p){Object.assign(store,p);return Promise.resolve({ok:true})},
    getStore(k){const o={};for(const x of k||[])if(x in store)o[x]=store[x];return Promise.resolve(o)},
    streamEvents({onEvent}){onEv=onEvent;return{close(){}}} } };
let sq=0; const next=()=>(sq=Math.max(Date.now(),sq+1));
const ctl=(op,extra)=>{const patch={jpy_ctl:{seq:next(),op,...(extra||{})}};Object.assign(store,patch);if(onEv)onEv({patch})};
const until=async(p,w,ms=25000)=>{const t0=Date.now();while(Date.now()-t0<ms){if(p())return;await new Promise(r=>setTimeout(r,120))}throw new Error('timeout '+w)};
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const fileSrc=(id)=>{const nb=readJson(NB);const c=nb.cells.find(x=>x.id===id);return c?(Array.isArray(c.source)?c.source.join(''):c.source):null};
let fails=0; const ok=(l,c,e)=>{if(!c)fails++;console.log((c?'  PASS  ':'  FAIL  ')+l+(e!==undefined?'  -> '+String(e).slice(0,110):''))};

await svc.start(ctx);
await until(()=>store.jpy_conn && store.jpy_conn.state!=='discovering','connect');
ok('connected', store.jpy_conn.ok===true, store.jpy_conn.error);
ok('a baseline version was sealed at open', store.jpy_hist && store.jpy_hist.depth>=1, store.jpy_hist && store.jpy_hist.depth);
const dirs = fs.existsSync(HIST) ? fs.readdirSync(HIST) : [];
ok('journal exists on host disk', dirs.length===1, dirs.join(','));

console.log('\n— typing autosaves after the idle debounce —');
ctl('edit',{cell:'one', source:'edited once'});
await wait(400);
ok('nothing written yet (still inside the debounce)', fileSrc('one')==='original one', fileSrc('one'));
await until(()=>fileSrc('one')==='edited once','autosave to land');
ok('autosaved after ~1.2s idle', fileSrc('one')==='edited once', fileSrc('one'));
ok('a version was sealed for it', store.jpy_hist.depth>=2, store.jpy_hist.depth);
ok('undo is now available', store.jpy_hist.can_undo===true);

console.log('\n— undo —');
const revBefore = store.jpy_hist.rev;
ctl('undo',{});
await until(()=>fileSrc('one')==='original one','undo to land');
ok('buffer and FILE went back', fileSrc('one')==='original one', fileSrc('one'));
ok('cursor moved back', store.jpy_hist.rev < revBefore, store.jpy_hist.rev+' < '+revBefore);
ok('redo is now available', store.jpy_hist.can_redo===true);

console.log('\n— redo —');
ctl('redo',{});
await until(()=>fileSrc('one')==='edited once','redo to land');
ok('redo restored the edit', fileSrc('one')==='edited once', fileSrc('one'));

console.log('\n— a structural change saves immediately, no debounce —');
const before = readJson(NB).cells.length;
ctl('insert',{cell:'one', where:'after', type:'code'});
await until(()=>readJson(NB).cells.length===before+1,'insert to save');
ok('inserted cell hit the file without waiting', readJson(NB).cells.length===before+1);

console.log('\n— undo brings a DELETED cell back —');
ctl('delete',{cell:'two'});
await until(()=>fileSrc('two')===null,'delete to save');
ok('cell gone from the file', fileSrc('two')===null);
ctl('undo',{});
await until(()=>fileSrc('two')!==null,'undo of the delete');
ok('undo restored the deleted cell', fileSrc('two')==='original two', fileSrc('two'));

console.log('\n— stop() flushes an unsealed burst —');
ctl('edit',{cell:'one', source:'typed right before stop'});
await wait(200);
await stopSvc();
ok('the un-debounced burst was flushed on stop', fileSrc('one')==='typed right before stop', fileSrc('one'));

console.log('\n'+(fails?fails+' FAILING':'all green'));
process.exit(fails?1:0);
